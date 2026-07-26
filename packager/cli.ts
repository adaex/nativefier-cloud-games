import fs from 'fs';
import path from 'path';
import { build, deriveSlug, type AppConfig, type BuildResult } from './build.ts';

/** 构建前静态校验：不依赖网络，尽早拦截配置错误，避免浪费昂贵的构建 */
function preflight(apps: AppConfig[]): void {
  const errors: string[] = [];
  const idSeen = new Map<number, number>(); // id → 首次出现的下标
  const slugSeen = new Map<string, number>(); // slug → 首次出现的下标
  apps.forEach((app, i) => {
    const tag = `第 ${i + 1} 项`;
    if (app.id === undefined || app.id === null || !Number.isInteger(app.id)) {
      errors.push(`${tag}: id 必须是整数（App Store 数字 ID），实际为 ${JSON.stringify(app.id)}`);
      return;
    }
    if (idSeen.has(app.id)) {
      errors.push(`id 重复: ${app.id}（第 ${idSeen.get(app.id)! + 1} 项与第 ${i + 1} 项）`);
    } else {
      idSeen.set(app.id, i);
    }
    if (!app.url) {
      errors.push(`${tag} (id=${app.id}): 缺少 url`);
      return;
    }
    let slug: string;
    try {
      const u = new URL(app.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push(`${tag} (id=${app.id}): url 协议必须是 http(s)，实际为 ${u.protocol}`);
        return;
      }
      slug = deriveSlug(app.url);
    } catch (e) {
      errors.push(`${tag} (id=${app.id}): url 非法 (${(e as Error).message})`);
      return;
    }
    if (slugSeen.has(slug)) {
      errors.push(`slug 冲突: "${slug}"（第 ${slugSeen.get(slug)! + 1} 项与第 ${i + 1} 项），请区分 url 域名`);
    } else {
      slugSeen.set(slug, i);
    }
  });
  if (errors.length > 0) {
    console.error(`❌ 配置校验失败:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
}

async function main() {
  const repoRoot = path.join(import.meta.dirname, '..');
  const configPath = process.argv[2] ?? path.join(repoRoot, 'apps.json');

  let apps: AppConfig[];
  try {
    apps = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`❌ 无法读取配置 (${configPath}):`, (e as Error).message);
    process.exit(1);
  }
  if (!Array.isArray(apps) || apps.length === 0) {
    console.error(`❌ 配置 ${configPath} 必须是非空数组`);
    process.exit(1);
  }

  preflight(apps);

  const results: BuildResult[] = [];
  const failures: string[] = [];

  const buildOne = (app: AppConfig, i: number): Promise<BuildResult> => {
    console.log(`[${i + 1}/${apps.length}] id=${app.id}`);
    return build(app);
  };

  // 先串行构建第一个：预热 Electron 二进制下载缓存，避免并行时多个构建
  // 并发冷下载同一份 Electron。其余应用再并行（缓存已就绪，纯本地打包）。
  // 首个失败不再直接退出，统一纳入失败收集，与其余应用错误处理对称。
  try {
    results.push(await buildOne(apps[0], 0));
  } catch (e) {
    failures.push(`id=${apps[0].id}: ${(e as Error).message}`);
  }

  const rest = apps.slice(1);
  if (rest.length > 0) {
    const settled = await Promise.allSettled(rest.map((app, k) => buildOne(app, k + 1)));
    settled.forEach((r, k) => {
      if (r.status === 'fulfilled') results.push(r.value);
      else failures.push(`id=${rest[k].id}: ${(r.reason as Error).message}`);
    });
  }

  // 构建后校验：name 来自 App Store，只能此时得知。撞名会让 packager 产物目录
  // (name-platform-arch) 相同而互相覆盖，必须拦截。
  const nameSeen = new Map<string, number>();
  const nameConflicts: string[] = [];
  for (const r of results) {
    if (nameSeen.has(r.name)) {
      nameConflicts.push(`name 冲突: "${r.name}"（id=${nameSeen.get(r.name)} 与 id=${r.id}），产物目录会互相覆盖`);
    } else {
      nameSeen.set(r.name, r.id);
    }
  }
  if (nameConflicts.length > 0) {
    console.error(`\n❌ ${nameConflicts.join('\n❌ ')}`);
    process.exit(1);
  }

  // 全部失败：无任何产物，硬失败（不写空 manifest）
  if (results.length === 0) {
    console.error(`\n❌ 全部构建失败:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }

  // 写 manifest（只含成功者），供 CI 定位产物、生成 release notes。
  // 部分失败时仍写入成功者，让 CI 能发布可用的 app，而非整批报废。
  const distDir = path.join(repoRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(results, null, 2));

  const total = results.reduce((n, r) => n + r.appPaths.length, 0);
  if (failures.length > 0) {
    // 部分失败：警告但以 0 退出，使 CI 继续发布成功的 app
    console.warn(`\n⚠️  ${failures.length} 个应用失败（已跳过，其余照常发布）:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    console.log(`\n✅ 成功 ${results.length} 个，共 ${total} 个包`);
  } else {
    console.log(`\n✅ 全部完成，共 ${total} 个包`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

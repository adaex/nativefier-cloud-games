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
    if (app === null || typeof app !== 'object' || Array.isArray(app)) {
      errors.push(`${tag}：必须是包含 id 和 url 的对象`);
      return;
    }
    if (!Number.isSafeInteger(app.id) || app.id <= 0) {
      errors.push(`${tag}：id 必须是正的安全整数（App Store 数字 ID），实际为 ${JSON.stringify(app.id)}`);
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

  // 只保留本次产物，避免移除应用后，build-and-install 误装历史包
  const distDir = path.join(repoRoot, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });

  // 串行复用 Electron 下载缓存；任一应用失败都直接终止，CI 不进入发布步骤
  const results: BuildResult[] = [];
  for (const [i, app] of apps.entries()) {
    console.log(`[${i + 1}/${apps.length}] id=${app.id}`);
    results.push(await build(app));
  }

  // 构建后校验：name 来自 App Store，只能此时得知。同名应用会互相替换安装；
  // macOS 默认文件系统不区分大小写，Unicode 规范化后再按小写检测冲突。
  const nameSeen = new Map<string, number>();
  for (const r of results) {
    const key = r.name.normalize('NFKC').toLowerCase();
    const previousId = nameSeen.get(key);
    if (previousId !== undefined) {
      throw new Error(`name 冲突: "${r.name}"（id=${previousId} 与 id=${r.id}），安装目录会互相覆盖`);
    }
    nameSeen.set(key, r.id);
  }

  // 写内部与对外 manifest，供 CI 定位产物和生成 release notes
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'manifest.json'), JSON.stringify(results, null, 2));
  const releaseManifest = results.map(({ appPaths, ...entry }) => entry);
  fs.writeFileSync(path.join(distDir, 'release-manifest.json'), JSON.stringify(releaseManifest, null, 2));

  const total = results.reduce((n, r) => n + r.appPaths.length, 0);
  console.log(`\n✅ 全部完成，共 ${total} 个包`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

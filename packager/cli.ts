import fs from 'fs';
import path from 'path';
import { build, type AppConfig, type BuildResult } from './build.ts';

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

  const results: BuildResult[] = [];
  let total = 0;

  const buildOne = (app: AppConfig, i: number): Promise<BuildResult> => {
    console.log(`[${i + 1}/${apps.length}] ${app.id ?? '(缺少 id)'}`);
    return build(app);
  };

  // 先串行构建第一个：预热 Electron 二进制下载缓存，避免并行时多个构建
  // 并发冷下载同一份 Electron。其余应用再并行（缓存已就绪，纯本地打包）。
  // 仅 1 个 app 时等价于原来的串行行为。
  try {
    const first = await buildOne(apps[0], 0);
    results.push(first);
    total += first.appPaths.length;
  } catch (e) {
    console.error(`\n❌ 构建失败 (${apps[0].id ?? '第 1 项'}):`, (e as Error).message);
    process.exit(1);
  }

  const rest = apps.slice(1);
  if (rest.length > 0) {
    const settled = await Promise.allSettled(
      rest.map((app, k) => buildOne(app, k + 1)),
    );
    const failures: string[] = [];
    settled.forEach((r, k) => {
      const app = rest[k];
      if (r.status === 'fulfilled') {
        results.push(r.value);
        total += r.value.appPaths.length;
      } else {
        failures.push(`${app.id ?? `第 ${k + 2} 项`}: ${(r.reason as Error).message}`);
      }
    });
    if (failures.length > 0) {
      console.error(`\n❌ 构建失败:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
      process.exit(1);
    }
  }

  // 全部成功后写 manifest，供 CI 定位产物、生成 release notes
  const distDir = path.join(repoRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  // slug 是对外标识（zip 名/安装器选应用），重复会导致 zip 静默覆盖
  const slugSeen = new Map<string, number>();
  for (const r of results) {
    if (slugSeen.has(r.slug)) {
      console.error(`\n❌ slug 冲突: "${r.slug}" 同时来自 id=${slugSeen.get(r.slug)} 与 id=${r.id}，请区分 url 域名`);
      process.exit(1);
    }
    slugSeen.set(r.slug, r.id);
  }

  fs.writeFileSync(
    path.join(distDir, 'manifest.json'),
    JSON.stringify(results, null, 2),
  );

  console.log(`\n✅ 全部完成，共 ${total} 个包`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

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
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    if (i > 0) console.log();
    console.log(`[${i + 1}/${apps.length}] ${app.id ?? '(缺少 id)'}`);
    try {
      const result = await build(app);
      results.push(result);
      total += result.appPaths.length;
    } catch (e) {
      console.error(`\n❌ 构建失败 (${app.id ?? `第 ${i + 1} 项`}):`, (e as Error).message);
      process.exit(1);
    }
  }

  // 全部成功后写 manifest，供 CI 定位产物、生成 release notes
  const distDir = path.join(repoRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
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

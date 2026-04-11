import { build } from './build.js';

const configPaths = process.argv.slice(2);

if (configPaths.length === 0) {
  console.error('用法: npx tsx packager/cli.ts <config.json> [config2.json ...]');
  process.exit(1);
}

let total = 0;
for (const configPath of configPaths) {
  try {
    const paths = await build(configPath);
    total += paths.length;
  } catch (e) {
    console.error(`\n❌ 构建失败 (${configPath}):`, (e as Error).message);
    process.exit(1);
  }
}

console.log(`\n✅ 全部完成，共 ${total} 个包`);

import path from 'path';
import { build } from './build.js';

const configPaths = process.argv.slice(2);

if (configPaths.length === 0) {
  console.error('用法: npx tsx packager/cli.ts <config.json> [config2.json ...]');
  process.exit(1);
}

let total = 0;
for (let i = 0; i < configPaths.length; i++) {
  const configPath = configPaths[i];
  const id = path.basename(path.dirname(configPath));
  if (i > 0) console.log();
  console.log(`[${i + 1}/${configPaths.length}] ${id}`);
  try {
    const paths = await build(configPath);
    total += paths.length;
  } catch (e) {
    console.error(`\n❌ 构建失败 (${configPath}):`, (e as Error).message);
    process.exit(1);
  }
}

console.log(`\n✅ 全部完成，共 ${total} 个包`);

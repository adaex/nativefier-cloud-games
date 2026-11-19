import fs from 'fs';
import path from 'path';
import { build, deriveSlug, getBuildVersion, readAppName, refreshIcon, repoRoot, type AppConfig, type BuildResult } from './build.ts';

/** 保留校验过的 slug，供后续打包和生成清单使用 */
function preflight(apps: AppConfig[]) {
  const validated: (AppConfig & { slug: string })[] = [];
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
      slug = deriveSlug(u);
    } catch (e) {
      errors.push(`${tag} (id=${app.id}): url 非法 (${(e as Error).message})`);
      return;
    }
    if (slugSeen.has(slug)) {
      errors.push(`slug 冲突: "${slug}"（第 ${slugSeen.get(slug)! + 1} 项与第 ${i + 1} 项），请区分 url 域名`);
    } else {
      slugSeen.set(slug, i);
    }
    validated.push({ ...app, slug });
  });
  if (errors.length > 0) {
    console.error(`❌ 配置校验失败:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  return validated;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = ['--refresh-icons', '--cached-icons'].includes(args[0]) ? args.shift() : undefined;
  const configPath = args[0] ?? path.join(repoRoot, 'apps.json');

  let config: AppConfig[];
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`❌ 无法读取配置 (${configPath}):`, (e as Error).message);
    process.exit(1);
  }
  if (!Array.isArray(config) || config.length === 0) {
    console.error(`❌ 配置 ${configPath} 必须是非空数组`);
    process.exit(1);
  }

  const apps = preflight(config);
  if (mode !== '--cached-icons') {
    await Promise.all(apps.map(refreshIcon));
  }
  // 刷新后名称已确定，在提交图标或打包前检查安装目录是否重名
  const nameSeen = new Map<string, number>();
  const namedApps = apps.map(app => {
    const name = readAppName(app.id);
    const key = name.normalize('NFKC').toLowerCase();
    const previousId = nameSeen.get(key);
    if (previousId !== undefined) {
      throw new Error(`名称冲突：${name}（id=${previousId} 与 id=${app.id}），安装目录会互相覆盖`);
    }
    nameSeen.set(key, app.id);
    return { ...app, name };
  });
  if (mode === '--refresh-icons') return;

  // 只保留本次产物，避免移除应用后，build-and-install 误装历史包
  const distDir = path.join(repoRoot, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });

  // 串行复用 Electron 下载缓存；任一应用失败都直接终止，CI 不进入发布步骤
  const version = getBuildVersion();
  const results: BuildResult[] = [];
  for (const [i, app] of namedApps.entries()) {
    console.log(`[${i + 1}/${namedApps.length}] id=${app.id}`);
    results.push(await build(app, version));
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

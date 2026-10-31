import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { packager } from '@electron/packager';

const NPM_REGISTRY = process.env.CI
  ? 'https://registry.npmjs.org'
  : 'https://registry.npmmirror.com';
const ELECTRON_MIRROR = process.env.CI
  ? undefined
  : 'https://npmmirror.com/mirrors/electron/';

export interface AppConfig {
  /** App Store 数字 ID：既是应用唯一标识（bundleId/zip 名/userData），也是拉取图标与名称的查询键 */
  id: number;
  url: string;
  /** App Store 区域，默认 cn */
  country?: string;
}

export interface BuildResult {
  id: number;
  /** 对外标识：由 url 域名派生的可读 slug，用于 zip 名与安装器选应用 */
  slug: string;
  name: string;
  url: string;
  /** 构建使用的 Electron 版本 */
  electronVersion: string;
  /** 源码版本；同 Electron 版本下的内容更新也借此触发重装 */
  revision: string;
  appPaths: string[];
}

/** 常见复合 TLD（二级后缀），派生 slug 时需整体去掉 */
const COMPOUND_TLDS = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.tw', 'co.jp', 'or.jp', 'co.uk', 'org.uk', 'com.au', 'com.br',
]);

/**
 * 由 url 域名派生对外可读 slug：hostname 去 www 前缀、去顶级域名（含 com.cn 等
 * 复合 TLD）、其余段用连字符拼接。
 * 例：https://ys.mihoyo.com/... → ys-mihoyo；https://www.migufun.com/... → migufun
 */
export function deriveSlug(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length > 2 && COMPOUND_TLDS.has(parts.slice(-2).join('.'))) {
    parts.splice(-2); // 复合 TLD 整体去掉
  } else if (parts.length > 1) {
    parts.pop(); // 普通 TLD
  }
  const slug = parts.join('-').toLowerCase();
  if (!slug) throw new Error(`无法从 url 派生 slug: ${url}`);
  return slug;
}

const log = {
  info: (msg: string) => console.log(`\x1b[36m[INFO] ${msg}\x1b[0m`),
  ok: (msg: string) => console.log(`\x1b[32m[ OK ] ${msg}\x1b[0m`),
  err: (msg: string) => console.error(`\x1b[31m[ERR ] ${msg}\x1b[0m`),
};

let cachedElectronVersion: string | undefined;

function getElectronVersion(): string {
  if (cachedElectronVersion) return cachedElectronVersion;
  if (process.env.ELECTRON_VERSION) {
    cachedElectronVersion = process.env.ELECTRON_VERSION;
    log.ok(`Electron 版本 (env): ${cachedElectronVersion}`);
    return cachedElectronVersion;
  }
  log.info('正在获取最新 Electron 版本...');
  cachedElectronVersion = execFileSync(
    'npm', ['view', 'electron', 'version', '--registry', NPM_REGISTRY],
    { encoding: 'utf8' },
  ).trim();
  log.ok(`Electron 版本: ${cachedElectronVersion}`);
  return cachedElectronVersion;
}

let cachedSourceRevision: string | undefined;

function getSourceRevision(): string {
  if (!cachedSourceRevision) {
    cachedSourceRevision = process.env.GITHUB_SHA || execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8' },
    ).trim();
  }
  return cachedSourceRevision;
}

function pngToIcns(pngPath: string, tmpDir: string): string {
  const iconsetDir = path.join(tmpDir, 'app.iconset');
  fs.mkdirSync(iconsetDir);
  const sizes = [16, 32, 128, 256, 512];
  for (const s of sizes) {
    execFileSync('sips', ['-z', `${s}`, `${s}`, pngPath, '--out', path.join(iconsetDir, `icon_${s}x${s}.png`)], { stdio: 'pipe' });
    execFileSync('sips', ['-z', `${s * 2}`, `${s * 2}`, pngPath, '--out', path.join(iconsetDir, `icon_${s}x${s}@2x.png`)], { stdio: 'pipe' });
  }
  const icnsPath = path.join(tmpDir, 'app.icns');
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath], { stdio: 'pipe' });
  log.ok(`图标转换完成: PNG → ICNS`);
  return icnsPath;
}

/** 截断 App Store trackName 的营销后缀，取分隔符前的主名 */
function shortName(track: string): string {
  const name = track.split(/[-－｜|：:—–]/)[0].trim();
  if (!name) throw new Error(`无法从 trackName 提取有效名称: ${track}`);
  return name;
}

async function fetchBuffer(url: string, timeout = 15000): Promise<Buffer> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      if (i < 2) log.info(`请求失败，重试 (${i + 1}/2): ${(e as Error).message}`);
    }
  }
  throw new Error(`请求失败 (${url}): ${(lastErr as Error).message}`);
}

interface AppMeta {
  name: string;
  iconUrl: string;
}

/** 通过 iTunes Lookup API 获取 App 名称与 1024px 图标地址 */
async function fetchAppMeta(appId: number, country: string): Promise<AppMeta> {
  const url = `https://itunes.apple.com/lookup?id=${appId}&country=${country}`;
  const data = JSON.parse((await fetchBuffer(url)).toString('utf8')) as { resultCount?: number; results?: Array<{ trackName: string; artworkUrl512?: string; artworkUrl100?: string }> };
  if (!data.resultCount || !data.results?.length) {
    throw new Error(`App Store 未找到 appId=${appId} (country=${country})`);
  }
  const app = data.results[0];
  const artwork = app.artworkUrl512 ?? app.artworkUrl100;
  if (!artwork) throw new Error(`appId=${appId} 未返回图标地址`);
  const iconUrl = artwork.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1024x1024bb.png');
  if (iconUrl === artwork) {
    throw new Error(`图标地址格式异常，无法改写为 1024px PNG: ${artwork}`);
  }
  return { name: shortName(app.trackName), iconUrl };
}

/** 下载图标到指定 PNG 路径 */
async function downloadIcon(url: string, destPngPath: string): Promise<void> {
  const buf = await fetchBuffer(url, 30000);
  if (buf.length < 1024) throw new Error(`图标文件过小 (${buf.length} 字节)，疑似无效`);
  fs.writeFileSync(destPngPath, buf);
  log.ok(`图标下载完成: ${(buf.length / 1024).toFixed(0)} KB`);
}

/**
 * 在产物目录生成 install.sh：去隔离标记并复制到 /Applications。
 * 本地构建可双击直接运行，无需此脚本；它主要服务于 CI 下载包
 * （macOS 会给下载的文件打 quarantine，需去除才能通过 Gatekeeper）。
 */
function writeInstallScript(appDir: string): void {
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'app=$(find . -maxdepth 1 -name "*.app" -type d | head -1)',
    'if [ -z "$app" ]; then echo "未找到 .app"; exit 1; fi',
    'name=$(basename "$app")',
    'xattr -dr com.apple.quarantine "$app"',
    '# 无 /Applications 写权限（非管理员）时装进 ~/Applications',
    'if [ -w /Applications ]; then dest_base=/Applications; else dest_base="$HOME/Applications"; mkdir -p "$dest_base"; fi',
    '# 先 cp 到同卷临时目录，成功后再 rm 旧的 + mv 就位。',
    '# 避免 rm 先于 cp——若 cp 中途失败（磁盘满/中断），旧安装仍完好。',
    'dest="$dest_base/$name"',
    'if [ -e "$dest" ] && [ ! -w "$dest" ]; then echo "无权限替换 $dest（属主可能是其他用户），请先手动删除。"; exit 1; fi',
    'tmp="$dest_base/.${name}.tmp.$$"',
    'rm -rf "$tmp"',
    'trap \'rm -rf "$tmp"\' EXIT',
    'cp -R "$app" "$tmp"',
    'rm -rf "$dest"',
    'mv "$tmp" "$dest"',
    'echo "已安装: $dest"',
    '',
  ].join('\n');
  const scriptPath = path.join(appDir, 'install.sh');
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  log.ok(`生成 install.sh`);
}

export async function build(config: AppConfig): Promise<BuildResult> {
  const repoRoot = path.join(import.meta.dirname, '..');
  const id = config.id;
  const slug = deriveSlug(config.url);
  const bundleId = `io.github.adaex.cloudgames.${id}`;
  const country = config.country ?? 'cn';
  const electronVersion = getElectronVersion();
  const revision = getSourceRevision();
  // 每个 app 独立输出目录，避免同名或大小写相近的名称争用目录
  const outDir = path.join(repoRoot, 'dist', String(id));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packager-'));
  try {
    const templateDir = path.join(import.meta.dirname, 'template');
    fs.cpSync(templateDir, tmpDir, { recursive: true });

    // 读取 template package.json，稍后与 version/name 一起写回（name 需先解析）
    const pkgPath = path.join(tmpDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // 从 App Store 拉取名称与图标地址（id 即查询键）
    log.info(`查询 App Store: id=${id} (${country})`);
    const meta = await fetchAppMeta(id, country);
    const name = meta.name;
    const iconUrl = meta.iconUrl;
    log.ok(`App Store 名称: ${name}`);

    // package.json：version 对齐 Electron；productName 设为真实名，使
    // app.getName() 返回真实名（菜单 About/Quit 显示真实名）。name 保持
    // ASCII id 以符合 npm 规范，app.getName() 优先读 productName。
    pkg.version = electronVersion;
    pkg.name = String(id);
    pkg.productName = name;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    fs.writeFileSync(
      path.join(tmpDir, 'app.json'),
      JSON.stringify({ id, name, url: config.url }),
    );

    // 图标：按 id 从 App Store 下载
    const iconSrc = path.join(tmpDir, 'downloaded-icon.png');
    await downloadIcon(iconUrl, iconSrc);
    const icon = pngToIcns(iconSrc, tmpDir);

    log.info(`开始构建: ${name} (${id})`);
    const appPaths = await packager({
      dir: tmpDir,
      name,
      appBundleId: bundleId,
      electronVersion,
      extendInfo: { CloudGamesRevision: revision },
      platform: 'darwin',
      arch: 'arm64',
      out: outDir,
      overwrite: true,
      icon,
      quiet: true,
      download: ELECTRON_MIRROR
        ? { mirrorOptions: { mirror: ELECTRON_MIRROR } }
        : undefined,
    });

    for (const p of appPaths) {
      log.ok(`输出: ${p}`);
      writeInstallScript(p);
    }
    return { id, slug, name, url: config.url, electronVersion, revision, appPaths };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

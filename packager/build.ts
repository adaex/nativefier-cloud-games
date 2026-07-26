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
  /** 应用唯一标识，用于生成 bundleId 与 zip 文件名（须为 ASCII，保持稳定） */
  id: string;
  url: string;
  /** App Store 数字 ID，用于动态拉取图标与名称 */
  appId?: number;
  /** 手动覆盖显示名（缺省则取 App Store trackName 截断后的主名） */
  name?: string;
  /** 手动覆盖图标本地路径，相对仓库根目录（缺省则按 appId 从 App Store 下载） */
  icon?: string;
  /** App Store 区域，默认 cn */
  country?: string;
  platform?: string;
  arch?: string;
}

export interface BuildResult {
  id: string;
  name: string;
  url: string;
  appId?: number;
  appPaths: string[];
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

async function fetchJson(url: string, retries = 3): Promise<unknown> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) log.info(`请求失败，重试 (${i + 1}/${retries - 1}): ${(e as Error).message}`);
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
  const data = await fetchJson(url) as { resultCount?: number; results?: Array<{ trackName: string; artworkUrl512?: string; artworkUrl100?: string }> };
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
async function downloadIcon(url: string, destPngPath: string, retries = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`图标文件过小 (${buf.length} 字节)，疑似无效`);
      fs.writeFileSync(destPngPath, buf);
      log.ok(`图标下载完成: ${(buf.length / 1024).toFixed(0)} KB`);
      return;
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) log.info(`图标下载失败，重试 (${i + 1}/${retries - 1}): ${(e as Error).message}`);
    }
  }
  throw new Error(`图标下载失败 (${url}): ${(lastErr as Error).message}`);
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
    'rm -rf "/Applications/$name"',
    'cp -R "$app" "/Applications/$name"',
    'echo "已安装: /Applications/$name"',
    '',
  ].join('\n');
  const scriptPath = path.join(appDir, 'install.sh');
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  log.ok(`生成 install.sh`);
}

export async function build(config: AppConfig): Promise<BuildResult> {
  const repoRoot = path.join(import.meta.dirname, '..');

  // 校验矩阵：id、url 恒必填；appId 或（name 且 icon）之一必须提供
  if (!config.id) {
    throw new Error('配置项必须包含 id 字段');
  }
  if (!config.url) {
    throw new Error(`配置项 ${config.id} 必须包含 url 字段`);
  }
  const hasManualOverride = Boolean(config.name && config.icon);
  if (config.appId === undefined && !hasManualOverride) {
    throw new Error(`配置项 ${config.id} 必须包含 appId，或同时提供 name 和 icon 作为手动覆盖`);
  }

  const id = config.id;
  const bundleId = `com.electron.webapp.${id}`;
  const country = config.country ?? 'cn';
  const electronVersion = getElectronVersion();
  const platform = config.platform ?? process.platform;
  const arch = config.arch ?? os.arch();
  const outDir = path.join(repoRoot, 'dist');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packager-'));
  try {
    const templateDir = path.join(import.meta.dirname, 'template');
    fs.cpSync(templateDir, tmpDir, { recursive: true });

    // app 版本号与 Electron 版本对齐
    const pkgPath = path.join(tmpDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = electronVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    // 按需从 App Store 拉取名称与图标地址（name/icon 显式提供时可跳过对应部分）
    let name = config.name;
    let iconUrl: string | undefined;
    if (config.appId !== undefined && (!name || !config.icon)) {
      log.info(`查询 App Store: appId=${config.appId} (${country})`);
      const meta = await fetchAppMeta(config.appId, country);
      if (!name) name = meta.name;
      if (!config.icon) iconUrl = meta.iconUrl;
      log.ok(`App Store 名称: ${meta.name}`);
    }
    if (!name) throw new Error('无法确定应用名称');

    fs.writeFileSync(
      path.join(tmpDir, 'app.json'),
      JSON.stringify({ id, name, url: config.url }),
    );

    // 图标解析：①显式 config.icon 本地路径（相对仓库根目录）→ ②按 appId 下载
    let iconSrc: string | undefined;
    if (config.icon) {
      iconSrc = path.resolve(repoRoot, config.icon);
      if (!fs.existsSync(iconSrc)) {
        throw new Error(`指定的图标文件不存在: ${iconSrc}`);
      }
    } else if (iconUrl) {
      iconSrc = path.join(tmpDir, 'downloaded-icon.png');
      await downloadIcon(iconUrl, iconSrc);
    }

    let icon: string | undefined;
    if (iconSrc) {
      if (platform === 'darwin' && iconSrc.endsWith('.png')) {
        icon = pngToIcns(iconSrc, tmpDir);
      } else {
        icon = iconSrc;
      }
    }

    log.info(`开始构建: ${name} (${id})`);
    const appPaths = await packager({
      dir: tmpDir,
      name,
      appBundleId: bundleId,
      electronVersion,
      platform: platform,
      arch: arch,
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
      // 仅 macOS 产物需要 install.sh（去隔离标记 + 复制到 /Applications）
      if (platform === 'darwin') {
        writeInstallScript(p);
      }
    }
    return { id, name, url: config.url, appId: config.appId, appPaths };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

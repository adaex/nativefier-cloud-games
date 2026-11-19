import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { packager } from '@electron/packager';
import compoundTlds from './template/compound-tlds.json' with { type: 'json' };

export const repoRoot = path.join(import.meta.dirname, '..');
const iconsDir = path.join(repoRoot, 'icons');

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

interface BuildVersion {
  electronVersion: string;
  revision: string;
}

export interface BuildResult extends BuildVersion {
  id: number;
  /** 对外标识：由 url 域名派生的可读 slug，用于 zip 名与安装器选应用 */
  slug: string;
  name: string;
  url: string;
  appPaths: string[];
}

/**
 * 由 url 域名派生对外可读 slug：hostname 去 www 前缀、去顶级域名（含 com.cn 等
 * 复合 TLD）、其余段用连字符拼接。
 * 例：https://ys.mihoyo.com/... → ys-mihoyo；https://www.migufun.com/... → migufun
 */
export function deriveSlug(url: URL): string {
  const host = url.hostname.replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length > 2 && compoundTlds.includes(parts.slice(-2).join('.'))) {
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
};

export function getBuildVersion(): BuildVersion {
  let electronVersion = process.env.ELECTRON_VERSION;
  if (!electronVersion) {
    log.info('正在获取最新 Electron 版本...');
    electronVersion = execFileSync('npm', ['view', 'electron', 'version', '--registry', NPM_REGISTRY], { encoding: 'utf8' }).trim();
  }
  log.ok(`Electron 版本: ${electronVersion}`);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  return { electronVersion, revision };
}

function pngToIcns(pngPath: string, tmpDir: string): string {
  const iconsetDir = path.join(tmpDir, 'app.iconset');
  fs.mkdirSync(iconsetDir);
  // 缓存原图为 1024 像素，普通图标与 @2x 图标中相同的像素尺寸也可复用
  const rendered = new Map<number, string>([[1024, pngPath]]);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const output = path.join(iconsetDir, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
      const existing = rendered.get(pixels);
      if (existing) {
        fs.copyFileSync(existing, output);
      } else {
        execFileSync('sips', ['-z', String(pixels), String(pixels), pngPath, '--out', output]);
        rendered.set(pixels, output);
      }
    }
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
  const sizeSuffix = /\/\d+x\d+bb\.(jpg|png)$/;
  if (!sizeSuffix.test(artwork)) throw new Error(`无法识别 App Store 图标地址: ${artwork}`);
  const iconUrl = artwork.replace(sizeSuffix, '/1024x1024bb.png');
  return { name: shortName(app.trackName), iconUrl };
}

export function readAppName(id: number): string {
  return fs.readFileSync(path.join(iconsDir, `${id}.txt`), 'utf8').trim();
}

export async function refreshIcon({ id, country = 'cn' }: AppConfig): Promise<void> {
  const png = path.join(iconsDir, `${id}.png`);
  const nameFile = path.join(iconsDir, `${id}.txt`);
  using cleanup = new DisposableStack();
  let candidate: string | undefined;
  let name: string;
  try {
    const meta = await fetchAppMeta(id, country);
    name = meta.name;
    const bytes = await fetchBuffer(meta.iconUrl, 30000);
    if (!fs.existsSync(png) || !fs.readFileSync(png).equals(bytes)) {
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('下载内容不是 PNG');
      // 读原图宽高，避免 sips 把占位图放大
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (width !== 1024 || height !== 1024) throw new Error(`图标应为 1024×1024，实际为 ${width}×${height}`);
      fs.mkdirSync(iconsDir, { recursive: true });
      const tmp = cleanup.use(fs.mkdtempDisposableSync(path.join(iconsDir, '.refresh-')));
      candidate = path.join(tmp.path, 'icon.png');
      fs.writeFileSync(candidate, bytes);
      pngToIcns(candidate, tmp.path);
    }
  } catch (error) {
    if (!fs.existsSync(png) || !fs.existsSync(nameFile)) throw error;
    console.warn(`[${id}] 更新图标失败，沿用本地图标和名称：${(error as Error).message}`);
    return;
  }
  if (candidate) fs.renameSync(candidate, png);
  if (!fs.existsSync(nameFile) || fs.readFileSync(nameFile, 'utf8') !== `${name}\n`) {
    fs.writeFileSync(nameFile, `${name}\n`);
  }
}

export async function build(
  { id, slug, name, url }: AppConfig & { slug: string; name: string },
  { electronVersion, revision }: BuildVersion,
): Promise<BuildResult> {
  using tmp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), 'packager-'));
  // 应用源码与图标中间产物分开，避免 PNG、ICNS、iconset 被打进 app.asar
  const sourceDir = path.join(tmp.path, 'app');
  fs.cpSync(path.join(import.meta.dirname, 'template'), sourceDir, { recursive: true });

  // npm 包名使用数字 id，Electron 菜单通过 productName 显示真实名称
  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = electronVersion;
  pkg.name = String(id);
  pkg.productName = name;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(sourceDir, 'app.json'), JSON.stringify({ id, url }));

  const icon = pngToIcns(path.join(iconsDir, `${id}.png`), tmp.path);
  log.info(`开始构建: ${name} (${id})`);
  const appPaths = await packager({
    dir: sourceDir,
    name,
    appBundleId: `io.github.adaex.cloudgames.${id}`,
    electronVersion,
    extendInfo: { CloudGamesRevision: revision },
    platform: 'darwin',
    arch: 'arm64',
    out: path.join(repoRoot, 'dist', String(id)),
    overwrite: true,
    icon,
    quiet: true,
    download: ELECTRON_MIRROR ? { mirrorOptions: { mirror: ELECTRON_MIRROR } } : undefined,
  });

  for (const p of appPaths) {
    log.ok(`输出: ${p}`);
    fs.copyFileSync(path.join(import.meta.dirname, 'install.sh'), path.join(p, 'install.sh'));
  }
  return { id, slug, name, url, electronVersion, revision, appPaths };
}

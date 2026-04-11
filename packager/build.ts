import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import packager from '@electron/packager';

const NPM_REGISTRY = process.env.CI
  ? 'https://registry.npmjs.org'
  : 'https://registry.npmmirror.com';
const ELECTRON_MIRROR = process.env.CI
  ? undefined
  : 'https://npmmirror.com/mirrors/electron/';

export interface AppConfig {
  name: string;
  url: string;
  icon?: string;
  platform?: string;
  arch?: string;
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

function patchMacLocale(appOutDir: string, appName: string): void {
  const appBundle = fs.readdirSync(appOutDir).find((f) => f.endsWith('.app'));
  if (!appBundle) return;
  const contentsDir = path.join(appOutDir, appBundle, 'Contents');
  const resDir = path.join(contentsDir, 'Resources');
  const plistPath = path.join(contentsDir, 'Info.plist');
  const pb = (cmd: string) =>
    execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plistPath], { stdio: 'pipe' });

  // 删除空的非中文 lproj，避免 macOS 匹配到英文等空目录
  for (const entry of fs.readdirSync(resDir)) {
    if (entry.endsWith('.lproj') && entry !== 'zh_CN.lproj') {
      const lprojPath = path.join(resDir, entry);
      if (fs.readdirSync(lprojPath).length === 0) {
        fs.rmSync(lprojPath, { recursive: true });
      }
    }
  }

  // 写入 zh_CN.lproj/InfoPlist.strings
  const lprojDir = path.join(resDir, 'zh_CN.lproj');
  fs.mkdirSync(lprojDir, { recursive: true });
  fs.writeFileSync(
    path.join(lprojDir, 'InfoPlist.strings'),
    `CFBundleDisplayName = "${appName}";\nCFBundleName = "${appName}";\n`,
  );

  // 修改 Info.plist
  pb('Add :CFBundleDevelopmentRegion string zh_CN');
  pb('Add :CFBundleLocalizations array');
  pb('Add :CFBundleLocalizations:0 string zh_CN');

  log.ok(`已写入中文本地化: ${appName}`);
}

export async function build(configPath: string): Promise<string[]> {
  const configDir = path.dirname(path.resolve(configPath));
  const config: AppConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  if (!config.name || !config.url) {
    throw new Error('配置文件必须包含 name 和 url 字段');
  }

  const id = path.basename(configDir);
  const bundleId = `com.electron.webapp.${id}`;
  const electronVersion = getElectronVersion();
  const platform = config.platform ?? process.platform;
  const arch = config.arch ?? os.arch();
  const outDir = path.resolve(configDir, '../../dist');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packager-'));
  try {
    const templateDir = path.join(import.meta.dirname, 'template');

    log.info(`准备应用模板: ${tmpDir}`);
    fs.cpSync(templateDir, tmpDir, { recursive: true });

    // app 版本号与 Electron 版本对齐
    const pkgPath = path.join(tmpDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = electronVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    fs.writeFileSync(
      path.join(tmpDir, 'app.json'),
      JSON.stringify({ name: config.name, url: config.url }),
    );

    let icon: string | undefined;
    const iconSrc = config.icon
      ? path.resolve(configDir, config.icon)
      : path.join(configDir, 'icon.png');
    if (fs.existsSync(iconSrc)) {
      if (platform === 'darwin' && iconSrc.endsWith('.png')) {
        icon = pngToIcns(iconSrc, tmpDir);
      } else {
        icon = iconSrc;
      }
    }

    log.info(`开始构建: ${config.name} (${id})`);
    const appPaths = await packager({
      dir: tmpDir,
      name: config.name,
      appBundleId: bundleId,
      electronVersion,
      platform: platform as any,
      arch: arch as any,
      out: outDir,
      overwrite: true,
      icon,
      download: ELECTRON_MIRROR
        ? { mirrorOptions: { mirror: ELECTRON_MIRROR } }
        : undefined,
    });

    // macOS: 写入中文本地化，让系统菜单显示中文
    if (platform === 'darwin') {
      for (const appPath of appPaths) {
        patchMacLocale(appPath, config.name);
      }
    }

    for (const p of appPaths) {
      log.ok(`输出: ${p}`);
    }
    return appPaths;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

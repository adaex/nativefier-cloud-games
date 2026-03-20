const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.chdir(__dirname);

const DIST_DIR = 'dist';
const APPLICATIONS_DIR = '/Applications';
const NPM_REGISTRY = 'https://registry.npmmirror.com';
const ARCH = os.arch() === 'x64' ? 'x64' : 'arm64';

const logInfo = msg => console.log(`\x1b[36m[INFO] ${msg}\x1b[0m`);
const logError = msg => console.error(`\x1b[31m[ERR ] ${msg}\x1b[0m`);
const logSuccess = msg => console.log(`\x1b[32m[ OK ] ${msg}\x1b[0m`);

// ---- 获取最新 Electron 版本 ----
logInfo('正在获取最新 Electron 版本...');
const electronVersion = execSync(`npm view electron version --registry ${NPM_REGISTRY}`, { encoding: 'utf8' }).trim();
logSuccess(`Electron 版本: ${electronVersion}`);

fs.mkdirSync(DIST_DIR, { recursive: true });

// ---- 构建单个应用 ----
function build(url, name, icon, menu) {
  logInfo(`开始构建: ${name}`);
  const outDir = path.join(DIST_DIR, name);
  fs.mkdirSync(outDir, { recursive: true });

  const result = spawnSync(
    'npx',
    [
      '--yes',
      'nativefier',
      url,
      outDir,
      '--name',
      name,
      '--icon',
      icon,
      '--bookmarks-menu',
      menu,
      '--platform',
      'darwin',
      '--arch',
      ARCH,
      '--electron-version',
      electronVersion,
      '--single-instance',
      '--fast-quit',
    ],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    logError(`构建失败: ${name}`);
    process.exit(result.status ?? 1);
  }
  logSuccess(`构建完成: ${name}`);
}

// ---- 复制到 /Applications ----
function install(name) {
  const appPath = execSync(`find ${DIST_DIR}/${name} -maxdepth 2 -type d -name "${name}.app"`, { encoding: 'utf8' }).trim();
  if (!appPath) {
    logError(`未找到 ${name}.app`);
    process.exit(1);
  }

  const dest = path.join(APPLICATIONS_DIR, `${name}.app`);
  spawnSync('rm', ['-rf', dest], { stdio: 'inherit' });
  spawnSync('cp', ['-R', appPath, APPLICATIONS_DIR + '/'], { stdio: 'inherit' });
  logSuccess(`已安装到 ${dest}`);
}

// ---- 执行 ----
build('https://www.migufun.com/middlepc/ucenter', 'MiGuFun', 'icons/migufun.icns', 'menus/migufan.json');
build('https://ys.mihoyo.com/cloud/#/', 'miHoYo', 'icons/mihoyo.icns', 'menus/mihoyo.json');

install('MiGuFun');
install('miHoYo');

logInfo('全部完成 ✅');

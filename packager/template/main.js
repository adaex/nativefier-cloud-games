const { app, BrowserWindow, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'),
);

app.commandLine.appendSwitch('lang', 'zh-CN');

// 每个 app 用独立 userData 目录（按 id 隔离），否则所有 app 共享同一份
// session/cookie/缓存，且单实例锁会跨 app 互斥。须在 requestSingleInstanceLock 前设置。
app.setPath('userData', path.join(app.getPath('appData'), `cloud-games-${config.id}`));

// 只允许单实例：云游戏站多开会争抢同一会话，第二个实例直接退出
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// 伪装成纯 Chrome：从默认 UA 剥掉 "Electron/x" 与 "<应用名>/x" 段，避免云游戏
// 站点按 UA 检测到非标准浏览器而降级或拒绝。不硬编码版本，随 Electron 升级自适应。
function cleanUserAgent() {
  const name = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // 名字入正则前转义元字符
  return app.userAgentFallback
    .replace(/ Electron\/\S+/, '')
    .replace(new RegExp(` ${name}\\/\\S+`), '');
}

// 主域（eTLD+1 近似）：will-navigate 用它判断「站内」。无 PSL，对 com.cn 等
// 常见复合 TLD 取后三段，其余取后两段。mihoyo.com 系登录域（passport.mihoyo.com
// 等）与主站同主域，不会被误判为外站。
const COMPOUND_TLDS = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.tw', 'co.jp', 'or.jp', 'co.uk', 'org.uk', 'com.au', 'com.br'];
function baseDomain(host) {
  const parts = host.split('.');
  const last2 = parts.slice(-2).join('.');
  const n = parts.length > 2 && COMPOUND_TLDS.includes(last2) ? 3 : 2;
  return parts.slice(-n).join('.');
}
const SITE_BASE = baseDomain(new URL(config.url).hostname);

// 全屏加载失败提示页（断网 / 站点 502 时不再白屏）
function showErrorPage(win, url, code, desc) {
  const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{height:100%;margin:0;background:#111;color:#eee;
    font:16px/1.6 -apple-system,system-ui,sans-serif}
  .box{height:100%;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:16px}
  code{color:#f88}
  button{padding:10px 24px;font-size:15px;border:0;border-radius:8px;
    background:#3a7afe;color:#fff;cursor:pointer}
</style>
<div class="box">
  <div>页面加载失败 <code>${desc || code}</code></div>
  <button onclick="location.href='${url}'">重试</button>
</div>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
    show: false, // 等 ready-to-show 再显示，消除先小窗后全屏的闪烁与白屏
    webPreferences: {
      // 显式声明默认安全项，防止未来误改；加载的是外部不可信页面
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const ua = cleanUserAgent();
  win.webContents.setUserAgent(ua);

  win.once('ready-to-show', () => win.show());

  // 弹窗 / window.open / target=_blank：一律交给系统浏览器。
  // 全屏窗口没有标签页与导航 UI，开在站内无法返回，故站内弹窗也不放行。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 页面内跳转：只允许留在同主域；跳外站交给系统浏览器，避免全屏窗口
  // 被困在没有返回手段的外部页面。畸形 URL 解析失败时放行，交 Chromium 处理
  win.webContents.on('will-navigate', (e, url) => {
    if (!/^https?:/.test(url)) return;
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    if (baseDomain(host) === SITE_BASE) return;
    e.preventDefault();
    shell.openExternal(url);
  });

  // data: 错误页自身失败不递归；-3 是主动取消，忽略
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || failedUrl.startsWith('data:')) return;
    showErrorPage(win, config.url, code, desc);
  });

  win.loadURL(config.url, { userAgent: ua });
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );

  createWindow();

  // 已有实例时再次启动：聚焦现有窗口
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

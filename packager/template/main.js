const { app, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'),
);

app.commandLine.appendSwitch('lang', 'zh-CN');

app.whenReady().then(() => {
  const { name } = config;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: name,
        submenu: [
          { label: `关于 ${name}`, role: 'about' },
          { type: 'separator' },
          { label: `隐藏 ${name}`, role: 'hide' },
          { label: '隐藏其他', role: 'hideOthers' },
          { label: '显示全部', role: 'unhide' },
          { type: 'separator' },
          { label: `退出 ${name}`, role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { label: '撤销', role: 'undo' },
          { label: '重做', role: 'redo' },
          { type: 'separator' },
          { label: '剪切', role: 'cut' },
          { label: '复制', role: 'copy' },
          { label: '粘贴', role: 'paste' },
          { label: '全选', role: 'selectAll' },
        ],
      },
      {
        label: '显示',
        submenu: [
          { label: '重新加载', role: 'reload' },
          { label: '强制重新加载', role: 'forceReload' },
          { type: 'separator' },
          { label: '实际大小', role: 'resetZoom' },
          { label: '放大', role: 'zoomIn' },
          { label: '缩小', role: 'zoomOut' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { label: '最小化', role: 'minimize' },
          { label: '缩放', role: 'zoom' },
          { type: 'separator' },
          { label: '前置全部窗口', role: 'front' },
          { type: 'separator' },
          { label: '关闭', role: 'close' },
        ],
      },
    ]),
  );

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: name,
  });
  win.setFullScreen(true);
  win.loadURL(config.url);
});

app.on('window-all-closed', () => {
  app.quit();
});

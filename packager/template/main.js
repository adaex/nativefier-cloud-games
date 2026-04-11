const { app, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'),
);

app.commandLine.appendSwitch('lang', 'zh-CN');

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );

  const win = new BrowserWindow();
  win.setFullScreen(true);
  win.loadURL(config.url);
});

app.on('window-all-closed', () => {
  app.quit();
});

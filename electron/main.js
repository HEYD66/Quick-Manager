'use strict';
/**
 * Quick 多账号管理器 — Electron 外壳
 * - 单实例（第二次启动会聚焦已有窗口）
 * - 托盘常驻，关窗最小化到托盘
 * - 自动拉起本地服务（node server.js），退出时按需收掉
 */
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

// 解析服务端目录（支持三种布局：开发目录 / 便携版 resources/app/server / 内嵌 server/）
const ROOT = (() => {
  const cands = [];
  if (process.env.QWM_ROOT) cands.push(process.env.QWM_ROOT);
  cands.push(path.join(__dirname, '..'));                                   // 开发：qwmgr/
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'app', 'server')); // 便携版
  cands.push(path.join(__dirname, 'server'));
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'server.js'))) return c; } catch (_) {}
  }
  return path.join(__dirname, '..');
})();
const PORT = Number(process.env.QWM_PORT || 9600);
const HOST = '127.0.0.1';
const URL_ = `http://${HOST}:${PORT}/`;
const ICON = path.join(__dirname, 'icon.png');
const TRAY_ICON = path.join(__dirname, 'tray.png');

let win = null;
let tray = null;
let serverChild = null;
let quitting = false;

// ---------- 服务管理 ----------
function probe(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(URL_ + 'api/health', { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function findNode() {
  const cands = [];
  if (process.env.QWM_NODE) cands.push(process.env.QWM_NODE);
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true });
    for (const line of String(out).split(/\r?\n/)) if (line.trim()) cands.push(line.trim());
  } catch (_) {}
  cands.push('C:\\Program Files\\nodejs\\node.exe');
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return 'node';
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ensureServer() {
  if (await probe()) return true;
  const node = findNode();
  // 清理可能残留的环境变量，避免把 Electron 当成 node 用
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  serverChild = spawn(node, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    windowsHide: true,
    stdio: 'ignore',
    env,
  });
  serverChild.on('exit', () => { serverChild = null; });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    if (await probe()) return true;
  }
  return false;
}

async function stopServer() {
  try {
    const tokenPath = path.join(ROOT, 'data', 'mgr-token.txt');
    const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '';
    if (token) {
      await new Promise((resolve) => {
        const req = http.request({
          hostname: HOST, port: PORT, path: '/api/shutdown', method: 'POST',
          headers: { 'x-qwm-token': token, 'content-type': 'application/json' },
          timeout: 2000,
        }, (res) => { res.resume(); resolve(); });
        req.on('error', resolve);
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end('{}');
      });
    }
  } catch (_) {}
  if (serverChild) {
    try { serverChild.kill(); } catch (_) {}
    serverChild = null;
  }
  await sleep(300);
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    show: true,
    backgroundColor: '#0d1017',
    title: 'Quick 家庭账号助手',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });

  const reveal = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  win.loadURL(URL_);

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (tray) tray.displayBalloon && tray.displayBalloon({
        title: 'Quick 家庭账号助手',
        content: '已最小化到托盘，双击图标可随时切回。',
      });
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('did-fail-load', async () => {
    const ok = await ensureServer();
    if (ok) win.loadURL(URL_);
  });
}

function buildTray() {
  const img = fs.existsSync(TRAY_ICON) ? nativeImage.createFromPath(TRAY_ICON) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Quick 家庭账号助手');
  const menu = Menu.buildFromTemplate([
    { label: '显示主界面', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: '重新加载页面', click: () => { if (win) win.reload(); } },
    {
      label: '重启本地服务',
      click: async () => {
        await stopServer();
        const ok = await ensureServer();
        if (win) win.reload();
        if (!ok) dialog.showErrorBox('启动失败', '本地服务未能启动，请检查 Node.js 环境');
      },
    },
    { type: 'separator' },
    { label: '在浏览器中打开', click: () => shell.openExternal(URL_) },
    { type: 'separator' },
    { label: '完全退出', click: async () => { quitting = true; await stopServer(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.local.quick-account-manager');
    Menu.setApplicationMenu(null);
    const ok = await ensureServer();
    createWindow();
    buildTray();
    if (!ok) {
      dialog.showErrorBox('本地服务未启动', '无法启动 http://' + HOST + ':' + PORT + '/，请检查 Node.js 是否可用，或查看 data/server.err.log');
    }
  });

  app.on('window-all-closed', () => { /* 保持托盘常驻 */ });

  app.on('before-quit', async () => {
    quitting = true;
    await stopServer();
  });
}

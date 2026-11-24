'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { handleResponses, openAIError } = require('./quick2api-responses');

const home = process.env.QWM_QUICK2API_HOME || (process.platform === 'win32' ? 'D:\\quick2api' : path.join(__dirname, '..', 'quick2api'));
const defaultPort = Number(process.env.QWM_QUICK2API_PORT || 8081);
if (!Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535) throw new Error('Invalid QWM_QUICK2API_PORT');
const configPath = path.join(home, 'config.json');
let port = configuredPort();
const executable = process.env.QWM_QUICK2API_EXE || path.join(home, 'source', 'bin',
  process.platform === 'win32' ? 'quickproxy-manager.exe' : 'quickproxy-manager');
let starting;
let restarting;
let openingLogin;

function configuredPort() {
  if (process.env.QWM_QUICK2API_PORT) return defaultPort;
  try {
    const address = JSON.parse(fs.readFileSync(configPath, 'utf8')).managed_addr;
    const match = /^127\.0\.0\.1:([0-9]+)$/.exec(address);
    const candidate = Number(match?.[1]);
    if (candidate > 0 && candidate < 65536) return candidate;
  } catch (_) {}
  return defaultPort;
}

function localBrowser(req, managerPort) {
  const hostname = req.headers.host || '';
  const validHost = ['127.0.0.1', '[::1]', 'localhost'].some(name =>
    hostname === `${name}:${managerPort}` || (managerPort === 80 && hostname === name));
  const localPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return validHost && localPeer && (!req.headers.origin || req.headers.origin === `http://${hostname}`);
}

function backendHealthy(target = port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${target}/admin/api/status`, {
      timeout: 1500, headers: { 'x-quickproxy-dashboard': '1' },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          const status = JSON.parse(body);
          resolve(res.statusCode === 200 && Array.isArray(status.models) && Array.isArray(status.accounts));
        }
        catch { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

async function openIsolatedLogin() {
  if (openingLogin) return openingLogin;
  openingLogin = launchLoginBrowser();
  try { await openingLogin; }
  finally { openingLogin = null; }
}

async function launchLoginBrowser() {
  const response = await fetch(`http://127.0.0.1:${port}/admin/api/login`, {
    headers: { 'x-quickproxy-dashboard': '1' }, redirect: 'error', signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error('无法读取 Quick2API 授权状态');
  const login = await response.json();
  if (login.status !== 'pending' || !login.url || login.manual) {
    throw new Error('请先生成本机授权链接');
  }
  const url = new URL(login.url);
  const allowedHost = /^(?:quick\.aws\.com|devtest\.quicksuite\.aws\.dev|(?:[a-z0-9-]+\.)?(?:quicksight\.aws\.amazon\.com|spaceneedle-(?:alpha|beta)\.amazon\.com))$/;
  const allowedPath = /^\/sn(?:\/start\/app-integrations\/quickwork-enterprise-login)?$/;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !allowedHost.test(url.hostname) || !allowedPath.test(url.pathname) ||
      !url.searchParams.get('qwSurface')?.startsWith('desktop:')) {
    throw new Error('授权链接不是受支持的 AWS Quick 登录入口');
  }

  const installDirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const supportedBrowsers = [
    { path: ['Microsoft', 'Edge', 'Application', 'msedge.exe'], mode: '--inprivate' },
    { path: ['Google', 'Chrome', 'Application', 'chrome.exe'], mode: '--incognito' },
  ];
  const browsers = supportedBrowsers.flatMap(browser => installDirs.map(dir => ({
    exe: path.join(dir, ...browser.path), mode: browser.mode,
  })));
  const browser = process.platform === 'win32' && browsers.find(candidate => fs.existsSync(candidate.exe));
  if (!browser) throw new Error('找不到 Edge 或 Chrome，请复制链接到新的隐私窗口');

  // Chromium reuses the private session within a profile. A new profile
  // keeps this authorization separate even when another private window is open.
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'quick-auth-'));
  function cleanProfile() {
    const actual = path.resolve(profile);
    if (path.dirname(actual) === tempRoot && path.basename(actual).startsWith('quick-auth-')) {
      fs.rm(actual, { recursive: true, force: true }, () => {});
    }
  }
  const child = spawn(browser.exe, [
    `--user-data-dir=${profile}`, browser.mode, '--no-first-run', '--no-default-browser-check', '--new-window', url.href,
  ], { detached: true, stdio: 'ignore' });
  child.once('exit', cleanProfile);
  try {
    await once(child, 'spawn');
  } catch (_) {
    cleanProfile();
    throw new Error('浏览器启动失败，请复制链接到新的隐私窗口');
  }
  child.unref();
}

async function startBackend(logDirectory) {
  if (restarting) return restarting;
  if (starting) return starting;
  starting = launchBackend(logDirectory, port);
  try { return await starting; }
  finally { starting = null; }
}

async function launchBackend(logDirectory, target) {
  if (await backendHealthy(target)) return true;
  if (!fs.existsSync(executable)) throw new Error('找不到 Quick2API 可执行文件');
  const log = fs.openSync(path.join(logDirectory, 'quick2api.log'), 'a');
  let failed = false;
  try {
    const child = spawn(executable, ['serve', '-dashboard', '-addr', `127.0.0.1:${target}`, '-config', configPath], {
      cwd: home, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    child.on('error', () => { failed = true; });
    child.on('exit', () => { failed = true; });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
  for (let attempt = 0; attempt < 24 && !failed; attempt++) {
    if (await backendHealthy(target)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Quick2API 未能启动，请检查 quick2api.log');
}

function portOpen(target) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: target });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
}

async function stopBackend(target) {
  if (!(await backendHealthy(target))) return;
  const response = await fetch(`http://127.0.0.1:${target}/admin/api/shutdown`, {
    method: 'POST', headers: { 'x-quickproxy-dashboard': '1' }, signal: AbortSignal.timeout(6000),
  });
  if (response.status !== 204) throw new Error('Quick2API 拒绝了重启请求');
  for (let attempt = 0; attempt < 25; attempt++) {
    if (!(await portOpen(target))) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Quick2API 尚未完成退出');
}

async function restartBackend(logDirectory) {
  if (restarting) return restarting;
  restarting = (async () => {
    if (starting) await starting;
    const next = configuredPort();
    if (next !== port) {
      if (await portOpen(next)) throw new Error(`端口 ${next} 已被占用`);
      await launchBackend(logDirectory, next);
      const previous = port;
      try {
        await stopBackend(previous);
      } catch (err) {
        await stopBackend(next).catch(() => {});
        throw err;
      }
      port = next;
    } else {
      await stopBackend(port);
      await launchBackend(logDirectory, port);
    }
    return true;
  })();
  try { return await restarting; }
  finally { restarting = null; }
}

function outboundHeaders(req, admin) {
  const headers = { host: `127.0.0.1:${port}` };
  for (const name of ['authorization', 'x-api-key', 'x-thread-id', 'content-type', 'content-length', 'accept',
    'access-control-request-method', 'access-control-request-headers']) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  if (admin && req.headers['x-quickproxy-dashboard'] === '1') headers['x-quickproxy-dashboard'] = '1';
  return headers;
}

function dashboardProxy(req, res, pathname, managerPort) {
  if (!localBrowser(req, managerPort)) {
    res.writeHead(403).end('本机访问限定');
    return;
  }
  if (pathname === '/quick2api') {
    res.writeHead(307, { location: '/quick2api/' }).end();
    return;
  }
  const asset = pathname.slice('/quick2api/'.length);
  if (!/^(?:|app\.js|app\.css|api\/(?:status|models|settings|advanced|usage|login(?:\/callback)?|accounts(?:\/(?:refresh|[0-9]+(?:\/refresh)?))?))$/.test(asset)) {
    res.writeHead(404).end();
    return;
  }
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  forward(req, res, `/admin/${asset}${query}`, true);
}

function forward(req, res, pathname, admin = false) {
  const upstream = http.request({ hostname: '127.0.0.1', port, path: pathname, method: req.method, headers: outboundHeaders(req, admin) }, incoming => {
    const headers = { ...incoming.headers };
    for (const name of ['connection', 'keep-alive', 'transfer-encoding']) delete headers[name];
    if (admin && headers['content-security-policy']) {
      headers['content-security-policy'] = headers['content-security-policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'");
    }
    res.writeHead(incoming.statusCode, headers);
    incoming.on('error', err => res.destroy(err));
    incoming.pipe(res);
  });
  res.on('close', () => upstream.destroy());
  upstream.setTimeout(15 * 60_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else openAIError(res, 503, 'quick2api_unavailable', 'Quick2API 后端无法连接');
  });
  req.pipe(upstream);
}

function apiProxy(req, res, pathname) {
  if (pathname === '/v1/responses' && req.method === 'POST') {
    return handleResponses(req, res, port, outboundHeaders(req, false));
  }
  if (pathname === '/v1/models' || pathname === '/v1/chat/completions' ||
    (pathname === '/v1/responses' && req.method === 'OPTIONS')) {
    return forward(req, res, pathname);
  }
  openAIError(res, 404, 'not_found', '此 API 路径不可用');
}

module.exports = { localBrowser, startBackend, restartBackend, openIsolatedLogin, backendHealthy, dashboardProxy, apiProxy };

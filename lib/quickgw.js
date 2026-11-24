'use strict';
/**
 * quickgw.js — 可选本地反代网关（awsquick-2api）适配层
 *
 * 目录解析顺序：
 *   1) 环境变量 QWM_QUICKGW_HOME
 *   2) 同级目录 ../awsquick-2api
 *   3) 项目内 ./quickgw
 *
 * 端口默认：
 *   面板 (Flask)  :8788   ── 账号池 / 密钥 / 调用账本 / 设置
 *   网关 (Node)   :3426   ── OpenAI 兼容 /v1/models /v1/chat/completions(流式)
 *
 * 环境变量：
 *   QWM_QUICKGW_HOME  反代项目根目录
 *   QWM_QUICKGW_PANEL 面板端口覆盖
 *   QWM_QUICKGW_GW    网关端口覆盖
 *   QWM_QUICKGW_AUTOSTART=0 关闭自动拉起
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { handleResponses, openAIError } = require('./quick2api-responses');

const HOME = (() => {
  if (process.env.QWM_QUICKGW_HOME) return process.env.QWM_QUICKGW_HOME;
  const sibling = path.resolve(__dirname, '..', '..', 'awsquick-2api');
  if (fs.existsSync(sibling)) return sibling;
  return path.join(__dirname, '..', 'quickgw');
})();

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); }
  catch (_) { return {}; }
}

function panelPort() {
  if (process.env.QWM_QUICKGW_PANEL) return Number(process.env.QWM_QUICKGW_PANEL);
  const cfg = readConfig();
  const p = Number(cfg?.panel?.port);
  return p > 0 && p < 65536 ? p : 8788;
}

function gatewayPort() {
  if (process.env.QWM_QUICKGW_GW) return Number(process.env.QWM_QUICKGW_GW);
  const cfg = readConfig();
  const p = Number(cfg?.gateway?.port);
  return p > 0 && p < 65536 ? p : 3426;
}

const PANEL_HOST = () => readConfig()?.panel?.host || '127.0.0.1';
const GW_HOST = () => readConfig()?.gateway?.host || '127.0.0.1';

// ---------- 底层 HTTP ----------
function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs || 5000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 4 * 1024 * 1024) req.destroy();
        });
        res.on('end', () => {
          try { finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(body) }); }
          catch (_) { finish({ ok: false, status: res.statusCode, raw: body.slice(0, 400) }); }
        });
        res.on('error', () => finish({ ok: false, error: 'stream_error' }));
      });
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: 'timeout' }); });
      req.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    } catch (e) { finish({ ok: false, error: e.code || e.message }); }
  });
}

function callJson(url, method, body, timeoutMs) {
  return new Promise((resolve) => {
    let payload = null;
    if (body !== undefined && body !== null) payload = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ 'content-type': 'application/json' },
        payload ? { 'content-length': payload.length } : {}),
      timeout: timeoutMs || 15000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw: raw.slice(0, 500) });
      });
      res.on('error', () => resolve({ ok: false, error: 'stream_error' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- 健康 ----------
async function gatewayHealth() {
  return getJson(`http://${GW_HOST()}:${gatewayPort()}/health`, 2500);
}
async function panelHealth() {
  return getJson(`http://${PANEL_HOST()}:${panelPort()}/api/config`, 2500);
}

async function healthy() {
  const h = await gatewayHealth();
  return !!h.ok;
}

/** 汇总给前端:网关 + 面板 + 账号池 + 成本 + 密钥,一次拿全 */
async function status() {
  const pp = panelPort(), gp = gatewayPort();
  const [health, accounts, usage, stats, keys, calls, pcfg, pstats] = await Promise.all([
    gatewayHealth(),
    getJson(`http://${GW_HOST()}:${gp}/accounts`, 15000),
    getJson(`http://${GW_HOST()}:${gp}/usage`, 20000),
    getJson(`http://${GW_HOST()}:${gp}/stats`, 6000),
    getJson(`http://${GW_HOST()}:${gp}/keys`, 6000),
    getJson(`http://${GW_HOST()}:${gp}/calls?limit=40`, 6000),
    panelHealth(),
    getJson(`http://${PANEL_HOST()}:${pp}/api/stats`, 6000),
  ]);

  const cfg = readConfig();
  const accList = (accounts.json && accounts.json.accounts) || [];
  const accCount = (accounts.json && accounts.json.count != null)
    ? accounts.json.count
    : ((health.json && health.json.accounts) || accList.length);
  return {
    ok: !!health.ok,
    home: HOME,
    panel: { port: pp, host: PANEL_HOST(), up: !!pcfg.ok, url: `http://${PANEL_HOST()}:${pp}/` },
    gateway: { port: gp, host: GW_HOST(), up: !!health.ok, url: `http://${GW_HOST()}:${gp}/v1` },
    models: (cfg?.gateway_behavior?.default_model ? [cfg.gateway_behavior.default_model] : []),
    behavior: cfg?.gateway_behavior || null,
    health: health.json || null,
    accounts: accList,
    accountCount: accCount,
    usage: (usage.json && usage.json.accounts) || [],
    stats: stats.json || null,
    keys: (keys.json && keys.json.keys) || [],
    calls: (calls.json && calls.json.calls) || [],
    panelStats: pstats.json || null,
    errors: {
      gateway: health.ok ? null : (health.error || health.status || 'down'),
      panel: pcfg.ok ? null : (pcfg.error || pcfg.status || 'down'),
      accounts: accounts.ok ? null : (accounts.error || accounts.status || 'failed'),
    },
  };
}

// ---------- 进程管理 ----------
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

function dataDirs() {
  const gatewayDir = path.join(HOME, 'data', 'oauth');
  const dataDir = path.join(HOME, 'data', 'gateway');
  for (const d of [gatewayDir, dataDir, path.join(HOME, 'data')]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  }
  return { gatewayDir, dataDir };
}

function pythonExe() {
  const candidates = [
    process.env.QWM_QUICKGW_PYTHON,
    path.join(HOME, '.venv', 'Scripts', 'python.exe'),
    path.join(HOME, '.venv', 'bin', 'python'),
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'python') return c;
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'python';
}

function nodeExe() {
  if (process.env.QWM_QUICKGW_NODE) return process.env.QWM_QUICKGW_NODE;
  return process.execPath && /node(\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : 'node';
}

function spawnDetached(exe, args, options) {
  const child = spawn(exe, args, Object.assign({ detached: true, windowsHide: true, stdio: 'ignore' }, options || {}));
  child.on('error', () => {});
  child.unref();
  return child;
}

let lastStart = null;

/**
 * 拉起整套栈。已监听就跳过,幂等。
 * @returns {Promise<{gateway:boolean, panel:boolean, skipped:string[]}>}
 */
async function startStack() {
  if (lastStart) return lastStart;
  lastStart = (async () => {
    const pp = panelPort(), gp = gatewayPort();
    const { gatewayDir, dataDir } = dataDirs();
    const skipped = [];
    const logDir = path.join(HOME, 'data');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}

    // 1) 网关
    let gwOk = await portOpen(gp);
    if (gwOk) skipped.push('gateway');
    else {
      const servePath = path.join(HOME, 'vendor', 'quick-gateway', 'bin', 'serve-oauth.mjs');
      if (!fs.existsSync(servePath)) throw new Error('找不到网关入口:' + servePath);
      spawnDetached(nodeExe(), ['bin/serve-oauth.mjs'], {
        cwd: path.join(HOME, 'vendor', 'quick-gateway'),
        env: Object.assign({}, process.env, {
          PORT: String(gp), HOST: '127.0.0.1',
          GATEWAY_DIR: gatewayDir, DATA_DIR: dataDir,
        }),
      });
      for (let i = 0; i < 40; i++) {
        if (await portOpen(gp)) { gwOk = true; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    // 2) 面板
    let pOk = await portOpen(pp);
    if (pOk) skipped.push('panel');
    else {
      const appPath = path.join(HOME, 'app.py');
      if (!fs.existsSync(appPath)) throw new Error('找不到面板入口:' + appPath);
      spawnDetached(pythonExe(), ['app.py'], {
        cwd: HOME,
        env: Object.assign({}, process.env, {
          PANEL_PORT: String(pp), GW_PORT: String(gp),
        }),
      });
      for (let i = 0; i < 60; i++) {
        if (await portOpen(pp)) { pOk = true; break; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return { gateway: gwOk, panel: pOk, skipped };
  })();
  try { return await lastStart; } finally { lastStart = null; }
}

/** 精确找出监听指定端口的 PID。
 *  绝不使用 findstr :port —— 那是子串匹配,:3426 会连 :13426 / :34260 一起命中,误杀无关进程。 */
function pidsListeningOn(port) {
  const { execSync } = require('node:child_process');
  const pids = new Set();
  let out = '';
  try {
    out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  } catch (_) { return pids; }
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // TCP  127.0.0.1:3426  0.0.0.0:0  LISTENING  66764
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue;
    if (cols[3].toUpperCase() !== 'LISTENING') continue;
    const local = cols[1];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    if (local.slice(idx + 1) !== String(port)) continue;   // 端口必须完全相等
    const pid = cols[4];
    if (/^\d+$/.test(pid) && Number(pid) > 0) pids.add(pid);
  }
  return pids;
}

/** 停掉监听这两个端口的进程(只认本机监听、端口精确相等) */
async function stopStack() {
  const ports = [gatewayPort(), panelPort()];
  const { execSync } = require('node:child_process');
  const stopped = [];
  for (const port of ports) {
    for (const pid of pidsListeningOn(port)) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, timeout: 8000 });
        stopped.push({ port, pid });
      } catch (_) {}
    }
  }
  return stopped;
}

// ---------- 登录(网关侧 OAuth) ----------
async function loginStart() {
  return callJson(`http://${GW_HOST()}:${gatewayPort()}/login`, 'POST', undefined, 40000);
}
async function loginSubmit(callbackUrl) {
  return callJson(`http://${GW_HOST()}:${gatewayPort()}/login/submit`, 'POST', { url: callbackUrl }, 120000);
}
async function loginStatus() {
  return getJson(`http://${GW_HOST()}:${gatewayPort()}/login/status`, 5000);
}

// ---------- 密钥 ----------
async function keysList() { return callJson(`http://${GW_HOST()}:${gatewayPort()}/keys`, 'GET'); }
async function keysNew(name) { return callJson(`http://${GW_HOST()}:${gatewayPort()}/keys`, 'POST', { name: name || 'default' }); }
async function keysDelete(kid) {
  return callJson(`http://${GW_HOST()}:${gatewayPort()}/keys/${encodeURIComponent(kid)}`, 'DELETE');
}

// ---------- 面板反代(可选,给前端同源访问用) ----------
// 只放行静态资源与已知只读 API;写操作必须带管理器令牌,且不把管理器的令牌继续往下游送。
const PANEL_STATIC = /^\/(?:shs-(?:regular|bold)\.woff2)?$/;
const PANEL_READ_API = /^\/api\/(?:config|stats|proxy|logs|tasks|pools|keys|otp|proxies|export\.csv)$/;

function panelProxy(req, res, pathname, token) {
  const sub = pathname.slice('/quickgw'.length) || '/';
  if ((sub === '' || sub === '/')) {
    const upstream = http.request({
      hostname: PANEL_HOST(), port: panelPort(), path: '/', method: 'GET',
      headers: { host: `${PANEL_HOST()}:${panelPort()}` },
    }, (inc) => {
      res.writeHead(inc.statusCode, { 'content-type': inc.headers['content-type'] || 'text/html; charset=utf-8' });
      inc.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); });
    return upstream.end();
  }
  const isStatic = PANEL_STATIC.test(sub);
  const isRead = req.method === 'GET' && PANEL_READ_API.test(sub);
  if (!isStatic && !isRead) {
    // 写操作(或非白名单路径)一律要求管理器令牌
    if (token !== req.headers['x-qwm-token']) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ ok: false, error: '本机管理请求未授权' }));
      return;
    }
    if (!isStatic && !/^\/api\/[a-z0-9._\-\/]*$/i.test(sub)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
  }
  const upstream = http.request({
    hostname: PANEL_HOST(), port: panelPort(), path: sub, method: req.method,
    headers: { host: `${PANEL_HOST()}:${panelPort()}`,
      'content-type': req.headers['content-type'] || 'application/json' },
  }, (inc) => {
    const headers = Object.assign({}, inc.headers);
    delete headers.connection;
    delete headers['transfer-encoding'];
    res.writeHead(inc.statusCode, headers);
    inc.pipe(res);
  });
  res.on('close', () => upstream.destroy());
  upstream.setTimeout(15 * 60_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ ok: false, error: 'quickgw_panel_unreachable' }));
  });
  req.pipe(upstream);
}

// ---------- /v1 代理 ----------
function outboundHeaders(req, target) {
  const headers = { host: `127.0.0.1:${target}` };
  for (const name of ['authorization', 'x-api-key', 'content-type', 'content-length', 'accept',
    'accept-encoding', 'user-agent', 'openai-beta']) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  return headers;
}

function forward(req, res, pathname) {
  const gp = gatewayPort();
  // 允许的查询串原样透传(/v1/models 之类通常没有,但保险)
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstream = http.request({
    hostname: GW_HOST(), port: gp, path: pathname + q, method: req.method,
    headers: outboundHeaders(req, gp),
  }, (inc) => {
    const headers = Object.assign({}, inc.headers);
    for (const name of ['connection', 'keep-alive', 'transfer-encoding']) delete headers[name];
    res.writeHead(inc.statusCode, headers);
    inc.on('error', (err) => res.destroy(err));
    inc.pipe(res);
  });
  res.on('close', () => upstream.destroy());
  upstream.setTimeout(15 * 60_000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else openAIError(res, 503, 'quickgw_unavailable', '新反代网关无法连接(127.0.0.1:' + gp + ')');
  });
  req.pipe(upstream);
}

/**
 * /v1/* 统一入口。
 * - /v1/responses → 用 quick2api-responses.js 转成 chat/completions 后再打网关
 * - /v1/models、/v1/chat/completions → 直通网关
 */
function apiProxy(req, res, pathname) {
  const gp = gatewayPort();
  if (pathname === '/v1/responses' && req.method === 'POST') {
    return handleResponses(req, res, gp, outboundHeaders(req, gp));
  }
  if (pathname === '/v1/models' || pathname === '/v1/chat/completions'
    || (pathname === '/v1/responses' && req.method === 'OPTIONS')) {
    return forward(req, res, pathname);
  }
  openAIError(res, 404, 'not_found', '此 API 路径不可用');
}

module.exports = {
  HOME, panelPort, gatewayPort, readConfig,
  healthy, gatewayHealth, panelHealth, status,
  startStack, stopStack, portOpen,
  loginStart, loginSubmit, loginStatus,
  keysList, keysNew, keysDelete,
  panelProxy, apiProxy,
};

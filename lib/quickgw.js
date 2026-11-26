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
const { createHash } = require('node:crypto');
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
async function status(desktopAccounts = []) {
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

  const stored = readOauthSessionsMeta(desktopAccounts);
  const byEmail = new Map(stored.list.map((x) => [String(x.email || '').toLowerCase(), x]));
  const byKey = new Map(stored.list.map((x) => [x.key, x]));

  const cfg = readConfig();
  const accList = ((accounts.json && accounts.json.accounts) || []).map((a) => {
    const meta = byEmail.get(String(a.email || '').toLowerCase()) || byKey.get(a.key);
    return {
      ...a,
      fullKey: meta ? meta.key : (a.key || ''),
      displayName: meta ? meta.displayName : (a.email || a.key || ''),
      authSource: meta ? meta.authSource : 'independent',
      paused: false,
    };
  });
  // 把已暂停的账号也附在列表尾部，方便用户在表格里随时点「启用」
  for (const p of stored.list) {
    if (!p.paused) continue;
    accList.push({
      key: p.key,
      fullKey: p.key,
      email: p.email,
      displayName: p.displayName,
      authSource: p.authSource,
      paused: true,
      dead: false,
      plan: '—',
      quota: null,
    });
  }
  const activeStoredCount = stored.list.filter((x) => !x.paused).length;
  const accCount = (accounts.json && accounts.json.count != null)
    ? accounts.json.count
    : ((health.json && health.json.accounts) || activeStoredCount);
  return {
    ok: !!health.ok,
    home: HOME,
    panel: { port: pp, host: PANEL_HOST(), up: !!pcfg.ok, url: `http://${PANEL_HOST()}:${pp}/` },
    gateway: { port: gp, host: GW_HOST(), up: !!health.ok, url: `http://${GW_HOST()}:${gp}/v1` },
    models: (cfg?.gateway_behavior?.default_model ? [cfg.gateway_behavior.default_model] : []),
    behavior: cfg?.gateway_behavior || null,
    health: health.json || null,
    accounts: accList,
    storedAccounts: stored.list,
    independentCount: stored.independentCount,
    sharedCount: stored.sharedCount,
    pausedCount: stored.pausedCount,
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

// ---------- 区分「独立反代登录」与「共享桌面凭据」及单号暂停/移除管理 ----------
function readJsonAccountsFile(file) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return { file, data: { ...parsed, accounts: (parsed.accounts && !Array.isArray(parsed.accounts)) ? { ...parsed.accounts } : {} } };
      }
    }
  } catch (_) {}
  return { file, data: { accounts: {} } };
}

function readOauthSessionsFile() {
  const { gatewayDir } = dataDirs();
  return readJsonAccountsFile(path.join(gatewayDir, 'oauth-sessions.json'));
}

function readPausedSessionsFile() {
  const { gatewayDir } = dataDirs();
  return readJsonAccountsFile(path.join(gatewayDir, 'oauth-sessions.paused.json'));
}

function writeAtomicJson(file, data, backupPrefix) {
  if (backupPrefix && fs.existsSync(file)) {
    const bak = path.join(path.dirname(file), `${backupPrefix}-${Date.now()}.json`);
    try { fs.copyFileSync(file, bak); } catch (_) {}
  }
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function classifyGatewayEntry(entry, desktopClientIdsByEmail) {
  if (!entry || typeof entry !== 'object') return 'independent';
  if (entry._qwm_source === 'desktop_shared') return 'desktop_shared';
  const email = String(entry.email || '').toLowerCase();
  const gwCid = String((entry.client && entry.client.client_id) || '').trim();
  const deskCid = email && desktopClientIdsByEmail ? desktopClientIdsByEmail.get(email) : '';
  if (gwCid && deskCid && gwCid === deskCid) return 'desktop_shared';
  return 'independent';
}

function readOauthSessionsMeta(desktopAccounts = []) {
  const { data: activeData } = readOauthSessionsFile();
  const { data: pausedData } = readPausedSessionsFile();
  const deskMap = new Map();
  for (const a of (desktopAccounts || [])) {
    if (a && a.email && a.clientId) deskMap.set(String(a.email).toLowerCase(), String(a.clientId).trim());
  }
  const list = [];
  let independentCount = 0;
  let sharedCount = 0;
  let pausedCount = 0;
  const pushAll = (accMap, paused) => {
    for (const [key, entry] of Object.entries(accMap || {})) {
      const authSource = classifyGatewayEntry(entry, deskMap);
      if (authSource === 'independent') independentCount += 1;
      else sharedCount += 1;
      if (paused) pausedCount += 1;
      list.push({
        key,
        email: entry.email || '',
        displayName: entry.display_name || entry.email || key,
        authSource,
        paused: !!paused,
      });
    }
  };
  pushAll(activeData.accounts, false);
  pushAll(pausedData.accounts, true);
  return { list, independentCount, sharedCount, pausedCount };
}

function keyForGatewaySession(email, tenantUrl, fallbackId) {
  const who = String(email || tenantUrl || fallbackId || '').trim();
  return 'oauth-' + createHash('sha256').update(who || String(Date.now())).digest('hex').slice(0, 16);
}

function buildGatewaySessionFromPoolAccount(acc) {
  const tenant = String(acc.tenantUrl || '').trim().replace(/\/+$/, '');
  if (!tenant) return null;
  let wsHost = '';
  try { wsHost = new URL(tenant).host; } catch (_) { return null; }
  const access = String(acc.access || '').trim();
  const refresh = String(acc.refresh || '').trim();
  const idToken = String(acc.idToken || acc.id_token || '').trim();
  const jwt = idToken || access;
  if (!jwt && !refresh) return null;

  const now = Math.floor(Date.now() / 1000);
  const expSec = acc.expiresAt
    ? (Number(acc.expiresAt) > 1e12 ? Math.floor(Number(acc.expiresAt) / 1000) : Math.floor(Number(acc.expiresAt)))
    : (now + 1800);
  const region = String(acc.region || acc.oidcRegion || 'us-east-1').trim() || 'us-east-1';
  const issuerUrl = String(acc.issuerUrl || '').trim();
  const email = String(acc.email || '').trim();
  const displayName = String(acc.displayName || acc.alias || email || acc.profileId || '').trim();

  return {
    provider: String(acc.providerType || 'social').toLowerCase(),
    stage: 'prod',
    _qwm_source: 'desktop_shared',
    tenant_url: tenant,
    ws_host: wsHost,
    jwt: jwt || '',
    actor_arn: acc.userArn || '',
    aws_account_id: acc.awsAccountId || '',
    account_name: acc.accountName || '',
    email,
    display_name: displayName,
    region,
    usable_until: expSec,
    obtained_at: now,
    user_info: {
      email,
      display_name: displayName,
      user_arn: acc.userArn || '',
      aws_account_id: acc.awsAccountId || '',
      account_name: acc.accountName || '',
    },
    tokens: {
      access_token: access,
      refresh_token: refresh,
      id_token: idToken,
      expires_in: Math.max(0, expSec - now),
    },
    client: {
      client_id: String(acc.clientId || '').trim(),
      client_secret: String(acc.clientSecret || '').trim(),
      idc_region: region,
      issuer_url: issuerUrl,
    },
    discovery: {
      issuer_url: issuerUrl,
      tenant_url: tenant,
      idc_region: region,
    },
  };
}

/**
 * 把 Quick Manager 账号池里的健康账号同步到 awsquick-2api/data/oauth/oauth-sessions.json。
 * 硬性保护：已在网关里「独立登录」的账号（client_id 与桌面不同）绝不覆盖！
 */
async function syncFromPool(accounts, { restart = true, overwriteIndependent = false } = {}) {
  const { gatewayDir } = dataDirs();
  const { file, data: existing } = readOauthSessionsFile();
  if (fs.existsSync(file)) {
    const bak = path.join(gatewayDir, 'oauth-sessions.backup-' + Date.now() + '.json');
    try { fs.copyFileSync(file, bak); } catch (_) {}
  }

  const deskMap = new Map();
  for (const a of (accounts || [])) {
    if (a && a.email && a.clientId) deskMap.set(String(a.email).toLowerCase(), String(a.clientId).trim());
  }

  const synced = [];
  const preservedIndependent = [];
  const skipped = [];
  for (const acc of (accounts || [])) {
    if (!acc || acc.needsRelogin) {
      if (acc) skipped.push({ label: acc.alias || acc.displayName || acc.email, reason: 'needs_relogin' });
      continue;
    }
    const sess = buildGatewaySessionFromPoolAccount(acc);
    if (!sess) {
      skipped.push({ label: acc.alias || acc.displayName || acc.email, reason: 'missing_credentials' });
      continue;
    }
    const key = keyForGatewaySession(sess.email, sess.tenant_url, acc.profileId || acc.id);
    const prev = existing.accounts[key];
    // 保护已有独立反代 OAuth 会话，绝不覆盖！
    if (prev && !overwriteIndependent && classifyGatewayEntry(prev, deskMap) === 'independent') {
      preservedIndependent.push({ key, email: sess.email, label: acc.alias || acc.displayName || sess.email });
      continue;
    }
    existing.accounts[key] = {
      ...(prev || {}),
      ...sess,
      _qwm_source: 'desktop_shared',
      user_info: { ...((prev && prev.user_info) || {}), ...(sess.user_info || {}) },
      discovery: { ...((prev && prev.discovery) || {}), ...(sess.discovery || {}) },
      tokens: {
        ...((prev && prev.tokens) || {}),
        ...sess.tokens,
        id_token: sess.tokens.id_token || (prev && prev.tokens && prev.tokens.id_token) || '',
      },
    };
    synced.push({ key, email: sess.email, label: acc.alias || acc.displayName || sess.email });
  }

  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf8');
  fs.renameSync(tmp, file);

  let stackResult = null;
  if (restart && (await portOpen(gatewayPort()))) {
    await stopStack().catch(() => {});
    stackResult = await startStack();
  }
  return {
    ok: true,
    file,
    syncedCount: synced.length,
    preservedIndependentCount: preservedIndependent.length,
    totalInGateway: Object.keys(existing.accounts).length,
    synced,
    preservedIndependent,
    skipped,
    stack: stackResult,
  };
}

/** 清除所有「共享桌面凭据」条目（含已暂停的），只保留「独立反代登录」的账号 */
async function clearDesktopShared(desktopAccounts = [], { restart = true } = {}) {
  const { file, data: existing } = readOauthSessionsFile();
  const { file: pausedFile, data: pausedData } = readPausedSessionsFile();
  const deskMap = new Map();
  for (const a of (desktopAccounts || [])) {
    if (a && a.email && a.clientId) deskMap.set(String(a.email).toLowerCase(), String(a.clientId).trim());
  }
  const removed = [];
  const kept = [];
  for (const [key, entry] of Object.entries(existing.accounts || {})) {
    if (classifyGatewayEntry(entry, deskMap) === 'desktop_shared') {
      removed.push({ key, email: entry.email || key });
      delete existing.accounts[key];
    } else {
      kept.push({ key, email: entry.email || key });
    }
  }
  for (const [key, entry] of Object.entries(pausedData.accounts || {})) {
    if (classifyGatewayEntry(entry, deskMap) === 'desktop_shared') {
      removed.push({ key, email: entry.email || key, paused: true });
      delete pausedData.accounts[key];
    } else {
      kept.push({ key, email: entry.email || key, paused: true });
    }
  }
  writeAtomicJson(file, existing, 'oauth-sessions.backup');
  writeAtomicJson(pausedFile, pausedData);

  let stackResult = null;
  if (restart && (await portOpen(gatewayPort()))) {
    await stopStack().catch(() => {});
    stackResult = await startStack();
  }
  return { ok: true, removedCount: removed.length, keptIndependentCount: kept.length, removed, kept, stack: stackResult };
}

/** 单号暂停 / 恢复参与反代轮询（无损挪动于 oauth-sessions.json 与 oauth-sessions.paused.json 之间） */
async function toggleAccountPaused(targetKey, pause, { restart = true } = {}) {
  const k = String(targetKey || '').trim();
  if (!k) throw new Error('缺少账号 key');
  const { file, data: activeData } = readOauthSessionsFile();
  const { file: pausedFile, data: pausedData } = readPausedSessionsFile();

  let changed = false;
  let email = '';
  if (pause) {
    const entry = activeData.accounts[k];
    if (!entry) throw new Error('未在活跃网关账号池中找到该账号');
    email = entry.email || k;
    pausedData.accounts[k] = entry;
    delete activeData.accounts[k];
    changed = true;
  } else {
    const entry = pausedData.accounts[k];
    if (!entry) throw new Error('未在暂停列表中找到该账号');
    email = entry.email || k;
    activeData.accounts[k] = entry;
    delete pausedData.accounts[k];
    changed = true;
  }

  if (changed) {
    writeAtomicJson(file, activeData, 'oauth-sessions.backup');
    writeAtomicJson(pausedFile, pausedData);
  }

  let stackResult = null;
  if (restart && (await portOpen(gatewayPort()))) {
    await stopStack().catch(() => {});
    stackResult = await startStack();
  }
  return { ok: true, key: k, email, paused: !!pause, stack: stackResult };
}

/** 仅从反代网关移除单个账号（绝不影响桌面端账号池） */
async function removeAccount(targetKey, { restart = true } = {}) {
  const k = String(targetKey || '').trim();
  if (!k) throw new Error('缺少账号 key');
  const { file, data: activeData } = readOauthSessionsFile();
  const { file: pausedFile, data: pausedData } = readPausedSessionsFile();

  const entry = activeData.accounts[k] || pausedData.accounts[k];
  if (!entry) throw new Error('网关中未找到该账号');
  const email = entry.email || k;
  delete activeData.accounts[k];
  delete pausedData.accounts[k];

  writeAtomicJson(file, activeData, 'oauth-sessions.backup');
  writeAtomicJson(pausedFile, pausedData);

  let stackResult = null;
  if (restart && (await portOpen(gatewayPort()))) {
    await stopStack().catch(() => {});
    stackResult = await startStack();
  }
  return { ok: true, key: k, email, stack: stackResult };
}

module.exports = {
  HOME, panelPort, gatewayPort, readConfig,
  healthy, gatewayHealth, panelHealth, status,
  startStack, stopStack, portOpen,
  syncFromPool, clearDesktopShared, toggleAccountPaused, removeAccount, readOauthSessionsMeta,
  loginStart, loginSubmit, loginStatus,
  keysList, keysNew, keysDelete,
  panelProxy, apiProxy,
};

#!/usr/bin/env node
/**
 * server.js — Quick 家庭账号助手（本地 Web 服务）
 * 启动：node server.js → http://127.0.0.1:9600
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const C = require('./lib/core');
const O = require('./lib/ops');
const Pool = require('./lib/pool');
const Conv = require('./lib/conversations');
const QuickBadge = require('./lib/quick-badge');
const quickgw = require('./lib/quickgw');
const quick2api = require('./lib/quick2api');

const PORT = Number(process.env.QWM_PORT || 9600);
const HOST = process.env.QWM_HOST || '127.0.0.1';
const WEB = path.join(__dirname, 'web');
const TOKEN = C.mgrToken();

let lastTurnSeen = 0;
let quickgwStartedByUs = false;

C.ensureDirs();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(b),
  });
  res.end(b);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', fin);
    req.on('error', fin);
    req.on('aborted', fin);
    setTimeout(fin, 5000);
  });
}

function authorized(req) {
  return (req.headers['x-qwm-token'] || '') === TOKEN;
}

function adminAuthorized(req) {
  const pin = req.headers['x-qwm-pin'] || '';
  return Pool.checkPin(pin);
}

// ---------- SSE ----------
const sseClients = new Set();

function sseSend(res, event, data) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (_) {}
}

function snapshot() {
  const acc = C.listAccounts();
  return {
    ts: Date.now(),
    ...acc,
    jobs: O.getJobs(),
    appRunning: Pool.isQuickRunning(),
    pool: Pool.listPoolView(),
  };
}

function broadcast() {
  if (!sseClients.size) return;
  const snap = snapshot();
  for (const res of sseClients) sseSend(res, 'snapshot', snap);
}

setInterval(broadcast, 4000).unref();

// ---------- 后台静默额度刷新（每 10 分钟刷一次空闲池，避免过于频繁请求云端） ----------
setInterval(() => {
  const view = Pool.listPoolView();
  if (!view.accounts.length) return;
  Pool.refreshAllQuotas().then(broadcast).catch(() => {});
}, 10 * 60 * 1000).unref();

// ---------- 后台自动附着 AWS Quick 9222 调试端口（在每条回复下方展示实际模型） ----------
async function tryAttachQuickBadge() {
  const store = Pool.loadStore();
  if (store.cdpModelBadge === false) return { ok: false, skipped: true };
  const activeId = store.activeAccountId || null;
  const entries = activeId ? Conv.collectUsageEntriesForAccount(activeId, 15) : [];
  return QuickBadge.attachAndSync(entries);
}

setInterval(() => {
  tryAttachQuickBadge().catch(() => {});
}, 6000).unref();

// ---------- HTTP 路由 ----------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const p = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams.entries());

  try {
    // ===== /v1 OpenAI 兼容反代（修复 legacy 开关优先级） =====
    if (p === '/v1' || p.startsWith('/v1/')) {
      if (process.env.QWM_LEGACY_QUICK2API === '1') {
        return await quick2api.apiProxy(req, res, p);
      }
      return await quickgw.apiProxy(req, res, p);
    }

    if (p === '/quickgw' || p.startsWith('/quickgw/')) {
      if (!quick2api.localBrowser(req, PORT)) {
        return json(res, 403, { ok: false, error: '请在本机管理器中访问' });
      }
      return quickgw.panelProxy(req, res, p, TOKEN);
    }

    if (p === '/api/quickgw' && req.method === 'GET') {
      return json(res, 200, await quickgw.status(Pool.loadStore().accounts));
    }

    if (['/api/quickgw/start', '/api/quickgw/stop', '/api/quickgw/restart',
      '/api/quickgw/sync-pool', '/api/quickgw/clear-shared',
      '/api/quickgw/account/toggle', '/api/quickgw/account/remove',
      '/api/quickgw/login', '/api/quickgw/login/submit', '/api/quickgw/login/status',
      '/api/quickgw/keys', '/api/quickgw/keys/delete'].includes(p)) {
      if (!quick2api.localBrowser(req, PORT) || !authorized(req)) {
        return json(res, 403, { ok: false, error: '本机管理请求未授权' });
      }
      if (!adminAuthorized(req)) return json(res, 403, { ok: false, error: '需要管理员密码' });
      let body = {};
      if (req.method !== 'GET') {
        const raw = await readBody(req);
        if (raw) { try { body = JSON.parse(raw); } catch (_) { return json(res, 400, { ok: false, error: 'bad_json' }); } }
      }
      try {
        if (p === '/api/quickgw/start') {
          const result = await quickgw.startStack();
          if (result && (result.gateway || result.panel) && (!result.skipped || result.skipped.length < 2)) {
            quickgwStartedByUs = true;
          }
          return json(res, 200, { ok: true, result });
        }
        if (p === '/api/quickgw/stop') {
          const stopped = await quickgw.stopStack();
          quickgwStartedByUs = false;
          return json(res, 200, { ok: true, stopped });
        }
        if (p === '/api/quickgw/restart') {
          const stopped = await quickgw.stopStack();
          const result = await quickgw.startStack();
          quickgwStartedByUs = true;
          return json(res, 200, { ok: true, stopped, result });
        }
        if (p === '/api/quickgw/sync-pool') {
          await Pool.syncFromDesktop({ includeExisting: false }).catch(() => {});
          const store = Pool.loadStore();
          const ids = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids) : null;
          const list = ids ? store.accounts.filter((a) => ids.has(a.id) || ids.has(a.profileId)) : store.accounts;
          const result = await quickgw.syncFromPool(list, { restart: body.restart !== false });
          if (result && result.stack && (result.stack.gateway || result.stack.panel)) quickgwStartedByUs = true;
          return json(res, 200, result);
        }
        if (p === '/api/quickgw/clear-shared') {
          const store = Pool.loadStore();
          const result = await quickgw.clearDesktopShared(store.accounts, { restart: body.restart !== false });
          return json(res, 200, result);
        }
        if (p === '/api/quickgw/account/toggle') {
          const result = await quickgw.toggleAccountPaused(body.key, !!body.paused, { restart: body.restart !== false });
          return json(res, 200, result);
        }
        if (p === '/api/quickgw/account/remove') {
          const result = await quickgw.removeAccount(body.key, { restart: body.restart !== false });
          return json(res, 200, result);
        }
        if (p === '/api/quickgw/login') {
          if (!(await quickgw.portOpen(quickgw.gatewayPort()))) {
            await quickgw.startStack();
            quickgwStartedByUs = true;
          }
          const r = await quickgw.loginStart();
          return json(res, r.ok ? 200 : 502, r.json || r);
        }
        if (p === '/api/quickgw/login/status') {
          const r = await quickgw.loginStatus();
          return json(res, r.ok ? 200 : 502, r.json || r);
        }
        if (p === '/api/quickgw/login/submit') {
          if (!body.url) return json(res, 400, { ok: false, error: 'missing_url' });
          const r = await quickgw.loginSubmit(String(body.url));
          return json(res, r.ok ? 200 : 502, r.json || r);
        }
        if (p === '/api/quickgw/keys') {
          if (req.method === 'GET') return json(res, 200, (await quickgw.keysList()).json || {});
          const r = await quickgw.keysNew(body.name);
          return json(res, r.ok ? 200 : 502, r.json || r);
        }
        if (p === '/api/quickgw/keys/delete') {
          if (!body.id) return json(res, 400, { ok: false, error: 'missing_id' });
          const r = await quickgw.keysDelete(body.id);
          return json(res, r.ok ? 200 : 502, r.json || r);
        }
      } catch (err) {
        return json(res, 500, { ok: false, error: String(err.message || err) });
      }
      return json(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    // ===== 静态资源 =====
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
      html = html.replace(/__QWM_TOKEN_VALUE__/g, TOKEN);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && (p === '/app.css' || p === '/app.js')) {
      const file = path.join(WEB, p.slice(1));
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(body);
    }

    // ===== SSE =====
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      sseSend(res, 'snapshot', snapshot());
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ===== 只读 API =====
    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, { ok: true, pid: process.pid, uptime: process.uptime(), tokenFile: C.TOKEN_FILE });
    }

    if (req.method === 'GET' && p === '/api/pool') {
      return json(res, 200, { ok: true, ...Pool.listPoolView() });
    }

    if (req.method === 'GET' && p === '/api/pool/skills') {
      return json(res, 200, await Pool.listAccountSkills(query.id || null));
    }

    if (req.method === 'GET' && p === '/api/cdp/status') {
      return json(res, 200, { ok: true, cdp: QuickBadge.getStatus() });
    }

    if (req.method === 'GET' && p === '/api/cdp/inspect') {
      return json(res, 200, await QuickBadge.inspectDom());
    }

    if (req.method === 'GET' && p === '/api/pool/oauth/status') {
      return json(res, 200, { ok: true, oauth: Pool.getOAuthStatus() });
    }

    if (req.method === 'GET' && p === '/api/conversations') {
      return json(res, 200, Conv.listLocalConversations({
        accountId: query.accountId || '',
        query: query.q || '',
      }));
    }

    if (req.method === 'GET' && p === '/api/conversations/detail') {
      if (!query.accountId || !query.sessionId) {
        return json(res, 400, { ok: false, error: 'missing_params' });
      }
      const doc = Conv.getLocalConversation(query.accountId, query.sessionId);
      if (!doc) return json(res, 404, { ok: false, error: 'conversation_not_found' });
      return json(res, 200, { ok: true, conversation: doc });
    }

    if (req.method === 'GET' && p === '/api/accounts') {
      return json(res, 200, snapshot());
    }

    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/accounts\/([^/]+)\/quota$/))) {
      const id = decodeURIComponent(m[1]);
      if (query.refresh === '1') {
        // 优先走直连云端额度查询，兜底旧 relay
        const r = await Pool.refreshAccountQuota(id);
        if (r.ok) return json(res, 200, r.quota);
        const q = await C.fetchQuota(id);
        return json(res, 200, q.ok ? q : { ok: false, reason: r.error || q.reason, message: r.error || q.message });
      }
      const cache = C.readQuotaCache();
      return json(res, 200, cache[id] || { ok: false, reason: 'no_cache' });
    }

    if (req.method === 'GET' && (m = p.match(/^\/api\/accounts\/([^/]+)\/configs$/))) {
      return json(res, 200, O.readConfigs(decodeURIComponent(m[1])));
    }

    if (req.method === 'GET' && (m = p.match(/^\/api\/accounts\/([^/]+)\/sessions$/))) {
      return json(res, 200, { ok: true, sessions: C.listSessions(decodeURIComponent(m[1]), Number(query.limit) || 200) });
    }

    if (req.method === 'GET' && p === '/api/quota/series') {
      return json(res, 200, { ok: true, points: C.usageSeries(query.id || null, Number(query.days) || 7) });
    }

    if (req.method === 'GET' && p === '/api/jobs') {
      return json(res, 200, { ok: true, jobs: O.getJobs() });
    }

    if (req.method === 'GET' && p === '/api/relay') {
      return json(res, 200, await O.relayStatus());
    }

    if (req.method === 'GET' && p === '/api/relay/token') {
      const t = O.relayToken();
      return json(res, 200, { ok: !!t, token: t });
    }

    if (req.method === 'GET' && p === '/api/token-history') {
      return json(res, 200, C.tokenHistory());
    }

    if (req.method === 'GET' && p === '/api/tokens') {
      const r = await C.httpGetJson(C.RELAY_BASE + '/usage', 4000).catch(() => null);
      const stats = (r && r.stats) ? r.stats : null;
      if (stats && stats.lastAt && stats.lastAt !== lastTurnSeen) {
        lastTurnSeen = stats.lastAt;
        C.appendJsonl(path.join(C.DATA, 'turn-stats.jsonl'), Object.assign({ ts: Date.now() }, stats));
      }
      return json(res, 200, { ok: !!stats, stats });
    }

    if (req.method === 'GET' && p === '/api/import/scan') {
      return json(res, 200, O.scanProfiles());
    }

    if (req.method === 'GET' && p === '/api/config') {
      return json(res, 200, { ok: true, config: C.getConfig() });
    }

    if (req.method === 'GET' && p === '/api/mcp/test') {
      if (!query.url) return json(res, 400, { ok: false, error: 'missing_url' });
      return json(res, 200, await O.mcpTest(query.url));
    }

    if (req.method === 'GET' && p === '/api/logs') {
      return json(res, 200, { ok: true, logs: O.listLogs() });
    }

    if (req.method === 'GET' && p === '/api/logs/tail') {
      return json(res, 200, O.tailLog(query.name, Number(query.n) || 200, query.level || null));
    }

    if (req.method === 'GET' && p === '/api/backups') {
      return json(res, 200, { ok: true, backups: O.listBackups() });
    }

    if (req.method === 'GET' && p === '/api/audit') {
      return json(res, 200, { ok: true, lines: C.tailLines(C.AUDIT_FILE, 300).reverse() });
    }

    // ===== 写操作（需本地 token） =====
    if (req.method !== 'GET') {
      if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const raw = await readBody(req);
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch (_) { return json(res, 400, { ok: false, error: 'bad_json' }); } }

      // ---------- 家人可直接操作的安全接口（免 PIN） ----------
      if (p === '/api/pool/claim') {
        const r = await Pool.claimIdleAccount({
          excludeCurrent: body.excludeCurrent !== false,
          userName: body.userName,
        });
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/switch') {
        const r = await Pool.switchToAccount(body.id, { userName: body.userName, launch: body.launch !== false });
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/open-quick') {
        const r = Pool.focusOrLaunchQuick();
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/user') {
        const s = Pool.setFamilySettings({ currentUserLabel: body.userName || '' });
        broadcast();
        return json(res, 200, { ok: true, currentUserLabel: s.currentUserLabel });
      }

      if (p === '/api/conversations/sync') {
        const store = Pool.loadStore();
        const r = await Conv.syncAllAccounts(store.accounts, {
          accountId: body.accountId || null,
          force: !!body.force,
          isQuickRunning: Pool.isQuickRunning,
          onPersist: (accId, next) => {
            const cur = Pool.loadStore();
            const i = cur.accounts.findIndex((a) => a.id === accId);
            if (i >= 0) {
              cur.accounts[i] = { ...cur.accounts[i], ...next, updatedAt: Date.now() };
              Pool.saveStore(cur);
            }
          },
        });
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/conversations/open-dir') {
        return json(res, 200, Conv.openArchiveFolder());
      }

      if (p === '/api/admin/pin/verify') {
        const ok = Pool.checkPin(body.pin || '');
        return json(res, ok ? 200 : 403, { ok, error: ok ? null : '管理员密码不正确' });
      }

      if (p === '/api/shutdown') {
        json(res, 200, { ok: true, bye: true });
        if (quickgwStartedByUs) {
          quickgw.stopStack().catch(() => {}).finally(() => setTimeout(() => process.exit(0), 120));
        } else {
          setTimeout(() => process.exit(0), 120);
        }
        return;
      }

      // ---------- 管理员维护接口（若设了 PIN 则需通过 x-qwm-pin 校验） ----------
      const isPoolAdminRoute = p.startsWith('/api/pool/') || p.startsWith('/api/admin/');
      if (isPoolAdminRoute && !adminAuthorized(req)) {
        return json(res, 403, { ok: false, error: '需要管理员密码验证' });
      }

      if (p === '/api/admin/pin') {
        const r = Pool.setAdminPin(body.newPin, body.currentPin);
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      if (p === '/api/admin/settings') {
        const s = Pool.setFamilySettings(body);
        broadcast();
        return json(res, 200, {
          ok: true,
          familyUsers: s.familyUsers,
          quickgwAutostart: s.quickgwAutostart,
          autoSyncConversationsOnSwitch: s.autoSyncConversationsOnSwitch !== false,
          autoCopyHandoffOnSwitch: s.autoCopyHandoffOnSwitch !== false,
          cdpModelBadge: s.cdpModelBadge !== false,
          autoGrantFullAccess: s.autoGrantFullAccess !== false,
          autoPruneSkills: s.autoPruneSkills !== false,
          autoSetZhCn: s.autoSetZhCn !== false,
          commonTemplate: s.commonTemplate,
        });
      }

      if (p === '/api/pool/sync-desktop') {
        const r = await Pool.syncFromDesktop({ includeExisting: !!body.includeExisting });
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/refresh-quota') {
        const r = body.id ? await Pool.refreshAccountQuota(body.id) : await Pool.refreshAllQuotas();
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/probe') {
        if (body.id) {
          const r = await Pool.probeAccountHealth(body.id);
          broadcast();
          return json(res, 200, r);
        }
        const store = Pool.loadStore();
        const results = [];
        for (const a of store.accounts) {
          results.push(await Pool.probeAccountHealth(a.id));
        }
        broadcast();
        return json(res, 200, {
          ok: true,
          total: results.length,
          alive: results.filter((x) => x.alive).length,
          results,
        });
      }

      if (p === '/api/pool/oauth/start') {
        const st = await Pool.startOAuth({
          provider: body.provider || 'social',
          remote: !!body.remote,
          accountId: body.accountId || null,
        });
        broadcast();
        return json(res, 200, { ok: true, oauth: st });
      }

      if (p === '/api/pool/oauth/submit') {
        const r = await Pool.submitOAuthCallback(body.url);
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/oauth/cancel') {
        const r = Pool.cancelOAuth();
        broadcast();
        return json(res, 200, { ok: true, ...r });
      }

      if (p === '/api/pool/import-json') {
        const r = await Pool.importCredentialsJson(body.text);
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/blank-login/start') {
        const r = await Pool.startDesktopBlankLogin();
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/blank-login/cancel') {
        const r = await Pool.cancelDesktopBlankLogin();
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/template/save') {
        const r = Pool.saveCommonTemplate(body.id);
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/template/apply') {
        const r = Pool.applyCommonTemplateToAll();
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/local-tools') {
        const r = await Pool.setLocalToolsAccess({
          enabled: body.enabled !== false,
          autoAllowTools: body.autoAllowTools !== false,
          restartQuick: !!body.restartQuick,
          accountId: body.accountId || null,
        });
        broadcast();
        return json(res, 200, r);
      }

      if (p === '/api/pool/skills/batch') {
        const r = await Pool.batchToggleBundledSkills({
          accountId: body.accountId || null,
          enabled: !!body.enabled,
          keepIds: Array.isArray(body.keepIds) ? body.keepIds : ['acp_agents'],
        });
        return json(res, 200, r);
      }

      if (p === '/api/pool/skills/toggle') {
        const r = await Pool.toggleSingleSkill(body.accountId, body.skillId, !!body.enabled);
        return json(res, 200, r);
      }

      if (p === '/api/pool/locale') {
        const r = await Pool.setAccountsLocale({
          accountId: body.accountId || null,
          locale: body.locale || 'zh-CN',
          timezone: body.timezone || 'Asia/Shanghai',
        });
        return json(res, 200, r);
      }

      if (p === '/api/cdp/attach') {
        const r = await tryAttachQuickBadge();
        return json(res, 200, r);
      }

      if (p === '/api/cdp/restart-quick') {
        Pool.setFamilySettings({ cdpModelBadge: true });
        const r = await Pool.restartQuickWithCdp();
        broadcast();
        return json(res, 200, r);
      }

      if (req.method === 'POST' && (m = p.match(/^\/api\/pool\/account\/([^/]+)\/meta$/))) {
        const acc = Pool.updateAccountMeta(decodeURIComponent(m[1]), body);
        broadcast();
        return json(res, 200, { ok: true, account: acc });
      }

      if (req.method === 'POST' && (m = p.match(/^\/api\/pool\/account\/([^/]+)\/export$/))) {
        const data = Pool.exportAccountJson(decodeURIComponent(m[1]));
        return json(res, 200, { ok: true, data });
      }

      if (req.method === 'DELETE' && (m = p.match(/^\/api\/pool\/account\/([^/]+)$/))) {
        if (!body.confirm) return json(res, 400, { ok: false, error: 'confirm_required' });
        const r = await Pool.removeAccountSafely(decodeURIComponent(m[1]));
        broadcast();
        return json(res, 200, r);
      }

      // ---------- 兼容既有接口（保证 selftest.js 与运维工具可用） ----------
      if (p === '/api/config') {
        const cfg = C.setConfig(body);
        broadcast();
        return json(res, 200, { ok: true, config: cfg });
      }

      if (p === '/api/switch') {
        const job = await O.switchAccount(body.id, { force: !!body.force });
        return json(res, 200, { ok: true, job });
      }

      if (p === '/api/mcp/save') {
        return json(res, 200, O.saveMcpConfig(body.id, body.servers));
      }

      if (p === '/api/configs/clone') {
        const job = O.cloneConfigs(body.from, body.to, body.keys);
        return json(res, 200, { ok: true, job });
      }

      if (p === '/api/backup') {
        const dir = C.profileDir(body.id);
        if (!dir) return json(res, 404, { ok: false, error: 'account_not_found' });
        const file = O.backupDir(dir, body.id);
        C.audit('backup', { id: body.id, file });
        return json(res, 200, { ok: true, file });
      }

      if (p === '/api/restore') {
        const job = O.restoreBackup(body.file, body.id);
        return json(res, 200, { ok: true, job });
      }

      if (p === '/api/cache/purge') {
        const job = O.purgeCache(body.id, body.scopes);
        return json(res, 200, { ok: true, job });
      }

      if (p === '/api/quota/refresh') {
        const r = await Pool.refreshAccountQuota(body.id);
        broadcast();
        return json(res, 200, r.ok ? r.quota : r);
      }

      if (p === '/api/relay/start') {
        const job = O.startRelay(body.mute !== false);
        return json(res, 200, { ok: true, job });
      }

      if (p === '/api/telemetry') {
        const cfg = C.setConfig({ telemetryMute: !!body.enabled });
        const job = O.startRelay(!!body.enabled);
        return json(res, 200, { ok: true, config: cfg, job });
      }

      if (p === '/api/quickbar') {
        const r = await O.showStatusBar();
        return json(res, r.ok ? 200 : 500, r);
      }
    }

    return json(res, 404, { ok: false, error: 'not_found', path: p });
  } catch (e) {
    return json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('[qwmgr] listening http://' + HOST + ':' + PORT);
  console.log('[qwmgr] token file:', C.TOKEN_FILE);
  console.log('[qwmgr] profiles:', C.PROFILES_JSON);

  // 启动时自动从桌面端采集已有账号并刷新一次真实云端额度
  Pool.syncFromDesktop({ includeExisting: false })
    .then((r) => {
      console.log('[qwmgr] pool synced:', JSON.stringify(r));
      broadcast();
      return Pool.refreshAllQuotas();
    })
    .then((r) => {
      console.log('[qwmgr] initial quota refresh:', r.refreshed + '/' + r.total);
      broadcast();
    })
    .catch((err) => console.warn('[qwmgr] initial pool sync warn:', err.message));

  // API 反代栈仅在用户明确启用自启时才随软件拉起，避免拖慢家人日常使用
  const store = Pool.loadStore();
  const autoStartGw = process.env.QWM_QUICKGW_AUTOSTART === '1' || store.quickgwAutostart === true;
  if (autoStartGw && process.env.QWM_QUICKGW_AUTOSTART !== '0') {
    quickgw.startStack()
      .then((r) => {
        if (r && (!r.skipped || r.skipped.length < 2)) quickgwStartedByUs = true;
        console.log('[qwmgr] quickgw:', JSON.stringify(r));
      })
      .catch((err) => console.warn('[qwmgr] quickgw:', err.message));
  }
});

process.on('uncaughtException', (e) => console.error('[qwmgr] uncaught', e));
process.on('unhandledRejection', (e) => console.error('[qwmgr] unhandled', e));

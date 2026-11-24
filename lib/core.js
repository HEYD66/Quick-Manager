/**
* core.js — 数据层：路径、原子读写、账号聚合、额度缓存、健康判定 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const HOME = process.env.USERPROFILE || os.homedir();
const QW = path.join(HOME, '.quickwork');
const PROFILES_JSON = path.join(QW, 'profiles.json');
const PROFILES_DIR = path.join(QW, 'profiles');
const LOCAL = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'quickwork');
const LOGS_DIR = path.join(LOCAL, 'logs');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

/** 外部脚本目录（注入/relay 等）：支持新布局 ROOT\tools 与旧布局 ..\tools */
const TOOLS = (() => {
  const cands = [];
  if (process.env.QWM_TOOLS) cands.push(process.env.QWM_TOOLS);
  cands.push(path.join(ROOT, 'tools'));
  cands.push(path.join(ROOT, '..', 'tools'));
  for (const c of cands) { try { if (fs.existsSync(path.join(c, 'renderer-eval.js'))) return c; } catch (_) {} }
  return cands[1];
})();
const BACKUPS = path.join(DATA, 'backups');
const META_FILE = path.join(DATA, 'accounts.meta.json');
const IDENTITY_FILE = path.join(DATA, 'identity.json');
const QUOTA_CACHE = path.join(DATA, 'quota-cache.json');
const QUOTA_HISTORY = path.join(DATA, 'quota-history.jsonl');
const AUDIT_FILE = path.join(DATA, 'audit.jsonl');
const TOKEN_FILE = path.join(DATA, 'mgr-token.txt');
const RELAY_BASE = process.env.QWM_RELAY || 'http://127.0.0.1:9400';
const CDP_PORT = Number(process.env.QWM_CDP || 9229);
const APP_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'quickwork', 'Amazon Quick.exe');

function ensureDirs() {
  for (const d of [DATA, BACKUPS]) fs.mkdirSync(d, { recursive: true });
}

// ---------- 基础工具 ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

/** 原子写：临时文件 + rename（Windows 下同名 rename 是原子的） */
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function appendJsonl(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch (_) {}
}

function tailLines(file, n) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch (_) { return []; }
}

function audit(action, detail) {
  appendJsonl(AUDIT_FILE, { ts: Date.now(), action, detail: detail || null });
}

// ---------- 本地访问令牌 ----------
function mgrToken() {
  ensureDirs();
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}
  const t = crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

// ---------- profiles.json ----------
function readProfiles() {
  const j = readJson(PROFILES_JSON, null);
  if (!j || !Array.isArray(j.entries)) return { version: 1, entries: [], last_active: null, _missing: !j };
  return j;
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** 用于「读-改-写」：客户端可能正在写 profiles.json，读不到就重试；
 *  始终读不到时直接抛错，绝不拿空壳对象去覆盖客户端的文件。 */
function readProfilesStrict(retries = 6) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(PROFILES_JSON, 'utf8'));
      if (j && typeof j === 'object' && Array.isArray(j.entries)) return j;
      lastErr = new Error('bad_shape');
    } catch (e) { lastErr = e; }
    sleepSync(150);
  }
  const err = new Error('profiles_unreadable');
  err.cause = lastErr;
  throw err;
}

/** 客户端隔离掉的坏文件数量（.profiles.json.corrupt-*），用来发现「写进去被客户端拒收」 */
function countQuarantined() {
  try { return fs.readdirSync(QW).filter((f) => f.indexOf('.profiles.json.corrupt-') === 0).length; } catch (_) { return 0; }
}

/** 本机凭据管理器里是否有该账号的登录凭据（只看条目名，不读取内容） */
function hasCredential(id) {
  try {
    const out = require('child_process').execSync('cmdkey /list', { encoding: 'latin1', windowsHide: true, timeout: 8000 });
    return out.split(/\r?\n/).some((l) => /target=/i.test(l) && !/target=session@/i.test(l) && l.indexOf(id) >= 0);
  } catch (_) { return null; } // 查不到就返回 null（未知），不要误判
}

/** 原子写 profiles.json，写前备份 */
/** 校验 + 规范化：应用端对 profiles.json 很严格（data_path 必须是正斜杠），
 *  写之前统一处理，任何不合规都直接抛错而不是写坏文件。 */
function normalizeProfiles(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.entries)) throw new Error('profiles_invalid_shape');
  p.version = p.version || 1;
  const seen = new Set();
  for (const e of p.entries) {
    if (!e || typeof e !== 'object') throw new Error('profiles_entry_invalid');
    if (!e.id) throw new Error('profiles_entry_missing_id');
    if (seen.has(e.id)) throw new Error('profiles_duplicate_id:' + e.id);
    seen.add(e.id);
    if (typeof e.data_path === 'string') e.data_path = e.data_path.replace(/\\/g, '/');
    if (!e.data_path) e.data_path = 'profiles/' + e.id;
    if (!e.display_name) e.display_name = e.id;
    // 管理器内部字段（下划线开头）绝不能写进去：客户端用严格 schema 校验，多一个字段整份文件都会被隔离
    for (const k of Object.keys(e)) if (k.charAt(0) === '_') delete e[k];
    // 没有 login_metadata 的条目会让客户端判定整个文件非法并退回未登录状态
    if (!e.login_metadata || typeof e.login_metadata !== 'object') throw new Error('profiles_entry_not_logged_in:' + e.id);
  }
  for (const k of Object.keys(p)) if (k.charAt(0) === '_') delete p[k];
  if (p.last_active && !seen.has(p.last_active)) {
    p.last_active = p.entries.length ? p.entries[0].id : null;
  }
  return p;
}

function writeProfiles(next) {
  ensureDirs();
  if (next && next._missing !== undefined && (next._missing || !next.entries || !next.entries.length)) {
    // readProfiles() 读失败时给的空壳，拿它写回会把客户端的账号清单抹掉
    throw new Error('profiles_unreadable');
  }
  const safe = normalizeProfiles(next);
  // 序列化自检：确保写出去的内容能被重新解析且条目数一致
  const round = JSON.parse(JSON.stringify(safe));
  if (!round || !Array.isArray(round.entries) || round.entries.length !== safe.entries.length) {
    throw new Error('profiles_serialize_mismatch');
  }
  try {
    if (fs.existsSync(PROFILES_JSON)) {
      fs.copyFileSync(PROFILES_JSON, path.join(BACKUPS, 'profiles-' + Date.now() + '.json'));
    }
  } catch (_) {}
  writeJsonAtomic(PROFILES_JSON, safe);
  return safe;
}

function profileDir(id) {
  const j = readProfiles();
  const e = j.entries.find((x) => x.id === id);
  if (!e) return null;
  return path.join(QW, e.data_path || path.join('profiles', id));
}

// ---------- 本地备注（别名/颜色/头像） ----------
function getMeta() { return readJson(META_FILE, {}); }
function setMeta(id, patch) {
  const m = getMeta();
  m[id] = Object.assign({}, m[id] || {}, patch);
  ensureDirs();
  writeJsonAtomic(META_FILE, m);
  return m[id];
}

// ---------- 目录体积（带缓存） ----------
const sizeCache = new Map();
function dirSizeSync(dir, depth) {
  depth = depth || 0;
  if (depth > 6) return 0;
  let total = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeSync(p, depth + 1);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch (_) {}
  }
  return total;
}

function cachedDirSize(dir) {
  try {
    const st = fs.statSync(dir);
    const key = dir;
    const hit = sizeCache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.size;
    const size = dirSizeSync(dir);
    sizeCache.set(key, { mtimeMs: st.mtimeMs, size });
    return size;
  } catch (_) { return 0; }
}

// ---------- sessions.db（容错，vec0 缺失会抛错） ----------
let sqlite = null;
function getSqlite() {
  if (sqlite !== null) return sqlite;
  try { sqlite = require('node:sqlite'); } catch (_) { sqlite = false; }
  return sqlite;
}

const sessionsCache = new Map(); // id -> { ts, mtime, data }

function sessionsInfo(id) {
  const dir = profileDir(id);
  if (!dir) return { count: 0, lastTitle: null, lastAt: null, dbBytes: 0, available: false };
  const db = path.join(dir, 'sessions', 'sessions.db');
  let st = null;
  try { st = fs.statSync(db); } catch (_) { return { count: 0, lastTitle: null, lastAt: null, dbBytes: 0, available: false }; }
  const hit = sessionsCache.get(id);
  if (hit && hit.mtime === st.mtimeMs && Date.now() - hit.ts < 15000) return hit.data;
  const result = (() => {
    const sq = getSqlite();
    if (!sq) return { count: 0, lastTitle: null, lastAt: null, dbBytes: st.size, available: false };
    let conn = null;
    try {
      conn = new sq.DatabaseSync(db, { readOnly: true });
      const c = conn.prepare('SELECT COUNT(*) AS c FROM sessions').get();
      const last = conn.prepare('SELECT title, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 1').get();
      return {
        count: c ? c.c : 0,
        lastTitle: last ? last.title : null,
        lastAt: last ? Number(last.updated_at) : null,
        dbBytes: st.size,
        available: true,
      };
    } catch (e) {
      return { count: 0, lastTitle: null, lastAt: null, dbBytes: st.size, available: false, error: e.message };
    } finally { try { conn && conn.close(); } catch (_) {} }
  })();
  sessionsCache.set(id, { ts: Date.now(), mtime: st.mtimeMs, data: result });
  return result;
}

function listSessions(id, limit) {
  const dir = profileDir(id);
  if (!dir) return [];
  const sq = getSqlite();
  if (!sq) return [];
  const db = path.join(dir, 'sessions', 'sessions.db');
  let conn = null;
  try {
    conn = new sq.DatabaseSync(db, { readOnly: true });
    return conn.prepare('SELECT id, title, message_count, event_count, created_at, updated_at, agent_mode FROM sessions ORDER BY updated_at DESC LIMIT ?')
      .all(limit || 200)
      .map((r) => ({
        id: r.id, title: r.title, messages: r.message_count, events: r.event_count,
        createdAt: Number(r.created_at) * 1000, updatedAt: Number(r.updated_at) * 1000, mode: r.agent_mode,
      }));
  } catch (_) { return []; } finally { try { conn && conn.close(); } catch (_) {} }
}

// ---------- 健康 / 登录状态 ----------
function policyInfo() {
  const files = (() => { try { return fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log')); } catch (_) { return []; } })();
  files.sort();
  const last = files[files.length - 1];
  if (!last) return { disableSocialLogin: null, disableAutoUpdates: null };
  const lines = tailLines(path.join(LOGS_DIR, last), 4000);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/resolved policy:\s*(\{.*\})/);
    if (m) { try { return JSON.parse(m[1]); } catch (_) {} }
  }
  return { disableSocialLogin: null, disableAutoUpdates: null };
}

function loginState(id, entry, isActive, quota) {
  // Cookie 存在 userData（Chromium 层，全局），不在 profile 目录
  const cookies = fs.existsSync(path.join(LOCAL, 'Network', 'Cookies'));
  const failing = !!(entry && entry.refresh_failing_since);
  if (failing) return { state: 'refresh_failed', label: '刷新失败，需重新登录', cookies };
  if (isActive) {
    if (quota && quota.ok && (Date.now() - quota.fetchedAt) < 30 * 60000) {
      return { state: 'ok', label: '正常（云端已验证）', cookies };
    }
    return { state: 'unknown', label: '未验证（点「刷新额度」验证）', cookies };
  }
      return { state: 'unknown', label: '未验证（切过去可验证）', cookies };
}

// ---------- 身份缓存（来自 relay /whoami，仅当前账号可刷新） ----------
function readIdentity() { return readJson(IDENTITY_FILE, {}); }
function writeIdentity(o) { ensureDirs(); writeJsonAtomic(IDENTITY_FILE, o); }

/** 从 tenantUrl 提取短哈希：qbs-cell3761cb2f-xxxx… → cell3761cb2f */
function tenantHash(tenantUrl) {
  if (!tenantUrl) return null;
  const m = String(tenantUrl).match(/qbs-([a-z0-9]+)/i);
  if (m) return m[1].slice(0, 12);
  try { return new URL(tenantUrl).host.split('.')[0].replace(/^qbs-/, '').slice(0, 12); } catch (_) { return null; }
}

async function fetchIdentity() {
  const profiles = readProfiles();
  const id = profiles.last_active;
  if (!id) return { ok: false, reason: 'no_active' };
  let r;
  try { r = await httpGetJson(RELAY_BASE + '/whoami', 20000); }
  catch (e) { return { ok: false, reason: 'relay_down', message: e.message }; }
  if (!r || !r.ok) return { ok: false, reason: 'no_session', message: (r && r.error) || 'unknown' };
  const cache = readIdentity();
  cache[id] = {
    accountId: r.accountId || null,
    provider: r.provider || null,
    region: r.region || null,
    tenantUrl: r.tenantUrl || null,
    consoleAccountUrl: r.consoleAccountUrl || null,
    usableUntil: r.usableUntil || null,
    tokenLen: r.tokenLen || null,
    fetchedAt: Date.now(),
  };
  writeIdentity(cache);
  return { ok: true, identity: cache[id] };
}

// ---------- 按会话的 token 记账 ----------
const TOKEN_CONVS = path.join(DATA, 'token-convs.json');

function readTokenConvs() { return readJson(TOKEN_CONVS, {}); }

/** 合并页面导出的会话聚合；仅在数值变化时落盘，返回变化条数 */
function mergeTokenConvs(list) {
  const cur = readTokenConvs();
  let changed = 0;
  for (const c of list || []) {
    if (!c || !c.id) continue;
    const prev = cur[c.id];
    const same = prev && prev.totalTok === c.totalTok && prev.turns === c.turns &&
      prev.steps === c.steps && prev.cost === c.cost;
    if (same) continue;
    cur[c.id] = {
      id: c.id,
      turns: c.turns || 0,
      steps: c.steps || 0,
      inTok: c.inTok || 0,
      cacheReadTok: c.cacheReadTok || 0,
      cacheWriteTok: c.cacheWriteTok || 0,
      outTok: c.outTok || 0,
      totalTok: c.totalTok || 0,
      cost: c.cost || 0,
      ctxPct: c.ctxPct || 0,
      lastTotal: c.lastTotal || 0,
      ctx: c.ctx || null,
      model: c.model || null,
      lastAt: c.lastAt || 0,
      updatedAt: Date.now(),
    };
    changed += 1;
  }
  if (changed) writeJsonAtomic(TOKEN_CONVS, cur);
  return changed;
}

/** 从各 profile 的 sessions.db 读会话标题：短 id -> {title, updatedAt} */
function sessionTitles() {
  const out = {};
  const sq = getSqlite();
  if (!sq) return out;
  for (const e of readProfiles().entries) {
    const dir = profileDir(e.id);
    if (!dir) continue;
    const db = path.join(dir, 'sessions', 'sessions.db');
    if (!fs.existsSync(db)) continue;
    let conn = null;
    try {
      conn = new sq.DatabaseSync(db, { readOnly: true });
      const rows = conn.prepare('SELECT id, title, updated_at FROM sessions').all();
      for (const r of rows) {
        const full = String(r.id || '');
        out[full.split('-')[0].slice(0, 8)] = { title: r.title || null, updatedAt: Number(r.updated_at) || null };
      }
    } catch (_) {
    } finally { try { conn && conn.close(); } catch (_) {} }
  }
  return out;
}

/** 历史表：token 记账 + 会话标题，按 token 降序 */
function tokenHistory() {
  const store = readTokenConvs();
  const titles = sessionTitles();
  const rows = Object.keys(store).map((id) => {
    const c = store[id];
    const t = titles[id] || {};
    return {
      id,
      title: t.title || ('会话 ' + id),
      turns: c.turns, steps: c.steps, totalTok: c.totalTok, cost: c.cost,
      cachePct: (c.cacheReadTok + c.inTok) > 0 ? Math.round(100 * c.cacheReadTok / (c.cacheReadTok + c.inTok)) : 0,
      ctxPct: c.ctxPct, lastTotal: c.lastTotal, ctx: c.ctx,
      model: c.model, lastAt: c.lastAt, updatedAt: c.updatedAt,
    };
  }).sort((a, b) => b.totalTok - a.totalTok);
  const totals = rows.reduce((a, r) => ({
    convs: a.convs + 1, tokens: a.tokens + r.totalTok, cost: a.cost + r.cost,
    turns: a.turns + r.turns, steps: a.steps + r.steps,
  }), { convs: 0, tokens: 0, cost: 0, turns: 0, steps: 0 });
  return { ok: true, rows, totals };
}

// ---------- 管理器自身配置（预算告警等） ----------
const CONFIG_FILE = path.join(DATA, 'config.json');
const DEFAULT_CONFIG = {
  budgetMonthlyPercent: 80,
  budgetSessionPercent: 80,
  notify: true,
  telemetryMute: true,
};

function getConfig() {
  return Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
}
function setConfig(patch) {
  const next = Object.assign(getConfig(), patch || {});
  ensureDirs();
  writeJsonAtomic(CONFIG_FILE, next);
  audit('config', patch);
  return next;
}

function alertsFor(quota, cfg) {
  const out = [];
  if (!quota || !quota.ok) return out;
  const m = quota.monthly || {}, s = quota.session || {};
  if (m.percent != null && m.percent >= cfg.budgetMonthlyPercent) out.push({ level: m.percent >= 95 ? 'bad' : 'warn', text: '月度用量已达 ' + m.percent + '%' });
  if (s.percent != null && s.percent >= cfg.budgetSessionPercent) out.push({ level: s.percent >= 95 ? 'bad' : 'warn', text: '会话窗口已达 ' + s.percent + '%' });
    if (quota.overage) out.push({ level: 'bad', text: '已进入超额计费' });
  return out;
}

// ---------- 额度 ----------
function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs || 20000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b.slice(0, 120))); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function relayHealth() {
  return httpGetJson(RELAY_BASE + '/health', 4000).catch(() => null);
}

function readQuotaCache() { return readJson(QUOTA_CACHE, {}); }
function writeQuotaCache(c) { ensureDirs(); writeJsonAtomic(QUOTA_CACHE, c); }

async function fetchQuota(id) {
  const profiles = readProfiles();
  if (profiles.last_active !== id) {
    return { ok: false, reason: 'not_active', message: '只有当前登录账号能实时查额度' };
  }
  const h = await relayHealth();
  if (!h) return { ok: false, reason: 'relay_down', message: 'relay 未运行（无法取额度）' };
  let r;
  try {
    r = await httpGetJson(RELAY_BASE + '/probe?path=profile/usage&full=1', 25000);
  } catch (e) { return { ok: false, reason: 'probe_failed', message: e.message }; }
  if (!r || r.status !== 200 || typeof r.body !== 'string') {
    return { ok: false, reason: 'bad_response', message: (r && (r.error || r.status)) || 'unexpected' };
  }
  let usage = null;
  try { usage = JSON.parse(r.body); } catch (_) { return { ok: false, reason: 'bad_json', message: r.body.slice(0, 200) }; }

  const snap = {
    ok: true,
    fetchedAt: Date.now(),
    session: usage.session || null,
    monthly: usage.monthly || null,
    overage: usage.overage_monthly || null,
    subscription: usage.subscription || null,
    raw: usage,
  };
  const cache = readQuotaCache();
  cache[id] = snap;
  writeQuotaCache(cache);
  appendJsonl(QUOTA_HISTORY, {
    ts: snap.fetchedAt, id,
    mUsed: snap.monthly && snap.monthly.used, mLimit: snap.monthly && snap.monthly.limit,
    sUsed: snap.session && snap.session.used, sLimit: snap.session && snap.session.limit,
  });
  return snap;
}

// ---------- 账号聚合 ----------
function listAccounts() {
  const profiles = readProfiles();
  const meta = getMeta();
  const cache = readQuotaCache();
  const idCache = readIdentity();
  const policy = policyInfo();
  const cfg = getConfig();
  const now = Date.now();

  const accounts = profiles.entries.map((e) => {
    const dir = path.join(QW, e.data_path || path.join('profiles', e.id));
    const isActive = profiles.last_active === e.id;
    const q = cache[e.id] || null;
    const ls = loginState(e.id, e, isActive, q);
    const si = sessionsInfo(e.id);
    const m = meta[e.id] || {};
    const ident = idCache[e.id] || null;
    const tenantUrl = (ident && ident.tenantUrl) || (e.login_metadata && e.login_metadata.tenant_url) || null;
    const sub = (q && q.ok && q.subscription) || null;
    const planType = (sub && (sub.subscription_type || sub.type)) || null;
    const planLabel = planType
      ? String(planType).replace(/^QUICK_/i, '').replace(/_/g, ' ')
      : null;
    return {
      id: e.id,
      displayName: e.display_name || e.id,
      alias: m.alias || null,
      color: m.color || null,
      group: m.group || null,
      provider: e.provider,
      active: isActive,
      identity: {
        accountId: ident ? ident.accountId : null,
        provider: (ident && ident.provider) || e.provider || null,
        region: ident ? ident.region : null,
        tenantHash: tenantHash(tenantUrl),
        consoleAccountUrl: ident ? ident.consoleAccountUrl : null,
        usableUntil: ident ? ident.usableUntil : null,
        fetchedAt: ident ? ident.fetchedAt : null,
      },
      plan: {
        type: planType,
        label: planLabel,
        trial: sub && sub.free_trial_metadata ? sub.free_trial_metadata : null,
      },
      issuer: (e.login_metadata && e.login_metadata.issuer_url) || null,
      tenant: (e.login_metadata && e.login_metadata.tenant_url) || null,
      clientId: (e.login_metadata && e.login_metadata.client_id) || null,
      createdAt: e.created_at ? Date.parse(e.created_at) : null,
      lastUsedAt: e.last_used_at ? Date.parse(e.last_used_at) : null,
      refreshFailingSince: e.refresh_failing_since || null,
      login: ls,
      dir,
      dirExists: fs.existsSync(dir),
      diskBytes: fs.existsSync(dir) ? cachedDirSize(dir) : 0,
      sessions: si,
      quota: q,
      quotaAgeMs: q ? now - q.fetchedAt : null,
      alerts: alertsFor(q, cfg),
    };
  });

  return {
    now,
    lastActive: profiles.last_active || null,
    profilesPath: PROFILES_JSON,
    missing: !!profiles._missing,
    policy,
    config: cfg,
    accounts: accounts.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0)),
  };
}

// ---------- 用量趋势（来自额度快照历史） ----------
function usageSeries(id, days) {
  const from = Date.now() - (days || 7) * 86400000;
  const out = [];
  for (const line of tailLines(QUOTA_HISTORY, 20000)) {
    try {
      const o = JSON.parse(line);
      if (o.ts >= from && (!id || o.id === id)) out.push(o);
    } catch (_) {}
  }
  return out;
}

module.exports = {
  HOME, QW, PROFILES_JSON, PROFILES_DIR, LOCAL, LOGS_DIR, ROOT, DATA, BACKUPS,
  META_FILE, QUOTA_CACHE, QUOTA_HISTORY, AUDIT_FILE, TOKEN_FILE, RELAY_BASE, CDP_PORT, APP_EXE,
  TOOLS,
  ensureDirs, readJson, writeJsonAtomic, appendJsonl, tailLines, audit, mgrToken,
  readProfiles, readProfilesStrict, writeProfiles, countQuarantined, hasCredential, profileDir, getMeta, setMeta,
  dirSizeSync, cachedDirSize, sessionsInfo, listSessions,
  policyInfo, loginState, relayHealth, fetchQuota, readQuotaCache, writeQuotaCache,
  listAccounts, usageSeries, httpGetJson,
  CONFIG_FILE, DEFAULT_CONFIG, getConfig, setConfig, alertsFor,
  TOKEN_CONVS, readTokenConvs, mergeTokenConvs, sessionTitles, tokenHistory,
};

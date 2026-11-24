'use strict';
/**
 * lib/pool.js — 家庭共享空闲账号池 & 免 CDP 桌面切号引擎
 *
 * 职责：
 *  1. 维护 data/pool-store.json（账号池、家庭昵称/颜色/当前使用人/是否参与空闲池、通用配置模板、管理员 PIN）
 *  2. 自动与 ~/.quickwork/profiles.json + Windows 凭据管理器同步，精准识别凭据丢失与失效状态
 *  3. 直连 AWS Quick 云端并发刷新全号池真实月度/会话额度（不依赖 Quick 运行、不依赖 CDP/relay）
 *  4. 家人「一键取用空闲账号 / 换一个可用号」智能分配算法 + 免 CDP 优雅关启切号 + 失败自动回滚
 *  5. 独立 OAuth 登录（本机无痕 / 远程 VPS 跨设备 / 失效号一步重登）、凭证 JSON 导入、空白窗加号
 *  6. 家庭通用配置模板（MCP / 文件夹白名单 / 工具权限）换号自动同步
 */

const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { execFileSync, spawn } = require('child_process');
const C = require('./core');
const O = require('./ops');
const KC = require('./keychain');
const QC = require('./quick-cloud');
const Conv = require('./conversations');

const STORE_FILE = path.join(C.DATA, 'pool-store.json');
const TEMPLATE_DIR = path.join(C.DATA, 'common-template');
const TEMPLATE_FILES = [
  { key: 'mcp', file: 'mcp_config.json', label: 'MCP 服务器' },
  { key: 'allowedFolders', file: 'allowed_folders.db', label: '允许访问的文件夹' },
  { key: 'toolPermissions', file: 'tool_permissions.json', label: '工具权限' },
  { key: 'acpAgents', file: 'acp_agents.json', label: '外部编程代理 ACP' },
  { key: 'integrations', file: 'integrations_config.json', label: '集成开关' },
];
const LOCAL_TOOLS_MCP_KEY = 'local-tools';
const LOCAL_TOOLS_SCRIPT = path.join(C.TOOLS, 'local-tools-mcp.js');

const DEFAULT_AVATAR_COLORS = [
  '#4f46e5', '#0891b2', '#059669', '#d97706',
  '#db2777', '#7c3aed', '#2563eb', '#0d9488',
];

let activeOAuth = null;
let blankLoginState = null;
let switchMutex = null;
let lastSwitchHandoff = null;

function defaultStore() {
  return {
    version: 1,
    accounts: [],
    activeAccountId: null,
    currentUserLabel: '',
    familyUsers: ['爸爸', '妈妈', '我'],
    adminPinHash: null,
    commonTemplate: {
      enabled: true,
      sourceId: null,
      sourceName: null,
      savedAt: null,
      items: ['mcp', 'allowedFolders', 'toolPermissions', 'acpAgents', 'integrations'],
    },
    autoGrantFullAccess: false,
    autoSyncConversationsOnSwitch: true,
    autoCopyHandoffOnSwitch: true,
    quickgwAutostart: false,
  };
}

function loadStore() {
  C.ensureDirs();
  const raw = C.readJson(STORE_FILE, null);
  const base = defaultStore();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    familyUsers: Array.isArray(raw.familyUsers) && raw.familyUsers.length ? raw.familyUsers : base.familyUsers,
    commonTemplate: { ...base.commonTemplate, ...(raw.commonTemplate || {}) },
  };
}

function saveStore(store) {
  C.ensureDirs();
  C.writeJsonAtomic(STORE_FILE, store);
  return store;
}

function hashPin(pin) {
  return createHash('sha256').update('qwm-pin:' + String(pin || '')).digest('hex');
}

function checkPin() {
  // 全功能直接开放，不再拦截管理员密码锁
  return true;
}

function setAdminPin(newPin, currentPin) {
  const s = loadStore();
  if (s.adminPinHash && !checkPin(currentPin)) {
    throw new Error('当前管理员密码不正确');
  }
  const clean = String(newPin || '').trim();
  if (clean && (clean.length < 4 || clean.length > 16)) {
    throw new Error('管理员密码长度需在 4~16 位之间（留空可取消密码锁）');
  }
  s.adminPinHash = clean ? hashPin(clean) : null;
  saveStore(s);
  C.audit('admin_pin_update', { enabled: !!s.adminPinHash });
  return { pinEnabled: !!s.adminPinHash };
}

function setFamilySettings(patch) {
  const s = loadStore();
  if (typeof patch.currentUserLabel === 'string') {
    s.currentUserLabel = patch.currentUserLabel.trim().slice(0, 24);
  }
  if (Array.isArray(patch.familyUsers)) {
    const cleaned = patch.familyUsers.map((x) => String(x || '').trim().slice(0, 16)).filter(Boolean);
    if (cleaned.length) s.familyUsers = [...new Set(cleaned)].slice(0, 12);
  }
  if (typeof patch.quickgwAutostart === 'boolean') {
    s.quickgwAutostart = patch.quickgwAutostart;
  }
  if (typeof patch.autoSyncConversationsOnSwitch === 'boolean') {
    s.autoSyncConversationsOnSwitch = patch.autoSyncConversationsOnSwitch;
  }
  if (typeof patch.autoCopyHandoffOnSwitch === 'boolean') {
    s.autoCopyHandoffOnSwitch = patch.autoCopyHandoffOnSwitch;
  }
  if (patch.commonTemplate && typeof patch.commonTemplate === 'object') {
    if (typeof patch.commonTemplate.enabled === 'boolean') s.commonTemplate.enabled = patch.commonTemplate.enabled;
    if (Array.isArray(patch.commonTemplate.items)) s.commonTemplate.items = patch.commonTemplate.items;
  }
  saveStore(s);
  return s;
}

// ---------- 进程控制（免 CDP） ----------
function resolveQuickExe() {
  const local = process.env.LOCALAPPDATA || path.join(C.HOME, 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const cands = [
    process.env.AMAZON_QUICK_EXE,
    C.APP_EXE,
    path.join(local, 'Programs', 'quickwork', 'Amazon Quick.exe'),
    path.join(pf, 'quickwork', 'Amazon Quick.exe'),
    path.join(pf, 'Amazon Quick', 'Amazon Quick.exe'),
    path.join(pf86, 'Amazon Quick', 'Amazon Quick.exe'),
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || C.APP_EXE;
}

function isQuickRunning() {
  return O.appRunning();
}

async function quitQuickGracefully(timeoutMs = 1200) {
  if (!isQuickRunning()) return true;
  // 1. 先温和发 taskkill /T（注意：AWS Quick 关窗默认最小化到托盘，不会真正退出，所以只给短优雅窗口）
  try { execFileSync('taskkill', ['/IM', 'Amazon Quick.exe', '/T'], { timeout: 2500, windowsHide: true, stdio: 'ignore' }); } catch (_) {}

  const deadline = Date.now() + Math.min(timeoutMs, 1500);
  while (Date.now() < deadline) {
    await O.sleep(250);
    if (!isQuickRunning()) {
      await O.sleep(350);
      return true;
    }
  }

  // 2. Quick 仍驻留托盘时立即强制结束进程树（聊天都在云端、凭据实时写凭据管理器，安全无损）
  try { execFileSync('taskkill', ['/F', '/IM', 'Amazon Quick.exe', '/T'], { timeout: 3000, windowsHide: true, stdio: 'ignore' }); } catch (_) {}
  await O.sleep(400);
  return !isQuickRunning();
}

function launchQuick() {
  const exe = resolveQuickExe();
  if (!fs.existsSync(exe)) throw new Error('未找到 Amazon Quick.exe，请先安装 AWS Quick 客户端');
  const dir = path.dirname(exe);

  // 优先用 cmd start（~40ms，脱离 windowsHide 且默认正常前台窗口），失败再回退 PowerShell Start-Process
  if (process.platform === 'win32') {
    try {
      execFileSync('cmd.exe', ['/d', '/s', '/c', `start "" /D "${dir}" "${exe}"`], {
        timeout: 4000,
        windowsHide: true,
        stdio: 'ignore',
      });
      return true;
    } catch (_) {
      const qExe = exe.replace(/'/g, "''");
      const qDir = dir.replace(/'/g, "''");
      try {
        execFileSync('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `$ProgressPreference='SilentlyContinue'; Start-Process -FilePath '${qExe}' -WorkingDirectory '${qDir}' -WindowStyle Normal`,
        ], { timeout: 6000, windowsHide: true, stdio: 'ignore' });
        return true;
      } catch (_) {}
    }
  }

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  spawn(exe, [], { cwd: dir, detached: true, windowsHide: false, stdio: 'ignore', env }).unref();
  return true;
}

function focusQuickWindow() {
  try {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class QwFocus { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'; $p = Get-Process -Name 'Amazon Quick' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { [QwFocus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [QwFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }`,
    ], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function focusOrLaunchQuick() {
  if (!isQuickRunning()) {
    launchQuick();
    return { ok: true, launched: true, focused: false };
  }
  if (!focusQuickWindow()) {
    // 兜底再次启动会触发 Quick 单实例置前
    try { launchQuick(); } catch (_) {}
  }
  return { ok: true, launched: false, focused: true };
}

// ---------- 账号合并 / 匹配 ----------
function ensureProfileId(account) {
  if (account.profileId) return account.profileId;
  const provider = String(account.providerType || 'social').toLowerCase();
  const seed = account.externalId || `${account.email}|${account.tenantUrl}|${account.clientId || randomUUID()}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `${provider}-${hash}`;
}

function findAccountIndex(accounts, cand) {
  return accounts.findIndex((item) => {
    if (cand.id && item.id === cand.id) return true;
    if (cand.profileId && item.profileId && cand.profileId === item.profileId) return true;
    if (cand.email && item.email && cand.email.toLowerCase() !== item.email.toLowerCase()) return false;
    if (cand.externalId && item.externalId && cand.externalId === item.externalId) return true;
    if (cand.email && item.email && cand.email.toLowerCase() === item.email.toLowerCase()) {
      if (!cand.issuerUrl || !item.issuerUrl || cand.issuerUrl === item.issuerUrl) return true;
    }
    if (cand.tenantUrl && item.tenantUrl && cand.tenantUrl === item.tenantUrl && !cand.email && !item.email) return true;
    return false;
  });
}

function upsertAccount(store, incoming, extra = {}) {
  const accounts = [...store.accounts];
  const idx = findAccountIndex(accounts, incoming);
  const now = Date.now();

  if (idx >= 0) {
    const existing = accounts[idx];
    const hasFreshToken = Boolean(
      incoming.needsRelogin === false
      || (incoming.access && incoming.access !== existing.access)
      || (incoming.refresh && incoming.refresh !== existing.refresh)
    );
    const clearRelogin = incoming.needsRelogin !== true && hasFreshToken;
    const merged = {
      ...existing,
      ...incoming,
      id: existing.id,
      profileId: incoming.profileId || existing.profileId || ensureProfileId({ ...existing, ...incoming }),
      email: incoming.email || existing.email || '',
      displayName: incoming.displayName || existing.displayName || incoming.email || existing.email || 'Amazon Quick',
      alias: extra.alias !== undefined ? extra.alias : (existing.alias || null),
      color: extra.color !== undefined ? extra.color : (existing.color || DEFAULT_AVATAR_COLORS[idx % DEFAULT_AVATAR_COLORS.length]),
      group: extra.group !== undefined ? extra.group : (existing.group || ''),
      note: extra.note !== undefined ? extra.note : (existing.note || ''),
      poolEnabled: extra.poolEnabled !== undefined ? !!extra.poolEnabled : (existing.poolEnabled !== false),
      source: extra.source || existing.source || 'desktop',
      quota: extra.quota !== undefined ? extra.quota : (existing.quota || null),
      needsRelogin: clearRelogin ? false : Boolean(incoming.needsRelogin ?? existing.needsRelogin),
      reloginReason: clearRelogin ? null : (incoming.reloginReason ?? existing.reloginReason ?? null),
      lastError: clearRelogin ? null : (incoming.lastError !== undefined ? incoming.lastError : (existing.lastError ?? null)),
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    accounts[idx] = merged;
    return { store: { ...store, accounts }, account: merged, isNew: false };
  }

  const profileId = incoming.profileId || ensureProfileId(incoming);
  const created = {
    ...incoming,
    id: (incoming.id && !accounts.some((a) => a.id === incoming.id)) ? incoming.id : ('acc_' + randomUUID().replace(/-/g, '').slice(0, 12)),
    profileId,
    displayName: incoming.displayName || incoming.email || profileId,
    alias: extra.alias || null,
    color: extra.color || DEFAULT_AVATAR_COLORS[accounts.length % DEFAULT_AVATAR_COLORS.length],
    group: extra.group || '',
    note: extra.note || '',
    poolEnabled: extra.poolEnabled !== false,
    source: extra.source || 'desktop',
    quota: extra.quota || null,
    needsRelogin: Boolean(incoming.needsRelogin),
    reloginReason: incoming.reloginReason || null,
    lastError: null,
    lastUsedAt: incoming.lastUsedAt || null,
    createdAt: incoming.createdAt || now,
    updatedAt: now,
  };
  accounts.push(created);
  return { store: { ...store, accounts }, account: created, isNew: true };
}

// ---------- 从桌面端采集账号（合并旧 meta 与旧 quota 缓存） ----------
async function syncFromDesktop({ includeExisting = false, onlyProfileId = '' } = {}) {
  const manifest = C.readProfiles();
  const oldMeta = C.getMeta();
  const oldQuotaCache = C.readQuotaCache();
  let store = loadStore();
  let added = 0, updated = 0, skipped = 0;
  const errors = [];

  for (const entry of (manifest.entries || [])) {
    if (!entry || !entry.id) continue;
    if (onlyProfileId && entry.id !== onlyProfileId) continue;

    const existing = store.accounts.find((a) => a.profileId === entry.id) || null;
    const provider = String(entry.provider || 'social').toLowerCase();
    const svc = KC.getKeychainServiceName(entry.id, provider);
    const meta = oldMeta[entry.id] || {};
    const legacyQuota = oldQuotaCache[entry.id] || null;
    const entryFailing = !!entry.refresh_failing_since;

    const mustRead = Boolean(includeExisting || onlyProfileId || !existing || !existing.access || existing.needsRelogin);
    if (!mustRead && existing && existing.access) {
      // 更新时间/失效标记即可
      if (entryFailing && !existing.needsRelogin) {
        existing.needsRelogin = true;
        existing.reloginReason = '桌面客户端凭证刷新失败，请重新登录';
        updated += 1;
      } else {
        skipped += 1;
      }
      if (entry.id === manifest.last_active) store.activeAccountId = existing.id;
      continue;
    }

    const readRes = await KC.readKeychainSecretAsync(svc);
    let cred = null;
    let missingCred = false;

    if (readRes && readRes.ok && readRes.value) {
      try {
        cred = QC.normalizeCredential(JSON.parse(readRes.value), entry);
      } catch (_) {
        errors.push(`${entry.display_name || entry.id}: 凭据 JSON 解析失败`);
      }
    } else {
      missingCred = true;
    }

    if (!cred) {
      // 就算凭据丢失，也要把它收录进来并清晰标记 needsRelogin（管理员可一键重登修复！）
      cred = QC.normalizeCredential({}, entry);
    }

    const isNewer = !existing || (cred.access && cred.access !== existing.access) || (cred.refresh && cred.refresh !== existing.refresh);
    const needsRelogin = missingCred || entryFailing || (!cred.access && !cred.refresh)
      || (existing && existing.needsRelogin && !includeExisting && !isNewer);
    const reloginReason = missingCred
      ? '本机凭据已丢失，需管理员重新登录'
      : (entryFailing ? '桌面客户端凭证刷新失败，需重新登录' : (existing && existing.reloginReason) || null);

    const res = upsertAccount(store, {
      ...cred,
      profileId: entry.id,
      displayName: cred.displayName || entry.display_name || entry.id,
      createdAt: entry.created_at ? Date.parse(entry.created_at) : undefined,
      lastUsedAt: entry.last_used_at ? Date.parse(entry.last_used_at) : (existing && existing.lastUsedAt) || null,
      needsRelogin,
      reloginReason,
    }, {
      source: 'desktop',
      alias: existing ? existing.alias : (meta.alias || null),
      color: existing ? existing.color : (meta.color || undefined),
      quota: (existing && existing.quota) || legacyQuota || null,
    });
    store = res.store;
    if (res.isNew) added += 1;
    else updated += 1;
    if (entry.id === manifest.last_active) store.activeAccountId = res.account.id;
  }

  saveStore(store);
  C.audit('pool_sync_desktop', { added, updated, skipped, errors: errors.length });
  return { ok: true, added, updated, skipped, errors, total: store.accounts.length };
}

// ---------- 直连云端刷新单号 / 全池额度 ----------
function persistAccountPatch(accountId, patch) {
  const s = loadStore();
  const i = s.accounts.findIndex((a) => a.id === accountId);
  if (i < 0) return null;
  s.accounts[i] = { ...s.accounts[i], ...patch, updatedAt: Date.now() };
  saveStore(s);
  return s.accounts[i];
}

async function refreshAccountQuota(accountId) {
  const store = loadStore();
  const acc = store.accounts.find((a) => a.id === accountId || a.profileId === accountId);
  if (!acc) return { ok: false, error: '未找到该账号' };

  try {
    const { account: updatedAcc, quota } = await QC.fetchAccountUsage(
      acc,
      async (next) => { persistAccountPatch(acc.id, next); },
      { isQuickRunning, readManifest: C.readProfiles }
    );
    persistAccountPatch(acc.id, {
      ...updatedAcc,
      quota,
      needsRelogin: false,
      reloginReason: null,
      lastError: null,
    });
    // 同步写一份到旧 quota-cache 与 quota-history，兼容历史趋势图
    try {
      const pid = updatedAcc.profileId || acc.profileId;
      if (pid) {
        const cache = C.readQuotaCache();
        cache[pid] = quota;
        C.writeQuotaCache(cache);
        C.appendJsonl(C.QUOTA_HISTORY, {
          ts: quota.fetchedAt,
          id: pid,
          mUsed: quota.monthly && quota.monthly.used,
          mLimit: quota.monthly && quota.monthly.limit,
          sUsed: quota.session && quota.session.used,
          sLimit: quota.session && quota.session.limit,
        });
      }
    } catch (_) {}
    return { ok: true, id: acc.id, quota };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (err && err.needsRelogin) {
      persistAccountPatch(acc.id, { needsRelogin: true, reloginReason: msg, lastError: msg });
    } else if (!(err && err.skippedActiveQuick)) {
      persistAccountPatch(acc.id, { lastError: msg });
    }
    return {
      ok: false,
      id: acc.id,
      error: msg,
      needsRelogin: !!(err && err.needsRelogin),
      skippedActiveQuick: !!(err && err.skippedActiveQuick),
    };
  }
}

async function probeAccountHealth(accountId) {
  const store = loadStore();
  const acc = store.accounts.find((a) => a.id === accountId || a.profileId === accountId);
  if (!acc) return { ok: false, alive: false, error: '未找到该账号' };

  const label = acc.alias || acc.displayName || acc.email || acc.profileId;
  const t0 = Date.now();
  try {
    const { account: updatedAcc, quota } = await QC.fetchAccountUsage(
      acc,
      async (next) => { persistAccountPatch(acc.id, next); },
      { isQuickRunning, readManifest: C.readProfiles }
    );

    // 轻量探测会话接口，确认租户聊天 API 真正存活可用
    let sessionsOk = true;
    let sessionErr = '';
    try {
      await QC.invokeQbsApi(updatedAcc, 'api/sessions?limit=1', 'GET', {}, 12000);
    } catch (e) {
      sessionsOk = false;
      sessionErr = (e && e.message) || String(e);
      if (e && e.needsRelogin) throw e;
    }

    const latencyMs = Date.now() - t0;
    const monthly = normalizeQuotaWin(quota && quota.monthly);
    const session = normalizeQuotaWin(quota && quota.session);
    const probe = {
      ok: true,
      alive: true,
      sessionsOk,
      at: Date.now(),
      latencyMs,
      error: sessionsOk ? null : sessionErr,
    };
    persistAccountPatch(acc.id, {
      ...updatedAcc,
      quota,
      lastProbe: probe,
      needsRelogin: false,
      reloginReason: null,
      lastError: null,
    });

    C.audit('pool_probe', { id: acc.id, alive: true, latencyMs, sessionsOk });
    return {
      ok: true,
      alive: true,
      id: acc.id,
      label,
      latencyMs,
      sessionsOk,
      sessionErr: sessionErr || null,
      planLabel: (quota && quota.planLabel) || 'Amazon Quick',
      monthlyRemaining: monthly ? monthly.remaining : null,
      sessionRemaining: session ? session.remaining : null,
      quota,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const msg = (err && err.message) || String(err);
    const needsRelogin = !!(err && err.needsRelogin);
    const probe = {
      ok: false,
      alive: false,
      at: Date.now(),
      latencyMs,
      error: msg,
    };
    if (needsRelogin) {
      persistAccountPatch(acc.id, { lastProbe: probe, needsRelogin: true, reloginReason: msg, lastError: msg });
    } else if (!(err && err.skippedActiveQuick)) {
      persistAccountPatch(acc.id, { lastProbe: probe, lastError: msg });
    }
    C.audit('pool_probe', { id: acc.id, alive: false, latencyMs, needsRelogin, error: msg });
    return {
      ok: true,
      alive: false,
      id: acc.id,
      label,
      latencyMs,
      needsRelogin,
      skippedActiveQuick: !!(err && err.skippedActiveQuick),
      error: msg,
    };
  }
}

async function refreshAllQuotas() {
  const store = loadStore();
  // 先同步一次桌面清单，确保不会漏掉刚在客户端里登录或更新的凭据
  await syncFromDesktop({ includeExisting: false }).catch(() => {});
  const latest = loadStore();
  const results = [];
  // 适度并发（每次最多 3 个），兼顾速度与 AWS 限流
  const queue = [...latest.accounts];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const acc = queue.shift();
      if (!acc) break;
      results.push(await refreshAccountQuota(acc.id));
    }
  });
  await Promise.all(workers);
  const okCount = results.filter((r) => r.ok).length;
  C.audit('pool_refresh_all', { total: results.length, ok: okCount });
  return { ok: true, total: results.length, refreshed: okCount, results };
}

// ---------- 家庭通用配置模板（换号自动带设置） ----------
function saveCommonTemplate(fromId) {
  const store = loadStore();
  const acc = store.accounts.find((a) => a.id === fromId || a.profileId === fromId);
  if (!acc || !acc.profileId) throw new Error('未找到来源账号');
  const srcDir = path.join(C.PROFILES_DIR, acc.profileId);
  if (!fs.existsSync(srcDir)) throw new Error('来源账号目录不存在，请先至少启动使用一次该账号');

  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  const copied = [];
  for (const item of TEMPLATE_FILES) {
    const src = path.join(srcDir, item.file);
    const dst = path.join(TEMPLATE_DIR, item.file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      copied.push(item.key);
    }
  }
  if (!copied.length) throw new Error('该账号目录下暂无可保存的配置文件（MCP / 文件夹白名单 / 工具权限）');

  store.commonTemplate = {
    ...store.commonTemplate,
    enabled: true,
    sourceId: acc.id,
    sourceName: acc.alias || acc.displayName || acc.email || acc.profileId,
    savedAt: Date.now(),
    items: copied,
  };
  saveStore(store);
  C.audit('template_save', { from: acc.profileId, copied });
  return { ok: true, copied, template: store.commonTemplate };
}

function applyCommonTemplateToProfile(profileId, opts = {}) {
  const store = loadStore();
  const tpl = store.commonTemplate;
  if (!tpl || !tpl.savedAt) return { ok: true, skipped: true, reason: '尚未保存家庭通用配置模板', copied: [] };
  if (!opts.force && !tpl.enabled) return { ok: true, skipped: true, reason: '已关闭换号自动同步配置', copied: [] };

  const targetDir = path.join(C.PROFILES_DIR, profileId);
  fs.mkdirSync(targetDir, { recursive: true });
  const items = Array.isArray(tpl.items) && tpl.items.length ? tpl.items : TEMPLATE_FILES.map((x) => x.key);
  const copied = [];
  const skipped = [];

  for (const item of TEMPLATE_FILES) {
    if (!items.includes(item.key)) continue;
    const src = path.join(TEMPLATE_DIR, item.file);
    if (!fs.existsSync(src)) continue;
    // Quick 运行中不强写 .db，避免锁表
    if (item.file.endsWith('.db') && opts.quickRunning) {
      skipped.push(item.key);
      continue;
    }
    const dst = path.join(targetDir, item.file);
    try {
      const srcBuf = fs.readFileSync(src);
      if (fs.existsSync(dst)) {
        const dstBuf = fs.readFileSync(dst);
        if (srcBuf.equals(dstBuf)) continue;
        fs.copyFileSync(dst, dst + '.bak-' + Date.now());
      }
      fs.writeFileSync(dst, srcBuf);
      copied.push(item.key);
    } catch (_) {
      skipped.push(item.key);
    }
  }
  return { ok: true, copied, skipped };
}

function applyCommonTemplateToAll() {
  const store = loadStore();
  if (!store.commonTemplate || !store.commonTemplate.savedAt) {
    throw new Error('还没有保存通用配置模板，请先选一个配好的账号点击「存为通用模板」');
  }
  const running = isQuickRunning();
  const results = [];
  for (const acc of store.accounts) {
    if (!acc.profileId) continue;
    const r = applyCommonTemplateToProfile(acc.profileId, { force: true, quickRunning: running });
    results.push({ id: acc.id, name: acc.alias || acc.displayName, ...r });
  }
  C.audit('template_apply_all', { count: results.length });
  return { ok: true, quickRunning: running, results };
}

// ---------- 本机终端与文件权限（官方 stdio MCP + tool_permissions） ----------
function resolveNodePath() {
  if (process.execPath && /node\.exe$/i.test(path.basename(process.execPath))) return process.execPath;
  const std = 'C:\\Program Files\\nodejs\\node.exe';
  return fs.existsSync(std) ? std : 'node';
}

function buildLocalToolsMcpEntry() {
  return {
    command: resolveNodePath(),
    args: [LOCAL_TOOLS_SCRIPT],
    _quick: {
      name: 'Local Tools',
      startupTimeout: 60,
    },
  };
}

function defaultToolPermissions(globalDefault) {
  return {
    version: 1,
    global_default: globalDefault || 'prompt',
    integration_policies: {},
    tool_policies: {},
    tool_classifications: {},
    scoped_integration_policies: {},
    flow_tool_grants: {},
    all_flows_tool_grants: [],
  };
}

function patchProfileLocalTools(profileDir, enabled, autoAllowTools) {
  fs.mkdirSync(profileDir, { recursive: true });
  // 1. mcp_config.json（保留已有其他 MCP 服务器）
  const mcpPath = path.join(profileDir, 'mcp_config.json');
  const mcpDoc = C.readJson(mcpPath, { mcpServers: {} });
  if (!mcpDoc.mcpServers || typeof mcpDoc.mcpServers !== 'object') mcpDoc.mcpServers = {};
  if (fs.existsSync(mcpPath)) {
    try { fs.copyFileSync(mcpPath, mcpPath + '.bak-' + Date.now()); } catch (_) {}
  }
  if (enabled) mcpDoc.mcpServers[LOCAL_TOOLS_MCP_KEY] = buildLocalToolsMcpEntry();
  else delete mcpDoc.mcpServers[LOCAL_TOOLS_MCP_KEY];
  C.writeJsonAtomic(mcpPath, mcpDoc);

  // 2. tool_permissions.json（保留已有其他策略，仅调整 global_default）
  const tpPath = path.join(profileDir, 'tool_permissions.json');
  const existingTp = C.readJson(tpPath, null);
  const tpDoc = existingTp && typeof existingTp === 'object'
    ? Object.assign(defaultToolPermissions(), existingTp)
    : defaultToolPermissions();
  if (fs.existsSync(tpPath)) {
    try { fs.copyFileSync(tpPath, tpPath + '.bak-' + Date.now()); } catch (_) {}
  }
  tpDoc.global_default = (enabled && autoAllowTools) ? 'allow' : 'prompt';
  C.writeJsonAtomic(tpPath, tpDoc);
}

function readProfileLocalToolsFlags(profileId) {
  if (!profileId) return { fullAccess: false, mcpEnabled: false, autoAllow: false };
  const dir = path.join(C.PROFILES_DIR, profileId);
  const mcp = C.readJson(path.join(dir, 'mcp_config.json'), null);
  const tp = C.readJson(path.join(dir, 'tool_permissions.json'), null);
  const mcpEnabled = !!(mcp && mcp.mcpServers && mcp.mcpServers[LOCAL_TOOLS_MCP_KEY]);
  const autoAllow = !!(tp && tp.global_default === 'allow');
  return { fullAccess: mcpEnabled && autoAllow, mcpEnabled, autoAllow };
}

function getLocalToolsStatus() {
  const store = loadStore();
  const profileIds = new Set();
  for (const a of store.accounts) if (a.profileId) profileIds.add(a.profileId);
  for (const e of (C.readProfiles().entries || [])) if (e && e.id) profileIds.add(e.id);

  let enabledCount = 0;
  let autoAllowCount = 0;
  const total = profileIds.size;
  for (const pid of profileIds) {
    const f = readProfileLocalToolsFlags(pid);
    if (f.mcpEnabled) enabledCount += 1;
    if (f.autoAllow) autoAllowCount += 1;
  }
  return {
    scriptExists: fs.existsSync(LOCAL_TOOLS_SCRIPT),
    scriptPath: LOCAL_TOOLS_SCRIPT,
    total,
    enabledCount,
    autoAllowCount,
    allEnabled: total > 0 && enabledCount === total,
    allAutoAllow: total > 0 && autoAllowCount === total,
    autoGrantFullAccess: !!store.autoGrantFullAccess,
  };
}

async function setLocalToolsAccess({ enabled = true, autoAllowTools = true, restartQuick = false, accountId = null } = {}) {
  if (enabled && !fs.existsSync(LOCAL_TOOLS_SCRIPT)) {
    throw new Error('缺少本机工具脚本：' + LOCAL_TOOLS_SCRIPT);
  }
  const store = loadStore();
  const manifest = C.readProfiles();

  // 单号模式：仅修改指定账号，不改变全局模板
  if (accountId) {
    const acc = store.accounts.find((a) => a.id === accountId || a.profileId === accountId);
    if (!acc || !acc.profileId) throw new Error('未找到目标账号');
    patchProfileLocalTools(path.join(C.PROFILES_DIR, acc.profileId), !!enabled, !!autoAllowTools);
    let restarted = false;
    if (restartQuick && manifest.last_active === acc.profileId && isQuickRunning()) {
      await quitQuickGracefully(9000);
      launchQuick();
      restarted = true;
    }
    const st = getLocalToolsStatus();
    C.audit('local_tools_account', { id: acc.id, profileId: acc.profileId, enabled: !!enabled, autoAllowTools: !!autoAllowTools, restarted });
    return { ok: true, restarted, accountId: acc.id, localTools: st };
  }

  // 全池模式：覆盖所有账号 + 写入通用配置模板 + 开启/关闭新号自动继承
  const profileIds = new Set();
  for (const a of store.accounts) if (a.profileId) profileIds.add(a.profileId);
  for (const e of (manifest.entries || [])) if (e && e.id) profileIds.add(e.id);

  for (const pid of profileIds) {
    patchProfileLocalTools(path.join(C.PROFILES_DIR, pid), !!enabled, !!autoAllowTools);
  }

  patchProfileLocalTools(TEMPLATE_DIR, !!enabled, !!autoAllowTools);
  const items = new Set(Array.isArray(store.commonTemplate.items) ? store.commonTemplate.items : []);
  items.add('mcp');
  items.add('toolPermissions');
  store.autoGrantFullAccess = !!(enabled && autoAllowTools);
  store.commonTemplate = {
    ...store.commonTemplate,
    enabled: true,
    sourceName: store.commonTemplate.sourceName || '本机全权限配置',
    savedAt: Date.now(),
    items: [...items],
  };
  saveStore(store);

  let restarted = false;
  if (restartQuick && isQuickRunning()) {
    await quitQuickGracefully(9000);
    launchQuick();
    restarted = true;
  }

  const st = getLocalToolsStatus();
  C.audit('local_tools_access', { enabled: !!enabled, autoAllowTools: !!autoAllowTools, count: profileIds.size, restarted });
  return { ok: true, restarted, localTools: st };
}

// ---------- 池状态计算与智能空闲号推荐 ----------
function computePoolStatus(acc, isActive, cfg) {
  const mPct = acc.quota && acc.quota.ok && acc.quota.monthly ? Number(acc.quota.monthly.percent || 0) : null;
  const sPct = acc.quota && acc.quota.ok && acc.quota.session ? Number(acc.quota.session.percent || 0) : null;
  const mWarn = Number((cfg && cfg.budgetMonthlyPercent) || 80);
  const sWarn = Number((cfg && cfg.budgetSessionPercent) || 80);

  if (acc.needsRelogin || (!acc.access && !acc.refresh)) {
    return { code: 'needs_relogin', label: '待管理员维护', tone: 'bad', selectable: false, score: -1000 };
  }
  if ((mPct != null && mPct >= 98) || (sPct != null && sPct >= 98)) {
    return { code: 'exhausted', label: '额度已满', tone: 'bad', selectable: false, score: -100 };
  }
  if (isActive) {
    if ((mPct != null && mPct >= mWarn) || (sPct != null && sPct >= sWarn)) {
      return { code: 'in_use_low', label: '正在使用 · 余量紧张', tone: 'warn', selectable: true, score: 10 };
    }
    return { code: 'in_use', label: '正在使用', tone: 'primary', selectable: true, score: 20 };
  }
  if (!acc.poolEnabled) {
    return { code: 'paused', label: '已暂停自动分配', tone: 'muted', selectable: true, score: 0 };
  }
  if ((mPct != null && mPct >= mWarn) || (sPct != null && sPct >= sWarn)) {
    const remM = mPct != null ? (100 - mPct) : 50;
    const remS = sPct != null ? (100 - sPct) : 50;
    return { code: 'low_quota', label: '空闲 · 余量较少', tone: 'warn', selectable: true, score: 100 + remM * 2 + remS };
  }
  const remM = mPct != null ? (100 - mPct) : 70;
  const remS = sPct != null ? (100 - sPct) : 70;
  return { code: 'available', label: '空闲可用', tone: 'ok', selectable: true, score: 500 + remM * 3 + remS };
}

function normalizeQuotaWin(win) {
  if (!win || typeof win !== 'object') return null;
  const used = Number(win.used) || 0;
  const limit = Number(win.limit) || 0;
  const remaining = win.remaining != null ? Number(win.remaining) : Math.max(0, limit - used);
  const percent = win.percent != null ? Number(win.percent) : (limit > 0 ? Math.round((100 * used / limit) * 10) / 10 : 0);
  return { ...win, used, limit, remaining, percent };
}

function sanitizeAccountForView(acc, isActive, cfg) {
  const status = computePoolStatus(acc, isActive, cfg);
  const q = acc.quota && acc.quota.ok ? acc.quota : null;
  const monthly = normalizeQuotaWin(q && q.monthly);
  const session = normalizeQuotaWin(q && q.session);
  const perm = readProfileLocalToolsFlags(acc.profileId);
  return {
    id: acc.id,
    profileId: acc.profileId || '',
    displayName: acc.displayName || acc.email || acc.profileId,
    alias: acc.alias || null,
    label: acc.alias || acc.displayName || acc.email || acc.profileId,
    email: acc.email || '',
    color: acc.color || '#4f46e5',
    group: acc.group || '',
    note: acc.note || '',
    providerType: acc.providerType || 'social',
    poolEnabled: acc.poolEnabled !== false,
    fullAccess: perm.fullAccess,
    mcpLocalTools: perm.mcpEnabled,
    autoAllowTools: perm.autoAllow,
    active: isActive,
    status,
    needsRelogin: !!acc.needsRelogin,
    reloginReason: acc.reloginReason || null,
    lastError: acc.lastError || null,
    hasToken: !!(acc.access || acc.refresh),
    tenantUrl: acc.tenantUrl || '',
    issuerUrl: acc.issuerUrl || '',
    lastUsedAt: acc.lastUsedAt || null,
    createdAt: acc.createdAt || null,
    lastProbe: acc.lastProbe || null,
    quota: q ? {
      ok: true,
      fetchedAt: q.fetchedAt,
      planLabel: q.planLabel || 'Amazon Quick',
      trialExpiresAt: q.trialExpiresAt || null,
      monthly,
      session,
      overage: q.overage || null,
    } : null,
  };
}

function listPoolView() {
  const store = loadStore();
  const manifest = C.readProfiles();
  const cfg = C.getConfig();
  const desktopLastActive = manifest.last_active || null;
  const quickRunning = isQuickRunning();

  const items = store.accounts.map((acc) => {
    const isActive = desktopLastActive ? acc.profileId === desktopLastActive : acc.id === store.activeAccountId;
    return sanitizeAccountForView(acc, isActive, cfg);
  });

  // 排序：当前使用置顶 → 空闲可用按剩余分数高到低 → 余量较少 → 已暂停 → 额满/需维护垫底
  items.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (b.status.score !== a.status.score) return b.status.score - a.status.score;
    return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
  });

  const active = items.find((x) => x.active) || null;
  const idleCandidates = items.filter((x) => !x.active && x.poolEnabled && (x.status.code === 'available' || x.status.code === 'low_quota'));
  const recommendedNext = idleCandidates[0] || null;
  const totalAvailable = items.filter((x) => x.status.code === 'available' || x.status.code === 'low_quota' || x.status.code === 'in_use' || x.status.code === 'in_use_low').length;
  const needsMaintenance = items.filter((x) => x.status.code === 'needs_relogin').length;
  const totalMonthlyRemaining = items.reduce((sum, x) => {
    if (x.status.code === 'needs_relogin') return sum;
    return sum + ((x.quota && x.quota.monthly && x.quota.monthly.remaining) || 0);
  }, 0);

  const groups = [...new Set(items.map((x) => (x.group || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

  return {
    ts: Date.now(),
    quickRunning,
    currentUserLabel: store.currentUserLabel || '',
    familyUsers: store.familyUsers,
    pinEnabled: false,
    quickgwAutostart: !!store.quickgwAutostart,
    autoSyncConversationsOnSwitch: store.autoSyncConversationsOnSwitch !== false,
    autoCopyHandoffOnSwitch: store.autoCopyHandoffOnSwitch !== false,
    groups,
    commonTemplate: store.commonTemplate,
    localTools: getLocalToolsStatus(),
    config: cfg,
    active,
    recommendedNext,
    summary: {
      total: items.length,
      available: totalAvailable,
      idleReady: idleCandidates.length,
      needsMaintenance,
      totalMonthlyRemaining,
    },
    accounts: items,
    lastSwitchHandoff,
    oauth: activeOAuth ? activeOAuth.getPublicState() : null,
    blankLogin: blankLoginState ? {
      active: true,
      startedAt: blankLoginState.startedAt,
      savedCount: blankLoginState.previousEntries.length,
    } : null,
  };
}

function pickBestIdleAccount({ excludeCurrent = true } = {}) {
  const view = listPoolView();
  const pool = view.accounts.filter((a) => {
    if (excludeCurrent && a.active) return false;
    if (!a.poolEnabled) return false;
    return a.status.code === 'available' || a.status.code === 'low_quota' || (!excludeCurrent && (a.status.code === 'in_use' || a.status.code === 'in_use_low'));
  });
  pool.sort((a, b) => (b.status.score - a.status.score) || ((a.lastUsedAt || 0) - (b.lastUsedAt || 0)));
  return pool[0] || null;
}

// ---------- 免 CDP 稳定切号引擎 ----------
async function switchToAccount(accountId, { userName, launch = true } = {}) {
  if (switchMutex) throw new Error('正在切换账号中，请稍等几秒再操作');
  const job = O.newJob('pool_switch', { accountId });

  switchMutex = (async () => {
    let backupProfilesSnapshot = null;
    try {
      let store = loadStore();
      const target = store.accounts.find((a) => a.id === accountId || a.profileId === accountId);
      if (!target) throw new Error('未找到目标账号');
      if (target.needsRelogin || (!target.access && !target.refresh)) {
        throw new Error('该账号登录已失效，请管理员先重新登录此账号');
      }

      const profileId = ensureProfileId(target);
      const provider = String(target.providerType || 'social').toLowerCase();
      let account = { ...target, profileId, providerType: provider };

      O.step(job, '1/5 正在关闭旧账号 AWS Quick…');
      const wasRunning = isQuickRunning();
      if (wasRunning) {
        await quitQuickGracefully(1200);
      }

      // 2. 切走前回写旧激活号的最新凭据（防止刚轮换的新 token 丢失），并在客户端关闭后零竞争同步旧号最新对话
      const manifestBefore = C.readProfiles();
      backupProfilesSnapshot = JSON.parse(JSON.stringify(manifestBefore));
      const prevPid = manifestBefore.last_active || null;
      let prevAccountForSync = null;
      let handoff = null;
      if (prevPid && prevPid !== profileId) {
        const prevAcc = store.accounts.find((a) => a.profileId === prevPid);
        if (prevAcc) {
          O.step(job, '2/5 保存原账号最新登录态…');
          prevAccountForSync = prevAcc;
          const prevSvc = KC.getKeychainServiceName(prevPid, prevAcc.providerType || 'social');
          const prevRead = await KC.readKeychainSecretAsync(prevSvc);
          if (prevRead && prevRead.ok && prevRead.value) {
            try {
              const parsed = QC.normalizeCredential(JSON.parse(prevRead.value), (manifestBefore.entries || []).find((e) => e.id === prevPid));
              if (parsed.access || parsed.refresh) {
                const up = upsertAccount(store, { ...parsed, id: prevAcc.id, profileId: prevPid, needsRelogin: false, reloginReason: null }, {});
                store = up.store;
                prevAccountForSync = up.account;
                saveStore(store);
              }
            } catch (_) {}
          }
          // 先取已落盘的最近对话作为即时续聊备选；真正云端增量同步放到拉起新号 Quick 后后台并行执行，绝不拖慢切号
          try {
            handoff = Conv.getLatestConversationForAccount(prevAccountForSync.id);
          } catch (_) {}
        }
      }

      // 3. 核验目标账号在 Windows 凭据管理器中的凭据（已有则保护不覆盖，缺失则从号池补写）
      O.step(job, '3/5 同步目标账号凭据与配置…');
      const svcName = KC.getKeychainServiceName(profileId, provider);
      const existsRes = await KC.hasKeychainSecretAsync(svcName, 'session');
      if (existsRes && existsRes.ok && existsRes.exists === false) {
        // 凭据管理器里还没有该号（例如从远程 VPS 导入/OAuth 新登的号）→ 先确保 token 新鲜再写入
        try {
          account = await QC.ensureFreshToken(account, async (next) => { persistAccountPatch(account.id, next); }, false, {
            skipKeychainRead: true,
            isQuickRunning: () => false,
            readManifest: () => ({ entries: [], last_active: null }),
          });
        } catch (err) {
          if (err && err.needsRelogin) {
            persistAccountPatch(account.id, { needsRelogin: true, reloginReason: err.message });
          }
          throw err;
        }
        KC.writeKeychainSecret(svcName, JSON.stringify(QC.toKeychainPayload(account)), 'session');
      }

      // 确保 profile 目录存在并自动同步家庭通用配置模板（此时 Quick 已关，.db 也可完整同步！）
      const targetDir = path.join(C.PROFILES_DIR, profileId);
      fs.mkdirSync(targetDir, { recursive: true });
      const tplRes = applyCommonTemplateToProfile(profileId, { quickRunning: false });
      if (tplRes.copied && tplRes.copied.length) {
        O.step(job, '已自动同步通用配置：' + tplRes.copied.join('、'));
      }

      // 4. 原子更新 ~/.quickwork/profiles.json（保留所有有效条目）
      O.step(job, '4/5 更新客户端活动账号清单…');
      const entries = Array.isArray(manifestBefore.entries) ? [...manifestBefore.entries] : [];
      const nowIso = new Date().toISOString();
      const newEntry = {
        id: profileId,
        provider,
        display_name: account.displayName || account.email || profileId,
        data_path: `profiles/${profileId}`,
        login_metadata: {
          issuer_url: account.issuerUrl || QC.DEFAULT_SOCIAL_ISSUER_URL,
          tenant_url: account.tenantUrl || '',
          client_id: account.clientId || '',
        },
        created_at: account.createdAt ? new Date(account.createdAt).toISOString() : nowIso,
        last_used_at: nowIso,
        refresh_failing_since: null,
      };
      const idx = entries.findIndex((e) => e && e.id === profileId);
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], ...newEntry, created_at: entries[idx].created_at || newEntry.created_at };
      } else {
        entries.push(newEntry);
      }

      C.writeProfiles({
        version: manifestBefore.version || 1,
        entries,
        last_active: profileId,
      });

      // 更新号池记录
      store = loadStore();
      const tIdx = store.accounts.findIndex((a) => a.id === account.id);
      if (tIdx >= 0) {
        store.accounts[tIdx] = {
          ...store.accounts[tIdx],
          ...account,
          lastUsedAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      store.activeAccountId = account.id;
      if (typeof userName === 'string') store.currentUserLabel = userName.trim().slice(0, 24);
      saveStore(store);

      // 5. 立即拉起正常版 Amazon Quick（同时后台异步并行同步原账号最新对话，利用 Quick 开屏动画时间互不耽误）
      const targetLabel = account.alias || account.displayName || account.email || profileId;
      const switchedAt = Date.now();
      if (prevAccountForSync && store.autoSyncConversationsOnSwitch !== false && !prevAccountForSync.needsRelogin && (prevAccountForSync.access || prevAccountForSync.refresh)) {
        const bgAcc = { ...prevAccountForSync };
        setImmediate(() => {
          Conv.syncOneAccount(bgAcc, {
            force: false,
            maxSessions: 15,
            isQuickRunning: () => false,
            onPersist: (next) => persistAccountPatch(bgAcc.id, next),
          }).then(() => {
            const fresh = Conv.getLatestConversationForAccount(bgAcc.id);
            if (fresh && fresh.handoffPrompt) {
              lastSwitchHandoff = {
                key: `${switchedAt}:${fresh.sessionId}:${fresh.updatedAt || 0}`,
                switchedAt,
                targetLabel,
                handoff: fresh,
              };
            }
          }).catch(() => {});
        });
      }

      let launched = false;
      if (launch) {
        O.step(job, '5/5 启动 AWS Quick 客户端…');
        launchQuick();
        launched = true;
        // 后台异步确认存活（若遇 SingletonLock 早退则自动重试一次）并置前，绝不卡住前端遮罩
        setImmediate(async () => {
          try {
            await O.sleep(1500);
            if (!isQuickRunning()) {
              launchQuick();
              await O.sleep(1800);
            }
            if (isQuickRunning()) focusQuickWindow();
          } catch (_) {}
        });
      }

      if (handoff && handoff.handoffPrompt && (!lastSwitchHandoff || lastSwitchHandoff.switchedAt < switchedAt)) {
        lastSwitchHandoff = {
          key: `${switchedAt}:${handoff.sessionId}:${handoff.updatedAt || 0}`,
          switchedAt,
          targetLabel,
          handoff,
        };
      }

      C.audit('pool_switch', { id: account.id, profileId, userName: store.currentUserLabel, launched, hasHandoff: !!handoff });
      O.finish(job, { id: account.id, profileId, label: targetLabel, launched });
      return {
        ok: true,
        job,
        launched,
        handoff,
        switchedAt,
        account: sanitizeAccountForView(account, true, C.getConfig()),
      };
    } catch (e) {
      // 失败回滚 profiles.json
      if (backupProfilesSnapshot && !backupProfilesSnapshot._missing) {
        try { C.writeProfiles(backupProfilesSnapshot); } catch (_) {}
      }
      O.fail(job, e);
      C.audit('pool_switch_failed', { accountId, error: e.message || String(e) });
      throw e;
    } finally {
      switchMutex = null;
    }
  })();

  return switchMutex;
}

/** 家人一键取用/换空闲账号 */
async function claimIdleAccount({ excludeCurrent = true, userName } = {}) {
  let target = pickBestIdleAccount({ excludeCurrent });
  if (!target && excludeCurrent) {
    // 若除了当前号没有其他空闲号，检查当前号是否还可用
    const fallback = pickBestIdleAccount({ excludeCurrent: false });
    if (fallback && fallback.active) {
      focusOrLaunchQuick();
      return { ok: true, reusedCurrent: true, account: fallback, message: '当前账号已是唯一可用账号，已为你打开 AWS Quick' };
    }
  }
  if (!target) {
    throw new Error('账号池暂时没有空闲可用账号（可能额度已满或需管理员重新登录）');
  }
  return switchToAccount(target.id, { userName, launch: true });
}

// ---------- OAuth 登录会话管理（本机无痕 / 远程 VPS / 失效号一键重登） ----------
async function completeOAuthIntoPool(cred, session) {
  let store = loadStore();
  const profileId = cred.profileId || ensureProfileId(cred);
  const provider = String(cred.providerType || 'social').toLowerCase();
  const mergedCred = {
    ...cred,
    profileId,
    providerType: provider,
    id: session.reloginTargetId || undefined,
    needsRelogin: false,
    reloginReason: null,
    lastError: null,
  };

  // 1. 写入 Windows 凭据管理器（让桌面端随时可以切过去直接用！）
  const svc = KC.getKeychainServiceName(profileId, provider);
  KC.writeKeychainSecret(svc, JSON.stringify(QC.toKeychainPayload(mergedCred)), 'session');

  // 2. 确保 profile 目录存在；若开启了全权限策略，新号入库即自动授予完全权限
  const pDir = path.join(C.PROFILES_DIR, profileId);
  fs.mkdirSync(pDir, { recursive: true });
  if (store.autoGrantFullAccess) {
    try { patchProfileLocalTools(pDir, true, true); } catch (_) {}
  }

  // 3. 写入号池
  const up = upsertAccount(store, mergedCred, { source: session.remote ? 'remote_oauth' : 'local_oauth' });
  store = up.store;
  saveStore(store);

  // 4. 顺手同步登记进 profiles.json（不改动当前 last_active，避免打断正在用电脑的家人！）
  try {
    const manifest = C.readProfiles();
    const entries = Array.isArray(manifest.entries) ? [...manifest.entries] : [];
    const nowIso = new Date().toISOString();
    const entryObj = {
      id: profileId,
      provider,
      display_name: up.account.displayName || up.account.email || profileId,
      data_path: `profiles/${profileId}`,
      login_metadata: {
        issuer_url: up.account.issuerUrl || QC.DEFAULT_SOCIAL_ISSUER_URL,
        tenant_url: up.account.tenantUrl || '',
        client_id: up.account.clientId || '',
      },
      created_at: nowIso,
      last_used_at: nowIso,
      refresh_failing_since: null,
    };
    const idx = entries.findIndex((e) => e && e.id === profileId);
    if (idx >= 0) entries[idx] = { ...entries[idx], ...entryObj, created_at: entries[idx].created_at || nowIso };
    else entries.push(entryObj);
    C.writeProfiles({
      version: manifest.version || 1,
      entries,
      last_active: manifest.last_active || profileId,
    });
  } catch (_) {}

  // 5. 异步刷一次真实云端额度
  refreshAccountQuota(up.account.id).catch(() => {});
  C.audit('pool_oauth_complete', { id: up.account.id, profileId, remote: session.remote, relogin: !!session.reloginTargetId });
  return up.account;
}

async function startOAuth({ provider = 'social', remote = false, accountId = null } = {}) {
  if (activeOAuth) {
    try { activeOAuth.cancel(); } catch (_) {}
    activeOAuth = null;
  }
  let existingAccount = null;
  if (accountId) {
    const store = loadStore();
    existingAccount = store.accounts.find((a) => a.id === accountId || a.profileId === accountId) || null;
  }
  activeOAuth = await QC.createOAuthSession({
    provider,
    remote: !!remote,
    existingAccount,
    onComplete: completeOAuthIntoPool,
  });
  return activeOAuth.getPublicState();
}

function getOAuthStatus() {
  return activeOAuth ? activeOAuth.getPublicState() : null;
}

async function submitOAuthCallback(url) {
  if (!activeOAuth) throw new Error('当前没有进行中的登录会话，请先点击发起登录');
  return activeOAuth.submitCallback(url);
}

function cancelOAuth() {
  if (!activeOAuth) return { cancelled: false };
  const st = activeOAuth.cancel();
  activeOAuth = null;
  return { cancelled: true, state: st };
}

// ---------- 凭证 JSON 导入（兼容远程 VPS / AWS-Quick-Tools / Magpie） ----------
async function importCredentialsJson(text) {
  const { items, errors } = QC.parseImportedCredentials(String(text || ''));
  if (!items.length) throw new Error(errors.join('；') || '未检测到有效凭证');

  let store = loadStore();
  const imported = [];
  for (const cred of items) {
    const profileId = ensureProfileId(cred);
    const provider = String(cred.providerType || 'social').toLowerCase();
    const svc = KC.getKeychainServiceName(profileId, provider);
    KC.writeKeychainSecret(svc, JSON.stringify(QC.toKeychainPayload({ ...cred, profileId, providerType: provider })), 'session');
    const pDir = path.join(C.PROFILES_DIR, profileId);
    fs.mkdirSync(pDir, { recursive: true });
    if (store.autoGrantFullAccess) {
      try { patchProfileLocalTools(pDir, true, true); } catch (_) {}
    }

    const up = upsertAccount(store, { ...cred, profileId, providerType: provider, needsRelogin: false, reloginReason: null }, { source: 'import_json' });
    store = up.store;
    imported.push(up.account);
  }
  saveStore(store);

  // 刷新刚导入账号的真实额度
  for (const acc of imported) {
    await refreshAccountQuota(acc.id).catch(() => {});
  }
  C.audit('pool_import_json', { count: imported.length });
  return { ok: true, count: imported.length, errors, accounts: imported.map((a) => ({ id: a.id, name: a.alias || a.displayName || a.email })) };
}

// ---------- 桌面空白窗新增账号（免 CDP 兜底路线） ----------
async function startDesktopBlankLogin() {
  await syncFromDesktop({ includeExisting: false }).catch(() => {});
  const prevManifest = C.readProfiles();
  if (isQuickRunning()) await quitQuickGracefully(9000);

  blankLoginState = {
    startedAt: Date.now(),
    previousEntries: Array.isArray(prevManifest.entries) ? prevManifest.entries : [],
    previousLastActive: prevManifest.last_active || null,
  };

  // 先备份再置空 profiles.json，让 Quick 弹出干净登录窗
  try {
    if (fs.existsSync(C.PROFILES_JSON)) {
      fs.copyFileSync(C.PROFILES_JSON, path.join(C.BACKUPS, 'profiles-before-blank-' + Date.now() + '.json'));
    }
  } catch (_) {}
  C.writeJsonAtomic(C.PROFILES_JSON, { version: prevManifest.version || 1, entries: [], last_active: null });
  launchQuick();
  return { ok: true, startedAt: blankLoginState.startedAt };
}

async function pollDesktopBlankLogin() {
  if (!blankLoginState) return null;
  const manifest = C.readProfiles();
  if (!manifest.last_active || !Array.isArray(manifest.entries) || !manifest.entries.length) return null;
  const activeEntry = manifest.entries.find((e) => e && e.id === manifest.last_active);
  if (!activeEntry) return null;

  const prev = blankLoginState;
  blankLoginState = null;

  const merged = [...manifest.entries];
  for (const old of prev.previousEntries) {
    if (old && old.id && !merged.some((m) => m && m.id === old.id)) merged.push(old);
  }
  C.writeProfiles({ version: manifest.version || 1, entries: merged, last_active: activeEntry.id });
  if (loadStore().autoGrantFullAccess) {
    try { patchProfileLocalTools(path.join(C.PROFILES_DIR, activeEntry.id), true, true); } catch (_) {}
  }
  await syncFromDesktop({ onlyProfileId: activeEntry.id });
  await refreshAccountQuota(activeEntry.id).catch(() => {});
  return { ok: true, id: activeEntry.id, name: activeEntry.display_name || activeEntry.id };
}

async function cancelDesktopBlankLogin() {
  if (!blankLoginState) return { restored: false };
  const prev = blankLoginState;
  blankLoginState = null;
  if (isQuickRunning()) await quitQuickGracefully(8000);

  const cur = C.readProfiles();
  const merged = [...prev.previousEntries];
  for (const e of (cur.entries || [])) {
    if (e && e.id && !merged.some((m) => m && m.id === e.id)) merged.push(e);
  }
  if (merged.length) {
    C.writeProfiles({
      version: cur.version || 1,
      entries: merged,
      last_active: cur.last_active || prev.previousLastActive || merged[0].id,
    });
  }
  launchQuick();
  return { restored: true };
}

// ---------- 管理员账号编辑 & 安全移除 ----------
function updateAccountMeta(accountId, patch) {
  const store = loadStore();
  const idx = store.accounts.findIndex((a) => a.id === accountId || a.profileId === accountId);
  if (idx < 0) throw new Error('未找到账号');
  const acc = store.accounts[idx];
  if (patch.alias !== undefined) acc.alias = String(patch.alias || '').trim().slice(0, 30) || null;
  if (patch.color !== undefined) acc.color = String(patch.color || '').trim() || acc.color;
  if (patch.group !== undefined) acc.group = String(patch.group || '').trim().slice(0, 24);
  if (patch.note !== undefined) acc.note = String(patch.note || '').trim().slice(0, 120);
  if (patch.poolEnabled !== undefined) acc.poolEnabled = !!patch.poolEnabled;
  acc.updatedAt = Date.now();
  saveStore(store);
  // 同步旧 accounts.meta.json
  if (acc.profileId) C.setMeta(acc.profileId, { alias: acc.alias, color: acc.color });
  return sanitizeAccountForView(acc, acc.id === store.activeAccountId, C.getConfig());
}

async function removeAccountSafely(accountId) {
  const store = loadStore();
  const idx = store.accounts.findIndex((a) => a.id === accountId || a.profileId === accountId);
  if (idx < 0) throw new Error('未找到账号');
  const acc = store.accounts[idx];

  let backupFile = null;
  if (acc.profileId) {
    const dir = path.join(C.PROFILES_DIR, acc.profileId);
    if (fs.existsSync(dir)) {
      backupFile = O.backupDir(dir, 'removed-' + acc.profileId);
    }
    // 从 profiles.json 摘除（若仍存在）
    try {
      const m = C.readProfiles();
      if (m.entries.some((e) => e.id === acc.profileId)) {
        const rest = m.entries.filter((e) => e.id !== acc.profileId);
        if (rest.length) {
          C.writeProfiles({
            version: m.version || 1,
            entries: rest,
            last_active: m.last_active === acc.profileId ? rest[0].id : m.last_active,
          });
        }
      }
    } catch (_) {}
  }

  store.accounts.splice(idx, 1);
  if (store.activeAccountId === acc.id) store.activeAccountId = store.accounts[0] ? store.accounts[0].id : null;
  saveStore(store);
  C.audit('pool_remove', { id: acc.id, profileId: acc.profileId, backupFile });
  return { ok: true, id: acc.id, backupFile };
}

function exportAccountJson(accountId) {
  const store = loadStore();
  const acc = store.accounts.find((a) => a.id === accountId || a.profileId === accountId);
  if (!acc) throw new Error('未找到账号');
  return QC.toExportJson(acc);
}

// ---------- 云端内置技能一键批量开关（POST api/ws-rpc skill_toggle） ----------
async function getFreshAccountForApi(acc) {
  return QC.ensureFreshToken(
    acc,
    async (next) => { persistAccountPatch(acc.id, next); },
    false,
    { isQuickRunning, readManifest: C.readProfiles }
  );
}

async function listAccountSkills(accountId) {
  const store = loadStore();
  const acc = store.accounts.find((a) => a.id === accountId || a.profileId === accountId)
    || store.accounts.find((a) => a.id === store.activeAccountId)
    || store.accounts[0];
  if (!acc) throw new Error('未找到目标账号');
  if (acc.needsRelogin || (!acc.access && !acc.refresh)) throw new Error('该账号未登录或已失效');

  const cur = await getFreshAccountForApi(acc);
  const cap = await QC.invokeQbsApi(cur, 'api/capabilities', 'GET', {}, 20000);
  const rawSkills = Array.isArray(cap && cap.skills) ? cap.skills : [];
  const skills = rawSkills.map((s) => ({
    id: String(s.id || s.portableId || ''),
    displayName: String(s.displayName || s.id || ''),
    description: String(s.description || '').slice(0, 140),
    source: String(s.source || 'bundled'),
    enabled: s.enabled !== false,
    icon: typeof s.icon === 'string' ? s.icon : '',
  })).filter((s) => s.id);

  const bundled = skills.filter((s) => s.source === 'bundled');
  return {
    ok: true,
    accountId: acc.id,
    label: acc.alias || acc.displayName || acc.email || acc.profileId,
    total: skills.length,
    bundledTotal: bundled.length,
    bundledEnabled: bundled.filter((s) => s.enabled).length,
    skills,
  };
}

async function toggleSingleSkill(accountId, skillId, enabled) {
  const store = loadStore();
  const acc = store.accounts.find((a) => a.id === accountId || a.profileId === accountId);
  if (!acc) throw new Error('未找到目标账号');
  if (!skillId) throw new Error('缺少 skillId');

  const cur = await getFreshAccountForApi(acc);
  const res = await QC.invokeQbsApi(cur, 'api/ws-rpc', 'POST', {
    type: 'skill_toggle',
    payload: { skill_id: String(skillId), enabled: !!enabled },
  }, 15000);
  const frames = Array.isArray(res && res.frames) ? res.frames : [];
  const errFrame = frames.find((f) => f && f.type === 'error');
  if (errFrame) throw new Error((errFrame.payload && errFrame.payload.message) || '切换技能失败');
  return { ok: true, accountId: acc.id, skillId, enabled: !!enabled };
}

async function batchToggleBundledSkills({ accountId = null, enabled = false, keepIds = ['acp_agents'] } = {}) {
  const store = loadStore();
  const targets = accountId
    ? store.accounts.filter((a) => a.id === accountId || a.profileId === accountId)
    : store.accounts.filter((a) => !a.needsRelogin && (a.access || a.refresh) && a.tenantUrl);

  if (!targets.length) throw new Error('没有可操作的健康账号');
  const keepSet = new Set(Array.isArray(keepIds) ? keepIds.map((x) => String(x || '').trim()).filter(Boolean) : []);
  const targetEnabled = !!enabled;
  const results = [];

  for (const acc of targets) {
    const label = acc.alias || acc.displayName || acc.email || acc.profileId;
    try {
      const cur = await getFreshAccountForApi(acc);
      const cap = await QC.invokeQbsApi(cur, 'api/capabilities', 'GET', {}, 20000);
      const bundled = (Array.isArray(cap && cap.skills) ? cap.skills : []).filter((s) => s && s.id && s.source === 'bundled');

      const todo = [];
      let kept = 0;
      let already = 0;
      for (const s of bundled) {
        const want = (!targetEnabled && keepSet.has(s.id)) ? true : targetEnabled;
        if (!targetEnabled && keepSet.has(s.id)) kept += 1;
        if (Boolean(s.enabled) === want) {
          already += 1;
        } else {
          todo.push({ id: s.id, want });
        }
      }

      let changed = 0;
      let failed = 0;
      const queue = [...todo];
      const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          if (!item) break;
          try {
            const r = await QC.invokeQbsApi(cur, 'api/ws-rpc', 'POST', {
              type: 'skill_toggle',
              payload: { skill_id: item.id, enabled: item.want },
            }, 15000);
            const frames = Array.isArray(r && r.frames) ? r.frames : [];
            if (frames.some((f) => f && f.type === 'error')) failed += 1;
            else changed += 1;
          } catch (_) {
            failed += 1;
          }
        }
      });
      await Promise.all(workers);

      results.push({ ok: true, accountId: acc.id, label, totalBundled: bundled.length, changed, already, kept, failed });
    } catch (e) {
      results.push({ ok: false, accountId: acc.id, label, error: (e && e.message) || String(e), changed: 0, failed: 0 });
    }
  }

  const totalChanged = results.reduce((s, r) => s + (r.changed || 0), 0);
  const okAccounts = results.filter((r) => r.ok).length;
  C.audit('skills_batch_toggle', { enabled: targetEnabled, keepIds: [...keepSet], accounts: targets.length, okAccounts, totalChanged });
  return { ok: true, enabled: targetEnabled, keepIds: [...keepSet], accounts: targets.length, okAccounts, totalChanged, results };
}

async function setAccountsLocale({ accountId = null, locale = 'zh-CN', timezone = 'Asia/Shanghai' } = {}) {
  const store = loadStore();
  const targets = accountId
    ? store.accounts.filter((a) => a.id === accountId || a.profileId === accountId)
    : store.accounts.filter((a) => !a.needsRelogin && (a.access || a.refresh) && a.tenantUrl);

  if (!targets.length) throw new Error('没有可操作的健康账号');
  const results = [];

  for (const acc of targets) {
    const label = acc.alias || acc.displayName || acc.email || acc.profileId;
    try {
      const cur = await getFreshAccountForApi(acc);
      const payload = { default_locale: String(locale || 'zh-CN') };
      if (timezone) payload.user_timezone = String(timezone);
      const r = await QC.invokeQbsApi(cur, 'api/ws-rpc', 'POST', {
        type: 'update_settings',
        payload,
      }, 15000);
      const frames = Array.isArray(r && r.frames) ? r.frames : [];
      const errFrame = frames.find((f) => f && f.type === 'error');
      if (errFrame) throw new Error((errFrame.payload && errFrame.payload.message) || '设置语言失败');
      const updatedFrame = frames.find((f) => f && (f.type === 'settings_updated' || f.type === 'settings'));
      const actualLocale = updatedFrame && updatedFrame.payload && updatedFrame.payload.user_preferences
        ? updatedFrame.payload.user_preferences.default_locale
        : locale;
      results.push({ ok: true, accountId: acc.id, label, locale: actualLocale || locale });
    } catch (e) {
      results.push({ ok: false, accountId: acc.id, label, error: (e && e.message) || String(e) });
    }
  }

  const okAccounts = results.filter((r) => r.ok).length;
  C.audit('accounts_set_locale', { locale, timezone, accounts: targets.length, okAccounts });
  return { ok: true, locale, timezone, accounts: targets.length, okAccounts, results };
}

// 启动时自动把空白登录检测挂在后台轮询
setInterval(() => {
  if (blankLoginState) pollDesktopBlankLogin().catch(() => {});
}, 2500).unref();

module.exports = {
  STORE_FILE,
  TEMPLATE_DIR,
  loadStore,
  saveStore,
  checkPin,
  setAdminPin,
  setFamilySettings,
  isQuickRunning,
  quitQuickGracefully,
  launchQuick,
  focusOrLaunchQuick,
  syncFromDesktop,
  refreshAccountQuota,
  probeAccountHealth,
  refreshAllQuotas,
  saveCommonTemplate,
  applyCommonTemplateToProfile,
  applyCommonTemplateToAll,
  getLocalToolsStatus,
  setLocalToolsAccess,
  listPoolView,
  pickBestIdleAccount,
  switchToAccount,
  claimIdleAccount,
  startOAuth,
  getOAuthStatus,
  submitOAuthCallback,
  cancelOAuth,
  importCredentialsJson,
  startDesktopBlankLogin,
  pollDesktopBlankLogin,
  cancelDesktopBlankLogin,
  updateAccountMeta,
  removeAccountSafely,
  exportAccountJson,
  listAccountSkills,
  toggleSingleSkill,
  batchToggleBundledSkills,
  setAccountsLocale,
};

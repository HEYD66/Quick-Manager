'use strict';
/**
 * lib/quick-cloud.js — Amazon Quick 云端 API、凭据归一化、防双花续期、
 * 全号池实时额度查询，以及免 CDP 的本机无痕 & 远程 VPS 跨设备 OAuth 登录引擎
 */

const { createHash, randomBytes, randomUUID } = require('crypto');
const { existsSync } = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { homedir } = require('os');
const { join } = require('path');
const KC = require('./keychain');

const APP_VERSION = '1.2.4660';
const DEFAULT_SOCIAL_ISSUER_URL = 'https://identitycenter.amazonaws.com/ssoins-7223e642b2afb64c';
const SOCIAL_DATA_PLANE = 'https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev';
const SOCIAL_SCOPE = 'quicksight:read_write';
const DISCOVERY_ENTRY = {
  social: 'https://quick.aws.com/sn',
  enterprise: 'https://quicksight.aws.amazon.com/sn/start/app-integrations/quickwork-enterprise-login',
};
const REFRESH_LEAD_MS = 5 * 60 * 1000;
const KEEP_RENEWED_MS = 60 * 1000;
const GATEWAY_PROVIDERS = new Set(['gateway', 'social_gateway']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const randToken = () => b64url(randomBytes(32));

function hostFromUrl(u) {
  const s = str(u);
  if (!s) return '';
  try { return new URL(s.includes('://') ? s : `https://${s}`).host; } catch (_) { return ''; }
}

function regionFromUrl(u, fallback = '') {
  const s = str(u);
  if (!s) return fallback;
  const m = s.match(/\.([a-z]{2}-[a-z]+-\d+)\.(?:prod|beta|alpha|preprod)\./i)
    || s.match(/(?:oidc|sso|portal\.sso)\.([a-z]{2}-[a-z]+-\d+)\.amazonaws\.com/i)
    || s.match(/\.([a-z]{2}-[a-z]+-\d+)\.(?:amazonaws\.com|aws\.dev|quick\.aws\.(?:com|dev))/i);
  return m ? m[1].toLowerCase() : fallback;
}

function toMs(ts, fallback = 0) {
  if (ts == null || ts === '') return fallback;
  if (typeof ts === 'string' && isNaN(Number(ts))) {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function isGatewayProvider(provider) {
  return GATEWAY_PROVIDERS.has(str(provider).toLowerCase());
}

// ---------- 无痕浏览器打开 ----------
function resolvePrivateBrowsers() {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    { exe: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), flag: '--inprivate', name: 'Edge InPrivate' },
    { exe: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), flag: '--inprivate', name: 'Edge InPrivate' },
    { exe: join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), flag: '--inprivate', name: 'Edge InPrivate' },
    { exe: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), flag: '--incognito', name: 'Chrome 无痕' },
    { exe: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), flag: '--incognito', name: 'Chrome 无痕' },
    { exe: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'), flag: '--incognito', name: 'Chrome 无痕' },
  ];
}

function openPrivateBrowser(rawUrl) {
  const url = str(rawUrl);
  if (!/^https?:\/\//i.test(url) || /[\r\n\0]/.test(url)) {
    return { opened: false, inPrivate: false, browser: null };
  }
  if (process.platform === 'win32') {
    for (const cand of resolvePrivateBrowsers()) {
      if (existsSync(cand.exe)) {
        try {
          const child = spawn(cand.exe, [cand.flag, url], { detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          return { opened: true, inPrivate: true, browser: cand.name };
        } catch (_) {}
      }
    }
    try {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { opened: true, inPrivate: false, browser: '默认浏览器' };
    } catch (_) {
      return { opened: false, inPrivate: false, browser: null };
    }
  }
  return { opened: false, inPrivate: false, browser: null };
}

// ---------- 凭据归一化 / 导出 / 导入 ----------
function normalizeCredential(raw, profileMeta = null) {
  const cred = raw || {};
  const access = str(cred.access ?? cred.accessToken ?? cred.access_token);
  const refresh = str(cred.refresh ?? cred.refreshToken ?? cred.refresh_token);
  const tenantUrl = str(cred.tenantUrl ?? cred.tenant_url ?? (profileMeta && profileMeta.login_metadata && profileMeta.login_metadata.tenant_url)).replace(/\/+$/, '');
  const issuerUrl = str(cred.issuerUrl ?? cred.issuer_url ?? (profileMeta && profileMeta.login_metadata && profileMeta.login_metadata.issuer_url)).replace(/\/+$/, '');
  const clientId = str(cred.clientId ?? cred.client_id ?? (profileMeta && profileMeta.login_metadata && profileMeta.login_metadata.client_id));
  const clientSecret = str(cred.clientSecret ?? cred.client_secret);
  const providerType = str(cred.providerType ?? cred.provider ?? (profileMeta && profileMeta.provider)) || 'social';
  const region = str(cred.region) || regionFromUrl(issuerUrl) || regionFromUrl(tenantUrl) || 'us-east-1';

  const expires = toMs(cred.expires ?? cred.expiresAt ?? cred.access_token_expiry)
    || (Number(cred.expiresIn ?? cred.expires_in) > 0 ? Date.now() + Number(cred.expiresIn ?? cred.expires_in) * 1000 : 0);
  const refreshExpiresAt = toMs(cred.refreshExpiresAt ?? cred.refresh_token_expiry)
    || (Number(cred.refreshExpiresIn ?? cred.refresh_expires_in) > 0 ? Date.now() + Number(cred.refreshExpiresIn ?? cred.refresh_expires_in) * 1000 : 0);
  const clientSecretExpiresAt = toMs(cred.clientSecretExpiresAt ?? cred.client_secret_expires_at);

  const email = str(cred.email || (str(cred.accountId).includes('@') ? cred.accountId : ''));
  const displayName = str(cred.displayName ?? cred.display_name ?? (profileMeta && profileMeta.display_name));
  const firstName = str(cred.firstName ?? cred.first_name);
  const lastName = str(cred.lastName ?? cred.last_name);
  const role = str(cred.role) || 'EXPLORER';
  const externalId = str(cred.externalId ?? cred.external_id);
  const awsAccountId = str(cred.awsAccountId ?? cred.aws_account_id);
  const accountOwnership = str(cred.accountOwnership ?? cred.account_ownership) || 'OWNER';
  const profileId = str(cred.profileId ?? cred.profile_id ?? (profileMeta && profileMeta.id));

  return {
    access, refresh, expires, refreshExpiresAt,
    clientId, clientSecret, clientSecretExpiresAt,
    issuerUrl, tenantUrl, wsHost: hostFromUrl(tenantUrl), region, providerType,
    email, displayName, firstName, lastName, role, externalId, awsAccountId, accountOwnership, profileId,
  };
}

function toKeychainPayload(account) {
  const nowSec = Date.now() / 1000;
  return {
    refresh_token: account.refresh || '',
    refresh_token_expiry: account.refreshExpiresAt ? account.refreshExpiresAt / 1000 : nowSec + 90 * 86400,
    access_token: account.access || '',
    aws_account_id: account.awsAccountId || '',
    account_ownership: account.accountOwnership || 'OWNER',
    account_ownership_checked_at: nowSec,
    access_token_expiry: account.expires ? account.expires / 1000 : nowSec + 3600,
    client_id: account.clientId || '',
    ...(account.clientSecret ? { client_secret: account.clientSecret } : {}),
    ...(account.clientSecretExpiresAt ? { client_secret_expires_at: account.clientSecretExpiresAt / 1000 } : {}),
    issuer_url: account.issuerUrl || '',
    tenant_url: account.tenantUrl || '',
    display_name: account.displayName || account.email || 'Amazon Quick',
    email: account.email || '',
    first_name: account.firstName || '',
    last_name: account.lastName || '',
    role: account.role || 'EXPLORER',
    ...(account.externalId ? { external_id: account.externalId } : {}),
  };
}

function toExportJson(account) {
  return {
    access_token: account.access || '',
    refresh_token: account.refresh || '',
    access_token_expiry: account.expires ? Math.floor(account.expires / 1000) : 0,
    ...(account.refreshExpiresAt ? { refresh_token_expiry: Math.floor(account.refreshExpiresAt / 1000) } : {}),
    client_id: account.clientId || '',
    ...(account.clientSecret ? { client_secret: account.clientSecret } : {}),
    ...(account.clientSecretExpiresAt ? { client_secret_expires_at: Math.floor(account.clientSecretExpiresAt / 1000) } : {}),
    issuer_url: account.issuerUrl || '',
    tenant_url: account.tenantUrl || '',
    provider: account.providerType || 'social',
    region: account.region || 'us-east-1',
    ...(account.awsAccountId ? { aws_account_id: account.awsAccountId } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.displayName ? { display_name: account.displayName } : {}),
    ...(account.profileId ? { profile_id: account.profileId } : {}),
    ...(account.externalId ? { external_id: account.externalId } : {}),
  };
}

function parseImportedCredentials(text) {
  let root;
  try { root = JSON.parse(text); } catch (_) { return { items: [], errors: ['内容不是合法的 JSON 格式'] }; }
  const items = [];
  const errors = [];
  const seen = new Set();

  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    // 兼容 awsquick-2api oauth-sessions.json 结构
    if (node.tokens && (node.tokens.access_token || node.tokens.refresh_token)) {
      const ui = node.user_info || {};
      const cli = node.client || {};
      const norm = normalizeCredential({
        access_token: node.tokens.access_token || node.jwt,
        refresh_token: node.tokens.refresh_token,
        access_token_expiry: node.usable_until,
        client_id: cli.client_id,
        client_secret: cli.client_secret,
        issuer_url: cli.issuer_url || node.issuer_url,
        tenant_url: node.tenant_url,
        region: cli.idc_region || node.region,
        email: ui.email,
        display_name: ui.display_name || ui.email,
        first_name: ui.first_name,
        last_name: ui.last_name,
        aws_account_id: ui.aws_account_id,
        external_id: ui.external_id,
        role: ui.role,
        account_ownership: ui.account_ownership,
      });
      if (norm.tenantUrl) items.push(norm);
      else errors.push(`账号 ${norm.email || norm.displayName || '未知'} 缺少 tenant_url`);
      return;
    }
    const hasToken = !!(str(node.access ?? node.accessToken ?? node.access_token)
      || str(node.refresh ?? node.refreshToken ?? node.refresh_token));
    if (hasToken) {
      const norm = normalizeCredential(node);
      if (!norm.tenantUrl) errors.push(`账号 ${norm.email || norm.displayName || '未知'} 缺少 tenant_url`);
      else items.push(norm);
      return;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };

  walk(root, 0);
  if (!items.length && !errors.length) errors.push('未在 JSON 中检测到有效的 access_token / refresh_token 字段');
  return { items, errors };
}

// ---------- 防双花 Token 续期 ----------
function isTokenStale(account, leadMs = REFRESH_LEAD_MS, now = Date.now()) {
  if (!account || !account.access) return true;
  if (!account.expires) return false;
  return account.expires - leadMs <= now;
}

function isRefreshable(account, now = Date.now()) {
  return !!(account && account.refresh && account.clientId && (!account.refreshExpiresAt || account.refreshExpiresAt > now));
}

const renewQueue = new Map();
const recentRenewed = new Map();

async function renewOidc(account, onPersist = null) {
  const region = account.region || regionFromUrl(account.issuerUrl) || regionFromUrl(account.tenantUrl) || 'us-east-1';
  const key = `${region}|${account.clientId}|${account.refresh}`;
  const hit = recentRenewed.get(key);
  if (hit && Date.now() - hit.at < KEEP_RENEWED_MS) return hit.val;
  if (renewQueue.has(key)) return renewQueue.get(key);

  const run = (async () => {
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;
    const payload = {
      clientId: account.clientId,
      grantType: 'refresh_token',
      refreshToken: account.refresh,
      ...(account.clientSecret ? { clientSecret: account.clientSecret } : {}),
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch (_) {}
    if (!res.ok || !body.accessToken) {
      const code = body.error || body.__type || `HTTP_${res.status}`;
      const msg = body.error_description || body.message || text || res.statusText;
      const err = new Error(`OIDC 刷新失败 (${code}): ${msg}`);
      err.status = res.status;
      err.code = code;
      err.refreshRefused = /invalid_?grant|unauthorized|expired|revoked|access_?denied/i.test(`${code} ${msg}`);
      throw err;
    }
    const expiresIn = Number(body.expiresIn) > 0 ? Number(body.expiresIn) : 3600;
    const next = {
      ...account,
      access: str(body.accessToken),
      refresh: str(body.refreshToken) || account.refresh,
      expires: Date.now() + expiresIn * 1000,
    };
    recentRenewed.set(key, { val: next, at: Date.now() });
    if (recentRenewed.size > 64) {
      const firstKey = recentRenewed.keys().next().value;
      if (firstKey !== undefined) recentRenewed.delete(firstKey);
    }
    if (onPersist) await onPersist(next);
    return next;
  })();

  renewQueue.set(key, run);
  try { return await run; }
  finally { if (renewQueue.get(key) === run) renewQueue.delete(key); }
}

function mergeAccountWithKeychain(account, kcNorm) {
  return {
    ...account,
    access: kcNorm.access || account.access || '',
    refresh: kcNorm.refresh || account.refresh || '',
    expires: kcNorm.expires || account.expires || 0,
    refreshExpiresAt: kcNorm.refreshExpiresAt || account.refreshExpiresAt || 0,
    clientId: kcNorm.clientId || account.clientId || '',
    clientSecret: kcNorm.clientSecret || account.clientSecret || '',
    clientSecretExpiresAt: kcNorm.clientSecretExpiresAt || account.clientSecretExpiresAt || 0,
    issuerUrl: kcNorm.issuerUrl || account.issuerUrl || '',
    tenantUrl: kcNorm.tenantUrl || account.tenantUrl || '',
    wsHost: kcNorm.wsHost || account.wsHost || '',
    region: kcNorm.region || account.region || 'us-east-1',
    providerType: kcNorm.providerType || account.providerType || 'social',
    email: kcNorm.email || account.email || '',
    displayName: kcNorm.displayName || account.displayName || '',
    firstName: kcNorm.firstName || account.firstName || '',
    lastName: kcNorm.lastName || account.lastName || '',
    role: kcNorm.role || account.role || 'EXPLORER',
    externalId: kcNorm.externalId || account.externalId || '',
    awsAccountId: kcNorm.awsAccountId || account.awsAccountId || '',
    accountOwnership: kcNorm.accountOwnership || account.accountOwnership || 'OWNER',
    profileId: kcNorm.profileId || account.profileId || '',
  };
}

/**
 * 确保账号拥有最新可用 access_token（严格遵守防双花规则：绝不对运行中 Quick 激活号外部强刷）
 */
async function ensureFreshToken(account, onPersist = null, force = false, opts = {}) {
  const isQuickRunning = typeof opts.isQuickRunning === 'function' ? opts.isQuickRunning : () => false;
  const manifest = typeof opts.readManifest === 'function' ? opts.readManifest() : { last_active: null, entries: [] };
  const lastActive = manifest && manifest.last_active;
  const bound = !!(account.profileId && Array.isArray(manifest && manifest.entries)
    && manifest.entries.some((e) => e && e.id === account.profileId));

  let current = { ...account };

  // 1. 已绑定桌面端的账号，先以 Windows 凭据管理器为权威来源读取最新 token
  if (bound && !opts.skipKeychainRead) {
    const svc = KC.getKeychainServiceName(current.profileId, current.providerType || 'social');
    const readRes = await KC.readKeychainSecretAsync(svc);
    if (readRes && readRes.ok && readRes.value) {
      try {
        const entry = manifest.entries.find((e) => e && e.id === current.profileId) || null;
        const kcNorm = normalizeCredential(JSON.parse(readRes.value), entry);
        if (kcNorm.access || kcNorm.refresh) {
          const changed = (kcNorm.access && kcNorm.access !== account.access)
            || (kcNorm.refresh && kcNorm.refresh !== account.refresh)
            || (kcNorm.expires && (!account.expires || kcNorm.expires - account.expires > 5000));
          current = mergeAccountWithKeychain(current, kcNorm);
          if (changed) {
            current.needsRelogin = false;
            current.reloginReason = null;
            current.lastError = null;
            if (onPersist) await onPersist(current);
          }
        }
      } catch (_) {}
    } else if (!current.access && !current.refresh) {
      const err = new Error('本机凭据已丢失，需要重新登录');
      err.needsRelogin = true;
      err.code = 'KEYCHAIN_READ_FAILED';
      throw err;
    }
  }

  if (current.needsRelogin === true && !force) {
    const err = new Error(current.reloginReason || '账号需要重新登录');
    err.needsRelogin = true;
    err.code = 'NEEDS_RELOGIN';
    throw err;
  }

  if (!force && current.access && !isTokenStale(current)) return current;

  // 2. 防双花：Quick 正在运行且当前就是这个激活号，绝不外部强刷 refresh_token
  const isActiveRunning = bound && lastActive && lastActive === current.profileId && Boolean(isQuickRunning());
  if (isActiveRunning) {
    if (!force && current.access && (!current.expires || current.expires > Date.now())) return current;
    const err = new Error('AWS Quick 正在使用此账号，跳过外部刷新以避免令牌冲突');
    err.skippedActiveQuick = true;
    err.code = 'SKIPPED_ACTIVE_QUICK';
    throw err;
  }

  if (!isRefreshable(current)) {
    if (!force && current.access && (!current.expires || current.expires > Date.now())) return current;
    const err = new Error('刷新令牌缺失或已过期，请重新登录');
    err.needsRelogin = true;
    err.refreshRefused = true;
    throw err;
  }

  // 3. 刷新并写回 Windows 凭据管理器与号池
  let renewed;
  try {
    renewed = await renewOidc(current, async (next) => {
      const cleaned = { ...next, needsRelogin: false, reloginReason: null, lastError: null };
      if (bound && cleaned.profileId) {
        const svc = KC.getKeychainServiceName(cleaned.profileId, cleaned.providerType || 'social');
        try { KC.writeKeychainSecret(svc, JSON.stringify(toKeychainPayload(cleaned)), 'session'); } catch (_) {}
      }
      if (onPersist) await onPersist(cleaned);
    });
  } catch (err) {
    if (err && err.refreshRefused) err.needsRelogin = true;
    throw err;
  }

  return { ...renewed, needsRelogin: false, reloginReason: null, lastError: null };
}

// ---------- 直连云端 RPC 与额度查询 ----------
const gatewayCellCache = new Map();

async function resolveGatewayHost(account) {
  if (gatewayCellCache.has(account.tenantUrl)) return gatewayCellCache.get(account.tenantUrl);
  try {
    const res = await fetch(`${account.tenantUrl}/v1/discovery`, {
      headers: { Authorization: `Bearer ${account.access}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (str(body && body.cellHost)) {
        gatewayCellCache.set(account.tenantUrl, str(body.cellHost));
        return str(body.cellHost);
      }
    }
  } catch (_) {}
  return hostFromUrl(account.tenantUrl);
}

function unwrapInvokeAgentBody(rawText) {
  let outer;
  try { outer = JSON.parse(rawText); } catch (_) { return null; }
  let inner = (outer && outer.eventResponse && outer.eventResponse.invokeAgentResponse)
    ?? (outer && outer.invokeAgentResponse) ?? (outer && outer.result) ?? outer;
  if (typeof inner === 'string') {
    try { inner = JSON.parse(inner); } catch (_) { return { statusCode: 200, parsedBody: inner }; }
  }
  if (inner && typeof inner === 'object' && typeof inner.body === 'string') {
    try { return { ...inner, parsedBody: JSON.parse(inner.body) }; }
    catch (_) { return { ...inner, parsedBody: inner.body }; }
  }
  return { statusCode: 200, parsedBody: inner };
}

async function invokeQbsApi(account, apiPath, method = 'GET', body = {}, timeoutMs = 30000) {
  const cleanPath = String(apiPath || '').replace(/^\/+/, '');
  let url, reqBody;
  if (isGatewayProvider(account.providerType)) {
    const cellHost = await resolveGatewayHost(account);
    const acct = encodeURIComponent(account.awsAccountId || 'default');
    const qs = new URLSearchParams({ innerPath: cleanPath, _method: method });
    url = `https://${cellHost}/accounts/${acct}/invocations/rpc?${qs.toString()}`;
    reqBody = JSON.stringify(body ?? {});
  } else {
    url = `${account.tenantUrl}/integration/quick-work/qbs-event`;
    reqBody = JSON.stringify({
      eventType: 'invokeAgent',
      eventBody: {
        invokeAgent: {
          path: cleanPath,
          queryParams: { _method: method },
          body: body ?? {},
        },
      },
    });
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${account.access}`,
      'x-amzn-qs-internal-trace-id': randomUUID(),
    },
    body: reqBody,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`认证被拒 (${res.status})`);
    err.status = res.status;
    err.invalidToken = res.status === 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`云端接口错误 (${res.status}): ${text.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  const unwrapped = unwrapInvokeAgentBody(text);
  const payload = (unwrapped && unwrapped.parsedBody) ?? unwrapped;
  if (unwrapped && unwrapped.statusCode >= 400) {
    const err = new Error(`云端内部错误 (${unwrapped.statusCode})`);
    err.status = unwrapped.statusCode;
    err.invalidToken = unwrapped.statusCode === 401;
    throw err;
  }
  return payload;
}

function parseWindowQuota(q) {
  if (!q || typeof q !== 'object') return null;
  const limit = Number(q.limit) || 0;
  const used = Number(q.used) || 0;
  const percent = limit > 0
    ? Math.round((100 * used / limit) * 10) / 10
    : (Number.isFinite(Number(q.percent)) ? Number(q.percent) : 0);
  let resetsAtMs = toMs(q.resets_at);
  if (!resetsAtMs && Number(q.resume_in_minutes) > 0) {
    resetsAtMs = Date.now() + Number(q.resume_in_minutes) * 60000;
  }
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percent: Math.max(0, Math.min(100, percent)),
    resets_at: resetsAtMs ? Math.floor(resetsAtMs / 1000) : null,
    resetsAt: resetsAtMs ? new Date(resetsAtMs).toISOString() : null,
    resume_in_minutes: q.resume_in_minutes ?? null,
  };
}

function parseUsageResponse(raw) {
  const subType = str(raw && raw.subscription && raw.subscription.subscription_type);
  const planMap = {
    QUICK_LITE_FREE_TRIAL: '免费试用',
    FREE_TRIAL: '免费试用',
    FREE: '免费版',
    PRO: '专业版',
    ENTERPRISE: '企业版',
    TEAM: '团队版',
  };
  const planLabel = planMap[subType.toUpperCase()] || subType || 'Amazon Quick';
  const trialMeta = (raw && raw.subscription && raw.subscription.free_trial_metadata) || null;
  const trialExpiresAtMs = toMs(trialMeta && trialMeta.expiry_date);
  return {
    ok: true,
    fetchedAt: Date.now(),
    planLabel,
    subscriptionType: subType || null,
    trialExpiresAt: trialExpiresAtMs ? new Date(trialExpiresAtMs).toISOString() : null,
    monthly: parseWindowQuota(raw && raw.monthly),
    session: parseWindowQuota(raw && raw.session),
    overage: raw && raw.overage_monthly && (Number(raw.overage_monthly.used) > 0 || Number(raw.overage_monthly.limit) > 0)
      ? parseWindowQuota(raw.overage_monthly) : null,
    subscription: (raw && raw.subscription) || null,
  };
}

async function fetchAccountUsage(account, onPersist = null, opts = {}) {
  if (!account || !account.tenantUrl) {
    const err = new Error('缺少 Tenant URL，无法查询云端额度');
    err.code = 'MISSING_TENANT';
    throw err;
  }
  let current = await ensureFreshToken(account, onPersist, false, opts);
  try {
    const raw = await invokeQbsApi(current, 'profile/usage', 'GET');
    return { account: current, quota: parseUsageResponse(raw) };
  } catch (err) {
    if (err && (err.skippedActiveQuick || err.needsRelogin)) throw err;
    if (err && err.invalidToken && isRefreshable(current)) {
      current = await ensureFreshToken(current, onPersist, true, opts);
      const raw = await invokeQbsApi(current, 'profile/usage', 'GET');
      return { account: current, quota: parseUsageResponse(raw) };
    }
    throw err;
  }
}

// ---------- 统一本机无痕 & 远程 VPS OAuth 登录引擎 ----------
async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function parsePastedQuery(pasted) {
  const s = str(pasted);
  if (!s) return null;
  const noHash = s.split('#')[0];
  const qi = noHash.indexOf('?');
  let query = null;
  if (qi >= 0) query = noHash.slice(qi + 1);
  else if (/^[^\s/?#]*=/.test(noHash)) query = noHash;
  return query == null ? null : new URLSearchParams(query);
}

function normalizeUserInfo(raw) {
  const r = (raw && typeof raw.userInfo === 'object') ? raw.userInfo : (raw || {});
  const pick = (...ks) => { for (const k of ks) { if (r[k] != null && r[k] !== '') return str(String(r[k])); } return ''; };
  return {
    email: pick('email', 'emailAddress'),
    displayName: pick('displayName', 'display_name', 'userName', 'user_name'),
    firstName: pick('firstName', 'first_name'),
    lastName: pick('lastName', 'last_name'),
    role: pick('role') || 'EXPLORER',
    awsAccountId: pick('awsAccountId', 'aws_account_id', 'accountId'),
    externalId: pick('externalId', 'external_id'),
    accountOwnership: pick('accountOwnership', 'account_ownership') || 'OWNER',
  };
}

function htmlCard(ok, title, desc) {
  const color = ok ? '#10b981' : '#ef4444';
  const icon = ok ? '✓' : '!';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#eef2ff;font-family:"Microsoft YaHei UI",system-ui,sans-serif}
.box{max-width:420px;padding:32px;border-radius:16px;background:#181c27;border:1px solid rgba(255,255,255,.1);text-align:center}
.ico{width:54px;height:54px;line-height:54px;border-radius:50%;margin:0 auto 16px;font-size:26px;font-weight:700;background:${color}22;color:${color};border:1px solid ${color}55}
h2{margin:0 0 8px;font-size:19px}p{margin:0;color:#9aa4bd;font-size:14px;line-height:1.6}</style></head>
<body><div class="box"><div class="ico">${icon}</div><h2>${title}</h2><p>${desc}</p></div></body></html>`;
}

/**
 * 启动一次独立的 OAuth PKCE 登录会话（完全不依赖 Quick 客户端或 CDP）
 *
 * 支持 3 种场景：
 *  1. 本机无痕新增账号（remote=false, existingAccount=null）：起本地回调服务 + Edge InPrivate 无痕打开，全自动完成 2 步
 *  2. 远程 VPS 新增账号（remote=true, existingAccount=null）：绝不弹本机浏览器！展示第 1 步链接 + SSH 隧道命令 + 同会话粘贴第 1/2 步回调无缝推进
 *  3. 失效号一键重登（existingAccount 已有 issuerUrl/tenantUrl）：直接跳过第 1 步，直达单步 OIDC 授权链接（本机无痕或远程 VPS 均可）
 */
async function createOAuthSession({
  provider = 'social',
  remote = false,
  existingAccount = null,
  onComplete = null,
} = {}) {
  const sessionId = 'oauth-' + randomBytes(6).toString('hex');
  const nonce = randToken();
  const state = randToken();
  const verifier = randToken();
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const session = {
    id: sessionId,
    provider: provider === 'enterprise' ? 'enterprise' : 'social',
    remote: !!remote,
    reloginTargetId: existingAccount ? existingAccount.id : null,
    reloginTargetName: existingAccount ? (existingAccount.alias || existingAccount.displayName || existingAccount.email) : null,
    stage: 'init', // 'await_discovery' | 'await_code' | 'exchanging' | 'done' | 'error' | 'cancelled'
    port: 0,
    redirectUri: '',
    entryUrl: '',
    authorizeUrl: '',
    sshCommand: '',
    browserInfo: null,
    discovery: null,
    clientId: '',
    clientSecret: '',
    clientSecretExpiresAt: 0,
    account: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };

  let closed = false;
  let timer = null;
  let server = null;

  const closeServer = () => {
    if (closed) return;
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    try { server && server.close(); } catch (_) {}
  };

  const registerClientAndBuildAuthUrl = async (disc) => {
    const idcRegion = disc.idc_region || regionFromUrl(disc.issuer_url) || regionFromUrl(disc.tenant_url) || 'us-east-1';
    const issuerUrl = disc.issuer_url || DEFAULT_SOCIAL_ISSUER_URL;
    const client = await postJson(`https://oidc.${idcRegion}.amazonaws.com/client/register`, {
      clientName: 'AmazonQuick-Desktop',
      clientType: 'public',
      scopes: [SOCIAL_SCOPE],
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: [session.redirectUri],
      issuerUrl,
    });
    const clientId = str(client.clientId || client.client_id);
    if (!clientId) throw new Error('OIDC 客户端注册未返回 clientId');
    session.discovery = { ...disc, idc_region: idcRegion, issuer_url: issuerUrl };
    session.clientId = clientId;
    session.clientSecret = str(client.clientSecret || client.client_secret);
    session.clientSecretExpiresAt = toMs(client.clientSecretExpiresAt || client.client_secret_expires_at);

    const authUrl = new URL(`https://oidc.${idcRegion}.amazonaws.com/authorize`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', session.redirectUri);
    authUrl.searchParams.set('scope', SOCIAL_SCOPE);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'login');
    session.authorizeUrl = authUrl.toString();
    session.stage = 'await_code';
    return session.authorizeUrl;
  };

  const handleDiscoveryParams = async (q) => {
    if (q.get('nonce') !== nonce) throw new Error('第一步回调里的 nonce 与当前会话不匹配，请确认复制的是本次生成的链接');
    if (q.get('error')) throw new Error(`授权失败：${q.get('error')} ${q.get('error_description') || ''}`.trim());
    const disc = {
      issuer_url: str(q.get('issuerUrl') || q.get('issuer_url') || q.get('issuer')) || DEFAULT_SOCIAL_ISSUER_URL,
      tenant_url: str(q.get('tenantUrl') || q.get('tenant_url')).replace(/\/+$/, ''),
      idc_region: str(q.get('idcRegion') || q.get('idc_region')),
      account: str(q.get('account')),
    };
    if (!disc.tenant_url) throw new Error('回调地址中缺少 tenantUrl，请确认完整复制了地址栏内容');
    return registerClientAndBuildAuthUrl(disc);
  };

  const handleCodeParams = async (q) => {
    if (q.get('state') !== state) throw new Error('第二步回调里的 state 与当前会话不匹配，请复制当前步骤的回调地址');
    if (q.get('error')) throw new Error(`登录被拒绝：${q.get('error')} ${q.get('error_description') || ''}`.trim());
    const code = str(q.get('code'));
    if (!code) throw new Error('回调地址里缺少 code 参数，请确认已经完成登录跳转');

    session.stage = 'exchanging';
    const disc = session.discovery || {};
    const idcRegion = disc.idc_region || 'us-east-1';
    const tok = await postJson(`https://oidc.${idcRegion}.amazonaws.com/token`, {
      clientId: session.clientId,
      ...(session.clientSecret ? { clientSecret: session.clientSecret } : {}),
      grantType: 'authorization_code',
      code,
      redirectUri: session.redirectUri,
      codeVerifier: verifier,
    });
    const accessToken = str(tok.accessToken || tok.access_token);
    const refreshToken = str(tok.refreshToken || tok.refresh_token);
    if (!accessToken) throw new Error('换取 Token 失败，未返回 accessToken');
    const expiresIn = Number(tok.expiresIn ?? tok.expires_in) > 0 ? Number(tok.expiresIn ?? tok.expires_in) : 3600;

    // 读取 user-info（失败不阻塞主流程）
    let userInfo = {};
    try {
      const base = disc.tenant_url || SOCIAL_DATA_PLANE;
      const infoBase = base.includes('dp.appintegrations') ? base : SOCIAL_DATA_PLANE;
      const rawInfo = await postJson(`${infoBase}/integration/quick-work/user-info`, {}, {
        Authorization: `Bearer ${accessToken}`,
      });
      userInfo = normalizeUserInfo(rawInfo);
    } catch (_) {}

    const cred = normalizeCredential({
      access: accessToken,
      refresh: refreshToken,
      expires: Date.now() + expiresIn * 1000,
      refreshExpiresAt: Date.now() + 90 * 86400 * 1000,
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      clientSecretExpiresAt: session.clientSecretExpiresAt,
      issuerUrl: disc.issuer_url,
      tenantUrl: disc.tenant_url,
      region: idcRegion,
      providerType: (existingAccount && existingAccount.providerType) || session.provider,
      email: userInfo.email || (existingAccount && existingAccount.email) || '',
      displayName: userInfo.displayName || userInfo.email || (existingAccount && existingAccount.displayName) || '',
      firstName: userInfo.firstName || (existingAccount && existingAccount.firstName) || '',
      lastName: userInfo.lastName || (existingAccount && existingAccount.lastName) || '',
      role: userInfo.role || (existingAccount && existingAccount.role) || 'EXPLORER',
      awsAccountId: userInfo.awsAccountId || (existingAccount && existingAccount.awsAccountId) || '',
      externalId: userInfo.externalId || (existingAccount && existingAccount.externalId) || '',
      accountOwnership: userInfo.accountOwnership || 'OWNER',
      profileId: existingAccount ? existingAccount.profileId : '',
    });

    const saved = onComplete ? await onComplete(cred, session) : cred;
    session.account = saved;
    session.stage = 'done';
    session.finishedAt = Date.now();
    closeServer();
    return saved;
  };

  server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', `http://127.0.0.1:${session.port}`);
      if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

      // 第 1 步回调：/callback?nonce=...&issuerUrl=...&tenantUrl=...
      if (u.pathname === '/callback' && u.searchParams.has('nonce')) {
        const nextUrl = await handleDiscoveryParams(u.searchParams);
        res.writeHead(302, { Location: nextUrl, 'Cache-Control': 'no-store' });
        return res.end();
      }

      // 第 2 步回调：/?code=...&state=... 或 /callback?code=...&state=...
      if ((u.pathname === '/' || u.pathname === '/callback') && (u.searchParams.has('code') || u.searchParams.has('error'))) {
        const saved = await handleCodeParams(u.searchParams);
        const label = (saved && (saved.alias || saved.displayName || saved.email)) || '新账号';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(htmlCard(true, '登录授权成功', `账号「${label}」已写入本机账号池，现在可以关闭此浏览器标签页并回到 Quick 家庭账号助手。`));
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlCard(true, '等待授权完成', '请在打开的 AWS 登录页面完成登录，完成后此页面会自动确认。'));
    } catch (e) {
      session.error = e.message || String(e);
      if (session.stage !== 'done') {
        session.stage = 'error';
        session.finishedAt = Date.now();
        closeServer();
      }
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlCard(false, '登录未完成', session.error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  session.port = server.address().port;
  session.redirectUri = `http://127.0.0.1:${session.port}`;
  session.sshCommand = `ssh -R ${session.port}:127.0.0.1:${session.port} 用户名@你的VPS地址`;

  // 10 分钟超时自动收尾
  timer = setTimeout(() => {
    if (session.stage === 'await_discovery' || session.stage === 'await_code') {
      session.stage = 'error';
      session.error = '等待授权超时（10 分钟），请重新发起登录';
      session.finishedAt = Date.now();
      closeServer();
    }
  }, 10 * 60 * 1000);
  timer.unref && timer.unref();

  // 如果已有账号的 tenantUrl/issuerUrl，直接跳过第 1 步！
  if (existingAccount && existingAccount.tenantUrl) {
    await registerClientAndBuildAuthUrl({
      issuer_url: existingAccount.issuerUrl || DEFAULT_SOCIAL_ISSUER_URL,
      tenant_url: existingAccount.tenantUrl,
      idc_region: existingAccount.region || regionFromUrl(existingAccount.issuerUrl) || regionFromUrl(existingAccount.tenantUrl) || 'us-east-1',
    });
    session.entryUrl = session.authorizeUrl;
  } else {
    const base = DISCOVERY_ENTRY[session.provider] || DISCOVERY_ENTRY.social;
    session.entryUrl = `${base}?qwSurface=desktop:${nonce}:${session.port}:${APP_VERSION}`;
    session.stage = 'await_discovery';
  }

  // 本机模式自动用无痕浏览器打开；远程 VPS 模式绝不弹本机浏览器！
  if (!session.remote) {
    session.browserInfo = openPrivateBrowser(session.entryUrl);
  }

  return {
    getPublicState() {
      return {
        id: session.id,
        provider: session.provider,
        remote: session.remote,
        reloginTargetId: session.reloginTargetId,
        reloginTargetName: session.reloginTargetName,
        stage: session.stage,
        port: session.port,
        entryUrl: session.entryUrl,
        authorizeUrl: session.authorizeUrl,
        sshCommand: session.sshCommand,
        browserInfo: session.browserInfo,
        error: session.error,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt,
        account: session.account ? {
          id: session.account.id,
          displayName: session.account.alias || session.account.displayName || session.account.email,
          email: session.account.email || '',
        } : null,
      };
    },
    async submitCallback(pastedUrl) {
      if (session.stage === 'done') return { ok: true, stage: 'done', state: this.getPublicState() };
      if (session.stage === 'cancelled' || session.stage === 'error') {
        throw new Error(session.error || '当前登录会话已结束，请重新发起');
      }
      const q = parsePastedQuery(pastedUrl);
      if (!q) throw new Error('请粘贴浏览器地址栏里的完整回调地址（包含 ?nonce= 或 ?code=）');

      if (q.has('nonce')) {
        if (session.stage === 'await_code' && session.authorizeUrl) {
          return { ok: true, stage: 'await_code', nextUrl: session.authorizeUrl, state: this.getPublicState() };
        }
        const nextUrl = await handleDiscoveryParams(q);
        return { ok: true, stage: 'await_code', nextUrl, state: this.getPublicState() };
      }

      if (q.has('code') || q.has('error')) {
        if (!session.clientId) {
          throw new Error('请先提交第一步含 nonce 的回调地址，获取第二步链接后再完成登录');
        }
        await handleCodeParams(q);
        return { ok: true, stage: 'done', state: this.getPublicState() };
      }

      throw new Error('地址里没有检测到 nonce 或 code 参数，请确认浏览器已跳转到 127.0.0.1 回调页后再复制完整地址');
    },
    cancel() {
      if (session.stage !== 'done') {
        session.stage = 'cancelled';
        session.finishedAt = Date.now();
      }
      closeServer();
      return this.getPublicState();
    },
  };
}

module.exports = {
  APP_VERSION,
  DEFAULT_SOCIAL_ISSUER_URL,
  openPrivateBrowser,
  normalizeCredential,
  toKeychainPayload,
  toExportJson,
  parseImportedCredentials,
  isTokenStale,
  isRefreshable,
  ensureFreshToken,
  invokeQbsApi,
  fetchAccountUsage,
  createOAuthSession,
};

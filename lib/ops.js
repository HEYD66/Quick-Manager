/**
 * ops.js — 动作层：CDP、切号、登录/登出、备份/恢复、配置克隆、MCP 测试、日志
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, execSync } = require('child_process');
const C = require('./core');
const { findDesktopAuthLink, findDesktopContinuation, desktopContinuationUrl } = require('./desktop-auth-link');

// ============ 作业状态机（供 SSE 推送） ============
const jobs = new Map();
let jobSeq = 0;

function newJob(kind, meta) {
  const id = 'job-' + (++jobSeq) + '-' + Date.now();
  const job = { id, kind, state: 'running', steps: [], startedAt: Date.now(), meta: meta || null, result: null, error: null };
  jobs.set(id, job);
  if (jobs.size > 50) { const oldest = [...jobs.keys()][0]; jobs.delete(oldest); }
  return job;
}
function step(job, text, level) {
  job.steps.push({ ts: Date.now(), text, level: level || 'info' });
  if (job.steps.length > 60) job.steps.shift();
}
function finish(job, result) { job.state = 'done'; job.result = result || null; job.finishedAt = Date.now(); }
// 把内部错误码翻译成人话（保留错误码方便排查/前端识别）
const ERR_TEXT = {
  profiles_unreadable: '读不到客户端的 profiles.json（可能正在被客户端写入），已放弃写入以免覆盖，请稍后重试',
  target_not_logged_in: '目标账号没有登录信息，请先在客户端里登录这个账号',
  target_no_credential: '本机没有这个账号的登录凭据（可能已被登出），请先重新登录这个账号',
  target_refresh_failing: '这个账号的登录已失效（客户端刷新凭证被服务端拒绝），切过去会要求重新登录。请点「重新登录」登录一次',
  client_rejected_profiles: '客户端拒收了新的 profiles.json 并隔离了它，切换未生效',
  relogin_switch_failed: '没能把客户端切到这个账号，已停止，没有登出任何账号',
  not_current_account: '只能登出当前账号：客户端的登出只作用于当前登录的账号，请先切换到该账号',
  switch_timeout: '等待客户端确认切换超时',
  desktop_login_unavailable: '客户端没有提供桌面授权接口。请确认 AWS Quick 已通过管理器启动，并等待客户端加载完成',
  desktop_login_failed: 'AWS Quick 没有完成授权，请检查浏览器里的 AWS 登录结果后重试',
  desktop_login_interrupted: '与 Quick 的授权会话断开了，请重新发起授权',
  desktop_login_callback_busy: 'Quick 的回调端口仍被占用，请先结束上一轮授权再重试',
  desktop_login_duplicate: '这次授权没有添加新账号。请在 AWS 登录页选择另一个账号',
  desktop_login_registry: 'AWS 已返回授权结果，但客户端尚未登记可用的新账号',
  desktop_login_previous_missing: '客户端账号清单中原有的活动账号已变更，请检查原账号的登录状态',
  desktop_login_restart_failed: '新账号已写入客户端清单，但客户端未确认切换，请在账号页重试切换',
  login_timeout: '等待 AWS 授权超时，请重新添加账号',
};
function errText(code) {
  const base = String(code).split(':')[0];
  if (base === 'profiles_entry_not_logged_in') return '账号「' + String(code).split(':')[1] + '」没有登录信息，客户端会拒收整份账号清单，已取消写入 [' + base + ']';
  return ERR_TEXT[base] ? ERR_TEXT[base] + ' [' + base + ']' : String(code);
}
function fail(job, err) { job.state = 'error'; job.error = errText(err && err.message || err); job.finishedAt = Date.now(); }
function getJobs() {
  const list = [...jobs.values()];
  const recent = list.slice(-10);
  return [...list.slice(0, -10).filter((job) => job.state === 'running'), ...recent];
}

// ============ CDP ============
function httpGetJson(url, timeoutMs) { return C.httpGetJson(url, timeoutMs); }

async function cdpTargets() {
  try { return await httpGetJson('http://127.0.0.1:' + C.CDP_PORT + '/json/list', 3000); }
  catch (_) { return null; }
}

async function cdpEval(expression, timeoutMs) {
  const list = await cdpTargets();
  if (!list || !list.length) throw new Error('inspector_unreachable');
  const target = list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const done = new Promise((resolve, reject) => {
    let id = 0;
    const pend = new Map();
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('cdp_timeout')); }, timeoutMs || 15000);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    ws.addEventListener('open', async () => {
      const call = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
      await call('Runtime.enable', {});
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true });
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      const v = r && r.result;
      if (v && v.exceptionDetails) return reject(new Error('js_exception: ' + JSON.stringify(v.exceptionDetails).slice(0, 300)));
      resolve(v && v.result ? v.result.value : null);
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('cdp_ws_error')); });
  });
  return done;
}

function evalInRenderer(js, profilesBase, activeProfileRoot) {
  const expr = `(async () => {
    const r = process.mainModule.require;
    const { BrowserWindow: BW } = r('electron');
    const expectedBase = ${JSON.stringify(profilesBase || null)};
    if (expectedBase) {
      const path = r('path');
      const actualBase = process.env.QUICKWORK_BASE?.trim() || path.join(r('os').homedir(), '.quickwork');
      if (path.resolve(actualBase).toLowerCase() !== path.resolve(expectedBase).toLowerCase() ||
          process.env.QUICKWORK_PROFILES_ENABLED !== 'true' ||
          path.resolve(process.execPath).toLowerCase() !== path.resolve(${JSON.stringify(C.APP_EXE)}).toLowerCase()) {
        return { ok: false, reason: 'desktop_profiles_unavailable' };
      }
      const expectedRoot = ${JSON.stringify(activeProfileRoot || null)};
      if (expectedRoot && process.env.QUICKWORK_ROOT?.toLowerCase() !== expectedRoot.toLowerCase()) {
        return { ok: false, reason: 'desktop_profile_not_loaded' };
      }
    }
    const wins = BW.getAllWindows().filter((w) => !w.isDestroyed());
    if (!wins.length) return { ok: false, reason: 'no_window' };
    const w = wins.find((x) => /index\\.html/.test(x.webContents.getURL())) || wins[0];
    const res = await w.webContents.executeJavaScript(${JSON.stringify(js)}, true);
    return { ok: true, url: w.webContents.getURL(), result: res };
  })()`;
  return cdpEval(expr, 20000);
}

/** 把账号级动作交给主窗口渲染层（sign-out / profile-restart / retry-connection） */
function forwardAction(action) {
  const expr = `(() => {
    const r = process.mainModule.require;
    const BW = r('electron').BrowserWindow;
    const wins = BW.getAllWindows().filter((w) => !w.isDestroyed());
    if (!wins.length) return { ok: false, reason: 'no_window' };
    const w = wins.find((x) => /index\\.html/.test(x.webContents.getURL())) || wins[0];
    w.webContents.send('windows:main-action', ${JSON.stringify(action)});
    return { ok: true };
  })()`;
  return cdpEval(expr, 8000);
}

// ============ 应用进程 ============
function appRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Amazon Quick.exe" /NH', { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return /Amazon Quick\.exe/i.test(out);
  } catch (_) { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeoutMs, intervalMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(intervalMs || 1000);
  }
  return false;
}

// ============ 切号 ============
/** 温和地重启客户端：先正常关闭，等不到再强杀。
 *  直接 /F 可能打断客户端写凭据（日志里出现过 keychain "Torn chunk set"）。 */
async function restartClientGracefully(job) {
  try { execSync('taskkill /IM "Amazon Quick.exe"', { windowsHide: true, timeout: 15000 }); } catch (_) {}
  const closed = await waitFor(() => !appRunning(), 15000, 1000);
  if (!closed) {
    step(job, '客户端 15 秒内没有退出，强制结束', 'warn');
    try { execSync('taskkill /IM "Amazon Quick.exe" /F', { windowsHide: true, timeout: 15000 }); } catch (_) {}
    await sleep(2500);
  }
  if (!fs.existsSync(C.APP_EXE)) throw new Error('app_exe_missing');
  const { spawn } = require('child_process');
  spawn(C.APP_EXE, ['--inspect=' + C.CDP_PORT], { detached: true, stdio: 'ignore', cwd: path.dirname(C.APP_EXE) }).unref();
}

/** 切号前检查目标账号是否还能直接用。返回错误码或 null */
function switchPrecheck(entry) {
  if (!entry.login_metadata) return 'target_not_logged_in';
  if (entry.refresh_failing_since) return 'target_refresh_failing';
  if (C.hasCredential(entry.id) === false) return 'target_no_credential';
  return null;
}

async function switchAccount(id, opts) {
  const force = !!(opts && opts.force);
  const job = newJob('switch', { id, force });
  let profiles;
  try { profiles = C.readProfilesStrict(); } catch (e) { fail(job, e); return job; }
  const entry = profiles.entries.find((e) => e.id === id);
  if (!entry) { fail(job, 'account_not_found'); return job; }
  const dir = path.join(C.QW, entry.data_path || path.join('profiles', id));
  if (!fs.existsSync(dir)) { fail(job, 'profile_dir_missing'); return job; }
  if (profiles.last_active === id) { step(job, '已经是当前账号', 'warn'); finish(job, { noop: true }); return job; }
  if (!force) {
    const bad = switchPrecheck(entry);
    if (bad) { fail(job, bad); job.code = bad; return job; }
  }

  (async () => {
    try {
      step(job, '1/3 写入 last_active');
      const quarantinedBefore = C.countQuarantined();
      const next = C.readProfilesStrict(); // 重新读最新内容，只改 last_active，保留客户端刚写的字段
      next.last_active = id;
      C.writeProfiles(next);
      C.audit('switch', { to: id, force });

      step(job, '2/3 通知客户端重启后端');
      let viaAction = false;
      try {
        const r = await forwardAction({ type: 'profile-restart', profileRoot: dir });
        viaAction = !!(r && r.ok);
        step(job, viaAction ? '已发送 profile-restart' : '渲染层未响应，准备重启进程', viaAction ? 'info' : 'warn');
      } catch (e) { step(job, 'CDP 不可用：' + e.message, 'warn'); }

      if (!viaAction) {
        step(job, '重启客户端进程');
        await restartClientGracefully(job);
      }

      step(job, '3/3 等待账号就绪');
      let rejected = false;
      const ok = await waitFor(() => {
        if (C.countQuarantined() > quarantinedBefore) { rejected = true; return true; }
        const p = C.readProfiles();
        return p.last_active === id;
      }, 60000, 1500);
      if (rejected) throw new Error('client_rejected_profiles');
      if (!ok) throw new Error('switch_timeout');

      // 等 relay 恢复（如果之前跑过）
      await sleep(2000);
      step(job, '刷新额度');
      try {
        const q = await C.fetchQuota(id);
        step(job, q.ok ? '额度已刷新' : '额度暂不可用：' + (q.message || q.reason), q.ok ? 'info' : 'warn');
      } catch (e) { step(job, '额度刷新失败：' + e.message, 'warn'); }

      finish(job, { lastActive: id });
    } catch (e) { fail(job, e); C.audit('switch_failed', { to: id, error: job.error }); }
  })();

  return job;
}

// ============ 登录 ============
let desktopLoginJob = null;
let desktopLoginContinuation = null;
let desktopCallbackInFlight = null;
const DESKTOP_LOGIN_TIMEOUT = 600000;
const DESKTOP_LOGIN_DISCONNECT_GRACE = 20000;
const PROFILE_MUTATION_JOBS = new Set(['switch', 'relogin', 'logout', 'remove', 'restore', 'purge', 'adopt', 'import_json']);

function desktopLoginRunning() { return desktopLoginJob?.state === 'running'; }

// 运行在 Quick 渲染器中，沿用客户端自己的授权请求和实例校验。
async function desktopLoginInRenderer(action, id, provider, timeout) {
  const current = globalThis.__qwmDesktopLogin;
  if (action === 'status') {
    if (current?.id !== id) return null;
    await current.cancellation;
    return current.result;
  }
  if (action === 'cancel') {
    if (current?.id !== id || current.result.state !== 'waiting') return false;
    if (current.cancellation) return current.cancellation;
    current.cancellation = cancel().finally(() => { current.cancellation = null; });
    return current.cancellation;
  }
  async function cancel() {
    try {
      const response = await current.request('profile-login-cancel', {}, AbortSignal.timeout(5000));
      if (!response.ok || current.result.state === 'authorized') return false;
      current.result = { state: 'cancelled' };
      current.controller.abort();
      return true;
    } catch (_) { return false; }
  }

  const quick = window.quickwork;
  if (!quick?.cloudMode || !/^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/.test(quick.outpostUrl)) return 'unavailable';
  if (provider === 'social' && quick.hideSocialLogin) return 'unavailable';
  if (current?.result.state === 'waiting' ||
      document.querySelector('[data-automation-id="enterprise-signin"]:disabled, [data-automation-id="social-signin"]:disabled')) return 'busy';

  const controller = new AbortController();
  const request = (route, body, signal) => (globalThis.__quickwork_native_fetch || fetch)(
    quick.outpostUrl + '/auth/' + route,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }
  );
  const attempt = { id, controller, request, result: { state: 'waiting' } };
  globalThis.__qwmDesktopLogin = attempt;
  const timeoutSignal = AbortSignal.timeout(timeout + 20000);
  void (async () => {
    try {
      const response = await request('profile-login', { provider }, AbortSignal.any([controller.signal, timeoutSignal]));
      const data = await response.json().catch(() => null);
      if (attempt.result.state !== 'waiting') return;
      if (response.ok && data?.success) {
        attempt.result = { state: 'authorized', restart: !!data.restart_required, profileRoot: data.profile_root, documentStart: performance.timeOrigin };
      } else if (data?.failure_reason === 'cancelled') {
        attempt.result = { state: 'cancelled' };
      } else {
        const reason = data?.failure_reason === 'timeout' ? 'login_timeout'
          : data?.failure_reason === 'callback_port_in_use' ? 'desktop_login_callback_busy' : 'desktop_login_failed';
        attempt.result = { state: 'failed', reason };
      }
    } catch (_) {
      if (attempt.result.state === 'waiting') attempt.result = { state: 'failed' };
    }
  })();
  return 'started';
}

async function desktopLoginAction(action, job, provider) {
  const call = `(${desktopLoginInRenderer})(${JSON.stringify(action)},${JSON.stringify(job.id)},${JSON.stringify(provider || null)},${DESKTOP_LOGIN_TIMEOUT})`;
  const reply = await evalInRenderer(call, C.QW);
  return reply?.ok ? reply.result : null;
}

function readDesktopProfiles() {
  return fs.statSync(C.PROFILES_JSON, { throwIfNoEntry: false })
    ? C.readProfilesStrict()
    : { entries: [], last_active: null };
}

function addAccount(provider = 'enterprise') {
  if (desktopLoginRunning()) return desktopLoginJob;
  if ([...jobs.values()].some((job) => job.state === 'running' && PROFILE_MUTATION_JOBS.has(job.kind))) {
    const job = newJob('login_add', { provider });
    fail(job, '另一个桌面账号作业正在运行，请等它结束后重试');
    return job;
  }
  const job = newJob('login_add', { provider });
  desktopLoginJob = job;
  desktopLoginContinuation = null;

  (async () => {
    let needsCancel = false;
    try {
      if (provider !== 'social' && provider !== 'enterprise') throw new Error('desktop_login_unavailable');
      const before = readDesktopProfiles();
      const existing = new Set(before.entries.map((entry) => entry.id));
      const hadCredential = before.last_active && C.hasCredential(before.last_active) === true;
      step(job, '正在通过 AWS Quick 启动桌面授权');
      needsCancel = true;
      let started;
      try {
        started = await desktopLoginAction('start', job, provider);
      } catch (_) { throw new Error('desktop_login_unavailable'); }
      if (started !== 'started') {
        needsCancel = false;
        throw new Error(started === 'busy' ? '客户端正在等待另一项桌面授权' : 'desktop_login_unavailable');
      }
      step(job, '请在浏览器里选择要添加的 AWS 账号并完成授权');
      job.cancellable = true;
      let status;
      let lastAvailable = Date.now();
      const completed = await waitFor(async () => {
        status = await desktopLoginAction('status', job).catch(() => null);
        if (status) {
          lastAvailable = Date.now();
          return status.state !== 'waiting';
        }
        // 客户端若在确认后重载，渲染器里的授权状态会丢失，账号清单仍可核实登记结果。
        if (C.readProfiles().entries.some((entry) => !existing.has(entry.id) && entry.login_metadata)) {
          status = { state: 'authorized' };
          return true;
        }
        return Date.now() - lastAvailable >= DESKTOP_LOGIN_DISCONNECT_GRACE;
      }, DESKTOP_LOGIN_TIMEOUT, 1500);
      job.cancellable = false;
      if (!completed) throw new Error('login_timeout');
      if (!status) throw new Error('desktop_login_interrupted');
      needsCancel = false;
      const now = readDesktopProfiles();
      const fresh = now.entries.filter((entry) => !existing.has(entry.id) && entry.login_metadata);
      if (status.state === 'cancelled' && !fresh.length) {
        job.state = 'cancelled';
        job.finishedAt = Date.now();
        step(job, '已取消桌面授权');
        return;
      }
      if (status.state !== 'authorized' && !fresh.length) throw new Error(status.reason || 'desktop_login_failed');

      const preserved = new Set(now.entries.filter((entry) => entry.login_metadata).map((entry) => entry.id));
      if (before.entries.some((entry) => entry.login_metadata && !preserved.has(entry.id))) {
        throw new Error('desktop_login_previous_missing');
      }
      if (before.last_active) {
        if (!preserved.has(before.last_active) || (hadCredential && C.hasCredential(before.last_active) === false)) {
          throw new Error('desktop_login_previous_missing');
        }
      }
      if (!fresh.length) {
        throw new Error(now.entries.some((entry) => !existing.has(entry.id))
          ? 'desktop_login_registry' : 'desktop_login_duplicate');
      }
      if (fresh.length !== 1) throw new Error('desktop_login_registry');
      const entry = fresh[0];
      const profileRoot = C.profileDir(entry.id);
      const normalize = (file) => path.resolve(file).toLowerCase();
      if (!profileRoot || C.hasCredential(entry.id) === false) {
        throw new Error('desktop_login_registry');
      }
      if (status.restart) {
        if (typeof status.profileRoot !== 'string' || normalize(status.profileRoot) !== normalize(profileRoot)) {
          throw new Error('desktop_login_registry');
        }
        step(job, '正在让客户端加载新账号');
        const result = await forwardAction({ type: 'profile-restart', profileRoot }).catch(() => null);
        if (!result?.ok) throw new Error('desktop_login_restart_failed');
        const loaded = await waitFor(async () => {
          const frame = await evalInRenderer('window.quickwork?.cloudMode ? performance.timeOrigin : null',
            C.QW, profileRoot).catch(() => null);
          return frame?.ok && frame.result > status.documentStart && fs.existsSync(profileRoot);
        }, 45000, 1500);
        if (!loaded) throw new Error('desktop_login_restart_failed');
      }
      if (!fs.existsSync(profileRoot)) throw new Error('desktop_login_registry');
      const added = [{ id: entry.id, name: entry.display_name || entry.id }];
      step(job, '已添加桌面账号 ' + added[0].name);
      C.audit('login_add', added);
      finish(job, { added });
    } catch (e) {
      job.cancellable = false;
      if (needsCancel) await desktopLoginAction('cancel', job).catch(() => false);
      fail(job, e);
    }
  })();
  return job;
}

async function cancelAddAccount(id) {
  if (desktopLoginJob?.id !== id || desktopLoginJob.state !== 'running') return false;
  return desktopLoginAction('cancel', desktopLoginJob).catch(() => false);
}

async function submitDesktopCallback(id, callbackText) {
  const job = desktopLoginJob;
  if (!job || job.id !== id || job.state !== 'running' || !job.cancellable) {
    throw new Error('当前没有等待回调的桌面授权，请先发起授权');
  }
  if (desktopCallbackInFlight === job) throw new Error('正在提交回调，请稍候');
  const text = typeof callbackText === 'string' ? callbackText.trim() : '';
  const invalid = '请粘贴地址栏中的完整 AWS Quick 本机回调地址';
  let parsed;
  if (text.length > 8192 || /[\s\\#]/.test(text) ||
      !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):18080\//i.test(text)) {
    throw new Error(invalid);
  }
  try { parsed = new URL(text); } catch (_) { throw new Error(invalid); }
  const fields = parsed.searchParams;
  const has = (name) => fields.getAll(name).length === 1 && !!fields.get(name);
  const discovery = parsed.pathname === '/callback' && has('nonce') && !fields.has('state') && !fields.has('code');
  const completion = ['/', '/callback', '/index.html'].includes(parsed.pathname) &&
    has('state') && !fields.has('nonce') &&
    ((has('code') && !fields.has('error')) || (has('error') && !fields.has('code')));
  if (!discovery && !completion) throw new Error(invalid);

  let discoveryQuery;
  if (discovery) {
    const query = new URLSearchParams(fields);
    query.sort();
    discoveryQuery = query.toString();
    const entry = getDesktopAuthLink(id);
    const nonce = entry && new URL(entry).searchParams.get('qwSurface')?.split(':')[1];
    const continuation = getDesktopLoginContinuation(id, entry);
    if (nonce && nonce !== fields.get('nonce')) {
      throw new Error('第一步回调与当前授权不匹配，请复制当前起始授权链接。');
    }
    if (continuation) {
      if (continuation.discoveryQuery !== discoveryQuery) {
        throw new Error('Quick 已处理过不同的第一步回调。请取消本轮，重新发起后仅在目标浏览器打开起始链接。');
      }
      return { ok: true, discovery: true, nextUrl: continuation.url };
    }
  } else {
    const nextUrl = getDesktopLoginNextUrl(id);
    if (nextUrl && new URL(nextUrl).searchParams.get('state') !== fields.get('state')) {
      throw new Error('最终回调与当前授权不匹配，请复制下一步授权链接后再试。');
    }
  }

  desktopCallbackInFlight = job;
  try {
    return await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: parsed.hostname === '[::1]' ? '::1' : '127.0.0.1',
        port: 18080,
        path: parsed.pathname + parsed.search,
        headers: { host: parsed.host },
        timeout: 15000,
      }, (response) => {
        response.resume();
        const status = response.statusCode || 0;
        if (status < 200 || status >= 400) {
          reject(new Error(`Quick 未接受回调（HTTP ${status}），请确认它来自当前授权`));
          return;
        }
        const nextUrl = status >= 300 && discovery ? desktopContinuationUrl(response.headers.location) : null;
        if (nextUrl && desktopLoginJob === job) {
          desktopLoginContinuation = { url: nextUrl, discoveryQuery };
        }
        resolve({ ok: true, discovery, nextUrl });
      });
      request.on('timeout', () => request.destroy(new Error('callback_timeout')));
      request.on('error', () => reject(new Error('未收到本机 Quick 的回调响应，请确认授权仍在等待')));
    });
  } finally {
    if (desktopCallbackInFlight === job) desktopCallbackInFlight = null;
  }
}

function getDesktopAuthLink(id) {
  const job = desktopLoginJob;
  if (!job || job.id !== id || job.state !== 'running' || !job.cancellable) return null;
  return findDesktopAuthLink(job.meta.provider, job.startedAt);
}

function getDesktopLoginContinuation(id, entry) {
  if (desktopLoginJob?.id !== id || !desktopLoginRunning() || !desktopLoginJob.cancellable) return null;
  if (desktopLoginContinuation) return desktopLoginContinuation;
  const firstLink = entry === undefined ? getDesktopAuthLink(id) : entry;
  const nonce = firstLink && new URL(firstLink).searchParams.get('qwSurface')?.split(':')[1];
  desktopLoginContinuation = findDesktopContinuation(desktopLoginJob.startedAt, nonce);
  return desktopLoginContinuation;
}

function getDesktopLoginNextUrl(id, entry) {
  return getDesktopLoginContinuation(id, entry)?.url ?? null;
}

async function relogin(id) {
  const job = newJob('relogin', { id });
  (async () => {
    try {
      const profiles = C.readProfilesStrict();
      const entry = profiles.entries.find((e) => e.id === id);
      if (!entry) throw new Error('account_not_found');
      const prev = profiles.last_active;
      if (prev !== id) {
        step(job, '1/3 先把客户端切到这个账号（其他账号的登录保持不动）');
        const sw = await switchAccount(id, { force: true });
        const okSw = await waitFor(() => sw.state !== 'running', 90000, 1500);
        // 切换没成功就停下：客户端的 sign-out 只作用于「当前」账号，
        // 这时候发出去会把原来的账号登出（旧代码就是这样把别的账号登出的）
        if (!okSw || sw.state === 'error') throw new Error('relogin_switch_failed');
      }
      // 发 sign-out 前再确认一次当前账号确实是目标账号
      if (C.readProfilesStrict().last_active !== id) throw new Error('relogin_switch_failed');
      step(job, '2/3 只登出这个账号，让客户端弹出登录窗口');
      try {
        // logoutWeb=false：不清网页登录状态，避免波及其他账号
        const r = await forwardAction({ type: 'sign-out', logoutWeb: false });
        step(job, r && r.ok ? '已发送 sign-out' : '渲染层未响应（客户端检测到登录失效后也会自己弹出登录）', r && r.ok ? 'info' : 'warn');
      } catch (e) { step(job, 'CDP 不可用：' + e.message + '（客户端检测到登录失效后也会自己弹出登录）', 'warn'); }
      step(job, '3/3 请在客户端窗口登录' + (entry.display_name || id) + (prev && prev !== id ? '；原账号的登录没有动，登录完成后可直接切回' : ''));
      C.audit('relogin', { id, from: prev });
      finish(job, { id, previous: prev, note: '请在应用窗口完成登录；完成后刷新页面' });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

async function logout(id, logoutWeb) {
  const job = newJob('logout', { id, logoutWeb: !!logoutWeb });
  (async () => {
    try {
      // 客户端的 sign-out 只作用于「当前」账号，并且会删除它在本机的凭据；
      // 以前这里忽略了 id，点别的账号的「登出」实际登出的是当前账号
      const cur = C.readProfiles().last_active;
      if (id && cur && id !== cur) throw new Error('not_current_account');
      step(job, '发送 sign-out');
      const r = await forwardAction({ type: 'sign-out', logoutWeb: !!logoutWeb });
      C.audit('logout', { id, logoutWeb: !!logoutWeb });
      finish(job, r || { ok: false });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

// ============ 移除账号（备份后摘除） ============
async function removeAccount(id) {
  const job = newJob('remove', { id });
  (async () => {
    try {
      const profiles = C.readProfiles();
      const entry = profiles.entries.find((e) => e.id === id);
      if (!entry) throw new Error('account_not_found');
      const dir = path.join(C.QW, entry.data_path || path.join('profiles', id));

      step(job, '备份账号目录');
      const bk = dir && fs.existsSync(dir) ? backupDir(dir, 'removed-' + id) : null;
      step(job, bk ? '已备份到 ' + bk : '目录不存在，跳过备份', bk ? 'info' : 'warn');

      step(job, '从 profiles.json 摘除');
      const next = C.readProfiles();
      next.entries = next.entries.filter((e) => e.id !== id);
      if (next.last_active === id) next.last_active = next.entries[0] ? next.entries[0].id : null;
      C.writeProfiles(next);

      if (dir && fs.existsSync(dir)) {
        const dest = path.join(C.BACKUPS, 'removed-data-' + id + '-' + Date.now());
        try { fs.renameSync(dir, dest); step(job, '目录已移入备份区'); } catch (e) { step(job, '目录移动失败：' + e.message, 'warn'); }
      }
      C.audit('remove_account', { id });
      finish(job, { id, backup: bk });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

// ============ 备份 / 恢复 ============
function backupDir(dir, tag) {
  C.ensureDirs();
  const name = (tag || path.basename(dir)) + '-' + new Date().toISOString().replace(/[:.]/g, '-');
  const zip = path.join(C.BACKUPS, name + '.zip');
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  try {
    execFileSync('tar', ['-a', '-c', '-f', zip, '-C', parent, base], { windowsHide: true, timeout: 600000 });
    return zip;
  } catch (e) {
    // 退化：目录复制
    const dest = path.join(C.BACKUPS, name);
    copyDir(dir, dest);
    return dest;
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    try {
      if (e.isDirectory()) copyDir(s, d);
      else if (e.isFile()) fs.copyFileSync(s, d);
    } catch (_) {}
  }
}

function listBackups() {
  C.ensureDirs();
  try {
    return fs.readdirSync(C.BACKUPS)
      .filter((n) => !/^staging-/.test(n) && !/^profiles-.*\.json$/i.test(n))
      .map((n) => {
        const p = path.join(C.BACKUPS, n);
        const st = fs.statSync(p);
        return { name: n, path: p, bytes: st.isDirectory() ? C.dirSizeSync(p) : st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
      })
      .filter((x) => x.dir || /\.zip$/i.test(x.name))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 100);
  } catch (_) { return []; }
}

function restoreBackup(fileName, targetId) {
  const job = newJob('restore', { fileName, targetId });
  (async () => {
    let staging = null;
    try {
      const safeName = path.basename(String(fileName || ''));
      if (!safeName || safeName !== fileName || safeName.includes('..')) throw new Error('invalid_backup_name');
      const src = path.join(C.BACKUPS, safeName);
      if (!fs.existsSync(src)) throw new Error('backup_not_found');
      const st = fs.statSync(src);
      if (!st.isDirectory() && !/\.zip$/i.test(safeName)) throw new Error('not_a_profile_backup');
      const dir = C.profileDir(targetId);
      if (!dir) throw new Error('account_not_found');
      step(job, '先备份当前账号数据');
      if (fs.existsSync(dir)) backupDir(dir, 'pre-restore-' + targetId);
      step(job, '解压备份到账号目录');
      staging = path.join(C.BACKUPS, 'staging-' + Date.now());
      fs.mkdirSync(staging, { recursive: true });
      if (/\.zip$/i.test(safeName)) {
        execFileSync('tar', ['-x', '-f', src, '-C', staging], { windowsHide: true, timeout: 600000 });
      } else {
        copyDir(src, staging);
      }
      // 找到 staging 里的 profile 根（可能多一层目录）
      const roots = fs.readdirSync(staging, { withFileTypes: true }).filter((e) => e.isDirectory());
      const source = roots.length === 1 ? path.join(staging, roots[0].name) : staging;
      copyDir(source, dir);
      step(job, '恢复完成');
      C.audit('restore', { fileName: safeName, targetId });
      finish(job, { targetId });
    } catch (e) { fail(job, e); }
    finally {
      if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {} }
    }
  })();
  return job;
}

// ============ 缓存清理 ============
const PURGE_SCOPES = {
  browser: ['Cache', 'GPUCache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'Dictionaries'],
  web: ['web_egress'],
  temp: ['tmp'],
};

function purgeCache(id, scopes) {
  const job = newJob('purge', { id, scopes });
  (async () => {
    try {
      const local = path.join(C.LOCAL);
      const removed = [];
      let freed = 0;
      for (const s of scopes || []) {
        for (const sub of (PURGE_SCOPES[s] || [])) {
          const p = path.join(local, sub);
          if (!fs.existsSync(p)) continue;
          try {
            const sz = C.dirSizeSync(p);
            fs.rmSync(p, { recursive: true, force: true });
            freed += sz; removed.push(sub);
            step(job, '已清理 ' + sub + ' (' + (sz / 1048576).toFixed(1) + ' MB)');
          } catch (e) { step(job, '清理 ' + sub + ' 失败：' + e.message, 'warn'); }
        }
      }
      C.audit('purge_cache', { scopes, removed, freed });
      finish(job, { removed, freed });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

// ============ 配置读取 / 克隆 ============
const CONFIG_FILES = {
  mcp: 'mcp_config.json',
  acp: 'acp_agents.json',
  toolPermissions: 'tool_permissions.json',
  allowedFolders: 'allowed_folders.db',
  integrations: 'integrations_config.json',
};

function readConfigs(id) {
  const dir = C.profileDir(id);
  if (!dir) return { ok: false, reason: 'account_not_found' };
  const out = { ok: true, mcp: null, acp: null, toolPermissions: null, integrations: null, allowedFolders: null };
  for (const [k, file] of Object.entries(CONFIG_FILES)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) { out[k] = null; continue; }
    if (file.endsWith('.json')) out[k] = C.readJson(p, null);
    else out[k] = { bytes: fs.statSync(p).size, path: p };
  }
  return out;
}

function cloneConfigs(fromId, toId, keys) {
  const job = newJob('clone', { fromId, toId, keys });
  (async () => {
    try {
      const from = C.profileDir(fromId);
      const to = C.profileDir(toId);
      if (!from || !to) throw new Error('account_not_found');
      const done = [];
      for (const k of keys || []) {
        const file = CONFIG_FILES[k];
        if (!file) { step(job, '未知配置项 ' + k, 'warn'); continue; }
        const s = path.join(from, file), d = path.join(to, file);
        if (!fs.existsSync(s)) { step(job, file + ' 源不存在，跳过', 'warn'); continue; }
        if (fs.existsSync(d)) { try { fs.copyFileSync(d, d + '.bak-' + Date.now()); } catch (_) {} }
        fs.copyFileSync(s, d);
        done.push(k);
        step(job, '已复制 ' + file);
      }
      C.audit('clone_configs', { fromId, toId, keys: done });
      finish(job, { done });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

// ============ MCP 连通性测试 ============
async function mcpTest(url) {
  const started = Date.now();
  const hdr = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const parse = (ct, text) => {
    if (ct.includes('text/event-stream')) {
      const out = [];
      for (const block of text.split(/\n\n/)) {
        const d = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (d) { try { out.push(JSON.parse(d)); } catch (_) {} }
      }
      return out;
    }
    try { return [JSON.parse(text)]; } catch (_) { return []; }
  };
  const post = async (body, sid) => {
    const h = Object.assign({}, hdr);
    if (sid) h['mcp-session-id'] = sid;
    const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, sid: res.headers.get('mcp-session-id'), msgs: parse(res.headers.get('content-type') || '', text), text };
  };

  try {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qwmgr', version: '1.0' } } });
    const initMsg = init.msgs.find((m) => m.id === 1) || {};
    const sid = init.sid;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sid).catch(() => {});
    const tl = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid);
    const tlMsg = tl.msgs.find((m) => m.id === 2) || {};
    const tools = (tlMsg.result && tlMsg.result.tools) || [];
    return {
      ok: init.status < 400,
      status: init.status,
      ms: Date.now() - started,
      serverInfo: initMsg.result && initMsg.result.serverInfo,
      protocolVersion: initMsg.result && initMsg.result.protocolVersion,
      instructions: initMsg.result && initMsg.result.instructions,
      toolCount: tools.length,
      tools: tools.map((t) => t.name).slice(0, 30),
    };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - started };
  }
}

// ============ relay / 日志 ============
async function relayStatus() {
  const out = { base: C.RELAY_BASE, health: null, stats: null, up: false };
  try { out.health = await C.httpGetJson(C.RELAY_BASE + '/health', 5000); out.up = true; } catch (_) {}
  try { out.stats = await C.httpGetJson(C.RELAY_BASE + '/stats', 5000); } catch (_) {}
  try {
    const tf = path.join(C.LOCAL, 'relay-token.txt');
    out.hasToken = fs.existsSync(tf);
  } catch (_) {}
  return out;
}

function listLogs() {
  const out = [];
  for (const dir of [C.LOGS_DIR, path.join(C.ROOT, 'tmp')]) {
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/\.log$/i.test(n)) continue;
        const p = path.join(dir, n);
        const st = fs.statSync(p);
        out.push({ name: n, path: p, bytes: st.size, mtime: st.mtimeMs, group: dir === C.LOGS_DIR ? 'app' : 'relay' });
      }
    } catch (_) {}
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 50);
}

function tailLog(name, n, level) {
  const found = listLogs().find((x) => x.name === name);
  if (!found) return { ok: false, reason: 'not_found' };
  let lines = C.tailLines(found.path, Math.min(Number(n) || 200, 2000));
  if (level) lines = lines.filter((l) => l.toUpperCase().includes(level.toUpperCase()));
  return { ok: true, name, lines };
}

// ============ 配置文件读写（MCP 等） ============
function saveMcpConfig(id, servers) {
  const dir = C.profileDir(id);
  if (!dir) return { ok: false, reason: 'account_not_found' };
  const p = path.join(dir, 'mcp_config.json');
  const next = { mcpServers: servers || {} };
  try {
    if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak-' + Date.now());
    C.writeJsonAtomic(p, next);
    C.audit('save_mcp', { id, count: Object.keys(next.mcpServers).length });
    return { ok: true, config: next };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ============ relay 控制 ============
const RELAY_SCRIPT = path.join(C.TOOLS, 'start-quick-relay.ps1');

function relayToken() {
  try { return fs.readFileSync(path.join(C.LOCAL, 'relay-token.txt'), 'utf8').trim(); } catch (_) { return null; }
}

function startRelay(mute) {
  const job = newJob('relay_start', { mute: !!mute });
  (async () => {
    try {
      step(job, '启动/重载 relay（遥测静音=' + (mute ? '开' : '关') + '）');
      if (!fs.existsSync(RELAY_SCRIPT)) throw new Error('relay_script_missing');
      const env = Object.assign({}, process.env, { QW_TELEMETRY_MUTE: mute ? '1' : '0' });
      const fd = fs.openSync(path.join(C.DATA, 'relay-start.log'), 'a');
      const p = require('child_process').spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', RELAY_SCRIPT], {
        env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
      });
      p.unref();
      step(job, '已拉起启动脚本，等待 relay 就绪');
      const ok = await waitFor(async () => !!(await C.relayHealth()), 240000, 3000);
      if (!ok) throw new Error('relay_not_ready');
      step(job, 'relay 就绪');
      C.audit('relay_start', { mute: !!mute });
      finish(job, { ready: true });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

// ============ 导入 / 纳管 ============
/** 扫描：profiles.json 里已有的 + profiles/ 目录里没登记的（孤儿） */
function scanProfiles() {
  const profiles = C.readProfiles();
  const known = new Set(profiles.entries.map((e) => e.data_path ? path.basename(e.data_path) : e.id));
  const knownIds = new Set(profiles.entries.map((e) => e.id));
  let dirs = [];
  try { dirs = fs.readdirSync(C.PROFILES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) {}
  const orphans = dirs.filter((d) => !known.has(d) && !knownIds.has(d)).map((d) => {
    const full = path.join(C.PROFILES_DIR, d);
    let bytes = 0;
    try { bytes = C.dirSizeSync(full); } catch (_) {}
    return { dir: d, path: full, bytes };
  });
  return {
    ok: true,
    current: profiles.last_active,
    entries: profiles.entries.map((e) => ({ id: e.id, name: e.display_name, dataPath: e.data_path })),
    orphans,
    profilesDir: C.PROFILES_DIR,
  };
}

/** 把孤儿目录纳管成账号 */
function adoptOrphans(dirs) {
  const job = newJob('adopt', { dirs });
  (async () => {
    try {
      const next = C.readProfiles();
      const have = new Set(next.entries.map((e) => e.id));
      const added = [];
      for (const d of dirs || []) {
        const safe = String(d).replace(/[^a-zA-Z0-9._-]/g, '');
        const full = path.join(C.PROFILES_DIR, safe);
        if (!fs.existsSync(full)) { step(job, '目录不存在：' + safe, 'warn'); continue; }
        if (have.has(safe)) { step(job, '已存在：' + safe, 'warn'); continue; }
        next.entries.push({
          id: safe,
          provider: 'social',
          display_name: safe,
          data_path: 'profiles/' + safe,
          login_metadata: null,
          created_at: new Date().toISOString(),
          last_used_at: null,
          refresh_failing_since: null,
        });
        have.add(safe);
        added.push(safe);
        step(job, '已纳管 ' + safe);
      }
      if (added.length) {
        step(job, '这些目录没有登录信息，客户端会拒收整份账号清单，未写入。请在客户端里登录对应账号', 'warn');
        throw new Error('profiles_entry_not_logged_in:' + added.join(','));
      }
      C.audit('adopt_profiles', { added });
      finish(job, { added });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

/** 从 JSON 批量导入账号元数据（不含任何 token/凭证） */
function importAccountsJson(text) {
  const job = newJob('import_json', {});
  (async () => {
    try {
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (data && Array.isArray(data.accounts)) list = data.accounts;
      else if (data && data.id) list = [data];
      else throw new Error('格式不对：需要一个账号对象、数组，或 {accounts:[...]}');
      const next = C.readProfiles();
      const have = new Set(next.entries.map((e) => e.id));
      const added = [];
      for (const it of list) {
        const id = String(it.id || '').replace(/[^a-zA-Z0-9._-]/g, '');
        if (!id) { step(job, '跳过一条：缺少 id', 'warn'); continue; }
        if (have.has(id)) { step(job, '已存在：' + id, 'warn'); continue; }
        const dataPath = (it.dataPath || it.data_path || ('profiles/' + id)).replace(/\\/g, '/');
        next.entries.push({
          id,
          provider: it.provider || 'social',
          display_name: it.displayName || it.display_name || id,
          data_path: dataPath,
          login_metadata: it.login_metadata || null,
          created_at: it.created_at || new Date().toISOString(),
          last_used_at: it.last_used_at || null,
          refresh_failing_since: null,
        });
        if (it.alias || it.group) C.setMeta(id, { alias: it.alias || null, group: it.group || null });
        have.add(id);
        added.push(id);
        step(job, '已导入 ' + id);
      }
      if (added.length) C.writeProfiles(next);
      C.audit('import_accounts', { added });
      finish(job, { added });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

/** 在线登录：把客户端窗口拉到前台并调起登录，返回捕获到的授权链接 */
async function onlineLogin() {
  const job = newJob('online_login', {});
  const urls = [];
  (async () => {
    try {
      if (!appRunning()) throw new Error('app_not_running');
      step(job, '1/3 把客户端窗口拉到前台');
      try {
        await cdpEval(`(() => {
          const r = process.mainModule.require;
          const BW = r('electron').BrowserWindow;
          const w = BW.getAllWindows().find((x) => !x.isDestroyed());
          if (!w) return { ok: false };
          if (w.isMinimized()) w.restore();
          w.show(); w.focus();
          return { ok: true };
        })()`, 8000);
      } catch (e) { step(job, '置前失败：' + e.message, 'warn'); }

      step(job, '2/3 调起客户端登录窗口');
      const before = ((await C.httpGetJson(C.RELAY_BASE + '/urls', 6000).catch(() => ({ urls: [] }))) || {}).urls || [];
      const beforeSet = new Set(before.map((x) => x.url));

      try {
        // 点火即走：quickSuiteAuth() 会一直挂到窗口关闭，不能 await
        await evalInRenderer('(() => { try { window.quickwork.quickSuiteAuth(); return "started"; } catch (e) { return "err:" + e.message; } })()');
        step(job, '已调起登录窗口');
      } catch (e) { step(job, '调用登录失败：' + e.message, 'warn'); }

      step(job, '3/3 捕获授权链接');
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const now = ((await C.httpGetJson(C.RELAY_BASE + '/urls', 6000).catch(() => ({ urls: [] }))) || {}).urls || [];
        for (const u of now) if (!beforeSet.has(u.url) && !urls.includes(u.url)) urls.push(u.url);
        if (urls.length) break;
      }
      // 兜底：直接读当前所有窗口的 URL
      try {
        const winUrls = await cdpEval(`(() => {
          const r = process.mainModule.require;
          const BW = r('electron').BrowserWindow;
          return BW.getAllWindows().map((w) => w.webContents.getURL()).filter((u) => /^https?:/i.test(u));
        })()`, 8000);
        for (const u of (winUrls || [])) if (!urls.includes(u)) urls.push(u);
      } catch (_) {}
      if (!urls.length) step(job, '暂未捕获到链接（窗口可能已在别处打开）', 'warn');
      else urls.forEach((u) => step(job, '链接：' + u.slice(0, 120)));
      C.audit('online_login', { urls: urls.length });
      finish(job, { urls });
    } catch (e) { fail(job, e); }
  })();
  return job;
}

/** 在 Quick 窗口里显示/恢复实时状态条（重新注入，幂等）
 *  顺序：先注入按会话统计（stats-per-conv），再注入胶囊（inject-statusbar） */
function showStatusBar() {
  const { execFile } = require('child_process');
  const tools = C.TOOLS;
  const evalJs = path.join(tools, 'renderer-eval.js');
  const chain = ['stats-per-conv.js', 'inject-statusbar.js']
    .map((f) => path.join(tools, f))
    .filter((f) => fs.existsSync(f));
  if (!chain.length) return Promise.resolve({ ok: false, error: 'scripts_missing' });

  const runOne = (file) => new Promise((resolve) => {
    execFile('node', [evalJs, file], { timeout: 90000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        file: path.basename(file),
        ok: !err && /(conv-stats-ok|statusbar-injected)/.test(String(stdout || '')),
        error: err ? err.message : null,
        out: String(stdout || '').slice(0, 200),
      });
    });
  });

  return (async () => {
    const results = [];
    for (const f of chain) results.push(await runOne(f));
    const ok = results.every((r) => r.ok);
    C.audit('show_status_bar', { ok, results });
    return { ok, results };
  })();
}

module.exports = {
  jobs, newJob, step, finish, fail, getJobs,
  cdpTargets, cdpEval, evalInRenderer, forwardAction, appRunning, sleep, waitFor,
  switchAccount, addAccount, cancelAddAccount, submitDesktopCallback, getDesktopAuthLink, getDesktopLoginNextUrl, desktopLoginRunning, relogin, logout, removeAccount,
  backupDir, listBackups, restoreBackup, purgeCache,
  readConfigs, cloneConfigs, mcpTest, relayStatus, listLogs, tailLog, saveMcpConfig,
  startRelay, relayToken,
  scanProfiles, adoptOrphans, importAccountsJson, onlineLogin,
  showStatusBar,
  CONFIG_FILES, PURGE_SCOPES,
};

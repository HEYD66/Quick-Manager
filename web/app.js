/* Quick 家庭账号助手 — 侧栏 + 分段刻度标签卡片前端（家人极简模式 + 管理员高密度后台，零外部依赖、零 window.prompt） */
'use strict';

const TOKEN = window.__QWM_TOKEN__ || '';
const AVATAR_COLORS = ['#7c3aed', '#3b82f6', '#059669', '#d97706', '#db2777', '#0891b2', '#4f46e5', '#0d9488'];
const SEG_COUNT = 28;

const NAV_TITLES = {
  accounts: '账户管理',
  conversations: '对话同步',
  template: '通用配置',
  api: '本地反代',
  settings: '设置与备份',
};

const DEFAULT_GROUPS = ['主力', '备用', '家人', '测试'];

const S = {
  nav: 'accounts',
  pool: null,
  theme: localStorage.getItem('qwm-theme') || 'dark',
  collapsed: localStorage.getItem('qwm-sidebar-collapsed') === '1',
  privacyMask: localStorage.getItem('qwm-privacy-mask') === '1',
  compact: localStorage.getItem('qwm-compact-cards') === '1',
  mcpAccountId: null,
  oauthPollTimer: null,
  convSelectedKey: null,
  convItems: [],
  convSearchTimer: null,
  lastHandoff: null,
  lastHandoffKey: '',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 格式化与隐私打码 ---------------- */
function fmtAgo(ts) {
  if (!ts) return '尚未记录';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

function fmtTime(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
}

function fmtTok(n) {
  const v = Number(n || 0);
  if (!v) return '0';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(v);
}

function shortModelName(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  return s
    .replace(/^(?:us|eu|ap|global)\.(?:anthropic|amazon)\./i, '')
    .replace(/^anthropic\./i, '')
    .replace(/^claude-/i, '');
}

function modelTagHtml(lm) {
  if (!lm || !lm.resolvedModel) return '';
  const full = lm.resolvedModel;
  const short = shortModelName(full);
  const tip = `实际底层模型：${full}` + (lm.tier ? `（档位：${lm.tier}）` : '') + (lm.title ? ` · 最近对话《${lm.title}》` : '');
  return `<span class="k-tag model" title="${esc(tip)}">${esc(short)}</span>`;
}

function fmtCountdown(resetsAtSec) {
  if (!resetsAtSec) return '';
  const diff = resetsAtSec * 1000 - Date.now();
  if (diff <= 0) return '即将重置';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return days + ' 天 ' + hours + ' 小时后重置';
  const mins = Math.floor((diff % 3600000) / 60000);
  return hours > 0 ? (hours + ' 小时 ' + mins + ' 分后重置') : (mins + ' 分钟后重置');
}

function maskIdentity(str) {
  const s = String(str || '').trim();
  if (!S.privacyMask || !s) return s;
  const at = s.indexOf('@');
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const mLocal = local.length <= 3
      ? local.charAt(0) + '***'
      : local.slice(0, 2) + '****' + local.slice(-2);
    const dot = domain.lastIndexOf('.');
    const mDomain = dot > 1 ? '***' + domain.slice(dot) : domain;
    return mLocal + '@' + mDomain;
  }
  if (s.length <= 2) return s.charAt(0) + '*';
  if (s.length <= 4) return s.charAt(0) + '**' + s.slice(-1);
  return s.slice(0, 2) + '***' + s.slice(-2);
}

/* ---------------- 网络与通知基础 ---------------- */
async function api(url, opts) {
  const o = Object.assign({ headers: {} }, opts || {});
  o.headers['x-qwm-token'] = TOKEN;
  if (o.body && typeof o.body !== 'string') {
    o.body = JSON.stringify(o.body);
    o.headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, o);
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (_) {}
  if (!res.ok) {
    throw new Error((data && (data.error || data.message)) || raw.slice(0, 140) || ('HTTP ' + res.status));
  }
  return data;
}

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4200);
}

function setBusy(on, title, sub) {
  $('busyMask').hidden = !on;
  if (title) $('busyTitle').textContent = title;
  if (sub) $('busySub').textContent = sub;
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || '已复制到剪贴板');
  } catch (_) {
    toast('自动复制失败，请手动选中复制', true);
  }
}

/* ---------------- 自定义模态框（替代 prompt/confirm） ---------------- */
function openModal({ title, bodyHtml, actions = [], wide = false, onClose = null }) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalBox').className = 'modal-box' + (wide ? ' wide' : '');
  const actBox = $('modalActions');
  actBox.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (a.cls || 'ghost');
    btn.textContent = a.label;
    btn.onclick = () => a.onClick && a.onClick(closeModal);
    actBox.appendChild(btn);
  }
  $('modal').hidden = false;
  openModal._onClose = onClose;
}

function closeModal() {
  $('modal').hidden = true;
  if (typeof openModal._onClose === 'function') {
    const fn = openModal._onClose;
    openModal._onClose = null;
    fn();
  }
}
$('modalX').onclick = closeModal;

function confirmModal(title, html, okLabel = '确认', danger = false) {
  return new Promise((resolve) => {
    openModal({
      title,
      bodyHtml: html,
      actions: [
        { label: '取消', cls: 'ghost', onClick: (close) => { close(); resolve(false); } },
        { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: (close) => { close(); resolve(true); } },
      ],
      onClose: () => resolve(false),
    });
  });
}

/* ---------------- SVG 图标集合（卡片微操作与侧栏） ---------------- */
const SVG_SUN = '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const SVG_MOON = '<svg class="ico" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

const ICO = {
  switch: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  refresh: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  bolt: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  key: '<svg class="ico ico-sm" viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
  edit: '<svg class="ico ico-sm" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  export: '<svg class="ico ico-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  trash: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  clock: '<svg class="ico" style="width:12px;height:12px" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
};

/* ---------------- 侧栏、主题、打码、紧凑模式 ---------------- */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', S.theme);
  const btn = $('themeBtn');
  btn.innerHTML = (S.theme === 'dark' ? SVG_SUN : SVG_MOON)
    + `<span class="nav-label" id="themeLabel">${S.theme === 'dark' ? '浅色模式' : '深色模式'}</span>`;
}

function applySidebarCollapse() {
  $('appShell').classList.toggle('collapsed', S.collapsed);
  $('collapseLabel').textContent = S.collapsed ? '展开侧栏' : '收起侧栏';
}

function syncToolbarToggles() {
  const maskLabel = S.privacyMask ? '隐私打码中' : '隐私打码';
  const admMask = $('admMaskBtn');
  if (admMask) {
    admMask.textContent = maskLabel;
    admMask.classList.toggle('active-toggle', S.privacyMask);
  }
  const cmpBtn = $('admCompactBtn');
  if (cmpBtn) {
    cmpBtn.textContent = S.compact ? '紧凑模式中' : '紧凑模式';
    cmpBtn.classList.toggle('active-toggle', S.compact);
  }
  const admGrid = $('admCardGrid');
  if (admGrid) admGrid.classList.toggle('compact', S.compact);
}

$('themeBtn').onclick = () => {
  S.theme = S.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('qwm-theme', S.theme);
  applyTheme();
};

$('collapseBtn').onclick = () => {
  S.collapsed = !S.collapsed;
  localStorage.setItem('qwm-sidebar-collapsed', S.collapsed ? '1' : '0');
  applySidebarCollapse();
};

function togglePrivacyMask() {
  S.privacyMask = !S.privacyMask;
  localStorage.setItem('qwm-privacy-mask', S.privacyMask ? '1' : '0');
  syncToolbarToggles();
  renderCurrentView();
}
$('admMaskBtn').onclick = togglePrivacyMask;

$('admCompactBtn').onclick = () => {
  S.compact = !S.compact;
  localStorage.setItem('qwm-compact-cards', S.compact ? '1' : '0');
  syncToolbarToggles();
};

/* ---------------- 导航路由（全功能直接开放） ---------------- */
function setNav(nav) {
  if (!NAV_TITLES[nav]) nav = 'accounts';
  S.nav = nav;

  document.querySelectorAll('#sidebarNav .nav-btn[data-nav]').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === nav);
  });
  document.querySelectorAll('main.content > section.view').forEach((sec) => {
    sec.hidden = sec.id !== 'view-' + nav;
  });
  $('pageTitle').textContent = NAV_TITLES[nav];

  if (nav === 'accounts') renderAdminAccounts();
  else if (nav === 'conversations') loadConversationsView();
  else if (nav === 'template') loadTemplateTab();
  else if (nav === 'api') loadQuickGw();
  else if (nav === 'settings') loadSettingsTab();
}

$('sidebarNav').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.nav-btn[data-nav]');
  if (!btn || btn.hidden) return;
  setNav(btn.dataset.nav);
});

async function handleSwitchHandoff(result, targetLabel, explicitKey = '') {
  const h = result && result.handoff;
  if (!h || !h.handoffPrompt) {
    if (!explicitKey) {
      $('switchHandoffBanner').hidden = true;
      S.lastHandoff = null;
    }
    return;
  }
  const key = explicitKey || `${result.switchedAt || Date.now()}:${h.sessionId}:${h.updatedAt || 0}`;
  if (key === S.lastHandoffKey) return;
  S.lastHandoffKey = key;
  S.lastHandoff = h;
  let autoCopied = false;
  if (!S.pool || S.pool.autoCopyHandoffOnSwitch !== false) {
    try {
      await Promise.race([
        navigator.clipboard.writeText(h.handoffPrompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1200)),
      ]);
      autoCopied = true;
    } catch (_) {}
  }
  $('handoffBannerTitle').textContent = `已切到「${targetLabel}」· 原账号「${h.accountLabel}」最近对话《${h.title || '未命名对话'}》已同步`;
  $('handoffBannerSub').textContent = autoCopied
    ? '已自动复制续聊指令（含本地文件路径）！在 AWS Quick 输入框按 Ctrl+V，新号会自动读取该文件并接续对话。'
    : '点击右侧「复制续聊指令」，在 AWS Quick 输入框按 Ctrl+V 即可让新号读取本地对话文件直接接续。';
  $('switchHandoffBanner').hidden = false;
}

$('handoffCopyBtn').onclick = () => {
  if (!S.lastHandoff || !S.lastHandoff.handoffPrompt) return;
  copyText(S.lastHandoff.handoffPrompt, '续聊指令（含本地路径）已复制！在 Quick 输入框按 Ctrl+V 即可让新号读取接续');
};
$('handoffOpenConvBtn').onclick = async () => {
  const h = S.lastHandoff;
  setNav('conversations');
  if (h && h.accountId && h.sessionId) {
    setTimeout(() => openConversationDetail(h.accountId, h.sessionId, `${h.accountId}:${h.sessionId}`), 150);
  }
};
$('handoffCloseBtn').onclick = () => { $('switchHandoffBanner').hidden = true; };

/* ---------------- 顶部状态条渲染 ---------------- */
function renderTopbar() {
  const pool = S.pool;
  if (!pool) return;
  $('blankLoginBanner').hidden = !(pool.blankLogin && pool.blankLogin.active);
  $('navAccCount').textContent = String((pool.accounts || []).length);

  const act = pool.active;
  const chip = $('activeTopChip');
  if (act) {
    const ok = !act.needsRelogin;
    chip.className = 'status-chip ' + (ok ? 'ok' : 'warn');
    chip.innerHTML = `<span class="dot ${ok ? 'ok' : ''}"></span><span id="activeTopText">当前：${esc(maskIdentity(act.label))}</span>`;
  } else {
    chip.className = 'status-chip';
    chip.innerHTML = '<span class="dot"></span><span id="activeTopText">未选择账号</span>';
  }

  const appPill = $('appPill');
  appPill.className = 'status-chip ' + (pool.quickRunning ? 'ok' : '');
  appPill.innerHTML = `<span class="dot ${pool.quickRunning ? 'ok' : ''}"></span>${pool.quickRunning ? 'AWS Quick 运行中' : 'AWS Quick 未运行'}`;
}

$('topRecheckBtn').onclick = async () => {
  const b = $('topRecheckBtn');
  b.disabled = true;
  try {
    await refreshPool();
    toast('已重新检测账号池与客户端状态');
  } finally {
    b.disabled = false;
  }
};

/* ---------------- 28 格分段 LED 刻度进度条（支持月度 + 会话双进度条） ---------------- */
function buildSegUnitHtml(win, opts = {}) {
  const { title = '', fetchedAt = null, fallbackText = '额度未刷新', small = false, showCountdown = false, unitCls = '' } = opts;
  if (!win || !win.limit) {
    const emptySegs = '<span class="seg"></span>'.repeat(SEG_COUNT);
    return `
      <div class="seg-unit ${unitCls}">
        <div class="seg-row">
          <div class="seg-track ${small ? 'sm' : ''}">${emptySegs}</div>
          <span class="seg-pct" style="color:var(--muted)">—</span>
        </div>
        <div class="seg-meta">
          <span>${esc(title ? title + ' · ' : '')}${esc(fallbackText)}</span>
          <span style="display:inline-flex;align-items:center;gap:4px">${ICO.clock} ${esc(fmtTime(fetchedAt))}</span>
        </div>
      </div>`;
  }

  const used = Number(win.used || 0);
  const limit = Number(win.limit || 0);
  const rawPct = win.percent != null ? Number(win.percent) : (limit > 0 ? (used / limit) * 100 : 0);
  const clamped = Math.max(0, Math.min(100, rawPct));
  let lit = Math.round((clamped / 100) * SEG_COUNT);
  if (used > 0 && lit === 0) lit = 1;
  const tone = clamped >= 85 ? 'bad' : clamped >= 60 ? 'warn' : 'ok';
  const pctStr = clamped >= 100 ? '100%' : (Math.abs(clamped - Math.round(clamped)) < 0.05 ? Math.round(clamped) + '%' : clamped.toFixed(1) + '%');

  let segs = '';
  for (let i = 0; i < SEG_COUNT; i++) {
    segs += i < lit ? `<span class="seg on ${tone}"></span>` : '<span class="seg"></span>';
  }

  const rightText = showCountdown && win.resets_at
    ? fmtCountdown(win.resets_at)
    : (showCountdown ? (used > 0 ? '活跃中' : '未消耗') : fmtTime(fetchedAt));

  return `
    <div class="seg-unit ${unitCls}">
      <div class="seg-row">
        <div class="seg-track ${small ? 'sm' : ''}">${segs}</div>
        <span class="seg-pct ${tone}">${pctStr}</span>
      </div>
      <div class="seg-meta">
        <span>${title ? esc(title) + ' ' : ''}<strong>${used} / ${limit}</strong></span>
        <span style="display:inline-flex;align-items:center;gap:4px">${ICO.clock} ${esc(rightText)}</span>
      </div>
    </div>`;
}

function renderSegmentedMeter(win, opts = {}) {
  return `<div class="seg-box">${buildSegUnitHtml(win, opts)}</div>`;
}

function renderDualQuotaMeters(q, opts = {}) {
  if (!q || !q.ok) {
    return renderSegmentedMeter(null, {
      title: '月度',
      fetchedAt: q && q.fetchedAt,
      fallbackText: opts.fallbackText || '未刷新云端额度',
    });
  }
  const mHtml = buildSegUnitHtml(q.monthly, {
    title: '月度',
    fetchedAt: q.fetchedAt,
    showCountdown: false,
    unitCls: 'monthly-unit',
  });
  const sHtml = q.session && q.session.limit
    ? buildSegUnitHtml(q.session, {
      title: '会话',
      fetchedAt: q.fetchedAt,
      small: true,
      showCountdown: true,
      unitCls: 'session-unit',
    })
    : '';
  return `<div class="seg-box">${mHtml}${sHtml}</div>`;
}

function providerLabel(a) {
  if (!a) return '个人';
  return a.providerType === 'enterprise' ? '企业 SSO' : 'Personal';
}

function statusPillForCard(a) {
  if (a.needsRelogin) return '<span class="badge bad">待重登</span>';
  if (a.status && a.status.code === 'exhausted') return '<span class="badge bad">额度已满</span>';
  if (a.status && a.status.code === 'low') return '<span class="badge warn">余量紧张</span>';
  return '<span class="badge ok">正常</span>';
}

/* ---------------- 顶部紧凑快捷换号条（融合进账户管理页） ---------------- */
function renderQuickBar(pool) {
  const act = pool.active;
  if (act) {
    $('heroAvatar').textContent = String(act.label || '?').trim().charAt(0).toUpperCase();
    $('heroAvatar').style.background = act.color || '#7c3aed';
    $('heroName').textContent = maskIdentity(act.label);
    $('heroBadge').textContent = act.status.label;
    $('heroBadge').className = 'badge ' + (act.status.tone === 'bad' ? 'bad' : act.status.tone === 'warn' ? 'warn' : 'ok');
    const q = act.quota;
    if (act.needsRelogin) {
      $('heroSub').textContent = '登录已过期，请直接点右侧「一键换空闲号」';
    } else if (q && q.ok) {
      const mText = q.monthly && q.monthly.limit ? `月度 ${q.monthly.used}/${q.monthly.limit}` : '';
      const sText = q.session && q.session.limit ? `会话 ${q.session.used}/${q.session.limit}` : '';
      const rText = q.monthly && q.monthly.resets_at ? fmtCountdown(q.monthly.resets_at) : '';
      $('heroSub').textContent = [mText, sText, rText].filter(Boolean).join(' · ') || '状态正常';
    } else {
      $('heroSub').textContent = '点击右侧「打开 AWS Quick」或刷新额度';
    }
  } else {
    $('heroAvatar').textContent = 'Q';
    $('heroAvatar').style.background = '#7c3aed';
    $('heroName').textContent = '暂无当前账号';
    $('heroBadge').textContent = '未配置';
    $('heroBadge').className = 'badge';
    $('heroSub').textContent = '点击下方「添加账号」或「采集本机」';
  }

  const users = pool.familyUsers || ['爸爸', '妈妈', '我'];
  $('familyUserChips').innerHTML = users.map((u) => {
    const active = pool.currentUserLabel === u;
    return `<button type="button" class="chip ${active ? 'active' : ''}" data-family-user="${esc(u)}">${esc(u)}</button>`;
  }).join('') + (pool.currentUserLabel ? `<button type="button" class="chip" data-family-user="">×` + `</button>` : '');

  const rec = pool.recommendedNext;
  const claimBtn = $('heroClaimBtn');
  if (rec) {
    claimBtn.disabled = false;
    const rem = rec.quota && rec.quota.monthly ? `（月余 ${Math.round(100 - rec.quota.monthly.percent)}%）` : '';
    $('heroNextHint').textContent = `优先推荐：「${maskIdentity(rec.label)}」${rem}`;
  } else if (act && !act.needsRelogin) {
    claimBtn.disabled = false;
    $('heroNextHint').textContent = '暂无其他空闲号，当前账号仍可正常使用';
  } else {
    claimBtn.disabled = true;
    $('heroNextHint').textContent = '暂无空闲可用账号，请添加或修复登录';
  }
}

$('familyUserChips').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-family-user]');
  if (!btn) return;
  try {
    await api('/api/pool/user', { method: 'POST', body: { userName: btn.dataset.familyUser } });
    await refreshPool();
  } catch (e) { toast(e.message, true); }
});

$('heroOpenBtn').onclick = async () => {
  try {
    const r = await api('/api/pool/open-quick', { method: 'POST', body: {} });
    toast(r.launched ? '正在打开 AWS Quick…' : '已为你切回 AWS Quick 窗口');
    setTimeout(refreshPool, 1500);
  } catch (e) { toast('打开失败：' + e.message, true); }
};

$('heroClaimBtn').onclick = async () => {
  setBusy(true, '正在为你分配最空闲的可用账号…', '正在切换凭据并重启 AWS Quick');
  try {
    const r = await api('/api/pool/claim', { method: 'POST', body: { excludeCurrent: true } });
    setBusy(false);
    const lbl = (r.account && r.account.label) || '目标账号';
    toast(r.message || (`已切换到「${lbl}」并正在打开 AWS Quick`));
    handleSwitchHandoff(r, lbl);
    refreshPool();
  } catch (e) {
    setBusy(false);
    toast('换号失败：' + e.message, true);
  }
};

/* ---------------- 视图 1：账户管理（融合一键换号 + Kiro 风格三列高密度卡片） ---------------- */
function renderAdminAccounts() {
  const pool = S.pool;
  if (!pool) return;
  renderTopbar();
  renderQuickBar(pool);

  const lt = pool.localTools || {};
  const faBtn = $('admFullAccessBtn');
  if (lt.allEnabled && lt.allAutoAllow) {
    faBtn.textContent = `完全权限 (${lt.enabledCount}/${lt.total})`;
    faBtn.className = 'btn accent';
    faBtn.title = '全部账号已放开本机终端与全盘文件 MCP 且自动放行，点击可管理或收回';
  } else {
    faBtn.textContent = `一键完全权限 (${lt.enabledCount || 0}/${lt.total || 0})`;
    faBtn.className = 'btn primary';
    faBtn.title = '一键为全部账号及后续新号开启本机终端/文件 MCP 与工具自动放行';
  }

  // 动态更新分组下拉框（保留当前选中）
  const grpSel = $('admGroupFilter');
  const prevGrp = grpSel.value || 'all';
  const groups = pool.groups || [];
  grpSel.innerHTML = '<option value="all">全部分组</option>'
    + groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')
    + '<option value="__ungrouped__">未分组</option>';
  if ([...grpSel.options].some((o) => o.value === prevGrp)) grpSel.value = prevGrp;

  const s = pool.summary;
  const q = ($('admSearchInput').value || '').trim().toLowerCase();
  const grpFilter = grpSel.value || 'all';
  const stFilter = $('admStatusFilter').value || 'all';

  let list = pool.accounts || [];
  if (grpFilter === '__ungrouped__') list = list.filter((a) => !(a.group || '').trim());
  else if (grpFilter !== 'all') list = list.filter((a) => (a.group || '').trim() === grpFilter);
  if (stFilter === 'ready') list = list.filter((a) => !a.needsRelogin && a.status.code !== 'exhausted');
  else if (stFilter === 'fix') list = list.filter((a) => a.needsRelogin || a.status.code === 'exhausted');
  if (q) {
    list = list.filter((a) => {
      const hay = [a.label, a.alias, a.displayName, a.email, a.group, a.note, a.profileId].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  const normalCount = (pool.accounts || []).filter((a) => !a.needsRelogin).length;
  $('admSummaryLine').innerHTML = `
    <span>共 ${s.total} 个账号${list.length !== s.total ? `（筛选显示 ${list.length}）` : ''}</span>
    <span class="badge ok">正常 ${normalCount}</span>
    ${s.needsMaintenance ? `<span class="badge bad">待维护 ${s.needsMaintenance}</span>` : ''}
    <span class="badge purple">完全权限 ${lt.enabledCount || 0}/${lt.total || 0}</span>
    <span class="muted">月余合计 ${s.totalMonthlyRemaining}</span>
  `;

  const grid = $('admCardGrid');
  if (!list.length) {
    grid.innerHTML = `<div class="empty-card" style="grid-column:1/-1">
      <div class="empty-title">${pool.accounts.length ? '没有匹配的账号' : '账号池暂无账号'}</div>
      <div class="muted">${pool.accounts.length ? '试试清空搜索词或切换分组/状态筛选。' : '点击上方「采集本机」或「+ 添加账号」。'}</div>
    </div>`;
    return;
  }

  grid.innerHTML = list.map((a) => {
    const qInfo = a.quota;
    const planText = (qInfo && qInfo.planLabel) || 'Quick';
    const permTag = a.fullAccess
      ? `<span class="k-tag perm" data-adm="fullaccess" data-id="${esc(a.id)}" title="完全权限已开启（点击切换）">完全权限</span>`
      : (a.mcpLocalTools
        ? `<span class="k-tag warn" data-adm="fullaccess" data-id="${esc(a.id)}" title="终端已开但需弹窗确认（点击开启完全权限）">终端需确认</span>`
        : `<span class="k-tag" data-adm="fullaccess" data-id="${esc(a.id)}" title="默认沙箱（点击开启完全权限）">默认沙箱</span>`);

    const probe = a.lastProbe || null;
    const probeCls = probe ? (probe.alive ? 'ok' : 'bad') : '';
    const probeTitle = probe
      ? (probe.alive
        ? `测活（上次存活 ${probe.latencyMs}ms · ${fmtAgo(probe.at)}，点击重新测活）`
        : `测活（上次异常：${probe.error || '不可用'} · ${fmtAgo(probe.at)}，点击重试）`)
      : '快速测活（检测 Token、云端接口存活与延迟）';

    const footLeft = a.reloginReason
      ? `<span style="color:var(--red)" title="${esc(a.reloginReason)}">${esc(a.reloginReason)}</span>`
      : `${ICO.clock} <span>${a.lastUsedAt ? '用过 ' + fmtAgo(a.lastUsedAt) : '尚未在桌面使用'}</span>`;

    return `
      <div class="k-card ${a.active ? 'active' : ''} ${a.needsRelogin ? 'needs-fix' : ''}">
        <div class="k-head">
          <div class="k-title-wrap">
            <div class="k-name" title="${esc(maskIdentity(a.label))}">${esc(maskIdentity(a.label))}</div>
            <div class="k-sub" title="${esc(maskIdentity(a.email || a.profileId))}">${esc(maskIdentity(a.email || a.profileId))}</div>
            <div class="k-note" data-adm="edit" data-id="${esc(a.id)}" title="点击编辑分组与备注">备注：${a.note ? esc(a.note) : '点击添加备注 / 分组'}</div>
          </div>
          <div class="k-badges">
            ${a.active ? '<span class="badge ok">使用中</span>' : ''}
            ${statusPillForCard(a)}
          </div>
        </div>

        <div class="k-tags">
          <span class="k-tag plan">${esc(planText)}</span>
          <span class="k-tag">${esc(providerLabel(a))}</span>
          ${a.group ? `<span class="k-tag grp">${esc(a.group)}</span>` : ''}
          ${permTag}
          ${!a.poolEnabled ? '<span class="k-tag warn">不自动分配</span>' : ''}
        </div>

        ${renderDualQuotaMeters(qInfo, {
          fallbackText: a.needsRelogin ? '登录失效，点下方钥匙重登' : '未刷新云端额度',
        })}

        <div class="k-foot">
          <div class="k-foot-left">${footLeft}</div>
          <div class="k-foot-acts">
            <button type="button" class="act-switch-pill" data-adm="switch" data-id="${esc(a.id)}" title="${a.active ? '当前正在桌面使用' : '一键切换到此账号'}" ${a.active || a.needsRelogin ? 'disabled' : ''}>${a.active ? '使用中' : '切换'}</button>
            <button type="button" class="act-ico" data-adm="quota" data-id="${esc(a.id)}" title="刷新真实云端额度">${ICO.refresh}</button>
            <button type="button" class="act-ico ${probeCls}" data-adm="probe" data-id="${esc(a.id)}" title="${esc(probeTitle)}">${ICO.bolt}</button>
            <button type="button" class="act-ico ${a.needsRelogin ? 'ok' : ''}" data-adm="relogin" data-id="${esc(a.id)}" title="${a.needsRelogin ? '立即修复登录' : '重新登录'}">${ICO.key}</button>
            <button type="button" class="act-ico" data-adm="edit" data-id="${esc(a.id)}" title="编辑昵称 / 分组 / 备注">${ICO.edit}</button>
            <button type="button" class="act-ico" data-adm="export" data-id="${esc(a.id)}" title="导出 JSON 凭证">${ICO.export}</button>
            <button type="button" class="act-ico danger" data-adm="remove" data-id="${esc(a.id)}" title="备份并移除账号">${ICO.trash}</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

$('admSearchInput').oninput = () => renderAdminAccounts();
$('admGroupFilter').onchange = () => renderAdminAccounts();
$('admStatusFilter').onchange = () => renderAdminAccounts();

$('admCardGrid').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-adm]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.adm;
  const id = btn.dataset.id;
  const acc = S.pool && S.pool.accounts.find((x) => x.id === id);
  if (!acc) return;

  if (act === 'switch') {
    setBusy(true, '正在切换到「' + acc.label + '」…', '正在切换凭据并重启 AWS Quick');
    try {
      const r = await api('/api/pool/switch', { method: 'POST', body: { id, launch: true } });
      setBusy(false);
      toast(`已切换到「${acc.label}」并正在打开 AWS Quick`);
      handleSwitchHandoff(r, acc.label);
      refreshPool();
    } catch (e) {
      setBusy(false);
      toast('切换失败：' + e.message, true);
    }
  } else if (act === 'quota') {
    btn.disabled = true;
    try {
      const r = await api('/api/pool/refresh-quota', { method: 'POST', body: { id } });
      toast(r.ok ? '已刷新真实云端额度' : ('刷新失败：' + (r.error || '未知')), !r.ok);
      await refreshPool();
    } catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  } else if (act === 'probe') {
    btn.disabled = true;
    toast(`正在测活「${maskIdentity(acc.label)}」…`);
    try {
      const r = await api('/api/pool/probe', { method: 'POST', body: { id } });
      if (r.alive) {
        const remM = r.monthlyRemaining != null ? ` · 月余 ${r.monthlyRemaining}` : '';
        const remS = r.sessionRemaining != null ? ` · 会话余 ${r.sessionRemaining}` : '';
        const modStr = r.lastModel && r.lastModel.resolvedModel ? ` · 模型 ${shortModelName(r.lastModel.resolvedModel)}` : '';
        const sessWarn = r.sessionsOk === false ? '（会话接口受限）' : '';
        toast(`测活通过：「${maskIdentity(acc.label)}」存活 ${r.latencyMs}ms${remM}${remS}${modStr}${sessWarn}`);
      } else {
        toast(`测活异常：「${maskIdentity(acc.label)}」${r.error || '不可用'} (${r.latencyMs || 0}ms)`, true);
      }
      await refreshPool();
    } catch (e) { toast('测活失败：' + e.message, true); }
    finally { btn.disabled = false; }
  } else if (act === 'fullaccess') {
    const enable = !acc.fullAccess;
    const tip = enable
      ? `为「<b>${esc(acc.label)}</b>」开启本机终端与全盘文件读写权限（挂载 <code>local-tools</code> MCP 并自动放行工具调用）？`
      : `关闭「<b>${esc(acc.label)}</b>」的完全权限，恢复默认只读沙箱与工具确认弹窗？`;
    const ok = await confirmModal(enable ? '开启完全权限' : '关闭完全权限',
      tip + (acc.active ? '<br><br>这是当前正在使用的账号，确认后会自动平滑重启 AWS Quick 立即生效。' : ''),
      enable ? '开启并生效' : '关闭并生效', !enable);
    if (!ok) return;
    setBusy(true, (enable ? '正在开启' : '正在关闭') + '完全权限…', acc.active ? '正在同步配置并平滑重启 AWS Quick' : '正在写入账号配置');
    try {
      const r = await api('/api/pool/local-tools', {
        method: 'POST',
        body: { accountId: id, enabled: enable, autoAllowTools: enable, restartQuick: acc.active },
      });
      toast((enable ? '已开启' : '已关闭') + `「${acc.label}」的完全权限` + (r.restarted ? '，Quick 已重启生效' : ''));
      await refreshPool();
    } catch (e) { toast('操作失败：' + e.message, true); }
    finally { setBusy(false); }
  } else if (act === 'relogin') {
    openOAuthWizard({ reloginAccount: acc });
  } else if (act === 'edit') {
    openEditAccountModal(acc);
  } else if (act === 'export') {
    try {
      const r = await api('/api/pool/account/' + encodeURIComponent(id) + '/export', { method: 'POST', body: {} });
      const text = JSON.stringify(r.data, null, 2);
      openModal({
        title: '导出账号凭证 · ' + acc.label,
        wide: true,
        bodyHtml: `
          <p class="muted" style="margin-top:0">标准 JSON 凭证（兼容本软件、AWS Quick Tools 与 Magpie）。请勿泄露给他人。</p>
          <pre class="code" id="exportCode">${esc(text)}</pre>`,
        actions: [
          { label: '关闭', cls: 'ghost', onClick: (c) => c() },
          { label: '复制凭证 JSON', cls: 'primary', onClick: () => copyText(text, '凭证 JSON 已复制') },
        ],
      });
    } catch (e) { toast(e.message, true); }
  } else if (act === 'remove') {
    const ok = await confirmModal('备份并移除账号', `确定移除「<b>${esc(acc.label)}</b>」？<br><br>系统会先将它的本地会话数据打包备份到 <code>data/backups/</code>，再从账号池摘除。`, '备份并移除', true);
    if (!ok) return;
    try {
      await api('/api/pool/account/' + encodeURIComponent(id), { method: 'DELETE', body: { confirm: true } });
      toast('已备份并移除');
      await refreshPool();
    } catch (e) { toast('移除失败：' + e.message, true); }
  }
});

$('admSyncBtn').onclick = async () => {
  const b = $('admSyncBtn');
  b.disabled = true;
  try {
    const r = await api('/api/pool/sync-desktop', { method: 'POST', body: { includeExisting: true } });
    toast(`采集完成：新增 ${r.added}，更新 ${r.updated}`);
    await refreshPool();
  } catch (e) { toast('采集失败：' + e.message, true); }
  finally { b.disabled = false; }
};

$('admImportBtn').onclick = () => openImportJsonModal();

$('admFullAccessBtn').onclick = async () => {
  const lt = (S.pool && S.pool.localTools) || {};
  const isAllOpen = !!(lt.allEnabled && lt.allAutoAllow);
  openModal({
    title: '一键开启完全权限（本机终端 + 全盘文件读写）',
    bodyHtml: `
      <p class="muted" style="margin-top:0">通过 AWS Quick 官方 MCP 挂载本地无乱码 <code>local-tools</code> 工具，并将工具策略设为自动放行，让 AWS Quick 可以直接运行本机终端命令和读写文件。</p>
      <div class="step-box">
        <div><strong>当前覆盖</strong>：${lt.enabledCount || 0} / ${lt.total || 0} 个账号已挂载终端 MCP · ${lt.autoAllowCount || 0} / ${lt.total || 0} 个账号自动放行</div>
        <div class="hint" style="margin-top:6px">开启后会自动写入「家庭通用配置模板」，以后通过远程 VPS、无痕登录或 JSON 导入的新账号也会<b>自动继承完全权限</b>。</div>
      </div>
      <div style="margin-top:12px">
        <label class="inline"><input type="checkbox" id="faRestartChk" checked> 应用后自动平滑重启 AWS Quick 立即生效</label>
      </div>
    `,
    actions: [
      { label: '取消', cls: 'ghost', onClick: (c) => c() },
      ...(lt.enabledCount > 0 ? [{
        label: '收回全部完全权限',
        cls: 'danger',
        onClick: async (close) => {
          const restartQuick = $('faRestartChk').checked;
          close();
          setBusy(true, '正在收回所有账号的完全权限…', restartQuick ? '正在恢复默认沙箱并平滑重启 AWS Quick' : '正在更新全部账号配置');
          try {
            const r = await api('/api/pool/local-tools', { method: 'POST', body: { enabled: false, autoAllowTools: false, restartQuick } });
            toast('已收回全部完全权限' + (r.restarted ? '，Quick 已重启生效' : ''));
            await refreshPool();
          } catch (e) { toast('操作失败：' + e.message, true); }
          finally { setBusy(false); }
        },
      }] : []),
      {
        label: isAllOpen ? '重新同步并重启生效' : '一键全部开启',
        cls: 'primary',
        onClick: async (close) => {
          const restartQuick = $('faRestartChk').checked;
          close();
          setBusy(true, '正在为全部账号开启完全权限…', restartQuick ? '正在写入配置并平滑重启 AWS Quick 使其生效' : '正在写入全部账号配置与通用模板');
          try {
            const r = await api('/api/pool/local-tools', { method: 'POST', body: { enabled: true, autoAllowTools: true, restartQuick } });
            toast(`已为全部 ${r.localTools.enabledCount} 个账号开启完全权限` + (r.restarted ? '，Quick 已重启生效' : ''));
            await refreshPool();
          } catch (e) { toast('操作失败：' + e.message, true); }
          finally { setBusy(false); }
        },
      },
    ],
  });
};

$('admRefreshAllBtn').onclick = async () => {
  const b = $('admRefreshAllBtn');
  b.disabled = true; b.textContent = '刷新全池中…';
  try {
    const r = await api('/api/pool/refresh-quota', { method: 'POST', body: {} });
    toast(`全池刷新完成：成功 ${r.refreshed} / ${r.total}`);
    await refreshPool();
  } catch (e) { toast('刷新失败：' + e.message, true); }
  finally { b.disabled = false; b.textContent = '刷新全部额度'; }
};

$('cancelBlankLoginBtn').onclick = async () => {
  try {
    await api('/api/pool/blank-login/cancel', { method: 'POST', body: {} });
    toast('已取消并恢复原有账号列表');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- 编辑账号自定义弹窗（支持昵称 / 分组 / 备注 / 颜色） ---------------- */
function openEditAccountModal(acc) {
  let chosenColor = acc.color || AVATAR_COLORS[0];
  const presetGroups = [...new Set([...DEFAULT_GROUPS, ...((S.pool && S.pool.groups) || [])])];
  openModal({
    title: '编辑账号 · ' + acc.label,
    bodyHtml: `
      <div class="form-grid">
        <label>显示昵称
          <input class="input" id="editAlias" value="${esc(acc.alias || '')}" placeholder="${esc(acc.displayName)}">
        </label>
        <label>账号分组（可自定义或点下方快捷选择）
          <input class="input" id="editGroup" value="${esc(acc.group || '')}" placeholder="如：主力 / 备用 / 家人">
        </label>
      </div>
      <div style="margin-top:8px">
        <div class="chips" id="groupQuickChips">
          ${presetGroups.map((g) => `<button type="button" class="chip ${acc.group === g ? 'active' : ''}" data-grp="${esc(g)}">${esc(g)}</button>`).join('')}
          <button type="button" class="chip" data-grp="">清空分组</button>
        </div>
      </div>
      <div style="margin-top:12px">
        <label style="display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--muted)">备注说明（显示在卡片上，支持搜索）
          <input class="input" id="editNote" value="${esc(acc.note || '')}" placeholder="如：主要写代码用 / 5月底到期">
        </label>
      </div>
      <div style="margin-top:14px">
        <div class="muted">头像颜色</div>
        <div class="swatches" id="colorSwatches">
          ${AVATAR_COLORS.map((c) => `<button type="button" class="swatch ${c === chosenColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
        </div>
      </div>
      <div style="margin-top:14px">
        <label class="inline">
          <input type="checkbox" id="editPoolEnabled" ${acc.poolEnabled ? 'checked' : ''}>
          参与「一键换空闲号」自动分配
        </label>
      </div>
    `,
    actions: [
      { label: '取消', cls: 'ghost', onClick: (c) => c() },
      {
        label: '保存修改',
        cls: 'primary',
        onClick: async (close) => {
          try {
            await api('/api/pool/account/' + encodeURIComponent(acc.id) + '/meta', {
              method: 'POST',
              body: {
                alias: $('editAlias').value.trim(),
                group: $('editGroup').value.trim(),
                note: $('editNote').value.trim(),
                color: chosenColor,
                poolEnabled: $('editPoolEnabled').checked,
              },
            });
            toast('已保存账号信息');
            close();
            await refreshPool();
          } catch (e) { toast('保存失败：' + e.message, true); }
        },
      },
    ],
  });
  $('groupQuickChips').onclick = (ev) => {
    const ch = ev.target.closest('.chip');
    if (!ch) return;
    $('editGroup').value = ch.dataset.grp || '';
    $('groupQuickChips').querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === ch && !!ch.dataset.grp));
  };
  $('colorSwatches').onclick = (ev) => {
    const sw = ev.target.closest('.swatch');
    if (!sw) return;
    chosenColor = sw.dataset.color;
    $('colorSwatches').querySelectorAll('.swatch').forEach((x) => x.classList.toggle('selected', x === sw));
  };
}

/* ---------------- 添加账号 & 远程 VPS 登录向导 ---------------- */
$('admAddBtn').onclick = () => {
  openModal({
    title: '添加新账号到账号池',
    wide: true,
    bodyHtml: `
      <div class="opt-grid">
        <button type="button" class="opt-card featured" data-add-mode="remote">
          <div class="opt-title">远程 VPS / 跨设备登录 <span class="badge ok">推荐</span></div>
          <div class="opt-desc">绝不弹出本机浏览器抢跑；支持复制授权链接到远程浏览器登录，支持粘贴回调或 SSH 反向隧道自动完成。</div>
        </button>
        <button type="button" class="opt-card" data-add-mode="local">
          <div class="opt-title">本机无痕浏览器登录</div>
          <div class="opt-desc">自动用 Edge InPrivate / Chrome 无痕窗口发起独立 OAuth 登录，不串本机已有 AWS 会话，无需重启客户端。</div>
        </button>
        <button type="button" class="opt-card" data-add-mode="json">
          <div class="opt-title">导入账号凭证（JSON）</div>
          <div class="opt-desc">支持从远程 VPS、AWS Quick Tools 或 Magpie 导出的标准 JSON 凭证，自动写入本机 Windows 凭据管理器。</div>
        </button>
        <button type="button" class="opt-card" data-add-mode="blank">
          <div class="opt-title">桌面端空白窗口登录</div>
          <div class="opt-desc">先备份现有账号再打开空白 AWS Quick 窗口登录新号，完成后自动合并原有全部账号。</div>
        </button>
      </div>
    `,
    actions: [{ label: '关闭', cls: 'ghost', onClick: (c) => c() }],
  });
  $('modalBody').querySelectorAll('[data-add-mode]').forEach((el) => {
    el.onclick = () => {
      const m = el.dataset.addMode;
      if (m === 'remote') openOAuthWizard({ remote: true });
      if (m === 'local') openOAuthWizard({ remote: false });
      if (m === 'json') openImportJsonModal();
      if (m === 'blank') startBlankDesktopLogin();
    };
  });
};

function stopOAuthPoll() {
  if (S.oauthPollTimer) { clearInterval(S.oauthPollTimer); S.oauthPollTimer = null; }
}

function openOAuthWizard({ remote = false, reloginAccount = null } = {}) {
  stopOAuthPoll();
  const isRelogin = !!reloginAccount;
  const title = isRelogin
    ? `重新登录「${reloginAccount.label}」`
    : (remote ? '远程 VPS / 跨设备登录向导' : '本机无痕浏览器登录');

  openModal({
    title,
    wide: true,
    bodyHtml: `
      <div class="row" style="margin-bottom:12px">
        ${isRelogin ? `
          <label class="inline"><input type="radio" name="oauthRemoteMode" value="0" ${!remote ? 'checked' : ''}> 本机无痕窗口登录</label>
          <label class="inline"><input type="radio" name="oauthRemoteMode" value="1" ${remote ? 'checked' : ''}> 远程 VPS / 其他设备登录</label>
        ` : `
          <label class="inline">账号类型：
            <select class="select sm" id="oauthProvider">
              <option value="social">个人账号（最常用）</option>
              <option value="enterprise">企业 SSO</option>
            </select>
          </label>
        `}
        <button type="button" class="btn primary sm" id="oauthStartBtn">生成授权链接</button>
        <button type="button" class="btn ghost sm" id="oauthCancelBtn" hidden>取消本次授权</button>
      </div>

      <div id="oauthWorkspace" hidden>
        <div class="step-box" id="oauthStep1Box">
          <div class="step-title" id="oauthStep1Title">第 1 步：在目标浏览器打开授权链接</div>
          <div class="hint" id="oauthStep1Hint"></div>
          <div class="link-row">
            <input class="input grow" id="oauthEntryUrl" readonly>
            <button type="button" class="btn sm" id="oauthCopyEntry">复制链接</button>
          </div>
          <div id="oauthSshWrap" style="margin-top:10px" hidden>
            <div class="hint">如果你能从本机 SSH 连 VPS，运行下面这行命令后在 VPS 浏览器打开上方链接，即可<b>全自动完成，无需手动粘贴回调</b>：</div>
            <div class="link-row">
              <input class="input grow" id="oauthSshCmd" readonly>
              <button type="button" class="btn sm" id="oauthCopySsh">复制 SSH</button>
            </div>
          </div>
        </div>

        <div class="step-box" id="oauthStep2Box" hidden>
          <div class="step-title">第 2 步：在同一个远程浏览器打开最终确认链接</div>
          <div class="hint">已成功识别你的账号租户！复制下面这条链接到刚才同一个 VPS 浏览器打开并确认授权：</div>
          <div class="link-row">
            <input class="input grow" id="oauthAuthUrl" readonly>
            <button type="button" class="btn sm primary" id="oauthCopyAuth">复制第二步链接</button>
          </div>
        </div>

        <div class="step-box" id="oauthPasteBox">
          <div class="step-title" id="oauthPasteTitle">没有 SSH 隧道？直接把 VPS 浏览器跳转后的地址粘到这里</div>
          <div class="hint" id="oauthPasteHint">登录跳转后浏览器显示「无法访问 127.0.0.1」是完全正常的！直接复制浏览器地址栏里的完整网址（含 <code>?nonce=</code> 或 <code>?code=</code>）粘到下面并点提交：</div>
          <div class="link-row">
            <input class="input grow" id="oauthCallbackInput" placeholder="粘贴浏览器地址栏里的完整 127.0.0.1 回调地址…" autocomplete="off">
            <button type="button" class="btn accent sm" id="oauthSubmitBtn">提交回调</button>
          </div>
          <div class="hint" id="oauthSubmitMsg" style="margin-top:6px"></div>
        </div>
      </div>

      <div class="hint" id="oauthLiveStatus" style="margin-top:12px">点击「生成授权链接」开始。${remote ? '本模式绝不会弹出本机浏览器，彻底避免串号。' : ''}</div>
    `,
    actions: [{ label: '关闭窗口', cls: 'ghost', onClick: (c) => c() }],
    onClose: () => stopOAuthPoll(),
  });

  const renderState = (st) => {
    if (!st) return;
    $('oauthWorkspace').hidden = false;
    $('oauthCancelBtn').hidden = !(st.stage === 'await_discovery' || st.stage === 'await_code');
    $('oauthEntryUrl').value = st.entryUrl || '';
    $('oauthSshCmd').value = st.sshCommand || '';
    $('oauthSshWrap').hidden = !st.remote;

    if (st.stage === 'await_discovery') {
      $('oauthStep1Title').textContent = st.remote ? '第 1 步：复制链接到远程 VPS 浏览器打开' : '已用无痕浏览器打开，若未自动弹出可手动复制';
      $('oauthStep1Hint').textContent = st.remote
        ? '在 VPS 浏览器登录后，地址栏会跳到 http://127.0.0.1:' + st.port + '/callback?nonce=...（显示无法连接是正常的），复制完整地址粘到下方提交即可。'
        : `已尝试使用 ${(st.browserInfo && st.browserInfo.browser) || '浏览器'} 打开，完成后会自动收录，无需手动粘贴。`;
      $('oauthStep2Box').hidden = true;
      $('oauthLiveStatus').textContent = '状态：等待第一步授权…（会话 10 分钟内有效）';
    } else if (st.stage === 'await_code') {
      const skippedHop1 = st.entryUrl === st.authorizeUrl;
      $('oauthStep1Title').textContent = skippedHop1 ? '单步直达：在目标浏览器打开此链接完成授权' : '第 1 步已完成 ✓';
      $('oauthStep2Box').hidden = skippedHop1;
      $('oauthAuthUrl').value = st.authorizeUrl || '';
      $('oauthLiveStatus').textContent = '状态：等待最终登录授权确认…';
    } else if (st.stage === 'exchanging') {
      $('oauthLiveStatus').textContent = '状态：正在向 AWS 换取独立登录凭据并写入本机…';
    } else if (st.stage === 'done') {
      stopOAuthPoll();
      const who = (st.account && (st.account.displayName || st.account.email)) || '账号';
      toast(`授权成功！「${who}」已加入账号池并写入本机凭据`);
      refreshPool();
      closeModal();
    } else if (st.stage === 'error') {
      stopOAuthPoll();
      $('oauthLiveStatus').textContent = '失败：' + (st.error || '未知错误');
      $('oauthLiveStatus').style.color = 'var(--red)';
    } else if (st.stage === 'cancelled') {
      stopOAuthPoll();
      $('oauthLiveStatus').textContent = '已取消本次授权。';
    }
  };

  $('oauthCopyEntry').onclick = () => copyText($('oauthEntryUrl').value, '授权链接已复制');
  $('oauthCopyAuth').onclick = () => copyText($('oauthAuthUrl').value, '第二步授权链接已复制');
  $('oauthCopySsh').onclick = () => copyText($('oauthSshCmd').value, 'SSH 转发命令已复制');

  $('oauthStartBtn').onclick = async () => {
    const startBtn = $('oauthStartBtn');
    startBtn.disabled = true;
    $('oauthLiveStatus').style.color = '';
    $('oauthLiveStatus').textContent = '正在准备授权会话…';
    try {
      const remoteChoice = isRelogin
        ? (document.querySelector('input[name="oauthRemoteMode"]:checked')?.value === '1')
        : remote;
      const provider = $('oauthProvider') ? $('oauthProvider').value : (reloginAccount?.providerType || 'social');
      const r = await api('/api/pool/oauth/start', {
        method: 'POST',
        body: { provider, remote: remoteChoice, accountId: reloginAccount ? reloginAccount.id : null },
      });
      renderState(r.oauth);
      stopOAuthPoll();
      S.oauthPollTimer = setInterval(async () => {
        try {
          const st = await api('/api/pool/oauth/status');
          if (st.oauth) renderState(st.oauth);
        } catch (_) {}
      }, 1800);
    } catch (e) {
      $('oauthLiveStatus').textContent = '启动失败：' + e.message;
      $('oauthLiveStatus').style.color = 'var(--red)';
    } finally {
      startBtn.disabled = false;
    }
  };

  $('oauthSubmitBtn').onclick = async () => {
    const val = ($('oauthCallbackInput').value || '').trim();
    if (!val) return toast('请先粘贴回调地址', true);
    const b = $('oauthSubmitBtn');
    b.disabled = true;
    $('oauthSubmitMsg').textContent = '正在校验并提交…';
    try {
      const r = await api('/api/pool/oauth/submit', { method: 'POST', body: { url: val } });
      $('oauthCallbackInput').value = '';
      if (r.stage === 'await_code') {
        $('oauthSubmitMsg').textContent = '第一步已通过！请复制上方「第 2 步链接」到同一个 VPS 浏览器打开完成登录，再把新的回调地址粘回这里。';
      } else {
        $('oauthSubmitMsg').textContent = '授权已完成！';
      }
      if (r.state) renderState(r.state);
    } catch (e) {
      $('oauthSubmitMsg').textContent = '提交失败：' + e.message;
    } finally {
      b.disabled = false;
    }
  };

  $('oauthCancelBtn').onclick = async () => {
    await api('/api/pool/oauth/cancel', { method: 'POST', body: {} }).catch(() => {});
    stopOAuthPoll();
    $('oauthCancelBtn').hidden = true;
    $('oauthLiveStatus').textContent = '已取消本次授权。';
  };
}

function openImportJsonModal() {
  openModal({
    title: '导入账号凭证（JSON）',
    wide: true,
    bodyHtml: `
      <p class="muted" style="margin-top:0">兼容从远程 VPS、AWS Quick Tools、Magpie 或 awsquick-2api 导出的标准 JSON 凭证（支持单对象或数组）。导入后会自动写入本机 Windows 凭据管理器。</p>
      <p class="hint" style="color:var(--amber)">提醒：从 VPS 导入凭据后，请不要再在 VPS 上同时使用同一个号，以免两边抢刷新 token 导致互相掉线。</p>
      <textarea class="input" id="importJsonArea" style="width:100%;height:170px;margin-top:8px" placeholder='粘贴包含 access_token / refresh_token / tenant_url 的 JSON…'></textarea>
    `,
    actions: [
      { label: '取消', cls: 'ghost', onClick: (c) => c() },
      {
        label: '导入并验证额度',
        cls: 'primary',
        onClick: async (close) => {
          const text = ($('importJsonArea').value || '').trim();
          if (!text) return toast('请先粘贴 JSON 凭证', true);
          setBusy(true, '正在导入凭证并验证云端额度…', '会自动写入本机 Windows 凭据管理器');
          try {
            const r = await api('/api/pool/import-json', { method: 'POST', body: { text } });
            toast(`成功导入 ${r.count} 个账号！`);
            close();
            await refreshPool();
          } catch (e) {
            toast('导入失败：' + e.message, true);
          } finally {
            setBusy(false);
          }
        },
      },
    ],
  });
}

async function startBlankDesktopLogin() {
  closeModal();
  const ok = await confirmModal('桌面端空白窗口登录',
    '系统会先备份当前全部账号，暂时打开一个空白的 AWS Quick 窗口供你登录新号。<br><br>登录完成后会自动把之前所有账号全部合回来，不会丢数据。继续？',
    '启动空白登录窗口');
  if (!ok) return;
  try {
    await api('/api/pool/blank-login/start', { method: 'POST', body: {} });
    toast('已打开空白 AWS Quick 窗口，请在客户端中完成登录');
    await refreshPool();
  } catch (e) { toast('启动失败：' + e.message, true); }
}

/* ---------------- 视图 3：对话同步中心 ---------------- */
function updateConvSyncOneBtn() {
  const accId = $('convAccountFilter').value || '';
  const btn = $('convSyncOneBtn');
  if (!accId) {
    btn.disabled = true;
    btn.textContent = '同步选中账号';
    btn.title = '请先选择单个账号，或直接点击下方账号胶囊右侧的同步图标';
    return;
  }
  const acc = S.pool && (S.pool.accounts || []).find((x) => x.id === accId);
  const name = acc ? maskIdentity(acc.label) : '所选账号';
  btn.disabled = !!(acc && acc.needsRelogin);
  btn.textContent = `同步「${name}」`;
  btn.title = acc && acc.needsRelogin ? '该账号需先重新登录' : `仅从云端增量同步「${name}」的对话`;
}

async function runConversationSync(accountId = null) {
  const allBtn = $('convSyncBtn');
  const oneBtn = $('convSyncOneBtn');
  const acc = accountId && S.pool && (S.pool.accounts || []).find((x) => x.id === accountId);
  const who = acc ? maskIdentity(acc.label) : '全部账号';

  allBtn.disabled = true;
  oneBtn.disabled = true;
  $('convAccountChips').querySelectorAll('button.conv-acc-sync').forEach((b) => { b.disabled = true; });
  $('convSyncStatus').textContent = `正在直连云端增量同步「${who}」的对话，请稍候…`;
  try {
    const r = await api('/api/conversations/sync', { method: 'POST', body: { accountId: accountId || null } });
    const st = r.state || {};
    toast(st.message || `「${who}」同步完成`);
    await loadConversationsView();
  } catch (e) {
    toast('同步失败：' + e.message, true);
  } finally {
    allBtn.disabled = false;
    updateConvSyncOneBtn();
  }
}

async function loadConversationsView() {
  const pool = S.pool;
  if (pool) {
    const sel = $('convAccountFilter');
    const prev = sel.value;
    sel.innerHTML = '<option value="">全部账号</option>'
      + (pool.accounts || []).map((a) => `<option value="${esc(a.id)}">${esc(maskIdentity(a.label))}</option>`).join('');
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    $('convAutoSwitchChk').checked = pool.autoSyncConversationsOnSwitch !== false;
    $('convAutoCopyChk').checked = pool.autoCopyHandoffOnSwitch !== false;
  }
  updateConvSyncOneBtn();

  const accFilter = $('convAccountFilter').value || '';
  const q = ($('convSearchInput').value || '').trim();
  const qs = new URLSearchParams();
  if (accFilter) qs.set('accountId', accFilter);
  if (q) qs.set('q', q);

  try {
    const d = await api('/api/conversations' + (qs.toString() ? '?' + qs.toString() : ''));
    S.convItems = d.items || [];
    const counts = d.accountCounts || {};
    const accounts = (pool && pool.accounts) || [];
    $('convAccountChips').innerHTML = `
      <div class="conv-acc-pill ${!accFilter ? 'active' : ''}">
        <button type="button" class="conv-acc-sel" data-filter-acc="">全部 <span class="conv-acc-cnt">${d.totalConversations || 0}</span></button>
      </div>`
      + accounts.map((a) => {
        const cnt = counts[a.id] || 0;
        const active = accFilter === a.id;
        return `
          <div class="conv-acc-pill ${active ? 'active' : ''}">
            <button type="button" class="conv-acc-sel" data-filter-acc="${esc(a.id)}">
              <span class="dot" style="background:${esc(a.color || '#7c3aed')}"></span>
              ${esc(maskIdentity(a.label))}
              <span class="conv-acc-cnt">${cnt}</span>
            </button>
            <button type="button" class="conv-acc-sync" data-sync-acc="${esc(a.id)}" title="${a.needsRelogin ? '需先重新登录' : '仅同步「' + esc(maskIdentity(a.label)) + '」的对话'}" ${a.needsRelogin ? 'disabled' : ''}>${ICO.refresh}</button>
          </div>`;
      }).join('');

    const summary = `本地已归档 ${d.totalConversations || 0} 条对话（共 ${d.totalMessages || 0} 条消息）`
      + (d.lastSyncAt ? ` · 上次同步 ${fmtAgo(d.lastSyncAt)}` : ' · 尚未同步');
    const st = d.syncState || {};
    $('convSyncStatus').textContent = st.running
      ? `同步中：${st.message || '请稍候…'}`
      : `${summary} · ${st.message || ('归档目录：' + (d.archiveDir || 'data/conversations/markdown'))}`;

    const box = $('convListBox');
    if (!S.convItems.length) {
      box.innerHTML = `<div class="muted" style="padding:20px;text-align:center">${q ? '没有搜到匹配的对话' : '该筛选下暂无本地归档对话，点击上方「同步全部账号」或对应账号旁的刷新图标拉取'}</div>`;
      return;
    }

    box.innerHTML = S.convItems.map((c) => {
      const active = S.convSelectedKey === c.key;
      const modPill = c.lastModel
        ? `<span class="msg-model-pill" title="${esc(c.lastModel)}">${esc(shortModelName(c.lastModel))}</span>`
        : '';
      return `
        <button type="button" class="conv-item ${active ? 'active' : ''}" data-conv-acc="${esc(c.accountId)}" data-conv-sid="${esc(c.sessionId)}" data-conv-key="${esc(c.key)}">
          <div class="conv-item-title">${esc(c.title || '未命名对话')}</div>
          <div class="conv-item-preview">${esc(c.preview || '（无预览）')}</div>
          <div class="conv-item-meta">
            <span style="display:inline-flex;align-items:center;gap:4px;min-width:0">
              <span class="conv-tag" style="background:${esc(c.accountColor || '#7c3aed')}">${esc(maskIdentity(c.accountLabel || '账号'))}</span>
              ${modPill}
            </span>
            <span>${c.messageCount || 0} 条 · ${fmtAgo(c.updatedAt)}</span>
          </div>
        </button>`;
    }).join('');
  } catch (e) {
    toast('读取本地对话失败：' + e.message, true);
  }
}

async function openConversationDetail(accountId, sessionId, key) {
  S.convSelectedKey = key;
  $('convListBox').querySelectorAll('.conv-item').forEach((el) => el.classList.toggle('active', el.dataset.convKey === key));
  const detail = $('convDetailBox');
  detail.innerHTML = '<div class="conv-empty">正在加载完整对话…</div>';
  try {
    const r = await api(`/api/conversations/detail?accountId=${encodeURIComponent(accountId)}&sessionId=${encodeURIComponent(sessionId)}`);
    const c = r.conversation;
    const msgs = c.messages || [];
    const convModels = (c.models && c.models.length ? c.models : (c.lastModel ? [c.lastModel] : []));
    const usageSummaryHtml = (convModels.length || c.totalTokens || c.totalCostUsd)
      ? `<div class="row" style="margin-top:5px;gap:6px">
          ${convModels.map((m) => `<span class="msg-model-pill" title="实际底层模型">${esc(m)}</span>`).join('')}
          ${c.totalTokens ? `<span class="hint">总计 ${fmtTok(c.totalTokens)} tok</span>` : ''}
          ${c.totalCostUsd ? `<span class="hint">估算 $${Number(c.totalCostUsd).toFixed(4)}</span>` : ''}
        </div>`
      : '';
    detail.innerHTML = `
      <div class="conv-detail-head">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:14.5px">${esc(c.title || '未命名对话')}</div>
          <div class="hint">来自「${esc(maskIdentity(c.accountLabel))}」 · ${msgs.length} 条消息 · 更新于 ${fmtDate(c.updatedAt)}</div>
          ${usageSummaryHtml}
        </div>
        <div class="row">
          <button type="button" class="btn primary sm" id="convCopyHandoffBtn">复制续聊指令（本地路径）</button>
          <button type="button" class="btn ghost sm" id="convCopyMdPathBtn">仅复制路径</button>
        </div>
      </div>
      <div class="conv-msgs">
        ${msgs.length ? msgs.map((m) => {
          const u = m.usage;
          const usageBar = u ? `
            <div class="msg-usage">
              ${u.resolvedModel ? `<span class="msg-model-pill" title="实际落地底层模型">${esc(u.resolvedModel)}</span>` : ''}
              ${u.tier ? `<span>档位 ${esc(u.tier)}</span>` : ''}
              ${u.totalTokens ? `<span>总 ${fmtTok(u.totalTokens)} tok${u.cacheReadTokens ? `（缓存读 ${fmtTok(u.cacheReadTokens)}）` : ''}</span>` : ''}
              ${u.contextPercent ? `<span>上下文 ${u.contextPercent}%</span>` : ''}
              ${u.costUsd ? `<span>$${Number(u.costUsd).toFixed(4)}</span>` : ''}
            </div>` : '';
          return `
          <div class="msg-bubble ${m.role === 'user' ? 'user' : ''}">
            <div class="msg-head">
              <span>${m.role === 'user' ? '用户' : 'AWS Quick'}</span>
              <span>${m.ts ? fmtDate(m.ts) : ''}</span>
            </div>
            ${m.text ? `<div class="msg-text">${esc(m.text)}</div>` : ''}
            ${m.tools && m.tools.length ? `<div class="msg-tools">已调用 ${m.tools.length} 个工具：${esc(m.tools.map((t) => t.name).join('、'))}</div>` : ''}
            ${usageBar}
          </div>`;
        }).join('') : '<div class="conv-empty">该对话暂无文本消息</div>'}
      </div>`;
    $('convCopyHandoffBtn').onclick = () => copyText(c.handoffPrompt || '', '续聊指令（含本地路径）已复制！粘贴进新账号即可自动读取并接续');
    $('convCopyMdPathBtn').onclick = () => copyText(c.mdPath || '', '已复制本地 Markdown 归档路径');
  } catch (e) {
    detail.innerHTML = `<div class="conv-empty">读取失败：${esc(e.message)}</div>`;
  }
}

$('convListBox').addEventListener('click', (ev) => {
  const item = ev.target.closest('.conv-item');
  if (!item) return;
  openConversationDetail(item.dataset.convAcc, item.dataset.convSid, item.dataset.convKey);
});

$('convAccountChips').addEventListener('click', (ev) => {
  const syncBtn = ev.target.closest('button[data-sync-acc]');
  if (syncBtn && !syncBtn.disabled) {
    const accId = syncBtn.dataset.syncAcc;
    $('convAccountFilter').value = accId;
    updateConvSyncOneBtn();
    runConversationSync(accId);
    return;
  }
  const selBtn = ev.target.closest('button[data-filter-acc]');
  if (selBtn) {
    $('convAccountFilter').value = selBtn.dataset.filterAcc || '';
    loadConversationsView();
  }
});

$('convAccountFilter').onchange = loadConversationsView;
$('convSearchInput').oninput = () => {
  clearTimeout(S.convSearchTimer);
  S.convSearchTimer = setTimeout(loadConversationsView, 220);
};

$('convSyncBtn').onclick = () => runConversationSync(null);
$('convSyncOneBtn').onclick = () => {
  const accId = $('convAccountFilter').value || '';
  if (!accId) return toast('请先选择单个账号', true);
  runConversationSync(accId);
};

$('convOpenDirBtn').onclick = async () => {
  try {
    const r = await api('/api/conversations/open-dir', { method: 'POST', body: {} });
    toast('已打开本地 Markdown 归档文件夹：' + (r.dir || ''));
  } catch (e) { toast('打开失败：' + e.message, true); }
};

$('convAutoSwitchChk').onchange = async () => {
  try {
    await api('/api/admin/settings', { method: 'POST', body: { autoSyncConversationsOnSwitch: $('convAutoSwitchChk').checked } });
    toast($('convAutoSwitchChk').checked ? '已开启换号前自动同步对话' : '已关闭换号前自动同步对话');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

$('convAutoCopyChk').onchange = async () => {
  try {
    await api('/api/admin/settings', { method: 'POST', body: { autoCopyHandoffOnSwitch: $('convAutoCopyChk').checked } });
    toast($('convAutoCopyChk').checked ? '已开启换号后自动复制续聊上下文' : '已关闭换号后自动复制续聊上下文');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

/* ---------------- 视图 4：通用配置 ---------------- */
async function loadTemplateTab() {
  const pool = S.pool;
  if (!pool) return;

  const lt = pool.localTools || {};
  $('localToolsPill').textContent = lt.allEnabled
    ? (lt.allAutoAllow ? `已全放开 ${lt.enabledCount}/${lt.total}` : `已开 MCP ${lt.enabledCount}/${lt.total}`)
    : `${lt.enabledCount || 0}/${lt.total || 0} 账号`;
  $('localToolsPill').className = 'pill ' + (lt.allEnabled ? 'ok' : '');
  $('localToolsAutoAllowChk').checked = pool.autoGrantFullAccess !== false;
  $('localToolsHint').textContent = `脚本路径：${lt.scriptPath || '—'}`;
  $('localToolsHint').title = lt.scriptPath || '';

  $('cdpBadgeChk').checked = pool.cdpModelBadge !== false;
  refreshCdpStatus();

  const autoSkills = (pool.autoPruneSkills !== false) && (pool.autoSetZhCn !== false);
  $('skillsAutoChk').checked = autoSkills;
  if ($('skillsSummaryPill').textContent === '按需读取' || $('skillsSummaryPill').textContent === '默认开启' || $('skillsSummaryPill').textContent === '手动模式') {
    $('skillsSummaryPill').textContent = autoSkills ? '默认开启' : '手动模式';
    $('skillsSummaryPill').className = 'pill ' + (autoSkills ? 'ok' : '');
  }

  const opts = pool.accounts.map((a) => `<option value="${esc(a.id)}">${esc(maskIdentity(a.label))}</option>`).join('');
  $('tplSourceSelect').innerHTML = opts || '<option value="">暂无账号</option>';
  $('mcpAccountSelect').innerHTML = opts || '<option value="">暂无账号</option>';
  const skSel = $('skillsAccountSelect');
  const prevSk = skSel.value;
  skSel.innerHTML = '<option value="">全部健康账号</option>' + opts;
  if (prevSk && [...skSel.options].some((o) => o.value === prevSk)) skSel.value = prevSk;
  if (pool.active) {
    $('tplSourceSelect').value = pool.active.id;
    if (!S.mcpAccountId) S.mcpAccountId = pool.active.id;
  }
  if (S.mcpAccountId) $('mcpAccountSelect').value = S.mcpAccountId;

  const tpl = pool.commonTemplate || {};
  const tplOn = tpl.enabled !== false;
  $('tplAutoChk').checked = tplOn;
  $('tplStatusPill').textContent = tplOn ? '自动同步' : '已关闭';
  $('tplStatusPill').className = 'pill ' + (tplOn ? 'ok' : '');
  $('tplMetaInfo').textContent = tpl.savedAt
    ? `当前模板来自「${tpl.sourceName || '默认'}」· 保存于 ${fmtAgo(tpl.savedAt)} · 含 ${(tpl.items || []).length} 项配置`
    : '尚未手动保存模板（全权限放开时已自动生成默认模板）。';

  await loadMcpList();
}

async function loadMcpList() {
  const accId = $('mcpAccountSelect').value;
  S.mcpAccountId = accId;
  const acc = S.pool && S.pool.accounts.find((x) => x.id === accId);
  if (!acc || !acc.profileId) {
    $('mcpCountPill').textContent = '0 个';
    $('mcpList').innerHTML = '<div class="muted">暂无可读配置</div>';
    return;
  }
  const cfg = await api('/api/accounts/' + encodeURIComponent(acc.profileId) + '/configs').catch(() => null);
  const servers = (cfg && cfg.mcp && cfg.mcp.mcpServers) || {};
  const entries = Object.entries(servers);
  $('mcpCountPill').textContent = `${entries.length} 个`;
  $('mcpCountPill').className = 'pill ' + (entries.length ? 'ok' : '');
  $('mcpList').innerHTML = entries.length
    ? entries.map(([k, v]) => {
      const targetUrl = (v && (v.url || (v.command + ' ' + (v.args || []).join(' ')))) || '';
      const isHttp = /^https?:/.test(String((v && v.url) || ''));
      const isBuiltin = k === 'local-tools';
      return `
      <div class="mcp-item" data-name="${esc(k)}" data-url="${esc((v && (v.url || v.command)) || '')}">
        <span class="name">${esc(k)}</span>
        ${isBuiltin ? '<span class="k-tag perm">内置终端/文件</span>' : '<span class="k-tag">自定义</span>'}
        <span class="url" title="${esc(targetUrl)}">${esc(targetUrl)}</span>
        ${isHttp ? '<button type="button" class="btn sm" data-mcp="test">测试</button>' : ''}
        <button type="button" class="btn sm danger" data-mcp="del">删除</button>
      </div>`;
    }).join('')
    : '<div class="muted">该账号还没有配置 MCP 服务器</div>';
}

$('mcpAccountSelect').onchange = loadMcpList;

$('tplSaveBtn').onclick = async () => {
  const id = $('tplSourceSelect').value;
  if (!id) return toast('请先选择来源账号', true);
  try {
    const r = await api('/api/pool/template/save', { method: 'POST', body: { id } });
    toast('已存为家庭通用模板：' + (r.copied || []).join('、'));
    await refreshPool();
    loadTemplateTab();
  } catch (e) { toast('保存失败：' + e.message, true); }
};

$('tplApplyAllBtn').onclick = async () => {
  try {
    const r = await api('/api/pool/template/apply', { method: 'POST', body: {} });
    toast(`已同步到 ${r.results.length} 个账号` + (r.quickRunning ? '（Quick 运行中已跳过 .db，下次换号自动补齐）' : ''));
  } catch (e) { toast('同步失败：' + e.message, true); }
};

$('tplAutoChk').onchange = async () => {
  const on = $('tplAutoChk').checked;
  try {
    await api('/api/admin/settings', { method: 'POST', body: { commonTemplate: { enabled: on } } });
    $('tplStatusPill').textContent = on ? '自动同步' : '已关闭';
    $('tplStatusPill').className = 'pill ' + (on ? 'ok' : '');
    toast(on ? '已开启：切号时自动同步通用配置' : '已关闭：切号时不再自动同步通用配置');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

$('localToolsAutoAllowChk').onchange = async () => {
  const on = $('localToolsAutoAllowChk').checked;
  try {
    await api('/api/admin/settings', { method: 'POST', body: { autoGrantFullAccess: on } });
    toast(on ? '已开启：新号自动授予本机终端权限并免弹窗放行' : '已关闭：新号不再自动授予完全权限');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

$('skillsAutoChk').onchange = async () => {
  const on = $('skillsAutoChk').checked;
  try {
    await api('/api/admin/settings', { method: 'POST', body: { autoPruneSkills: on, autoSetZhCn: on } });
    $('skillsSummaryPill').textContent = on ? '默认开启' : '手动模式';
    $('skillsSummaryPill').className = 'pill ' + (on ? 'ok' : '');
    toast(on ? '已开启：新增/导入账号自动精简冗余技能并设为简体中文' : '已切换为手动操作模式');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

$('localToolsEnableBtn').onclick = async () => {
  const autoAllowTools = $('localToolsAutoAllowChk').checked;
  setBusy(true, '正在为所有账号开启本机终端与文件权限…', '会同步写入家庭通用模板并平滑重启 AWS Quick 使其生效');
  try {
    const r = await api('/api/pool/local-tools', {
      method: 'POST',
      body: { enabled: true, autoAllowTools, restartQuick: true },
    });
    toast(`已为全部 ${r.localTools.enabledCount} 个账号放开权限` + (r.restarted ? '，AWS Quick 已重启生效' : ''));
    await refreshPool();
    loadTemplateTab();
  } catch (e) { toast('操作失败：' + e.message, true); }
  finally { setBusy(false); }
};

$('localToolsDisableBtn').onclick = async () => {
  const ok = await confirmModal('收回本机命令权限', '将从所有账号和通用模板移除 <code>local-tools</code> MCP，并把工具默认策略改回「每次询问」。继续？', '确认收回', true);
  if (!ok) return;
  setBusy(true, '正在收回本机命令权限…', '会平滑重启 AWS Quick 使其生效');
  try {
    await api('/api/pool/local-tools', {
      method: 'POST',
      body: { enabled: false, autoAllowTools: false, restartQuick: true },
    });
    toast('已收回本机命令权限');
    await refreshPool();
    loadTemplateTab();
  } catch (e) { toast('操作失败：' + e.message, true); }
  finally { setBusy(false); }
};

async function refreshCdpStatus() {
  const r = await api('/api/cdp/status').catch(() => null);
  const st = r && r.cdp;
  const pill = $('cdpBadgePill');
  const hint = $('cdpBadgeHint');
  if (!st) {
    pill.textContent = '未知'; pill.className = 'pill'; return;
  }
  if (st.attached) {
    pill.textContent = `已附着 :${st.port}`;
    pill.className = 'pill ok';
    hint.textContent = `已连接到「${st.targetTitle || 'AWS Quick'}」，每条回复下方会自动显示实际底层模型（上次同步 ${fmtAgo(st.lastAttachAt)}）。`;
  } else if (st.reachable) {
    pill.textContent = `端口就绪 :${st.port}`;
    pill.className = 'pill warn';
    hint.textContent = '检测到 9222 调试端口，点击「立即刷新注入」或等待 6 秒自动附着。';
  } else {
    pill.textContent = '未开启 9222';
    pill.className = 'pill';
    hint.textContent = st.lastError || '当前 Quick 未带 --remote-debugging-port=9222 启动，点击「重启 Quick 并开启 9222」即可生效。';
  }
}

$('cdpBadgeChk').onchange = async () => {
  try {
    await api('/api/admin/settings', { method: 'POST', body: { cdpModelBadge: $('cdpBadgeChk').checked } });
    toast($('cdpBadgeChk').checked ? '已开启：以后启动 Quick 将自动带 9222 模型显示端口' : '已关闭：以后启动 Quick 不再带 9222 端口');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

$('cdpRestartBtn').onclick = async () => {
  setBusy(true, '正在带 --remote-debugging-port=9222 重启 AWS Quick…', '重启后会自动附着并在每条回复下显示真实模型');
  try {
    await api('/api/cdp/restart-quick', { method: 'POST', body: {} });
    setBusy(false);
    toast('已发出重启指令，等待 AWS Quick 窗口加载完成即可自动生效');
    setTimeout(refreshCdpStatus, 5000);
    setTimeout(refreshCdpStatus, 11000);
  } catch (e) {
    setBusy(false);
    toast('重启失败：' + e.message, true);
  }
};

$('cdpAttachBtn').onclick = async () => {
  const b = $('cdpAttachBtn');
  b.disabled = true;
  try {
    const r = await api('/api/cdp/attach', { method: 'POST', body: {} });
    toast(r.ok ? `已附着到 AWS Quick（已回填 ${r.pushed || 0} 条历史模型映射）` : ('未连接：' + (r.lastError || '请先点左侧重启 Quick 并开启 9222')), !r.ok);
    await refreshCdpStatus();
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; }
};

async function loadSkillsList() {
  const accId = $('skillsAccountSelect').value || (S.pool && S.pool.active && S.pool.active.id) || '';
  if (!accId) return toast('请先选择账号', true);
  $('skillsStatusHint').textContent = '正在从云端读取技能列表…';
  try {
    const r = await api('/api/pool/skills?id=' + encodeURIComponent(accId));
    $('skillsSummaryPill').textContent = `内置开启 ${r.bundledEnabled} / ${r.bundledTotal}`;
    $('skillsSummaryPill').className = 'pill ' + (r.bundledEnabled <= 1 ? 'ok' : '');
    $('skillsStatusHint').textContent = `当前查看「${maskIdentity(r.label)}」：共 ${r.total} 个技能，其中自带内置 ${r.bundledTotal} 个（开启 ${r.bundledEnabled} 个）。`;
    const drawer = $('skillsDrawer');
    const box = $('skillsListBox');
    drawer.hidden = false;
    box.dataset.accId = r.accountId;
    box.innerHTML = (r.skills || []).map((s) => `
      <label class="skill-row" title="${esc(s.description || s.id)}">
        <span class="skill-row-name">${esc(s.displayName)} <span class="muted">(${s.source === 'bundled' ? '内置' : '自定义'})</span></span>
        <input type="checkbox" data-skill-id="${esc(s.id)}" ${s.enabled ? 'checked' : ''}>
      </label>`).join('') || '<div class="muted">暂无技能</div>';
  } catch (e) {
    $('skillsStatusHint').textContent = '读取失败：' + e.message;
    toast('读取技能失败：' + e.message, true);
  }
}

$('skillsLoadBtn').onclick = () => {
  if (!$('skillsDrawer').hidden) {
    $('skillsDrawer').hidden = true;
    return;
  }
  loadSkillsList();
};
$('skillsDrawerCloseBtn').onclick = () => { $('skillsDrawer').hidden = true; };
$('skillsAccountSelect').onchange = () => {
  if (!$('skillsDrawer').hidden && $('skillsAccountSelect').value) loadSkillsList();
};

$('skillsListBox').addEventListener('change', async (ev) => {
  const chk = ev.target.closest('input[data-skill-id]');
  if (!chk) return;
  const accId = $('skillsListBox').dataset.accId;
  const skillId = chk.dataset.skillId;
  const nextVal = chk.checked;
  chk.disabled = true;
  try {
    await api('/api/pool/skills/toggle', { method: 'POST', body: { accountId: accId, skillId, enabled: nextVal } });
    toast(`已${nextVal ? '开启' : '关闭'}技能：${skillId}`);
  } catch (e) {
    chk.checked = !nextVal;
    toast('切换失败：' + e.message, true);
  } finally {
    chk.disabled = false;
  }
});

async function runBatchSkills(enabled) {
  const accId = $('skillsAccountSelect').value || null;
  const keepAcp = $('skillsKeepAcpChk').checked;
  const keepIds = (!enabled && keepAcp) ? ['acp_agents'] : [];
  const scopeLabel = accId
    ? `「${maskIdentity((S.pool.accounts.find((x) => x.id === accId) || {}).label || '所选账号')}」`
    : '全部健康账号';
  setBusy(true, `正在为${scopeLabel}${enabled ? '开启' : '关闭'}自带技能…`, '通过 AWS Quick 官方云端接口并发同步，通常只需几秒');
  try {
    const r = await api('/api/pool/skills/batch', { method: 'POST', body: { accountId: accId, enabled, keepIds } });
    const summary = (r.results || []).map((x) => x.ok ? `${maskIdentity(x.label)}(改${x.changed})` : `${maskIdentity(x.label)}(失败)`).join(' · ');
    $('skillsStatusHint').textContent = `批量完成：处理 ${r.okAccounts}/${r.accounts} 个账号，共变更 ${r.totalChanged} 项。${summary}`;
    toast(`批量${enabled ? '开启' : '关闭'}完成：共更新 ${r.totalChanged} 项技能`);
    if (!$('skillsDrawer').hidden) await loadSkillsList();
  } catch (e) {
    toast('批量操作失败：' + e.message, true);
  } finally {
    setBusy(false);
  }
}

$('skillsDisableAllBtn').onclick = () => runBatchSkills(false);
$('skillsEnableAllBtn').onclick = () => runBatchSkills(true);
$('skillsSetZhBtn').onclick = async () => {
  const accId = $('skillsAccountSelect').value || null;
  const scopeLabel = accId
    ? `「${maskIdentity((S.pool.accounts.find((x) => x.id === accId) || {}).label || '所选账号')}」`
    : '全部健康账号';
  setBusy(true, `正在将${scopeLabel}界面语言设为简体中文…`, '通过 AWS Quick 官方云端设置接口同步（时区 Asia/Shanghai）');
  try {
    const r = await api('/api/pool/locale', { method: 'POST', body: { accountId: accId, locale: 'zh-CN', timezone: 'Asia/Shanghai' } });
    const summary = (r.results || []).map((x) => x.ok ? `${maskIdentity(x.label)}(✓)` : `${maskIdentity(x.label)}(失败)`).join(' · ');
    $('skillsStatusHint').textContent = `语言同步完成：${r.okAccounts}/${r.accounts} 个账号已设为简体中文（zh-CN）。${summary}`;
    toast(`已将 ${r.okAccounts}/${r.accounts} 个账号设为简体中文（重启或刷新 Quick 即生效）`);
  } catch (e) {
    toast('设置中文失败：' + e.message, true);
  } finally {
    setBusy(false);
  }
};

$('mcpList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-mcp]');
  if (!btn) return;
  const item = btn.closest('.mcp-item');
  const acc = S.pool && S.pool.accounts.find((x) => x.id === $('mcpAccountSelect').value);
  if (!acc || !acc.profileId) return;
  if (btn.dataset.mcp === 'test') {
    const url = item.dataset.url;
    if (!/^https?:/.test(url)) return toast('仅支持测试 HTTP MCP 服务器', true);
    btn.disabled = true;
    const r = await api('/api/mcp/test?url=' + encodeURIComponent(url)).catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    $('mcpTestOut').hidden = false;
    $('mcpTestOut').textContent = JSON.stringify(r, null, 2);
    toast(r.ok ? `连通成功：${r.toolCount || 0} 个工具` : '连通失败', !r.ok);
  } else if (btn.dataset.mcp === 'del') {
    const cfg = await api('/api/accounts/' + encodeURIComponent(acc.profileId) + '/configs');
    const servers = (cfg && cfg.mcp && cfg.mcp.mcpServers) || {};
    delete servers[item.dataset.name];
    await api('/api/mcp/save', { method: 'POST', body: { id: acc.profileId, servers } });
    toast('已删除');
    loadMcpList();
  }
});

$('mcpTestBtn').onclick = async () => {
  const url = $('mcpUrl').value.trim();
  if (!url) return toast('请填写 URL', true);
  const r = await api('/api/mcp/test?url=' + encodeURIComponent(url)).catch((e) => ({ ok: false, error: e.message }));
  $('mcpTestOut').hidden = false;
  $('mcpTestOut').textContent = JSON.stringify(r, null, 2);
  toast(r.ok ? `连通成功：${r.toolCount || 0} 个工具` : '连通失败', !r.ok);
};

$('mcpSaveBtn').onclick = async () => {
  const name = $('mcpName').value.trim(), url = $('mcpUrl').value.trim();
  if (!name || !url) return toast('名称和 URL 都要填写', true);
  const acc = S.pool && S.pool.accounts.find((x) => x.id === $('mcpAccountSelect').value);
  if (!acc || !acc.profileId) return toast('未选中账号', true);
  const cfg = await api('/api/accounts/' + encodeURIComponent(acc.profileId) + '/configs');
  const servers = (cfg && cfg.mcp && cfg.mcp.mcpServers) || {};
  servers[name] = { url };
  await api('/api/mcp/save', { method: 'POST', body: { id: acc.profileId, servers } });
  $('mcpName').value = ''; $('mcpUrl').value = '';
  toast('已保存 MCP 配置');
  loadMcpList();
};

/* ---------------- 视图 5：本地反代（API 网关） ---------------- */
async function loadQuickGw() {
  const pool = S.pool;
  if (pool) $('gwAutostartChk').checked = !!pool.quickgwAutostart;
  const s = await api('/api/quickgw').catch(() => null);
  const pill = $('quickgw-status');
  if (!s) {
    pill.textContent = '无法读取状态'; pill.className = 'pill bad'; return;
  }
  const up = !!(s.gateway && s.gateway.up);
  pill.textContent = up ? `运行中 · ${s.accountCount} 个账号` : '未启动';
  pill.className = 'pill ' + (up ? 'ok' : '');
  $('quickgw-url').textContent = location.origin + '/v1';
  $('quickgw-open-panel').href = s.panel.url;
  $('quickgw-open-panel').hidden = !s.panel.up;
  $('quickgw-hint').textContent = `网关 127.0.0.1:${s.gateway.port} · 面板 127.0.0.1:${s.panel.port} · 默认按需启动，不拖慢家人打开软件`;

  const st = s.stats || {};
  const today = st.today || {};
  const stored = s.storedAccounts || [];
  const indCnt = Number(s.independentCount || 0);
  const shCnt = Number(s.sharedCount || 0);
  const pausedCnt = Number(s.pausedCount || 0);
  const activeCnt = Math.max(0, stored.length - pausedCnt);
  $('quickgw-summary').innerHTML = [
    ['网关', up ? '运行中' : '未启动', ':' + s.gateway.port],
    ['面板', s.panel.up ? '运行中' : '未启动', ':' + s.panel.port],
    ['账号池', `${activeCnt} / ${stored.length}`, `独立 ${indCnt} · 共享 ${shCnt}${pausedCnt ? ` · 暂停 ${pausedCnt}` : ''}`],
    ['累计调用', String(st.calls || 0), `今日花费 $${Number(today.cost || 0).toFixed(4)}`],
  ].map(([k, v, sub]) => `<div class="stat"><div class="stat-label">${k}</div><div class="stat-value">${v}</div><div class="stat-sub">${sub}</div></div>`).join('');

  const rows = s.accounts || [];
  const srcPill = (src) => src === 'desktop_shared'
    ? '<span class="pill warn" title="借用桌面端凭据，用反代时勿同时在桌面 Quick 使用同号">共享桌面 · 勿同开</span>'
    : '<span class="pill ok" title="反代独立 OAuth 授权，与桌面 Quick 互不抢 Token">独立登录 · 不互踢</span>';

  if (!up) {
    $('quickgw-accounts-meta').textContent = stored.length
      ? `网关未启动 · 已存 ${stored.length} 个号（独立 ${indCnt} / 共享 ${shCnt}${pausedCnt ? ` / 暂停 ${pausedCnt}` : ''}）`
      : '网关未启动，点击上方「启动网关」或右侧添加账号';
  } else {
    $('quickgw-accounts-meta').textContent = s.errors && s.errors.accounts
      ? `读取异常：${s.errors.accounts}`
      : (rows.length ? `启用 ${activeCnt} / 共 ${stored.length} 个（独立 ${indCnt} / 共享 ${shCnt}）` : '网关账号池为空');
  }

  const renderRowActions = (fullKey, paused, authSource, email) => `
    <div class="row" style="gap:5px;flex-wrap:nowrap">
      <button type="button" class="btn sm ${paused ? 'accent' : ''}" data-gw-act="toggle" data-key="${esc(fullKey)}" data-paused="${paused ? '0' : '1'}" title="${paused ? '恢复参与反代轮询' : '暂停参与反代轮询（保留凭证）'}">${paused ? '启用' : '暂停'}</button>
      ${authSource === 'desktop_shared' ? `<button type="button" class="btn sm ghost" data-gw-act="upgrade" data-email="${esc(email || '')}" title="走一次独立 OAuth 登录，升级为与桌面互不抢 Token 的独立账号">转独立</button>` : ''}
      <button type="button" class="btn sm danger" data-gw-act="remove" data-key="${esc(fullKey)}" data-email="${esc(email || '')}" title="仅从反代网关移除，不影响桌面端账号池">移出</button>
    </div>`;

  if (rows.length) {
    $('quickgw-accounts').innerHTML = '<tr><th>账号</th><th>凭据类型</th><th>套餐 / 额度</th><th>状态</th><th>管理操作</th></tr>' + rows.map((a) => {
      const fullKey = a.fullKey || a.key || '';
      const used = a.quota && a.quota.used != null ? Number(a.quota.used).toFixed(2) : null;
      const limit = a.quota && a.quota.limit != null ? a.quota.limit : null;
      const quotaStr = used != null ? `${esc(a.plan || '')} ${used}/${limit}` : (a.paused ? '—' : esc(a.plan || '—'));
      const stBadge = a.paused
        ? '<span class="pill">已暂停</span>'
        : (a.dead ? '<span class="pill bad">已熔断</span>' : '<span class="pill ok">参与轮询</span>');
      return `<tr style="${a.paused ? 'opacity:.62' : ''}">
        <td><div><strong>${esc(maskIdentity(a.email || a.key || '—'))}</strong></div>${a.displayName && a.displayName !== a.email ? `<div class="muted" style="font-size:11px">${esc(maskIdentity(a.displayName))}</div>` : ''}</td>
        <td>${srcPill(a.authSource)}</td>
        <td>${quotaStr}</td>
        <td>${stBadge}</td>
        <td>${renderRowActions(fullKey, !!a.paused, a.authSource, a.email)}</td>
      </tr>`;
    }).join('');
  } else if (stored.length) {
    $('quickgw-accounts').innerHTML = '<tr><th>已存账号</th><th>凭据类型</th><th>状态</th><th>管理操作</th></tr>' + stored.map((a) => {
      const stBadge = a.paused ? '<span class="pill">已暂停</span>' : '<span class="muted">待启动网关</span>';
      return `<tr style="${a.paused ? 'opacity:.62' : ''}">
        <td><div><strong>${esc(maskIdentity(a.email || a.displayName || a.key || '—'))}</strong></div>${a.displayName && a.displayName !== a.email ? `<div class="muted" style="font-size:11px">${esc(maskIdentity(a.displayName))}</div>` : ''}</td>
        <td>${srcPill(a.authSource)}</td>
        <td>${stBadge}</td>
        <td>${renderRowActions(a.key, !!a.paused, a.authSource, a.email)}</td>
      </tr>`;
    }).join('');
  } else {
    $('quickgw-accounts').innerHTML = `<tr><td class="muted">网关账号池为空，可点击右上角「+ 独立登录新号」或「选号导入桌面」添加</td></tr>`;
  }
}

async function openGatewayIndependentLoginModal(hintEmail = '') {
  openModal({
    title: hintEmail ? `为「${maskIdentity(hintEmail)}」升级独立反代登录` : '反代网关独立 OAuth 登录（与桌面互不互踢）',
    wide: true,
    bodyHtml: `
      <p class="muted" style="margin-top:0">将在反代网关内发起一次独立 AWS OAuth 授权，生成全新的 <code>client_id</code> 与 <code>refresh_token</code>；完成后该号会标记为 <span class="pill ok">独立登录 · 不互踢</span>，可与桌面端 AWS Quick 同时在线。</p>
      <div class="step-box">
        <div class="step-title">第 1 步：获取独立授权链接</div>
        <div id="gwLoginStatus" class="muted">点击下方按钮发起授权（若网关未启动会自动拉起）…</div>
        <div class="link-row" id="gwLoginUrlRow" hidden>
          <input class="input grow" id="gwLoginUrlInput" readonly>
          <button type="button" class="btn sm" id="gwLoginCopyBtn">复制链接</button>
          <a class="btn primary sm" id="gwLoginOpenLink" target="_blank" rel="noopener">浏览器打开</a>
        </div>
      </div>
      <div class="step-box">
        <div class="step-title">第 2 步：完成登录（本机一般自动回调；若停在空白回调页，把地址栏链接贴到下面）</div>
        <div class="row" style="margin-top:6px">
          <input class="input grow" id="gwLoginCbInput" placeholder="如未自动完成，粘贴 http://127.0.0.1:... 回调链接">
          <button type="button" class="btn primary sm" id="gwLoginSubmitBtn">提交回调</button>
        </div>
      </div>
    `,
    actions: [
      { label: '关闭', cls: 'ghost', onClick: (c) => c() },
      {
        label: '发起独立登录',
        cls: 'primary',
        onClick: async () => {
          $('gwLoginStatus').textContent = '正在启动网关并生成独立授权链接…';
          try {
            const r = await api('/api/quickgw/login', { method: 'POST', body: {} });
            const url = r.url || (r.login && r.login.url) || '';
            if (url) {
              $('gwLoginUrlRow').hidden = false;
              $('gwLoginUrlInput').value = url;
              $('gwLoginOpenLink').href = url;
              $('gwLoginCopyBtn').onclick = () => copyText(url, '已复制独立登录链接');
              $('gwLoginStatus').textContent = '授权链接已就绪！点击右侧「浏览器打开」完成登录后，系统会自动入库。';
              startGwLoginPoll();
            } else if (r.logged_in || r.ok) {
              $('gwLoginStatus').textContent = '授权状态已更新，请检查下方列表或刷新。';
              await loadQuickGw();
            } else {
              $('gwLoginStatus').textContent = '返回异常：' + JSON.stringify(r);
            }
          } catch (e) {
            $('gwLoginStatus').textContent = '发起失败：' + e.message;
            toast('发起独立登录失败：' + e.message, true);
          }
        },
      },
    ],
    onClose: () => { clearInterval(S.gwLoginTimer); S.gwLoginTimer = null; },
  });

  $('gwLoginSubmitBtn').onclick = async () => {
    const u = ($('gwLoginCbInput').value || '').trim();
    if (!u) return toast('请先粘贴回调 URL', true);
    const b = $('gwLoginSubmitBtn');
    b.disabled = true;
    try {
      const r = await api('/api/quickgw/login/submit', { method: 'POST', body: { url: u } });
      if (r && r.ok) {
        toast(`独立登录成功：${r.email || '已入库'}`);
        closeModal();
        await loadQuickGw();
      } else {
        toast('提交失败：' + ((r && r.error) || '未知错误'), true);
      }
    } catch (e) { toast('提交失败：' + e.message, true); }
    finally { b.disabled = false; }
  };
}

function startGwLoginPoll() {
  clearInterval(S.gwLoginTimer);
  let tries = 0;
  S.gwLoginTimer = setInterval(async () => {
    tries += 1;
    if (tries > 90) { clearInterval(S.gwLoginTimer); return; }
    const st = await api('/api/quickgw/login/status', { method: 'POST', body: {} }).catch(() => null);
    if (st && st.login && !st.login.running && !st.login.url) {
      clearInterval(S.gwLoginTimer);
      S.gwLoginTimer = null;
      toast('独立 OAuth 授权已完成！');
      closeModal();
      await loadQuickGw();
    }
  }, 2000);
}

async function openPickDesktopToGatewayModal() {
  const pool = S.pool;
  if (!pool || !pool.accounts || !pool.accounts.length) return toast('桌面账号池为空', true);
  const gw = await api('/api/quickgw').catch(() => null);
  const indEmails = new Set(((gw && gw.storedAccounts) || []).filter((x) => x.authSource === 'independent').map((x) => String(x.email || '').toLowerCase()));
  const gwEmails = new Set(((gw && gw.storedAccounts) || []).map((x) => String(x.email || '').toLowerCase()));

  openModal({
    title: '从桌面账号池选号导入反代网关',
    wide: true,
    bodyHtml: `
      <p class="muted" style="margin-top:0">勾选希望放进反代轮询池的账号（建议把正在桌面 Quick 使用的号留空，避免 Token 互踢；已有 <span class="pill ok">独立登录</span> 的号默认保护不覆盖）。</p>
      <div class="mcp-list" style="margin-top:10px">
        ${pool.accounts.map((a) => {
          const em = String(a.email || '').toLowerCase();
          const isInd = indEmails.has(em);
          const inGw = gwEmails.has(em);
          const checked = !a.needsRelogin && !isInd && !a.active;
          return `
            <label class="mcp-item" style="cursor:${isInd || a.needsRelogin ? 'not-allowed' : 'pointer'};opacity:${isInd || a.needsRelogin ? '.6' : '1'}">
              <input type="checkbox" class="gw-pick-chk" value="${esc(a.id)}" ${checked ? 'checked' : ''} ${isInd || a.needsRelogin ? 'disabled' : ''}>
              <span class="name">${esc(maskIdentity(a.label))}</span>
              <span class="url">${esc(maskIdentity(a.email || a.profileId))}</span>
              ${isInd ? '<span class="pill ok">已独立登录(保护)</span>' : (a.active ? '<span class="pill warn">桌面使用中</span>' : (inGw ? '<span class="pill">已在网关</span>' : ''))}
            </label>`;
        }).join('')}
      </div>
    `,
    actions: [
      { label: '取消', cls: 'ghost', onClick: (c) => c() },
      {
        label: '导入所选账号',
        cls: 'primary',
        onClick: async (close) => {
          const ids = [...document.querySelectorAll('.gw-pick-chk:checked')].map((el) => el.value);
          if (!ids.length) return toast('请至少勾选一个账号', true);
          try {
            const r = await api('/api/quickgw/sync-pool', { method: 'POST', body: { ids, restart: true } });
            toast(`已导入 ${r.syncedCount} 个账号到反代网关`);
            close();
            await loadQuickGw();
          } catch (e) { toast('导入失败：' + e.message, true); }
        },
      },
    ],
  });
}

$('quickgw-add-ind').onclick = () => openGatewayIndependentLoginModal('');
$('quickgw-pick-desk').onclick = openPickDesktopToGatewayModal;
$('quickgw-refresh-pool').onclick = () => loadQuickGw();

$('quickgw-accounts').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-gw-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.gwAct;
  const key = btn.dataset.key || '';
  const email = btn.dataset.email || '';
  if (act === 'toggle') {
    const paused = btn.dataset.paused === '1';
    btn.disabled = true;
    try {
      await api('/api/quickgw/account/toggle', { method: 'POST', body: { key, paused, restart: true } });
      toast(paused ? '已暂停该号参与反代轮询（保留凭证）' : '已恢复该号参与反代轮询');
      await loadQuickGw();
    } catch (e) { toast('操作失败：' + e.message, true); btn.disabled = false; }
  } else if (act === 'upgrade') {
    openGatewayIndependentLoginModal(email);
  } else if (act === 'remove') {
    const ok = await confirmModal('移出网关账号池', `确认将 <b>${esc(maskIdentity(email || key))}</b> 从反代网关移除吗？（仅从反代移出，不会影响桌面端账号池）`, '移出', true);
    if (!ok) return;
    btn.disabled = true;
    try {
      await api('/api/quickgw/account/remove', { method: 'POST', body: { key, restart: true } });
      toast('已从反代网关移出');
      await loadQuickGw();
    } catch (e) { toast('移出失败：' + e.message, true); btn.disabled = false; }
  }
});

$('gwAutostartChk').onchange = async () => {
  try {
    await api('/api/admin/settings', { method: 'POST', body: { quickgwAutostart: $('gwAutostartChk').checked } });
    toast('已更新网关自启设置');
    await refreshPool();
  } catch (e) { toast(e.message, true); }
};

$('quickgw-copy').onclick = () => copyText($('quickgw-url').textContent, '已复制转发 /v1 地址');
$('quickgw-copy-direct').onclick = () => copyText($('quickgw-direct-url').textContent, '已复制直连 Base URL（http://127.0.0.1:3426/v1）');
$('quickgw-copy-key').onclick = () => copyText('quick-local', '已复制默认 API Key（quick-local）');
$('quickgw-sync-pool').onclick = async () => {
  const b = $('quickgw-sync-pool');
  b.disabled = true; b.textContent = '同步中…';
  try {
    const r = await api('/api/quickgw/sync-pool', { method: 'POST', body: { restart: true } });
    const kept = r.preservedIndependentCount ? `，已保留 ${r.preservedIndependentCount} 个独立登录号不覆盖` : '';
    toast(`已同步 ${r.syncedCount} 个桌面号（网关共 ${r.totalInGateway} 个${kept}）`);
    await loadQuickGw();
  } catch (e) { toast('同步失败：' + e.message, true); }
  finally { b.disabled = false; b.textContent = '同步桌面号（免重登）'; }
};
$('quickgw-clear-shared').onclick = async () => {
  const ok = await confirmModal('仅保留独立登录号', '将从反代网关移除所有「共享桌面」凭据的账号，仅保留在反代面板里独立 OAuth 登录的账号（不会影响桌面端账号池）。继续？', '确认清理');
  if (!ok) return;
  const b = $('quickgw-clear-shared');
  b.disabled = true;
  try {
    const r = await api('/api/quickgw/clear-shared', { method: 'POST', body: { restart: true } });
    toast(`已移除 ${r.removedCount} 个共享桌面号，保留 ${r.keptIndependentCount} 个独立登录号`);
    await loadQuickGw();
  } catch (e) { toast('操作失败：' + e.message, true); }
  finally { b.disabled = false; }
};
$('quickgw-start').onclick = async () => {
  const b = $('quickgw-start');
  b.disabled = true; b.textContent = '启动中…';
  try { await api('/api/quickgw/start', { method: 'POST', body: {} }); toast('API 网关已启动'); await loadQuickGw(); }
  catch (e) { toast('启动失败：' + e.message, true); }
  finally { b.disabled = false; b.textContent = '启动网关'; }
};
$('quickgw-restart').onclick = async () => {
  const b = $('quickgw-restart');
  b.disabled = true; b.textContent = '重启中…';
  try { await api('/api/quickgw/restart', { method: 'POST', body: {} }); toast('API 网关已重启'); await loadQuickGw(); }
  catch (e) { toast('重启失败：' + e.message, true); }
  finally { b.disabled = false; b.textContent = '重启网关'; }
};
$('quickgw-stop').onclick = async () => {
  const b = $('quickgw-stop');
  b.disabled = true; b.textContent = '停止中…';
  try { await api('/api/quickgw/stop', { method: 'POST', body: {} }); toast('API 网关已停止'); await loadQuickGw(); }
  catch (e) { toast('停止失败：' + e.message, true); }
  finally { b.disabled = false; b.textContent = '停止网关'; }
};

$('quickgw-test').onsubmit = async (ev) => {
  ev.preventDefault();
  const btn = ev.submitter || ev.currentTarget.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const out = $('quickgw-output');
  const usageEl = $('quickgw-usage');
  out.hidden = false; usageEl.hidden = true; out.textContent = '等待回复中…';
  try {
    const headers = { 'content-type': 'application/json' };
    const k = $('quickgw-key').value.trim();
    if (k) headers.authorization = 'Bearer ' + k;
    const stream = $('quickgw-stream').checked;
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: $('quickgw-model').value,
        messages: [{ role: 'user', content: $('quickgw-prompt').value }],
        stream,
      }),
    });
    if (!res.ok || !stream) {
      const text = await res.text();
      let j = null; try { j = JSON.parse(text); } catch (_) {}
      const c0 = j && j.choices && j.choices[0];
      out.textContent = (c0 && c0.message && c0.message.content) || (j && j.error && j.error.message) || text || ('HTTP ' + res.status);
      return;
    }
    out.textContent = '';
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
        const d = JSON.parse(line.slice(5));
        const ch = d.choices && d.choices[0];
        out.textContent += (ch && ch.delta && ch.delta.content) || '';
      }
    }
  } catch (e) {
    out.textContent = '请求失败：' + e.message;
  } finally {
    if (btn) btn.disabled = false;
  }
};

/* ---------------- 视图 6：设置与备份 ---------------- */
async function loadSettingsTab() {
  const pool = S.pool;
  if (!pool) return;
  $('familyUsersInput').value = (pool.familyUsers || []).join(',');
  $('budgetMonthly').value = (pool.config && pool.config.budgetMonthlyPercent) || 80;
  $('budgetSession').value = (pool.config && pool.config.budgetSessionPercent) || 80;

  $('backupAccountSelect').innerHTML = pool.accounts.map((a) => `<option value="${esc(a.profileId)}">${esc(maskIdentity(a.label))}</option>`).join('');
  const bk = await api('/api/backups').catch(() => ({ backups: [] }));
  const rows = (bk.backups || []).slice(0, 30);
  $('backupTable').innerHTML = '<tr><th>备份文件</th><th>大小</th><th>创建时间</th><th>操作</th></tr>' + (
    rows.length
      ? rows.map((b) => `<tr><td>${esc(b.name)}</td><td>${fmtBytes(b.bytes)}</td><td>${fmtDate(b.mtime)}</td>
          <td><button type="button" class="btn sm" data-restore="${esc(b.name)}">恢复到所选账号</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">暂无可恢复的账号目录备份</td></tr>'
  );
}

$('saveSettingsBtn').onclick = async () => {
  const familyUsers = $('familyUsersInput').value.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
  try {
    await api('/api/admin/settings', { method: 'POST', body: { familyUsers } });
    await api('/api/config', {
      method: 'POST',
      body: {
        budgetMonthlyPercent: Number($('budgetMonthly').value) || 80,
        budgetSessionPercent: Number($('budgetSession').value) || 80,
      },
    });
    toast('设置已保存');
    await refreshPool();
  } catch (e) { toast('保存失败：' + e.message, true); }
};

$('backupNowBtn').onclick = async () => {
  const id = $('backupAccountSelect').value;
  if (!id) return toast('请先选择账号', true);
  try {
    const r = await api('/api/backup', { method: 'POST', body: { id } });
    toast('备份完成：' + (r.file || ''));
    loadSettingsTab();
  } catch (e) { toast('备份失败：' + e.message, true); }
};
$('reloadBackupsBtn').onclick = loadSettingsTab;

$('backupTable').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-restore]');
  if (!btn) return;
  const targetId = $('backupAccountSelect').value;
  if (!targetId) return toast('请先在上方选择目标账号', true);
  const ok = await confirmModal('确认恢复备份', `将把 <b>${esc(btn.dataset.restore)}</b> 恢复到账号 <b>${esc(targetId)}</b>（恢复前会自动先备份当前数据）。继续？`, '开始恢复', true);
  if (!ok) return;
  try {
    await api('/api/restore', { method: 'POST', body: { file: btn.dataset.restore, id: targetId } });
    toast('恢复任务已提交，稍后自动完成');
    setTimeout(loadSettingsTab, 2500);
  } catch (e) { toast('恢复失败：' + e.message, true); }
});

$('purgeBtn').onclick = async () => {
  const scopes = [...document.querySelectorAll('.purge:checked')].map((i) => i.value);
  if (!scopes.length) return toast('至少勾选一项', true);
  const ok = await confirmModal('确认清理缓存', `将清理：<b>${esc(scopes.join('、'))}</b>，不会影响聊天记录和账号凭据。继续？`, '清理', true);
  if (!ok) return;
  try {
    await api('/api/cache/purge', { method: 'POST', body: { scopes } });
    toast('缓存清理完成');
  } catch (e) { toast('清理失败：' + e.message, true); }
};

/* ---------------- 数据刷新与 SSE ---------------- */
function renderCurrentView() {
  renderTopbar();
  if (S.nav === 'accounts') renderAdminAccounts();
  else if (S.nav === 'conversations') loadConversationsView();
  else if (S.nav === 'template') loadTemplateTab();
  else if (S.nav === 'api') loadQuickGw();
  else if (S.nav === 'settings') loadSettingsTab();
}

async function refreshPool() {
  try {
    const data = await api('/api/pool');
    S.pool = data;
    renderTopbar();
    if (S.nav === 'accounts') renderAdminAccounts();
  } catch (e) {
    toast('刷新失败：' + e.message, true);
  }
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (ev) => {
    try {
      const snap = JSON.parse(ev.data);
      if (snap && snap.pool) {
        S.pool = snap.pool;
        renderTopbar();
        if (S.nav === 'accounts') renderAdminAccounts();
        const lsh = snap.pool.lastSwitchHandoff;
        if (lsh && lsh.key && lsh.key !== S.lastHandoffKey && (Date.now() - (lsh.switchedAt || 0) < 30000)) {
          handleSwitchHandoff({ handoff: lsh.handoff, switchedAt: lsh.switchedAt }, lsh.targetLabel || '目标账号', lsh.key);
        }
      }
    } catch (_) {}
  });
  es.onerror = () => { es.close(); setTimeout(connectSSE, 4000); };
}

/* ---------------- 启动 ---------------- */
applyTheme();
applySidebarCollapse();
syncToolbarToggles();
setNav('accounts');
refreshPool();
connectSSE();

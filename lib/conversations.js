'use strict';
/**
 * lib/conversations.js — 本地对话增量同步、全文搜索、Markdown 归档与跨号续聊引擎
 *
 * 数据目录：
 *   data/conversations/index.json                       轻量索引
 *   data/conversations/items/<accountId>/<sid>.json     完整结构化消息
 *   data/conversations/markdown/<账号名>/<日期_标题>.md   可读 Markdown 归档
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./core');
const QC = require('./quick-cloud');

const CONV_ROOT = path.join(C.DATA, 'conversations');
const ITEMS_DIR = path.join(CONV_ROOT, 'items');
const MD_DIR = path.join(CONV_ROOT, 'markdown');
const INDEX_FILE = path.join(CONV_ROOT, 'index.json');

const MESSAGE_PAGE_SIZE = 30;
const MAX_MESSAGE_PAGES = 80;
const MAX_LIST_PAGES = 10;

const SYSTEM_NOTE_RE = /^\s*\\?\[SYSTEM:[\s\S]*?\\?\]\s*/;
const ROUTE_NOTE_RE = /\s*\\?\[ACP_ROUTE:[^\]\n]*\\?\]\s*/g;

let syncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  stage: 'idle',
  message: '',
  totalAccounts: 0,
  doneAccounts: 0,
  syncedConvs: 0,
  skippedConvs: 0,
  errors: [],
};

function ensureConvDirs() {
  for (const d of [CONV_ROOT, ITEMS_DIR, MD_DIR]) fs.mkdirSync(d, { recursive: true });
}

function str(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function toMs(ts) {
  if (ts == null || ts === '') return 0;
  if (typeof ts === 'string' && isNaN(Number(ts))) {
    const p = Date.parse(ts);
    return Number.isFinite(p) ? p : 0;
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function safeName(s, max = 64) {
  let t = str(s)
    .replace(/[\x00-\x1f\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!t) t = '未命名对话';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = '_' + t;
  return t.length > max ? t.slice(0, max).trim() : t;
}

function safeId(id) {
  const s = str(id).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(s) || s.includes('..')) {
    throw new Error('无效的对话 ID');
  }
  return s;
}

function fmtDateTime(ms) {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  } catch (_) {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function fmtDay(ms) {
  const d = new Date(ms || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cleanUserText(s) {
  let t = str(s);
  for (let i = 0; i < 5 && SYSTEM_NOTE_RE.test(t); i++) t = t.replace(SYSTEM_NOTE_RE, '');
  t = t.replace(ROUTE_NOTE_RE, '\n');
  return t.trim();
}

function cleanQuickMarkup(s) {
  let t = str(s);
  t = t.replace(/<decision\b[^>]*>([\s\S]*?)<\/decision>/g, (_, inner) => {
    const opts = [...inner.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/g)].map((m) => '- ' + m[1].trim());
    return opts.length ? `\n\n**选项：**\n${opts.join('\n')}\n\n` : '';
  });
  t = t.replace(/<decision_response>([\s\S]*?)<\/decision_response>/g, (_, x) => `（选择：${x.trim()}）`);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function clip(v, max = 400) {
  const s = typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function normalizeMessage(m) {
  const role = m && m.role === 'user' ? 'user' : (m && m.role === 'assistant' ? 'assistant' : 'system');
  const tools = Array.isArray(m && m.toolCalls)
    ? m.toolCalls.map((t) => ({
      name: str(t && (t.displayName || t.name)) || 'tool',
      status: str(t && t.status),
      args: clip(t && (t.arguments ?? t.args), 240),
      result: clip(t && t.result, 300),
    }))
    : [];
  const rawContent = str(m && m.content);
  const text = cleanQuickMarkup(role === 'user' ? cleanUserText(rawContent) : rawContent);
  return {
    id: str(m && m.id),
    role,
    ts: toMs(m && m.timestamp),
    text,
    tools,
    isSystem: role === 'system' || Boolean(m && m.isSystemMessage),
  };
}

function readIndex() {
  ensureConvDirs();
  const raw = C.readJson(INDEX_FILE, null);
  if (!raw || typeof raw !== 'object' || typeof raw.items !== 'object') {
    return { version: 1, lastSyncAt: null, items: {} };
  }
  return raw;
}

function saveIndex(idx) {
  ensureConvDirs();
  C.writeJsonAtomic(INDEX_FILE, idx);
  return idx;
}

function itemKey(accountId, sessionId) {
  return `${accountId}:${sessionId}`;
}

function itemJsonPath(accountId, sessionId) {
  return path.join(ITEMS_DIR, safeName(accountId, 80), `${safeId(sessionId)}.json`);
}

function buildMarkdown(conv) {
  const lines = [
    `# ${conv.title || '未命名对话'}`,
    '',
    `- **所属账号**：${conv.accountLabel || conv.accountId}`,
    `- **会话 ID**：\`${conv.sessionId}\``,
    `- **最后更新**：${fmtDateTime(conv.updatedAt)}`,
    `- **同步时间**：${fmtDateTime(conv.syncedAt)}`,
    `- **消息条数**：${(conv.messages || []).length}`,
    '',
    '---',
    '',
  ];
  for (const m of (conv.messages || [])) {
    const who = m.role === 'user' ? '👤 用户' : '🤖 AWS Quick';
    const tm = m.ts ? `（${fmtDateTime(m.ts)}）` : '';
    lines.push(`### ${who}${tm}`);
    lines.push('');
    if (m.text) lines.push(m.text);
    if (m.tools && m.tools.length) {
      lines.push('');
      lines.push(`> 使用了 ${m.tools.length} 个工具：${m.tools.map((t) => '`' + t.name + '`').join('、')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function writeMarkdownArchive(conv) {
  const accDir = path.join(MD_DIR, safeName(conv.accountLabel || conv.accountId, 60));
  fs.mkdirSync(accDir, { recursive: true });
  const shortId = String(conv.sessionId || '').slice(0, 8);
  const fileName = `${fmtDay(conv.updatedAt || conv.createdAt)}_${safeName(conv.title, 48)}_${shortId}.md`;
  const mdPath = path.join(accDir, fileName);
  fs.writeFileSync(mdPath, buildMarkdown(conv), 'utf8');
  return mdPath;
}

function buildHandoffPrompt(conv) {
  if (!conv) return '';
  let mdPath = conv.mdPath || '';
  if (!mdPath || !fs.existsSync(mdPath)) {
    try { mdPath = writeMarkdownArchive(conv); } catch (_) {}
  }
  const msgCount = Array.isArray(conv.messages) ? conv.messages.length : Number(conv.messageCount || 0);
  const title = conv.title || '未命名对话';
  const who = conv.accountLabel || '原账号';
  if (mdPath) {
    return [
      `上一次任务的完整对话上下文保存在本地路径：${mdPath}`,
      `（原账号：${who}，对话标题：《${title}》，共 ${msgCount} 条消息）`,
      '',
      '请你先读取该本地文件了解完整上下文，然后直接接续对话。',
    ].join('\n');
  }
  return `请接着之前的对话《${title}》（原账号：${who}）继续处理。`;
}

// ---------- 云端读取（复用 quick-cloud.js） ----------
async function fetchSessionList(curAccount, maxPages = MAX_LIST_PAGES) {
  const seen = new Set();
  const list = [];
  let cursor = '';
  for (let p = 0; p < maxPages; p++) {
    const apiPath = cursor
      ? `api/sessions/page/${encodeURIComponent(cursor)}?limit=50`
      : 'api/sessions?limit=50';
    const res = await QC.invokeQbsApi(curAccount, apiPath, 'GET', {}, 35000);
    if (!res || typeof res !== 'object') break;
    const batch = [
      ...(Array.isArray(res.sessions) ? res.sessions : []),
      ...(Array.isArray(res.completeSections) ? res.completeSections : []),
    ];
    for (const s of batch) {
      if (!s || !s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      list.push({
        id: str(s.id),
        title: str(s.title).trim() || '未命名对话',
        createdAt: toMs(s.created_at ?? s.createdAt),
        updatedAt: toMs(s.updated_at ?? s.updatedAt) || toMs(s.created_at ?? s.createdAt),
        messageCount: Number(s.message_count ?? s.messageCount) || 0,
      });
    }
    cursor = str(res.nextCursor ?? res.next_cursor);
    if (!cursor) break;
  }
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list;
}

async function fetchAllSessionMessages(curAccount, sessionId) {
  const base = `store/sessions/${encodeURIComponent(sessionId)}/messages`;
  let before = '';
  const pages = [];
  for (let i = 0; i < MAX_MESSAGE_PAGES; i++) {
    const res = await QC.invokeQbsApi(
      curAccount,
      `${base}?limit=${MESSAGE_PAGE_SIZE}${before ? '&before=' + encodeURIComponent(before) : ''}`,
      'GET',
      {},
      60000
    );
    const list = Array.isArray(res) ? res : (res && Array.isArray(res.messages) ? res.messages : null);
    if (!list) break;
    pages.unshift(list);
    const hasMore = Boolean(res && res.has_more === true);
    const next = str(res && (res.next_token ?? res.nextToken));
    if (!hasMore || !next || next === before) break;
    before = next;
  }
  const seen = new Set();
  const out = [];
  for (const m of pages.flat()) {
    const key = str(m && m.id) || `${m && m.role}|${m && m.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const norm = normalizeMessage(m);
    if (!norm.isSystem && (norm.text || (norm.tools && norm.tools.length))) out.push(norm);
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

// ---------- 增量同步单个账号 / 全号池 ----------
async function syncOneAccount(account, { force = false, maxSessions = 100, isQuickRunning, onPersist } = {}) {
  if (!account || account.needsRelogin || (!account.access && !account.refresh) || !account.tenantUrl) {
    return { ok: false, skipped: true, reason: '账号未登录或需重新登录', synced: 0, unchanged: 0 };
  }
  const label = account.alias || account.displayName || account.email || account.profileId || account.id;
  const cur = await QC.ensureFreshToken(account, onPersist || null, false, {
    isQuickRunning: isQuickRunning || (() => false),
    readManifest: C.readProfiles,
  });

  const remoteList = (await fetchSessionList(cur)).slice(0, maxSessions);
  const idx = readIndex();
  let synced = 0;
  let unchanged = 0;

  for (const s of remoteList) {
    const key = itemKey(account.id, s.id);
    const existing = idx.items[key];
    const jsonFile = itemJsonPath(account.id, s.id);
    const upToDate = !force && existing && fs.existsSync(jsonFile)
      && Number(existing.updatedAt || 0) >= Number(s.updatedAt || 0)
      && Number(existing.remoteMessageCount || 0) === Number(s.messageCount || 0);

    if (upToDate) {
      // 如果账号昵称或标题变了，顺手更新索引
      if (existing.accountLabel !== label || existing.title !== s.title) {
        existing.accountLabel = label;
        existing.accountColor = account.color || existing.accountColor || '#4f46e5';
        existing.title = s.title;
        idx.items[key] = existing;
      }
      unchanged += 1;
      continue;
    }

    syncState.message = `正在同步「${label}」：${s.title.slice(0, 26)}`;
    let messages = [];
    try {
      messages = await fetchAllSessionMessages(cur, s.id);
    } catch (e) {
      // 单条拉取失败不影响其他对话
      syncState.errors.push(`${label} / ${s.title}: ${e.message}`);
      continue;
    }

    const now = Date.now();
    const conv = {
      accountId: account.id,
      profileId: account.profileId || '',
      accountLabel: label,
      accountColor: account.color || '#4f46e5',
      sessionId: s.id,
      title: s.title,
      createdAt: s.createdAt || (messages[0] && messages[0].ts) || now,
      updatedAt: s.updatedAt || (messages[messages.length - 1] && messages[messages.length - 1].ts) || now,
      syncedAt: now,
      remoteMessageCount: s.messageCount,
      messages,
    };

    const mdPath = writeMarkdownArchive(conv);
    conv.mdPath = mdPath;

    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    C.writeJsonAtomic(jsonFile, conv);

    const lastMsg = messages[messages.length - 1];
    const firstUser = messages.find((m) => m.role === 'user' && m.text);
    const preview = clip((lastMsg && lastMsg.text) || (firstUser && firstUser.text) || '', 120);

    idx.items[key] = {
      key,
      accountId: account.id,
      profileId: account.profileId || '',
      accountLabel: label,
      accountColor: account.color || '#4f46e5',
      sessionId: s.id,
      title: s.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      syncedAt: now,
      messageCount: messages.length,
      remoteMessageCount: s.messageCount,
      preview,
      mdPath,
    };
    idx.lastSyncAt = now;
    saveIndex(idx);
    synced += 1;
    syncState.syncedConvs += 1;
  }

  syncState.skippedConvs += unchanged;
  return { ok: true, accountId: account.id, label, totalRemote: remoteList.length, synced, unchanged };
}

async function syncAllAccounts(accounts, { accountId = null, force = false, maxSessions = 80, isQuickRunning, onPersist } = {}) {
  if (syncState.running) {
    return { ok: false, busy: true, state: getSyncState(), error: '正在同步对话中，请稍候' };
  }
  const targets = (accounts || []).filter((a) => {
    if (accountId && a.id !== accountId && a.profileId !== accountId) return false;
    return !a.needsRelogin && (a.access || a.refresh) && a.tenantUrl;
  });

  syncState = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    stage: 'syncing',
    message: `准备同步 ${targets.length} 个健康账号的云端对话…`,
    totalAccounts: targets.length,
    doneAccounts: 0,
    syncedConvs: 0,
    skippedConvs: 0,
    errors: [],
  };

  const results = [];
  try {
    for (const acc of targets) {
      const label = acc.alias || acc.displayName || acc.email || acc.id;
      syncState.message = `正在扫描「${label}」的对话列表…`;
      try {
        const r = await syncOneAccount(acc, {
          force,
          maxSessions,
          isQuickRunning,
          onPersist: onPersist ? (next) => onPersist(acc.id, next) : null,
        });
        results.push(r);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        syncState.errors.push(`${label}: ${msg}`);
        results.push({ ok: false, accountId: acc.id, label, error: msg });
      }
      syncState.doneAccounts += 1;
    }
    const idx = readIndex();
    idx.lastSyncAt = Date.now();
    saveIndex(idx);
    syncState.running = false;
    syncState.stage = 'done';
    syncState.finishedAt = Date.now();
    syncState.message = `同步完成：更新 ${syncState.syncedConvs} 条，未变更跳过 ${syncState.skippedConvs} 条`;
    C.audit('conversations_sync', {
      accounts: targets.length,
      synced: syncState.syncedConvs,
      skipped: syncState.skippedConvs,
      errors: syncState.errors.length,
    });
    return { ok: true, state: getSyncState(), results };
  } finally {
    syncState.running = false;
  }
}

function getSyncState() {
  return { ...syncState };
}

function listLocalConversations({ accountId = '', query = '' } = {}) {
  const idx = readIndex();
  const q = str(query).trim().toLowerCase();
  let list = Object.values(idx.items || {});

  if (accountId) {
    list = list.filter((x) => x.accountId === accountId || x.profileId === accountId);
  }

  if (q) {
    list = list.filter((x) => {
      if (str(x.title).toLowerCase().includes(q) || str(x.preview).toLowerCase().includes(q) || str(x.accountLabel).toLowerCase().includes(q)) {
        return true;
      }
      // 标题/摘要未命中时再搜正文
      try {
        const doc = C.readJson(itemJsonPath(x.accountId, x.sessionId), null);
        if (doc && Array.isArray(doc.messages)) {
          return doc.messages.some((m) => str(m.text).toLowerCase().includes(q));
        }
      } catch (_) {}
      return false;
    });
  }

  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const allItems = Object.values(idx.items || {});
  const totalMessages = allItems.reduce((s, x) => s + Number(x.messageCount || 0), 0);
  const accountCounts = {};
  for (const x of allItems) {
    if (x && x.accountId) accountCounts[x.accountId] = (accountCounts[x.accountId] || 0) + 1;
  }
  return {
    ok: true,
    archiveDir: MD_DIR,
    lastSyncAt: idx.lastSyncAt || null,
    totalConversations: allItems.length,
    totalMessages,
    accountCounts,
    syncState: getSyncState(),
    items: list,
  };
}

function getLocalConversation(accountId, sessionId) {
  const file = itemJsonPath(accountId, sessionId);
  const doc = C.readJson(file, null);
  if (!doc) return null;
  if (!doc.mdPath || !fs.existsSync(doc.mdPath)) {
    try { doc.mdPath = writeMarkdownArchive(doc); } catch (_) {}
  }
  return {
    ...doc,
    handoffPrompt: buildHandoffPrompt(doc),
  };
}

function getLatestConversationForAccount(accountId) {
  if (!accountId) return null;
  const idx = readIndex();
  const list = Object.values(idx.items || {})
    .filter((x) => x && (x.accountId === accountId || x.profileId === accountId))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!list.length) return null;
  const chosen = list.find((x) => Number(x.messageCount || 0) > 0) || list[0];
  const detail = getLocalConversation(chosen.accountId, chosen.sessionId);
  if (!detail) return null;
  return {
    accountId: detail.accountId,
    accountLabel: detail.accountLabel,
    sessionId: detail.sessionId,
    title: detail.title,
    updatedAt: detail.updatedAt,
    messageCount: (detail.messages || []).length,
    mdPath: detail.mdPath || '',
    handoffPrompt: detail.handoffPrompt || '',
  };
}

function openArchiveFolder() {
  ensureConvDirs();
  if (process.platform === 'win32') {
    spawn('explorer.exe', [MD_DIR], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, dir: MD_DIR };
  }
  return { ok: false, dir: MD_DIR };
}

module.exports = {
  CONV_ROOT,
  MD_DIR,
  getSyncState,
  syncOneAccount,
  syncAllAccounts,
  listLocalConversations,
  getLocalConversation,
  getLatestConversationForAccount,
  buildHandoffPrompt,
  openArchiveFolder,
};

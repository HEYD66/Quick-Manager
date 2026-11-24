#!/usr/bin/env node
/**
 * selftest.js — 端到端自检（只读为主，写操作用安全参数）
 * 用法：node selftest.js [baseUrl]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:9600';
const TOKEN = fs.readFileSync(path.join(__dirname, 'data', 'mgr-token.txt'), 'utf8').trim();

let pass = 0, fail = 0;
const rows = [];

async function check(name, fn) {
  try {
    const r = await fn();
    const ok = r !== false;
    rows.push([ok ? 'PASS' : 'FAIL', name, ok ? (typeof r === 'string' ? r : '') : 'unexpected']);
    ok ? pass++ : fail++;
  } catch (e) {
    rows.push(['FAIL', name, e.message]);
    fail++;
  }
}

const get = async (p, headers) => {
  const r = await fetch(BASE + p, { headers: headers || {} });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, text: t, json: j };
};
const post = async (p, body, method) => {
  const r = await fetch(BASE + p, {
    method: method || 'POST',
    headers: { 'content-type': 'application/json', 'x-qwm-token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, text: t, json: j };
};

(async () => {
  console.log('base:', BASE);

  await check('静态首页', async () => {
    const r = await get('/');
    if (r.status !== 200 || !/accountGrid/.test(r.text)) throw new Error('html bad');
    if (!/window\.__QWM_TOKEN__ = "[0-9a-f]{16,}"/.test(r.text)) throw new Error('token not injected');
    return 'token injected';
  });

  await check('app.css', async () => { const r = await get('/app.css'); if (r.status !== 200) throw new Error(r.status); return 'ok'; });
  await check('app.js', async () => { const r = await get('/app.js'); if (r.status !== 200) throw new Error(r.status); return 'ok'; });
  await check('/api/health', async () => { const r = await get('/api/health'); if (!r.json || !r.json.ok) throw new Error('bad'); return 'ok'; });

  let snap = null;
  await check('/api/accounts', async () => {
    const r = await get('/api/accounts');
    snap = r.json;
    if (!snap || !Array.isArray(snap.accounts)) throw new Error('shape');
    const a = snap.accounts[0];
    for (const k of ['id', 'displayName', 'login', 'sessions', 'diskBytes']) if (!(k in a)) throw new Error('missing field ' + k);
    return snap.accounts.length + ' accounts, active=' + snap.lastActive;
  });

  const id = snap && snap.accounts && snap.accounts[0] && snap.accounts[0].id;
  if (!id) { console.log('no account, abort'); process.exit(1); }

  await check('/api/accounts/:id/configs', async () => { const r = await get('/api/accounts/' + id + '/configs'); if (!r.json || !r.json.ok) throw new Error('bad'); return 'mcp=' + (r.json.mcp ? Object.keys(r.json.mcp.mcpServers || {}).length : 0) + ' servers'; });
  await check('/api/accounts/:id/sessions', async () => { const r = await get('/api/accounts/' + id + '/sessions'); if (!r.json || !r.json.ok) throw new Error('bad'); return (r.json.sessions || []).length + ' sessions'; });
  await check('/api/config', async () => { const r = await get('/api/config'); if (!r.json || !r.json.config) throw new Error('bad'); return JSON.stringify(r.json.config); });
  await check('/api/jobs', async () => { const r = await get('/api/jobs'); if (!r.json || !Array.isArray(r.json.jobs)) throw new Error('bad'); return r.json.jobs.length + ' jobs'; });
  await check('/api/relay', async () => { const r = await get('/api/relay'); if (!r.json) throw new Error('bad'); return 'up=' + r.json.up; });
  await check('/api/relay/token', async () => { const r = await get('/api/relay/token'); if (!r.json) throw new Error('bad'); return r.json.ok ? 'token present' : 'no token'; });
  await check('/api/backups', async () => { const r = await get('/api/backups'); if (!r.json || !Array.isArray(r.json.backups)) throw new Error('bad'); return r.json.backups.length + ' backups'; });
  await check('/api/logs', async () => { const r = await get('/api/logs'); if (!r.json || !Array.isArray(r.json.logs)) throw new Error('bad'); return r.json.logs.length + ' logs'; });
  await check('/api/logs/tail', async () => { const l = (await get('/api/logs')).json.logs; if (!l.length) return 'no logs'; const r = await get('/api/logs/tail?name=' + encodeURIComponent(l[0].name) + '&n=20'); if (!r.json || !r.json.ok) throw new Error('bad'); return (r.json.lines || []).length + ' lines'; });
  await check('/api/audit', async () => { const r = await get('/api/audit'); if (!r.json || !Array.isArray(r.json.lines)) throw new Error('bad'); return r.json.lines.length + ' entries'; });

  await check('额度刷新（当前账号）', async () => {
    const r = await get('/api/accounts/' + id + '/quota?refresh=1');
    if (!r.json) throw new Error('bad');
    if (!r.json.ok) return 'degraded: ' + (r.json.reason || '');
    const m = r.json.monthly || {};
    return 'monthly ' + m.used + '/' + m.limit + ' (' + m.percent + '%)';
  });

  await check('/api/quota/series', async () => { const r = await get('/api/quota/series?days=7'); if (!r.json || !Array.isArray(r.json.points)) throw new Error('bad'); return r.json.points.length + ' points'; });

  await check('MCP 连通性测试（本机 8765）', async () => {
    const cfg = await get('/api/accounts/' + id + '/configs');
    const servers = (cfg.json && cfg.json.mcp && cfg.json.mcp.mcpServers) || {};
    const first = Object.values(servers).find((v) => v && v.url);
    if (!first) return 'skipped: no http mcp server';
    const r = await get('/api/mcp/test?url=' + encodeURIComponent(first.url));
    if (!r.json) throw new Error('bad');
    return r.json.ok ? ('ok, ' + r.json.toolCount + ' tools, ' + r.json.ms + 'ms') : ('failed: ' + (r.json.error || r.json.status));
  });

  await check('写操作鉴权（无 token 应 401）', async () => {
    const r = await fetch(BASE + '/api/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"x"}' });
    if (r.status !== 401) throw new Error('expected 401, got ' + r.status);
    return '401 as expected';
  });

  await check('写操作（有 token）配置保存', async () => {
    const r = await post('/api/config', { budgetMonthlyPercent: 80, budgetSessionPercent: 80 });
    if (!r.json || !r.json.ok) throw new Error('bad');
    return 'saved';
  });

  await check('MCP 配置保存（幂等）', async () => {
    const cfg = await get('/api/accounts/' + id + '/configs');
    const servers = (cfg.json && cfg.json.mcp && cfg.json.mcp.mcpServers) || {};
    const r = await post('/api/mcp/save', { id, servers });
    if (!r.json || !r.json.ok) throw new Error('bad: ' + JSON.stringify(r.json));
    return Object.keys(servers).length + ' servers kept';
  });

  await check('备份', async () => {
    const r = await post('/api/backup', { id });
    if (!r.json || !r.json.ok) throw new Error('bad: ' + JSON.stringify(r.json).slice(0, 120));
    const size = fs.existsSync(r.json.file) ? fs.statSync(r.json.file).size : 0;
    return path.basename(r.json.file) + ' (' + (size / 1048576).toFixed(1) + ' MB)';
  });

  await check('清缓存（空 scope，不应破坏数据）', async () => {
    const r = await post('/api/cache/purge', { scopes: [] });
    if (!r.json || !r.json.ok || !r.json.job) throw new Error('bad');
    return 'job ' + r.json.job.state;
  });

  await check('切换（不存在的账号应报错但不崩）', async () => {
    const r = await post('/api/switch', { id: 'no-such-account' });
    if (!r.json || !r.json.job) throw new Error('bad');
    if (r.json.job.state !== 'error') throw new Error('expected error state');
    return 'graceful error: ' + r.json.job.error;
  });

  // 输出
  console.log('');
  const w1 = 6, w2 = 40;
  for (const [s, n, d] of rows) console.log(s.padEnd(w1), n.padEnd(w2), d || '');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

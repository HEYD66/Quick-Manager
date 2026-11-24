#!/usr/bin/env node
/**
 * local-tools-mcp.js — 极简 MCP server（stdio / JSON-RPC 2.0）
 *
 * 目的：以「用户身份」运行，给 Quick 的云端模型提供本地能力。
 * 因为本进程不在 AppContainer 沙箱里，所以它不受 Quick 沙箱的目录白名单限制。
 *
 * 工具：run_command / read_file / write_file / list_dir / whoami
 * 用法：node local-tools-mcp.js   （由 Quick 作为 MCP server 拉起，走 stdin/stdout）
 */
'use strict';

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_INFO = { name: 'local-tools', version: '1.0.0' };
const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'run_command',
    description: '在本机以当前用户身份执行一条 shell 命令，返回 stdout/stderr 和退出码。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（cmd.exe 语法）' },
        cwd: { type: 'string', description: '工作目录，可选' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认 60000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: '读取本机任意文本文件（UTF-8），返回内容。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        max_bytes: { type: 'number', description: '最多读取字节数，默认 200000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '向本机任意路径写入文本文件（会创建父目录）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: '列出目录内容（名称/大小/是否目录）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'whoami',
    description: '返回当前进程的用户身份与环境信息，用于确认是否受沙箱限制。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function ok(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: false };
}
function err(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch (_) {
      return buf.toString('utf8');
    }
  }
}

function runCommand(args) {
  return new Promise((resolve) => {
    const timeout = Math.min(Number(args.timeout_ms) || 60000, 600000);
    const rawCmd = String(args.command || '');
    const cmd = process.platform === 'win32' ? `chcp 65001 >nul & ${rawCmd}` : rawCmd;
    exec(cmd, { cwd: args.cwd || process.cwd(), timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const parts = [];
        const outText = decodeOutput(stdout).trimEnd();
        const errText = decodeOutput(stderr).trimEnd();
        if (outText) parts.push('STDOUT:\n' + outText);
        if (errText) parts.push('STDERR:\n' + errText);
        if (error) parts.push('EXIT: ' + (error.code !== undefined ? error.code : error.message));
        resolve(ok(parts.join('\n\n') || '(no output)'));
      });
  });
}

async function callTool(name, args) {
  args = args || {};
  try {
    if (name === 'run_command') return await runCommand(args);
    if (name === 'read_file') {
      const max = Number(args.max_bytes) || 200000;
      const buf = fs.readFileSync(args.path);
      return ok(buf.slice(0, max).toString('utf8') + (buf.length > max ? '\n...[truncated]' : ''));
    }
    if (name === 'write_file') {
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      fs.writeFileSync(args.path, args.content, 'utf8');
      return ok('written: ' + args.path + ' (' + Buffer.byteLength(args.content, 'utf8') + ' bytes)');
    }
    if (name === 'list_dir') {
      const items = fs.readdirSync(args.path, { withFileTypes: true }).slice(0, 500).map((d) => {
        let size = '';
        try { if (d.isFile()) size = String(fs.statSync(path.join(args.path, d.name)).size); } catch (_) {}
        return (d.isDirectory() ? '[D] ' : '    ') + d.name + (size ? '  (' + size + ')' : '');
      });
      return ok(items.join('\n') || '(empty)');
    }
    if (name === 'whoami') {
      return ok(JSON.stringify({
        user: os.userInfo().username,
        home: os.homedir(),
        cwd: process.cwd(),
        sandboxed: false,
        canReadD: (() => { try { fs.readdirSync('D:\\'); return true; } catch (e) { return 'DENIED: ' + e.code; } })(),
      }, null, 2));
    }
    return err('unknown tool: ' + name);
  } catch (e) {
    return err(e.code ? e.code + ': ' + e.message : e.message);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  // 通知类：不需要回包
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const result = await callTool(params && params.name, params && params.arguments);
    return send({ jsonrpc: '2.0', id, result });
  }
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

process.stderr.write('[local-tools-mcp] started, pid=' + process.pid + '\n');

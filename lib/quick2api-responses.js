'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createInterface } = require('node:readline');
const { once } = require('node:events');

const cors = { 'access-control-allow-origin': '*' };

function openAIError(res, status, code, message) {
  res.writeHead(status, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, code, type: status < 500 ? 'invalid_request_error' : 'server_error' } }));
}

function invalid(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function messageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) invalid('消息内容必须是文本或内容数组');
  return content.map(part => {
    if (['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string') {
      return { type: 'text', text: part.text };
    }
    invalid(`不支持的内容类型 ${part?.type || ''}`);
  });
}

function chatPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请求必须是 JSON 对象');
  if (input.previous_response_id || input.conversation || input.background) {
    invalid('请发送完整 input 历史，此接口使用无状态请求');
  }
  if (input.max_output_tokens != null || (input.text?.format?.type && input.text.format.type !== 'text')) {
    invalid('此接口暂时无法设置 max_output_tokens 或结构化输出格式');
  }
  const items = typeof input.input === 'string' ? [{ role: 'user', content: input.input }] : input.input;
  if (!Array.isArray(items)) invalid('input 必须是文本或消息数组');
  const messages = [];
  if (input.instructions) messages.push({ role: 'developer', content: input.instructions });
  for (const item of items) {
    if (item?.type === 'reasoning') continue;
    if (item?.type === 'function_call') {
      if (!item.call_id || !item.name || typeof item.arguments !== 'string') invalid('function_call 字段不完整');
      let assistant = messages.at(-1);
      if (assistant?.role !== 'assistant') {
        assistant = { role: 'assistant', content: '', tool_calls: [] };
        messages.push(assistant);
      }
      (assistant.tool_calls ??= []).push({
        id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }
    if (item?.type === 'function_call_output') {
      if (!item.call_id || item.output === undefined) invalid('function_call_output 字段不完整');
      messages.push({
        role: 'tool', tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      });
      continue;
    }
    if ((!item?.type || item.type === 'message') && ['user', 'assistant', 'system', 'developer'].includes(item?.role)) {
      messages.push({ role: item.role, content: messageContent(item.content) });
      continue;
    }
    invalid(`不支持的输入类型 ${item?.type || ''}`);
  }
  if (!messages.length) invalid('input 不能为空');
  const stream = input.stream === true;
  if (input.tools !== undefined && !Array.isArray(input.tools)) invalid('tools 必须是数组');
  const tools = (input.tools || []).map(tool => {
    if (tool?.type !== 'function' || !tool.name) invalid('此接口支持 function 工具');
    const { name, description, parameters, strict } = tool;
    return { type: 'function', function: { name, description, parameters, strict } };
  });
  const choice = input.tool_choice;
  let toolChoice = choice;
  if (choice && typeof choice === 'object') {
    if (choice.type !== 'function' || !choice.name) invalid('不支持该 tool_choice');
    toolChoice = { type: 'function', function: { name: choice.name } };
  }
  return {
    model: input.model, messages, stream, tools, tool_choice: toolChoice,
    parallel_tool_calls: input.parallel_tool_calls,
    stream_options: stream ? { include_usage: true } : undefined,
  };
}

async function readJSON(req, limit = 8 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { invalid('JSON 格式无效'); }
}

function responseUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 },
  };
}

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const textPart = text => ({ type: 'output_text', text, annotations: [], logprobs: [] });

function responseState(model) {
  return {
    id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000),
    model, status: 'in_progress', output: [], error: null, incomplete_details: null, usage: null,
  };
}

function textItem() {
  return { id: id('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [textPart('')] };
}

function toolItem(call) {
  return {
    id: id('fc'), type: 'function_call', status: 'in_progress',
    call_id: call.id || id('call'), name: call.function?.name || '', arguments: '',
  };
}

function complete(state, reason, usage) {
  state.status = reason === 'length' ? 'incomplete' : 'completed';
  if (state.status === 'incomplete') state.incomplete_details = { reason: 'max_output_tokens' };
  state.usage = responseUsage(usage);
}

async function plainResponse(upstream, res, state) {
  const chat = await readJSON(upstream).catch(() => { throw new Error('上游返回的 JSON 无效'); });
  const choice = chat.choices?.[0];
  if (!choice) throw new Error('上游没有返回聊天结果');
  state.model = chat.model || state.model;
  const message = choice.message || {};
  if (message.content || !message.tool_calls?.length) {
    const item = textItem();
    item.content[0].text = message.content || '';
    state.output.push(item);
  }
  for (const call of message.tool_calls || []) {
    state.output.push({ ...toolItem(call), arguments: call.function?.arguments || '' });
  }
  complete(state, choice.finish_reason, chat.usage);
  for (const item of state.output) item.status = state.status;
  res.writeHead(200, { ...cors, 'content-type': 'application/json' });
  res.end(JSON.stringify(state));
}

async function streamResponse(upstream, res, state, signal) {
  res.writeHead(200, { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  let sequence = 0;
  async function event(type, fields) {
    const frame = `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`;
    if (!res.write(frame)) await once(res, 'drain', { signal });
  }
  let messageIndex;
  let reason;
  let usage;
  let ended = false;
  const calls = new Map();
  await event('response.created', { response: state });
  await event('response.in_progress', { response: state });
  const lines = createInterface({ input: upstream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        ended = true;
        break;
      }
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error('上游流式请求失败');
      if (chunk.model) state.model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) reason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) {
        if (messageIndex === undefined) {
          const item = textItem();
          messageIndex = state.output.push(item) - 1;
          await event('response.output_item.added', { output_index: messageIndex, item: { ...item, content: [] } });
          await event('response.content_part.added', { output_index: messageIndex, content_index: 0, item_id: item.id, part: item.content[0] });
        }
        const item = state.output[messageIndex];
        item.content[0].text += delta.content;
        await event('response.output_text.delta', { output_index: messageIndex, content_index: 0, item_id: item.id, delta: delta.content, logprobs: [] });
      }
      for (const call of delta.tool_calls || []) {
        if (!calls.has(call.index)) {
          const item = toolItem(call);
          const outputIndex = state.output.push(item) - 1;
          calls.set(call.index, outputIndex);
          await event('response.output_item.added', { output_index: outputIndex, item });
        }
        const outputIndex = calls.get(call.index);
        const item = state.output[outputIndex];
        const args = call.function?.arguments || '';
        if (args) {
          item.arguments += args;
          await event('response.function_call_arguments.delta', { output_index: outputIndex, item_id: item.id, delta: args });
        }
      }
    }
    if (!ended || !reason) throw new Error('上游在完成前关闭了流');
    complete(state, reason, usage);
    for (const [outputIndex, item] of state.output.entries()) {
      item.status = state.status;
      const fields = { output_index: outputIndex, item_id: item.id };
      if (item.type === 'message') {
        await event('response.output_text.done', { ...fields, content_index: 0, text: item.content[0].text, logprobs: [] });
        await event('response.content_part.done', { ...fields, content_index: 0, part: item.content[0] });
      } else {
        await event('response.function_call_arguments.done', { ...fields, arguments: item.arguments, name: item.name });
      }
      await event('response.output_item.done', { output_index: outputIndex, item });
    }
    await event(`response.${state.status}`, { response: state });
  } catch (error) {
    if (signal.aborted) return;
    state.status = 'failed';
    state.error = { code: 'server_error', message: error.message };
    await event('response.failed', { response: state });
  } finally {
    lines.close();
    res.end();
  }
}

async function handleResponses(req, res, port, headers) {
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const input = await readJSON(req);
    const chat = chatPayload(input);
    const body = JSON.stringify(chat);
    const upstream = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', signal: abort.signal,
        headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, resolve);
      request.setTimeout(15 * 60_000, () => request.destroy(new Error('Quick2API 请求超时')));
      request.on('error', reject);
      request.end(body);
    });
    if (upstream.statusCode !== 200) {
      res.writeHead(upstream.statusCode, { ...cors, 'content-type': upstream.headers['content-type'] || 'application/json' });
      upstream.on('error', error => res.destroy(error));
      upstream.pipe(res);
      return;
    }
    const state = responseState(input.model);
    if (chat.stream) await streamResponse(upstream, res, state, abort.signal);
    else await plainResponse(upstream, res, state);
  } catch (error) {
    if (abort.signal.aborted) return;
    if (res.headersSent) res.destroy(error);
    else {
      const status = error.status || 502;
      openAIError(res, status, status < 500 ? 'invalid_request' : 'quick2api_error',
        status < 500 ? error.message : 'Quick2API 请求失败');
    }
  }
}

module.exports = { handleResponses, openAIError };

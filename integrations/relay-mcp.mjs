#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { isMainModule, parseArgs } from './_shared.mjs';
import { loadConnection, publishEvent } from './notify.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const MAX_LINE_BYTES = 1024 * 1024;
const STRING_LIMITS = { title: 200, body: 8192, source: 80, dedupeKey: 256, prompt: 8192, model: 160, effort: 80, providerSessionId: 512 };

const tools = [
  {
    name: 'relay_notify',
    description: 'Publish a local Relay notification. This only writes to the local Relay inbox; it does not contact a provider or send messages.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: STRING_LIMITS.title },
        body: { type: 'string', minLength: 1, maxLength: STRING_LIMITS.body },
        source: { type: 'string', minLength: 1, maxLength: STRING_LIMITS.source },
        dedupeKey: { type: 'string', minLength: 1, maxLength: STRING_LIMITS.dedupeKey },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'relay_status',
    description: 'Report prompt, working, ready, or settings state for the current Relay session. Does not run commands or call external providers.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        event: { type: 'string', enum: ['prompt', 'working', 'ready', 'settings'] },
        title: { type: 'string', maxLength: STRING_LIMITS.title },
        body: { type: 'string', maxLength: STRING_LIMITS.body },
        prompt: { type: 'string', maxLength: STRING_LIMITS.prompt },
        model: { type: 'string', maxLength: STRING_LIMITS.model },
        effort: { type: 'string', maxLength: STRING_LIMITS.effort },
        providerSessionId: { type: 'string', maxLength: STRING_LIMITS.providerSessionId },
        source: { type: 'string', maxLength: STRING_LIMITS.source },
        dedupeKey: { type: 'string', maxLength: STRING_LIMITS.dedupeKey },
      },
      required: ['event'],
    },
  },
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function validateArguments(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object');
  const allowed = name === 'relay_notify'
    ? ['title', 'body', 'source', 'dedupeKey']
    : ['event', 'title', 'body', 'prompt', 'model', 'effort', 'providerSessionId', 'source', 'dedupeKey'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unsupported argument: ${key}`);
  for (const [key, max] of Object.entries(STRING_LIMITS)) {
    if (!(key in value)) continue;
    if (typeof value[key] !== 'string' || value[key].length > max) throw new Error(`${key} must be a string of at most ${max} characters`);
  }
  for (const key of ['title', 'body']) {
    if (name === 'relay_notify' && (typeof value[key] !== 'string' || !value[key].trim())) throw new Error(`${key} is required`);
  }
  if (name === 'relay_status') {
    if (!['prompt', 'working', 'ready', 'settings'].includes(value.event)) throw new Error('event must be prompt, working, ready, or settings');
    if (value.event === 'prompt' && !value.prompt?.trim()) throw new Error('prompt is required for a prompt event');
    if (value.event === 'settings' && !value.model?.trim() && !value.effort?.trim()) throw new Error('settings event needs model or effort');
  }
  return value;
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(name, rawArgs, connection) {
  if (!tools.some((tool) => tool.name === name)) return toolError(`Unknown tool: ${String(name).slice(0, 100)}`);
  const args = validateArguments(name, rawArgs ?? {});
  const sessionId = process.env.RELAY_SESSION_ID?.trim();
  if (name === 'relay_status' && !sessionId) throw new Error('RELAY_SESSION_ID is required for relay_status');
  const payload = {
    event: name === 'relay_notify' ? 'notification' : args.event,
    source: args.source?.trim() || 'mcp',
  };
  if (sessionId) payload.sessionId = sessionId;
  for (const key of ['title', 'body', 'prompt', 'model', 'effort', 'providerSessionId', 'dedupeKey']) {
    if (args[key] !== undefined) payload[key] = args[key];
  }
  await publishEvent({ ...connection, payload });
  return { content: [{ type: 'text', text: name === 'relay_notify' ? 'Relay notification published.' : `Relay ${args.event} event published.` }] };
}

export function createHandler(connection) {
  return async (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id ?? null, -32600, 'Invalid Request');
    }
    const hasId = Object.hasOwn(message, 'id');
    const id = message.id;
    if (hasId && !['string', 'number'].includes(typeof id) && id !== null) return rpcError(null, -32600, 'Invalid Request');
    if (!hasId) {
      if (message.method.startsWith('notifications/')) return undefined;
      return undefined;
    }
    if (message.method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'relay-mcp', version: '1.0.0' },
      });
    }
    if (message.method === 'ping') return rpcResult(id, {});
    if (message.method === 'tools/list') return rpcResult(id, { tools });
    if (message.method === 'tools/call') {
      const params = message.params;
      if (!params || typeof params !== 'object' || typeof params.name !== 'string') return rpcError(id, -32602, 'Invalid params');
      try { return rpcResult(id, await callTool(params.name, params.arguments, connection)); }
      catch (error) {
        const safeMessage = error instanceof Error ? error.message : 'Tool call failed';
        return rpcResult(id, toolError(safeMessage));
      }
    }
    if (message.method.startsWith('notifications/')) return undefined;
    return rpcError(id, -32601, 'Method not found');
  };
}

export async function serve({ input = process.stdin, output = process.stdout, connection }) {
  const handler = createHandler(connection);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let response;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) response = rpcError(null, -32600, 'Request too large');
    else {
      let message;
      try { message = JSON.parse(line); }
      catch { response = rpcError(null, -32700, 'Parse error'); }
      if (message !== undefined) response = await handler(message);
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const connection = await loadConnection(parseArgs(process.argv.slice(2)));
    await serve({ connection });
  } catch {
    process.stderr.write('Relay MCP server failed to start; check its local connection settings.\n');
    process.exitCode = 1;
  }
}

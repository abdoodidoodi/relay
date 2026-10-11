#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { event, isMainModule, parseArgs, requestJson, runCli } from './_shared.mjs';

const MAX_EVENT_BYTES = 64 * 1024;

export function validateLocalEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Relay endpoint must be a valid loopback URL'); }
  const host = url.hostname.toLowerCase();
  const ipHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const loopback = host === 'localhost'
    || (isIP(ipHost) === 4 && ipHost.split('.')[0] === '127')
    || (isIP(ipHost) === 6 && ipHost === '::1');
  if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/events') {
    throw new Error('Relay endpoint must be a loopback HTTP(S) URL ending in /events, without credentials or query');
  }
  return url.href;
}

export async function loadConnection(args) {
  const file = args.get('--connection');
  if (file) {
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error('Could not read Relay connection file'); }
    if (typeof data.endpoint !== 'string' || typeof data.token !== 'string' || !data.token.trim()) throw new Error('Relay connection file must contain endpoint and token');
    return data;
  }
  const endpoint = process.env.RELAY_ENDPOINT?.trim();
  const token = process.env.RELAY_TOKEN?.trim();
  if (!endpoint || !token) throw new Error('Set RELAY_ENDPOINT and RELAY_TOKEN, or pass --connection <connection.json>');
  return { endpoint, token };
}

export async function publishEvent({ endpoint, token, payload, fetchImpl = fetch }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Relay event payload must be an object');
  if (!['session_start', 'prompt', 'working', 'ready', 'notification', 'settings'].includes(payload.event)) throw new Error('Unsupported Relay event type');
  if (!token?.trim()) throw new Error('Relay connection token is missing');
  const safeEndpoint = validateLocalEndpoint(endpoint);
  const bodyJson = JSON.stringify(payload);
  if (Buffer.byteLength(bodyJson, 'utf8') > MAX_EVENT_BYTES) throw new Error(`Relay event exceeds ${MAX_EVENT_BYTES} bytes`);
  return requestJson(safeEndpoint, token, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: bodyJson,
  }, fetchImpl);
}

export async function publish({ endpoint, token, title, body, source, dedupeKey, sessionId, fetchImpl = fetch }) {
  if (!title || !body || !source || !dedupeKey) throw new Error('title, body, source, and dedupeKey are required');
  const payload = event(title, body, source, dedupeKey);
  if (sessionId) payload.sessionId = sessionId;
  return publishEvent({ endpoint, token, payload, fetchImpl });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  await runCli(async () => {
    const args = parseArgs(process.argv.slice(2));
    const connection = await loadConnection(args);
    await publish({
      ...connection,
      title: args.get('--title'),
      body: args.get('--body'),
      source: args.get('--source'),
      dedupeKey: args.get('--dedupe-key'),
    });
    return [];
  });
}

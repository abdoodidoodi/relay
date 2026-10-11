import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./relay-mcp.mjs', import.meta.url));

function runServer(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${input.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')}\n`);
  });
}

test('MCP stdio server initializes, lists tools, publishes local events, and rejects invalid calls', async () => {
  const token = 'mcp-local-test-secret';
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (part) => { body += part; });
    request.on('end', () => {
      received.push({ path: request.url, auth: request.headers.authorization, payload: JSON.parse(body) });
      response.writeHead(204).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'relay_notify', arguments: { title: 'Hello', body: 'From MCP', source: 'agent', dedupeKey: 'notify:1' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'relay_status', arguments: { event: 'settings', model: 'sonnet', effort: 'high' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_shell', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'relay_status', arguments: { event: 'prompt' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'relay_notify', arguments: { title: 42, body: 'bad' } } },
  ];
  try {
    const result = await runServer(input, {
      ...process.env,
      RELAY_ENDPOINT: `http://127.0.0.1:${server.address().port}/events`,
      RELAY_TOKEN: token,
      RELAY_SESSION_ID: 'session-abc',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(token), false);
    const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(responses.length, 7, 'notifications/initialized has no JSON-RPC response');
    assert.equal(responses[0].result.protocolVersion, '2024-11-05');
    assert.deepEqual(responses[0].result.capabilities, { tools: {} });
    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['relay_notify', 'relay_status']);
    assert.deepEqual(responses[1].result.tools[1].inputSchema.properties.event.enum, ['prompt', 'working', 'ready', 'settings']);
    assert.equal(responses[2].result.isError, undefined);
    assert.equal(responses[3].result.isError, undefined);
    assert.equal(responses[4].result.isError, true);
    assert.equal(responses[5].result.isError, true);
    assert.equal(responses[6].result.isError, true);
    assert.deepEqual(received.map(({ path }) => path), ['/events', '/events']);
    assert.deepEqual(received.map(({ auth }) => auth), [`Bearer ${token}`, `Bearer ${token}`]);
    assert.deepEqual(received[0].payload, {
      event: 'notification', title: 'Hello', body: 'From MCP', source: 'agent', dedupeKey: 'notify:1', sessionId: 'session-abc',
    });
    assert.deepEqual(received[1].payload, {
      event: 'settings', source: 'mcp', sessionId: 'session-abc', model: 'sonnet', effort: 'high',
    });
  } finally {
    server.close();
  }
});

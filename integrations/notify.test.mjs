import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish, validateLocalEndpoint } from './notify.mjs';

const script = fileURLToPath(new URL('./notify.mjs', import.meta.url));

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (part) => { stdout += part; });
    child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('generic notifier sends a bearer-authenticated JSON event and never prints the token', async () => {
  const token = 'secret-local-test-token';
  let received;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (part) => { body += part; });
    request.on('end', () => {
      received = { authorization: request.headers.authorization, body: JSON.parse(body) };
      response.writeHead(204).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/events`;
  const directory = await mkdtemp(join(tmpdir(), 'relay-notify-test-'));
  const connection = join(directory, 'connection.json');
  try {
    await writeFile(connection, JSON.stringify({ endpoint, token }), { mode: 0o600 });
    const result = await runNode([
      '--connection', connection,
      '--title', 'Calendar meeting', '--body', 'Starts soon',
      '--source', 'calendar', '--dedupe-key', 'gcal:event-1',
    ], { ...process.env, RELAY_ENDPOINT: '', RELAY_TOKEN: '' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '[]\n');
    assert.deepEqual(received, {
      authorization: `Bearer ${token}`,
      body: { event: 'notification', title: 'Calendar meeting', body: 'Starts soon', source: 'calendar', dedupeKey: 'gcal:event-1' },
    });
    assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('notifier rejects non-loopback or malformed endpoints before sending credentials', async () => {
  let called = false;
  for (const endpoint of [
    'https://example.com/events',
    'http://127.0.0.1.attacker.example/events',
    'http://relay.localhost:8000/events',
    'http://127.0.0.1:8000/other',
    'http://user:pass@localhost:8000/events',
    'http://localhost:8000/events?to=external',
    'not a URL',
  ]) {
    await assert.rejects(publish({
      endpoint, token: 'never-send-this-token', title: 't', body: 'b', source: 's', dedupeKey: 'd',
      fetchImpl: async () => { called = true; throw new Error('must not send'); },
    }));
  }
  assert.equal(called, false);
  assert.equal(validateLocalEndpoint('http://[::1]:1234/events'), 'http://[::1]:1234/events');
  assert.equal(validateLocalEndpoint('http://127.0.0.1:1234/events'), 'http://127.0.0.1:1234/events');
});

test('notifier rejects oversized payloads before the HTTP request', async () => {
  let called = false;
  await assert.rejects(publish({
    endpoint: 'http://127.0.0.1:1234/events', token: 'secret', title: 't', body: 'x'.repeat(70_000), source: 's', dedupeKey: 'd',
    fetchImpl: async () => { called = true; throw new Error('must not send'); },
  }), /exceeds 65536 bytes/);
  assert.equal(called, false);
});

test('malformed connection JSON fails without echoing its content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-notify-invalid-'));
  const connection = join(directory, 'connection.json');
  const secret = 'secret-from-malformed-file';
  try {
    await writeFile(connection, `not-json-${secret}`);
    const result = await runNode(['--connection', connection], { ...process.env, RELAY_ENDPOINT: '', RELAY_TOKEN: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not read Relay connection file/);
    assert.equal(result.stderr.includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

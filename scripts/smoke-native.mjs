// Windows native smoke test. Uses only isolated Relay data and a local shell.
// Run `npm run build`, `cargo build --features devtools`, and `npm run dev` first.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('This native CDP smoke harness currently targets Windows WebView2.');
const root = process.cwd();
const dataDir = resolve(root, '.relay-test', `native-${Date.now()}`);
await mkdir(dataDir, { recursive: true });
await mkdir('artifacts', { recursive: true });
const binary = resolve(root, process.env.RELAY_QA_BINARY || 'src-tauri/target/debug/relay.exe');
const port = Number(process.env.RELAY_QA_PORT || 9334);
let child, browser, page;
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await wait(120);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
async function launch() {
  child = spawn(binary, [], { cwd: root, windowsHide: true, env: { ...process.env, RELAY_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', data => { const text = data.toString(); if (/panicked|fatal error/i.test(text)) errors.push(text); });
  child.on('error', error => errors.push(error.message));
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 'native debug endpoint', 45000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => !page.url().startsWith('devtools:')), 'native page');
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, { timeout: 30000 });
  await page.getByRole('button', { name: 'New session', exact: false }).first().waitFor();
}
const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const snapshot = () => invoke('relay_snapshot');
const action = action => invoke('relay_action', { action });
async function forceStop() {
  // Kill only the executable this harness spawned. PTYs belong to this isolated process.
  if (child && child.exitCode === null) child.kill();
  await until(() => child.exitCode !== null || child.signalCode !== null, 'test process exit');
  if (browser) await browser.close().catch(() => {});
  browser = null;
  await wait(300);
}
try {
  await launch();
  let state = await snapshot();
  assert.equal(state.sessions.length, 0);
  state = await action({ type: 'create_group', title: 'Recovery QA' });
  const group = state.groups.find(group => group.title === 'Recovery QA');
  state = await action({ type: 'create_session', session: { provider: 'shell', cwd: root, groupId: group.id, title: 'Native shell QA' } });
  const shell = state.sessions.find(session => session.title === 'Native shell QA');
  await action({ type: 'select_session', id: shell.id });
  await until(async () => new TextDecoder().decode(new Uint8Array((await invoke('relay_attach', { sessionId: shell.id })).data)).includes('PS '), 'interactive PowerShell prompt');
  await invoke('relay_write', { sessionId: shell.id, data: Array.from(new TextEncoder().encode("Write-Output ('RELAY_SUM=' + (2 + 3))\r")) });
  await until(async () => new TextDecoder().decode(new Uint8Array((await invoke('relay_attach', { sessionId: shell.id })).data)).includes('RELAY_SUM=5'), 'real PTY execution');
  await action({ type: 'move_session', id: shell.id, groupId: state.groups[0].id });
  // A webview reload must attach to the same still-running PTY and recover output.
  await page.reload();
  await page.getByRole('button', { name: 'New session', exact: false }).first().waitFor();
  assert.equal((await snapshot()).sessions.find(s => s.id === shell.id).status, 'running');
  assert.ok(new TextDecoder().decode(new Uint8Array((await invoke('relay_attach', { sessionId: shell.id })).data)).includes('RELAY_SUM=5'));
  // Exercise the OS window-close event; renderer ACL intentionally cannot close windows.
  assert.ok(Number.isInteger(child.pid));
  execFileSync('powershell.exe', ['-NoProfile','-Command',`(Get-Process -Id ${child.pid}).CloseMainWindow()`], {windowsHide:true,stdio:'ignore'});
  await until(async () => !(await invoke('plugin:window|is_visible', {label:'main'})), 'close to tray');
  assert.equal((await snapshot()).sessions.find(s => s.id === shell.id).status, 'running');
  const reopen = spawn(binary, [], {cwd:root, windowsHide:true, stdio:'ignore', env:{...process.env,RELAY_DATA_DIR:dataDir}});
  await until(async () => await invoke('plugin:window|is_visible', {label:'main'}), 'single-instance tray reopen');
  await until(() => reopen.exitCode !== null, 'second instance exits after focusing first');
  let connection = JSON.parse(await readFile(resolve(dataDir, 'connection.json'), 'utf8'));
  const event = { event: 'notification', title: 'Durable meeting', body: 'This local test notification must survive a process restart.', source: 'smoke', dedupeKey: 'native-smoke-meeting' };
  let response = await fetch(connection.endpoint, { method: 'POST', body: JSON.stringify(event) });
  assert.equal(response.status, 403);
  response = await fetch(connection.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, Origin: 'https://example.invalid' }, body: JSON.stringify(event) });
  assert.equal(response.status, 403);
  const publish = event => fetch(connection.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal((await publish(event)).status, 200);
  assert.equal((await publish(event)).status, 200);
  state = await snapshot();
  assert.equal(state.notifications.filter(n => n.title === event.title).length, 1);
  const notice = state.notifications.find(n => n.title === event.title);
  assert.equal(state.sessions.find(s => s.id === notice.sessionId).kind, 'assistant');
  assert.equal(state.sessions.find(s => s.id === notice.sessionId).status, 'stopped');
  await action({ type: 'open_notification', id: notice.id });
  assert.equal((await snapshot()).notifications.find(n => n.id === notice.id).dismissed, false);
  const reminder = { id: 'native-reminder', title: 'One-time reminder QA', source: 'qa', kind: 'reminder', enabled: true, intervalMinutes: 1, nextRunAt: Date.now() + 1500, command: '', args: [], cwd: root, body: 'An actual scheduled reminder.', sessionId: null, lastRunAt: null, lastError: null };
  await action({ type: 'save_rule', rule: reminder });
  await until(async () => (await snapshot()).notifications.some(n => n.title === reminder.title), 'scheduled notification');
  await action({ type: 'select_session', id: shell.id });
  await page.getByRole('button', { name: 'Notifications', exact: false }).first().click();
  await page.screenshot({ path: 'artifacts/relay-native-inbox.png' });
  const before = await snapshot();
  await forceStop();
  await launch();
  state = await snapshot();
  assert.equal(state.activeSessionId, shell.id);
  assert.equal(state.sessions.find(s => s.id === shell.id).groupId, before.sessions.find(s => s.id === shell.id).groupId);
  assert.equal(state.notifications.find(n => n.id === notice.id).body, event.body);
  assert.equal(state.rules.find(r => r.id === reminder.id).enabled, false);
  connection = JSON.parse(await readFile(resolve(dataDir, 'connection.json'), 'utf8'));
  assert.equal((await publish(event)).status, 200);
  assert.equal((await snapshot()).notifications.filter(n => n.title === event.title).length, 1);
  await action({ type: 'dismiss_notification', id: notice.id });
  await forceStop();
  await launch();
  assert.equal((await snapshot()).notifications.find(n => n.id === notice.id).dismissed, true);
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile('artifacts/native-smoke-result.json', JSON.stringify({ passed: true, dataDir, checks: ['real PTY input/output', 'frontend reload reattachment', 'close to tray keeps PTY alive', 'second launch reopens same instance', 'move group persistence', 'hook authentication and origin check', 'notification own dormant conversation', 'notification read retains entry', 'dedupe across process restart', 'scheduled reminder', 'forced process restart', 'active selection restore', 'dismissal persistence'] }, null, 2));
  console.log('Native smoke checks passed: real PTY, reload, groups, hooks, reminders, notification dedupe and dismissal across forced process restarts.');
} finally {
  if (page && child?.exitCode === null) await invoke('relay_quit').catch(() => {});
  if (child && child.exitCode === null) await forceStop().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

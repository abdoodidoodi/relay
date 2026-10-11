// Opt-in live Windows provider check. Uses the installed/authenticated Codex CLI
// for two short, tool-free turns in an isolated workspace. No global settings edits.
// Run manually: node scripts/smoke-codex.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';

if (process.platform !== 'win32') throw new Error('This CDP harness targets Windows.');
const root = process.cwd();
// Keep the trust boundary outside the source Git repository. Codex can otherwise
// apply a subdirectory's trust decision to the repository root.
const dataDir = await mkdtemp(resolve(tmpdir(), 'relay-codex-'));
const cwd = resolve(dataDir, 'workspace');
await mkdir(cwd, { recursive: true });
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const binary = resolve(root, process.env.RELAY_QA_BINARY || 'src-tauri/target/release/relay.exe');
const port = Number(process.env.RELAY_QA_PORT || 9336);
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Valid CDP port required');
const phrase = `cobalt heron ${String(Date.now()).slice(-6)}`;
const storedMarker = 'RELAY_CODEX_MEMORY_STORED';
const question = 'What phrase did I ask you to remember? Reply with the phrase only. Do not invoke any tools or access files.';
let child, browser, page, sessionId, boundId;
let ownedDataConfirmed = false;
const trustChoices = [];
const errors = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
class ProviderBlocked extends Error {}
async function until(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; }
    catch (error) { if (error instanceof ProviderBlocked) throw error; last = error; }
    await wait(250);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
const invoke = (command, args) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
const snapshot = () => invoke('relay_snapshot');
const action = action => invoke('relay_action', {action});
const output = async () => {
  const bytes = (await invoke('relay_attach', {sessionId})).data;
  return stripVTControlCharacters(new TextDecoder().decode(new Uint8Array(bytes))
    .replace(/\x1b\[(\d+)C/g, (_,n) => ' '.repeat(Math.min(Number(n),200))));
};
const normalized = text => text.replace(/\s+/g, ' ').trim();
const send = data => invoke('relay_write', {sessionId, data:Array.from(new TextEncoder().encode(data))});
async function enter() {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
}
async function launch() {
  // Refuse an occupied endpoint rather than connecting to someone else's app.
  let occupied = false;
  try { occupied = (await fetch(`http://127.0.0.1:${port}/json/version`, {signal:AbortSignal.timeout(1000)})).ok; } catch {}
  if (occupied) throw new Error(`CDP port ${port} is already in use`);
  ownedDataConfirmed = false;
  child = spawn(binary, [], {cwd:root, windowsHide:true, stdio:['ignore','ignore','pipe'], env:{...process.env, RELAY_DATA_DIR:dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
  child.on('error', error => errors.push(error.message));
  child.stderr.on('data', data => { const text = data.toString(); if (/panicked|fatal error/i.test(text)) errors.push(text); });
  await until(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new ProviderBlocked(`Owned Relay process exited before CDP connection (${child.exitCode ?? child.signalCode}). ${errors.join(' ')}`);
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
  }, 'WebView2 endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:')), 'native page');
  await page.getByRole('button', {name:'New session',exact:false}).first().waitFor();
  assert.equal(resolve((await snapshot()).dataDir).toLowerCase(), dataDir.toLowerCase(), 'Only own isolated Relay data may be controlled');
  ownedDataConfirmed = true;
}
async function kill() {
  // Only terminate the executable spawned by this harness.
  if (child?.exitCode === null) child.kill();
  if (child) await until(() => child.exitCode !== null || child.signalCode !== null, 'owned test process exit');
  await browser?.close().catch(() => {});
  browser = null;
  page = null;
  ownedDataConfirmed = false;
  await wait(500);
}
async function inspectProvider(text, allowTrust = false) {
  const session = (await snapshot()).sessions.find(s => s.id === sessionId);
  if (session?.status === 'error') throw new ProviderBlocked(session.error || 'Codex failed to start');
  if (/Sign in with ChatGPT|Provide your own API key|Not logged in|AuthenticationError|Incorrect API key|authentication failed|401 Unauthorized/i.test(text)) {
    throw new ProviderBlocked('Codex authentication is unavailable. The harness does not sign in or change credentials.');
  }
  // Trust only an explicit prompt naming our own empty test workspace.
  const compact = text.replace(/\s+/g, '').replaceAll('/', '\\').toLowerCase();
  const ownPath = cwd.replace(/\s+/g, '').toLowerCase();
  if (!allowTrust || trustChoices.length || !compact.includes(ownPath)) return;
  if (/Trusting will apply to the repository root/i.test(text)) throw new ProviderBlocked('Codex trust would extend beyond the isolated test workspace.');
  if ((/Do you trust the (?:contents of this directory|files in this directory|folder)/i.test(text) && /Yes, (?:continue|I trust)/i.test(text)) || (/Trust this folder\?/i.test(text) && /1\. Trust and continue/i.test(text))) {
    trustChoices.push('Explicitly trusted own isolated workspace');
    await enter();
  } else if (/not version controlled/i.test(text) && /Require approval of edits and commands/i.test(text)) {
    trustChoices.push('Required approval of edits and commands in own isolated workspace');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('ArrowDown');
    await enter();
  }
}
async function result(value) {
  await writeFile(resolve(root,'artifacts/codex-smoke-result.json'), JSON.stringify(value,null,2));
}
try {
  await launch();
  assert.equal((await snapshot()).sessions.length, 0, 'Isolated workspace starts empty');
  const grouped = await action({type:'create_group',title:'Codex recovery QA'});
  const group = grouped.groups.find(g => g.title === 'Codex recovery QA');
  const state = await action({type:'create_session',session:{groupId:group.id, title:'Codex live recovery',provider:'codex',cwd,
    model:process.env.RELAY_QA_CODEX_MODEL || '', effort:process.env.RELAY_QA_CODEX_EFFORT || '',
    initialPrompt:`Remember the test phrase ${phrase} for this conversation. Reply exactly ${storedMarker}. Do not invoke any tools or access files.`}});
  sessionId = state.sessions.find(s => s.provider === 'codex').id;
  assert.equal(state.sessions.find(s => s.id === sessionId).providerSessionId, null, 'Codex starts unbound');
  await action({type:'select_session',id:sessionId});
  await page.locator('.session-select').first().click();
  await until(async () => {
    const text = await output();
    await inspectProvider(text, true);
    const current = await snapshot();
    const session = current.sessions.find(s => s.id === sessionId);
    return session.status === 'ready' && session.providerSessionId && current.notifications.some(n => n.sessionId === sessionId && n.body.includes(storedMarker)) && text.includes(storedMarker);
  }, 'actual Codex first response, ready notification and authoritative thread-ID binding', 180000);
  await until(async () => {
    const session = (await snapshot()).sessions.find(s => s.id === sessionId);
    return session.model && session.effort;
  }, 'bound Codex transcript reports exact model and effort', 45000);
  const before = (await snapshot()).sessions.find(s => s.id === sessionId);
  boundId = before.providerSessionId;
  assert.ok(boundId && !/[\x00-\x1f]/.test(boundId));
  await page.screenshot({path:resolve(root,'artifacts/relay-codex-first-turn.png')});
  await kill();
  await launch();
  await until(async () => {
    const text = await output();
    await inspectProvider(text);
    return text.includes(storedMarker);
  }, 'resumed exact Codex transcript', 90000);
  const restoredState = await snapshot();
  const restored = restoredState.sessions.find(s => s.id === sessionId);
  assert.equal(restored.providerSessionId, boundId);
  assert.equal(restored.model, before.model);
  assert.equal(restored.effort, before.effort);
  assert.equal(restored.groupId, before.groupId);
  assert.equal(restoredState.activeSessionId, sessionId);
  const priorNotices = new Set(restoredState.notifications.map(n => n.id));
  await send(`\x1b[200~${question}\x1b[201~`);
  await wait(2000);
  await enter();
  await until(async () => {
    const text = await output();
    await inspectProvider(text);
    const current = await snapshot();
    const session = current.sessions.find(s => s.id === sessionId);
    assert.equal(session.providerSessionId, boundId, 'Second turn remains bound to exact thread');
    const memoryNotice = current.notifications.find(n => !priorNotices.has(n.id) && n.sessionId === sessionId && normalized(n.body).includes(phrase));
    return session.status === 'ready' && memoryNotice && normalized(text.slice(text.lastIndexOf('What phrase'))).includes(phrase);
  }, 'Codex remembers after process restart and sends its second ready notification', 180000);
  if (errors.length) throw new Error(errors.join('\n'));
  await page.screenshot({path:resolve(root,'artifacts/relay-codex-recovery.png')});
  await result({passed:true,dataDir,providerSessionId:boundId,model:restored.model,effort:restored.effort,trustChoices,
    checks:['actual Codex first response','native notify command delivery','authoritative full thread ID','exact transcript model and effort','forced process restart','same model and effort','same group and selected tab','exact provider transcript resumed','remembered unique phrase in second turn','second-turn ready notification on same thread']});
  console.log('Codex live recovery passed: native notify binding, exact conversation/model/effort, group/selection and remembered context across a forced restart.');
} catch (error) {
  if (sessionId && page && ownedDataConfirmed) {
    await writeFile(resolve(root,'artifacts/codex-smoke-output.txt'), await output().catch(()=>''));
    await page.screenshot({path:resolve(root,'artifacts/codex-smoke-blocked.png')}).catch(()=>{});
  }
  await result({passed:false,blocked:error instanceof ProviderBlocked,error:error.message,dataDir,providerSessionId:boundId || null,trustChoices});
  throw error;
} finally {
  if (page && ownedDataConfirmed && child?.exitCode === null) await invoke('relay_quit').catch(()=>{});
  if (child?.exitCode === null) await kill().catch(()=>{});
  await browser?.close().catch(()=>{});
}

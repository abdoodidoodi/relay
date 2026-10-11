// Opt-in live provider check: uses the installed/authenticated Claude CLI and two short turns.
// Never changes global Claude settings or bypasses provider permissions.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
if (process.platform !== 'win32') throw new Error('This CDP harness targets Windows.');
const root = process.cwd();
const dataDir = resolve('.relay-test', `claude-${Date.now()}`);
const cwd = resolve(dataDir, 'workspace');
await mkdir(cwd, { recursive: true });
await mkdir('artifacts', { recursive: true });
const binary = resolve(process.env.RELAY_QA_BINARY || 'src-tauri/target/release/relay.exe');
const port = 9335;
let child, browser, page, sessionId;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await wait(250);
  }
  throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
}
const invoke = (command, args) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
const snapshot = () => invoke('relay_snapshot');
const action = action => invoke('relay_action', { action });
const output = async () => stripVTControlCharacters(new TextDecoder().decode(new Uint8Array((await invoke('relay_attach', {sessionId})).data)).replace(/\x1b\[(\d+)C/g, (_,n) => ' '.repeat(Math.min(Number(n),200))));
const send = data => invoke('relay_write', {sessionId, data: Array.from(new TextEncoder().encode(data))});
async function launch() {
  child = spawn(binary, [], {cwd: root, windowsHide: true, stdio: 'ignore', env: {...process.env, RELAY_DATA_DIR:dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 'WebView2 endpoint');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => !p.url().startsWith('devtools:')), 'native page');
  await page.getByRole('button', { name: 'New session', exact: false }).first().waitFor();
}
async function kill() {
  if (child?.exitCode === null) child.kill();
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned test process exit');
  await browser?.close().catch(() => {});
  browser = null;
  await wait(400);
}
try {
  await launch();
  const initial = await snapshot();
  const state = await action({type:'create_session', session:{groupId:initial.groups[0].id,provider:'claude',cwd, model:'sonnet', effort:'low', initialPrompt:'Remember the secret test phrase violet otter 731 for this conversation. Reply exactly MEMORY_STORED. Do not use any tools.'}});
  sessionId = state.sessions[0].id;
  const assignedId = state.sessions[0].providerSessionId;
  await action({type:'select_session',id:sessionId});
  await page.locator('.session-select').first().click();
  let trustAccepted = false;
  await until(async () => {
    const text = await output();
    if (!trustAccepted && text.includes('Yes, I trust this folder')) { trustAccepted = true; await send('\x1b[B\r'); }
    const session = (await snapshot()).sessions.find(s=>s.id===sessionId);
    if (session.status === 'error') throw new Error(session.error);
    return session.status === 'ready' && text.includes('MEMORY_STORED');
  }, 'Claude first response and ready hook', 120000);
  const before = (await snapshot()).sessions.find(s=>s.id===sessionId);
  assert.equal(before.providerSessionId, assignedId);
  assert.equal(before.effort, 'low');
  assert.ok(before.model.includes('sonnet'));
  await kill();
  await launch();
  await until(async () => (await output()).includes('MEMORY_STORED'), 'resumed Claude transcript', 60000);
  const restored = (await snapshot()).sessions.find(s=>s.id===sessionId);
  assert.equal(restored.providerSessionId, assignedId);
  assert.equal(restored.model, before.model);
  assert.equal(restored.effort, before.effort);
  assert.equal(restored.groupId, before.groupId);
  assert.equal((await snapshot()).activeSessionId, sessionId);
  await send('\x1b[200~What was the secret test phrase? Reply with the phrase only. Do not use any tools.\x1b[201~');
  // Allow Claude's burst/paste detector to settle before treating Enter as submit.
  await wait(2000);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await until(async () => {
    const text = await output();
    return (await snapshot()).sessions.find(s=>s.id===sessionId).status === 'ready' && /violet.{0,25}otter.{0,25}731/s.test(text.slice(text.lastIndexOf('What was the secret test phrase?')));
  }, 'Claude remembers after process restart', 120000);
  await page.screenshot({path:'artifacts/relay-claude-recovery.png'});
  await writeFile('artifacts/claude-smoke-result.json', JSON.stringify({passed:true,dataDir,providerSessionId:assignedId,model:restored.model,effort:restored.effort,checks:['actual Claude response','ready hook','preassigned exact ID','forced process restart','same model and effort','same group and selected tab','provider transcript resumed','memory recalled in second turn']},null,2));
  console.log('Claude live recovery passed: exact conversation, model/effort, group/selection and remembered context across a forced restart.');
} catch (error) {
  if (sessionId && page) {
    await writeFile('artifacts/claude-smoke-output.txt', await output().catch(()=>''));
    await page.screenshot({path:'artifacts/claude-smoke-blocked.png'}).catch(()=>{});
    const current = await snapshot().catch(()=>null);
    console.error(JSON.stringify(current?.sessions.map(({id,status,error,model,effort})=>({id,status,error,model,effort}))));
  }
  throw error;
} finally {
  if (page && child?.exitCode === null) await invoke('relay_quit').catch(()=>{});
  if (child?.exitCode === null) await kill().catch(()=>{});
  await browser?.close().catch(()=>{});
}

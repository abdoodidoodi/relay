// Native Windows integration QA. Provider modes use two short authenticated model turns.
// Only controls a freshly created workspace and its own spawned Relay process.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export async function runShellSmoke(provider = '') {
  if (process.platform !== 'win32') throw new Error('This WebView2 smoke harness targets Windows.');
  if (!['', 'claude', 'codex'].includes(provider)) throw new Error('Expected claude, codex, or no provider.');
  const root = process.cwd();
  const dataDir = realpathSync.native(await mkdtemp(join(tmpdir(), `relay-shell-${provider || 'native'}-`)));
  const cwd = join(dataDir, 'starting folder');
  const project = join(dataDir, 'project with spaces');
  await Promise.all([mkdir(cwd), mkdir(project), mkdir('artifacts', {recursive:true})]);
  const binary = resolve(process.env.RELAY_QA_BINARY || 'src-tauri/target/debug/relay.exe');
  const port = Number(process.env.RELAY_QA_PORT || (provider === 'claude' ? 9341 : provider === 'codex' ? 9342 : 9340));
  const artifact = `artifacts/shell-${provider || 'native'}`;
  const phrase = `silver badger ${String(Date.now()).slice(-6)}`;
  const marker = 'RELAY_SHELL_MEMORY_STORED';
  let child, browser, page, sessionId, owned = false;
  const errors = [], checks = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const samePath = (a,b) => realpathSync.native(resolve(a)).toLowerCase() === realpathSync.native(resolve(b)).toLowerCase();
  async function until(fn, label, timeout = 30000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
      await wait(200);
    }
    throw new Error(`Timed out: ${label}${last ? `: ${last.message}` : ''}`);
  }
  const invoke = (command,args) => page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
  const snapshot = () => invoke('relay_snapshot');
  const action = action => invoke('relay_action',{action});
  const current = async () => (await snapshot()).sessions.find(s => s.id === sessionId);
  const output = async () => stripVTControlCharacters(new TextDecoder().decode(new Uint8Array((await invoke('relay_attach',{sessionId})).data)).replace(/\x1b\[(\d+)C/g,(_,n) => ' '.repeat(Math.min(Number(n),200))));
  const send = data => invoke('relay_write',{sessionId,data:Array.from(new TextEncoder().encode(data))});
  const enter = async () => { await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Enter'); };
  const submit = async text => { await send(`\x1b[200~${text}\x1b[201~`); await wait(2000); await enter(); };
  async function clickTab(id) {
    const session = (await snapshot()).sessions.find(s => s.id === id);
    await page.locator('.session-select').filter({has:page.getByText(session.title,{exact:true})}).first().click();
  }
  async function launch() {
    let occupied = false;
    try { occupied = (await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1000)})).ok; } catch {}
    if (occupied) throw new Error(`QA port ${port} is already occupied; refusing to attach.`);
    owned = false;
    child = spawn(binary,[],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,RELAY_DATA_DIR:dataDir,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
    child.on('error',error => errors.push(error.message));
    child.stderr.on('data',data => { if (/panicked|fatal error/i.test(data.toString())) errors.push(data.toString()); });
    await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,'native WebView2 endpoint',45000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = await until(() => browser.contexts().flatMap(c=>c.pages()).find(p=>!p.url().startsWith('devtools:')),'native page');
    page.on('pageerror',error => errors.push(error.message));
    await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
    assert.ok(samePath((await snapshot()).dataDir,dataDir),'Must only control isolated QA data');
    owned = true;
    await until(async()=> (await page.getByRole('button',{name:'Open terminal',exact:true}).count()) || (await page.locator('.new-session').count()),'application interface');
  }
  async function forceStop() {
    if (child?.exitCode === null) child.kill();
    if (child) await until(()=>child.exitCode!==null || child.signalCode!==null,'owned process exit');
    await browser?.close().catch(()=>{}); browser=null; page=null; owned=false;
    await wait(500);
  }
  try {
    await launch();
    assert.equal((await snapshot()).settings.setupComplete,false);
    await page.getByLabel('Working folder',{exact:true}).fill(cwd);
    await page.getByRole('button',{name:'Open terminal',exact:true}).click();
    await until(async()=>(await snapshot()).settings.setupComplete,'first-run setup completes');
    let state=await snapshot();
    assert.equal(state.groups[0].title,'Group 1');
    assert.equal(state.sessions.length,1);
    sessionId=state.activeSessionId;
    assert.equal((await current()).provider,'shell');
    assert.equal((await current()).shellIntegrated,true);
    assert.equal(await page.getByRole('dialog').count(),0);
    await page.getByRole('button',{name:'Rename group Group 1',exact:true}).click();
    await page.getByRole('textbox',{name:'Group name',exact:true}).fill('Shell recovery QA');
    await page.getByRole('textbox',{name:'Group name',exact:true}).press('Enter');
    await until(async()=>(await snapshot()).groups[0].title==='Shell recovery QA','inline group rename');
    await until(async()=>(await output()).includes('>'),'shell prompt');
    await send("Write-Output ('RELAY_SUM=' + (2 + 3))\r");
    await until(async()=>(await output()).includes('RELAY_SUM=5'),'real shell execution');
    checks.push('folder-only setup creates Group 1 and real shell','inline group rename','no session creation modal');
    await send(`Set-Location -LiteralPath '${project.replaceAll("'","''")}'\r`);
    await until(async()=>samePath((await current()).shellCwd,project),'shell cd saved from prompt');
    checks.push('shell working directory tracks cd');

    if(provider) {
      // Type the default installed agent exactly as a user does. No launch picker or model override.
      await send(`${provider==='claude' ? 'claude-code' : 'codex'}\r`);
      let trusted=false;
      await until(async()=>{
        const text=(await page.locator('.xterm-screen').innerText()).replace(/\s+/g,' ');
        const compact=text.replace(/\s+/g,'').toLowerCase();
        if(!trusted && text.includes('Yes, I trust this folder') && compact.includes(project.replace(/\s+/g,'').toLowerCase())) {
          trusted=true;
          console.log('Trusting the isolated QA folder shown by Claude.');
          await wait(1200);
          if(text.includes('No, exit')) {
            await send('\x1b[B');
            await until(async()=> /[❯›>]\s*Yes, I trust this folder/.test(await page.locator('.xterm-screen').innerText()),'isolated folder trust selection',5000);
          }
          await send('\r'); return false;
        }
        const session=await current();
        return session.provider===provider && (provider==='claude' ? !!session.model : /Ask Codex|OpenAI Codex/.test(text)) && (!text.includes('Yes, I trust this folder') || trusted);
      },'agent manually launched inside shell',60000);
      await wait(1200);
      await submit(`Remember the phrase ${phrase} for this conversation. Reply exactly ${marker}. Do not invoke tools or access files.`);
      await until(async()=>{
        const session=await current(), text=await output();
        return session.status==='ready' && session.providerSessionId && text.split(marker).length>=3;
      },'agent first response and exact conversation binding',180000);
      await until(async()=>{const session=await current();return session.model && session.effort && session.title!=='Terminal' && session.title!=='New terminal';},'title and live model/effort captured',45000);
      assert.ok(samePath((await current()).cwd,project));
      checks.push(`${provider} launched manually with CLI defaults`,'actual provider title/model/effort/ID and cwd captured');
    }
    const before=await current();
    await page.reload();
    await page.locator('.new-session').waitFor();
    assert.ok((await output()).includes(provider?marker:'RELAY_SUM=5'));
    checks.push('frontend reload reattaches to same process');
    await page.locator('.new-session').click();
    await until(async()=>(await snapshot()).sessions.length===2,'plus creates second shell immediately');
    state=await snapshot();
    const second=state.sessions.find(s=>s.id!==sessionId);
    assert.equal(second.provider,'shell');
    assert.equal(await page.getByRole('dialog').count(),0);
    checks.push('plus creates a shell without a launch form');
    if(!provider) {
      let connection=JSON.parse(await readFile(join(dataDir,'connection.json'),'utf8'));
      const event={event:'notification',title:'Persistent inbox QA',body:'Keep this notification until dismissed.',source:'qa',dedupeKey:'shell-first-qa'};
      const publish=()=>fetch(connection.endpoint,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'Content-Type':'application/json'},body:JSON.stringify(event)});
      assert.equal((await fetch(connection.endpoint,{method:'POST',body:JSON.stringify(event)})).status,403);
      assert.equal((await publish()).status,200); assert.equal((await publish()).status,200);
      const notice=(await snapshot()).notifications.find(n=>n.title===event.title);
      assert.equal((await snapshot()).sessions.find(s=>s.id===notice.sessionId).status,'stopped');
      const rule={id:'shell-smoke-reminder',title:'One-shot reminder',source:'qa',kind:'reminder',enabled:true,intervalMinutes:1,nextRunAt:Date.now()+800,command:'',args:[],cwd,body:'Scheduled locally',sessionId:null,lastRunAt:null,lastError:null};
      await action({type:'save_rule',rule});
      await until(async()=>(await snapshot()).notifications.some(n=>n.title===rule.title),'one-time scheduled reminder');
      assert.ok(Number.isInteger(child.pid));
      execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${child.pid}).CloseMainWindow()`],{windowsHide:true,stdio:'ignore'});
      await until(async()=>!(await invoke('plugin:window|is_visible',{label:'main'})),'close to tray');
      const reopened=spawn(binary,[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,RELAY_DATA_DIR:dataDir}});
      await until(async()=>await invoke('plugin:window|is_visible',{label:'main'}),'reopen same workspace');
      await until(()=>reopened.exitCode!==null,'second launch exits');
      checks.push('tray close keeps processes alive','same-directory second instance reopens window');
      await forceStop(); await launch();
      state=await snapshot();
      assert.ok(state.sessions.every(s=>s.status==='stopped'),'Every saved tab must be dormant after restart');
      assert.equal(state.notifications.filter(n=>n.title===event.title).length,1);
      assert.equal(state.rules.find(r=>r.id===rule.id).enabled,false);
      connection=JSON.parse(await readFile(join(dataDir,'connection.json'),'utf8'));
      assert.equal((await publish()).status,200);
      assert.equal((await snapshot()).notifications.filter(n=>n.title===event.title).length,1);
      await action({type:'dismiss_notification',id:notice.id});
      checks.push('durable inbox and dedupe across restart','reminder does not repeat');
    } else { await forceStop(); await launch(); }
    state=await snapshot();
    assert.equal(state.settings.setupComplete,true);
    assert.equal(await page.getByRole('button',{name:'Open terminal',exact:true}).count(),0);
    assert.ok(state.sessions.every(s=>s.status==='stopped'),'Reopening app must not eagerly resume any tab');
    assert.equal((await invoke('relay_attach',{sessionId})).data.length,0);
    const saved=await current();
    assert.equal(saved.groupId,before.groupId); assert.equal(saved.title,before.title);
    assert.equal(saved.providerSessionId,before.providerSessionId);
    assert.equal(saved.model,before.model); assert.equal(saved.effort,before.effort);
    await clickTab(sessionId);
    await until(async()=> ['running','ready','idle'].includes((await current()).status),'clicked tab launches');
    assert.equal((await snapshot()).sessions.find(s=>s.id===second.id).status,'stopped');
    checks.push('setup runs only once','all tabs remain dormant until clicked','click starts only selected tab');
    if(provider) {
      await until(async()=>(await output()).includes(marker),'exact provider transcript restored',90000);
      const prior=new Set((await snapshot()).notifications.map(n=>n.id));
      await submit('What phrase did I ask you to remember? Reply with the phrase only. Do not invoke tools or access files.');
      await until(async()=>{
        const state=await snapshot(), session=state.sessions.find(s=>s.id===sessionId), text=await output();
        return session.status==='ready' && state.notifications.some(n=>n.sessionId===sessionId && !prior.has(n.id)) && text.slice(text.lastIndexOf('What phrase')).replace(/\s+/g,' ').includes(phrase);
      },'context recalled after lazy provider resume',180000);
      // Codex can deliver a separate background title notification after the visible turn.
      if(provider==='codex') await wait(3000);
      assert.equal((await current()).providerSessionId,before.providerSessionId);
      assert.equal((await current()).model,before.model); assert.equal((await current()).effort,before.effort);
      checks.push('same provider conversation/model/effort resumed from saved cwd','actual context remembered in next turn');
    } else {
      await until(async()=>samePath((await current()).shellCwd,project),'shell resumes saved cwd');
      await send("Write-Output ('RESTORED_SUM=' + (6 + 1))\r");
      await until(async()=>(await output()).includes('RESTORED_SUM=7'),'restored shell responds');
    }
    if(errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({path:`${artifact}.png`});
    await writeFile(`${artifact}-result.json`,JSON.stringify({passed:true,dataDir,provider:provider||'shell',checks},null,2));
    console.log(`Shell-first ${provider||'native'} smoke passed (${checks.length} checks).`);
  } catch(error) {
    if(owned && page && sessionId) { await writeFile(`${artifact}-output.txt`,await output().catch(()=>'')); await page.screenshot({path:`${artifact}-blocked.png`}).catch(()=>{}); }
    await writeFile(`${artifact}-result.json`,JSON.stringify({passed:false,dataDir,error:error.message,checks},null,2));
    throw error;
  } finally {
    if(owned && page && child?.exitCode===null) await invoke('relay_quit').catch(()=>{});
    if(child?.exitCode===null) await forceStop().catch(()=>{});
    await browser?.close().catch(()=>{});
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await runShellSmoke(process.argv[2]||'');

import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, X } from 'lucide-react';
import { errorText, isNative } from './api';
import type { Action, Provider, Rule, Session, Snapshot } from './types';

export type Dispatch = (action: Action) => Promise<Snapshot>;
export const providerNames: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', shell: 'Shell', custom: 'Custom command' };
export function ProviderOptions() { return <>{Object.entries(providerNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</>; }
export function EffortOptions() { return <><option value="">Provider default</option>{['low', 'medium', 'high', 'xhigh', 'max'].map(e => <option value={e} key={e}>{e}</option>)}</>; }
export function parseArgs(value: string): string[] {
  const parsed: unknown = JSON.parse(value || '[]');
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('Arguments must be a JSON array of strings, such as ["--flag", "value"].');
  return parsed;
}

export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`dialog-${crypto.randomUUID()}`);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []).filter(element => element.offsetParent !== null);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); previouslyFocused?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId.current}><header><h2 id={titleId.current}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={17} /></button></header>{children}</div></div>;
}

export function FolderField({ value, change, required = false }: { value: string; change: (value: string) => void; required?: boolean }) {
  const [error, setError] = useState('');
  const pick = async () => {
    try { setError(''); const path = await open({ directory: true, multiple: false, defaultPath: value || undefined }); if (typeof path === 'string') change(path); }
    catch (error) { setError(errorText(error)); }
  };
  return <label>Working folder<div className="folder-field"><input value={value} onChange={e => change(e.target.value)} placeholder="Choose a local project folder" required={required} /><button type="button" aria-label="Choose folder" disabled={!isNative} onClick={() => void pick()} title={isNative ? 'Browse folders' : 'Folder picker requires the desktop app'}><FolderOpen size={16} /></button></div>{error && <span className="field-error">{error}</span>}</label>;
}

export function NewSession({ snapshot, dispatch, close, created }: { snapshot: Snapshot; dispatch: Dispatch; close: () => void; created: (id: string) => void }) {
  const [groupId, setGroup] = useState(snapshot.groups[0]?.id || '');
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState<Provider>(snapshot.settings.defaultProvider);
  const [cwd, setCwd] = useState(snapshot.settings.defaultCwd);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [executable, setExecutable] = useState('');
  const [args, setArgs] = useState('[]');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const parsed = provider === 'custom' || provider === 'shell' ? parseArgs(args) : [];
      let targetGroup = groupId;
      if (!targetGroup) { const next = await dispatch({ type: 'create_group', title: 'Workspace' }); targetGroup = next.groups[next.groups.length - 1].id; }
      const next = await dispatch({ type: 'create_session', session: { groupId: targetGroup, title: title.trim() || undefined, provider, cwd: cwd.trim(), model: model.trim(), effort, executable: executable.trim(), args: parsed, initialPrompt: prompt.trim() } });
      if (next.activeSessionId) created(next.activeSessionId); close();
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <Modal title="New session" close={close}><form onSubmit={event => void submit(event)} className="form">
    <label>Title <span className="optional">optional · follows your first prompt</span><input value={title} onChange={e => setTitle(e.target.value)} placeholder="What are you working on?" maxLength={200} /></label>
    <div className="form-grid"><label>Agent<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><ProviderOptions /></select></label><label>Group<select value={groupId} onChange={e => setGroup(e.target.value)}>{snapshot.groups.length ? snapshot.groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>) : <option value="">Workspace (new)</option>}</select></label></div>
    <FolderField value={cwd} change={setCwd} required />
    {(provider === 'claude' || provider === 'codex') && <div className="form-grid"><label>Model<input value={model} onChange={e => setModel(e.target.value)} placeholder="Provider default" /></label><label>Reasoning effort<select value={effort} onChange={e => setEffort(e.target.value)}><EffortOptions /></select></label></div>}
    {(provider === 'shell' || provider === 'custom') && <><label>Executable<input required={provider === 'custom'} value={executable} onChange={e => setExecutable(e.target.value)} placeholder={provider === 'shell' ? 'Default system shell' : 'Executable name or full path'} /></label><label>Arguments <span className="optional">JSON array</span><input value={args} onChange={e => setArgs(e.target.value)} placeholder='["--flag", "value"]' spellCheck={false} className="mono" /></label></>}
    {provider !== 'shell' && <label>Initial prompt <span className="optional">optional</span><textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Give the agent a place to start…" rows={3} /></label>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Starting…' : 'Create session'}</button></footer>
  </form></Modal>;
}

export function SessionSettings({ session, dispatch, close }: { session: Session; dispatch: Dispatch; close: () => void }) {
  const locked = ['starting', 'running', 'ready', 'idle'].includes(session.status);
  const supportsBinding = session.provider === 'claude' || session.provider === 'codex';
  const [model, setModel] = useState(session.model);
  const [effort, setEffort] = useState(session.effort);
  const [providerSessionId, setProviderSessionId] = useState(session.providerSessionId || '');
  const [bindingEdited, setBindingEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (locked) { setModel(session.model); setEffort(session.effort); setProviderSessionId(session.providerSessionId || ''); setBindingEdited(false); } }, [locked, session.model, session.effort, session.providerSessionId]);
  return <Modal title="Session settings" close={close}><form className="form" onSubmit={event => {
    event.preventDefault(); if (locked) return;
    const binding = supportsBinding && bindingEdited && providerSessionId.trim() !== (session.providerSessionId || '') ? providerSessionId.trim() : undefined;
    if (binding === '') { setError('Enter an existing conversation ID from this provider.'); return; }
    setError(''); setBusy(true);
    void dispatch({ type: 'update_session', id: session.id, model: model.trim(), effort, ...(binding === undefined ? {} : { providerSessionId: binding }) }).then(close).catch(error => setError(errorText(error))).finally(() => setBusy(false));
  }}>
    <p className="muted">{providerNames[session.provider]} · {session.title}</p>
    <label>Model<input disabled={locked} value={model} onChange={e => setModel(e.target.value)} placeholder="Provider default" /></label>
    <label>Reasoning effort<select disabled={locked} value={effort} onChange={e => setEffort(e.target.value)}><EffortOptions />{effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) && <option value={effort}>{effort} (reported by agent)</option>}</select></label>
    <p className="form-help">{locked ? 'Use the agent’s model controls, or stop this session to change launch settings.' : 'Saved for the next launch. Changes reported by the agent also update these settings.'}</p>
    {supportsBinding ? <><label>Provider conversation ID<input disabled={locked} value={providerSessionId} onChange={event => { setProviderSessionId(event.target.value); setBindingEdited(true); }} placeholder="Exact existing conversation ID" spellCheck={false} className="mono" /></label><p className="form-help">Use an existing conversation ID from this provider; Relay never chooses the latest session.</p></> : session.providerSessionId && <label className="form-help">Saved conversation ID<code className="opaque-id">{session.providerSessionId}</code></label>}
    {error && <p role="alert" className="form-error">{error}</p>}<footer><button className="secondary" type="button" onClick={close}>{locked ? 'Close' : 'Cancel'}</button><button className="primary" disabled={busy || locked}>{busy ? 'Saving…' : 'Save settings'}</button></footer>
  </form></Modal>;
}

export function TextDialog({ title, initial = '', label, save, close }: { title: string; initial?: string; label: string; save: (text: string) => Promise<unknown>; close: () => void }) {
  const [text, setText] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title={title} close={close}><form className="form" onSubmit={event => { event.preventDefault(); if (!text.trim()) return; setBusy(true); void save(text.trim()).then(close).catch(error => setError(errorText(error))).finally(() => setBusy(false)); }}><label>{label}<input value={text} onChange={e => setText(e.target.value)} maxLength={200} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<footer><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save'}</button></footer></form></Modal>;
}

function datetimeInput(timestamp: number | null) {
  const date = new Date(timestamp || Date.now() + 3600000); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function RuleEditor({ rule, snapshot, dispatch, close }: { rule?: Rule; snapshot: Snapshot; dispatch: Dispatch; close: () => void }) {
  const [draft, setDraft] = useState<Rule>(rule || { id: crypto.randomUUID(), title: '', source: '', kind: 'interval', enabled: true, intervalMinutes: 60, nextRunAt: Date.now() + 3600000, command: '', args: [], cwd: snapshot.settings.defaultCwd, body: '', sessionId: null, lastRunAt: null, lastError: null });
  const [args, setArgs] = useState(JSON.stringify(draft.args));
  const [time, setTime] = useState(datetimeInput(draft.nextRunAt));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const change = <K extends keyof Rule>(key: K, value: Rule[K]) => setDraft(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const recurring = draft.kind === 'interval' || draft.kind === 'command';
      const nextRunAt = draft.kind === 'reminder' ? new Date(time).getTime() : draft.kind === 'webhook' ? null : recurring && (!rule || rule.intervalMinutes !== draft.intervalMinutes || rule.kind !== draft.kind) ? Date.now() + draft.intervalMinutes * 60000 : draft.nextRunAt;
      const next = { ...draft, title: draft.title.trim(), source: draft.source.trim() || draft.id, args: draft.kind === 'command' ? parseArgs(args) : [], nextRunAt };
      if (next.kind === 'reminder' && (!Number.isFinite(next.nextRunAt) || next.nextRunAt! <= Date.now())) throw new Error('Choose a future time for the reminder.');
      if ((next.kind === 'interval' || next.kind === 'command') && next.intervalMinutes < 1) throw new Error('The interval must be at least one minute.');
      await dispatch({ type: 'save_rule', rule: next }); close();
    } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  return <Modal title={rule ? 'Edit background rule' : 'New background rule'} close={close}><form className="form" onSubmit={event => void submit(event)}>
    <label>Title<input required value={draft.title} onChange={e => change('title', e.target.value)} placeholder="What should this rule do?" /></label>
    <div className="form-grid"><label>Type<select value={draft.kind} onChange={e => change('kind', e.target.value as Rule['kind'])}><option value="interval">Recurring notification</option><option value="reminder">One-time reminder</option><option value="command">Scheduled command</option><option value="webhook">Incoming webhook</option></select></label><label>Source<input value={draft.source} onChange={e => change('source', e.target.value)} required={draft.kind === 'webhook'} placeholder={draft.kind === 'webhook' ? 'Source to match' : 'Optional label'} /></label></div>
    {draft.kind === 'reminder' && <label>Remind me at<input type="datetime-local" required value={time} onChange={e => setTime(e.target.value)} /></label>}
    {(draft.kind === 'interval' || draft.kind === 'command') && <label>Every (minutes)<input type="number" min={1} max={525600} required value={draft.intervalMinutes} onChange={e => change('intervalMinutes', Number(e.target.value))} /></label>}
    {draft.kind === 'command' ? <><label>Executable<input required value={draft.command} onChange={e => change('command', e.target.value)} placeholder="Executable name or full path" /></label><label>Arguments <span className="optional">JSON array</span><input className="mono" value={args} onChange={e => setArgs(e.target.value)} spellCheck={false} /></label><FolderField value={draft.cwd} change={value => change('cwd', value)} /><p className="form-help">The program returns a JSON event or array of events on stdout. Credentials stay in the program’s environment.</p></> : <label>Notification message<textarea rows={3} value={draft.body} onChange={e => change('body', e.target.value)} placeholder={draft.kind === 'webhook' ? 'Optional default message for matching events' : 'What should the notification say?'} /></label>}
    <label>Session<select value={draft.sessionId || ''} onChange={e => change('sessionId', e.target.value || null)}><option value="">Create an assistant tab</option>{snapshot.sessions.filter(s => !s.archived).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
    <label className="checkbox-line"><input type="checkbox" checked={draft.enabled} onChange={e => change('enabled', e.target.checked)} />Enabled</label>
    {error && <p className="form-error" role="alert">{error}</p>}<footer><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button></footer>
  </form></Modal>;
}

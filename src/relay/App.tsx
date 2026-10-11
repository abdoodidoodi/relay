import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Archive, ArrowRight, Bell, ChevronDown, ChevronRight, Check, Command, Folder, Inbox, Loader2, MoreHorizontal, Play, Plus, Search, Settings2, Square, TerminalSquare, Trash2, X, Zap } from 'lucide-react';
import { errorText, getTransport, isDemo, type RelayTransport } from './api';
import { FolderField, Modal, RuleEditor, SessionSettings, TextDialog, providerNames, type Dispatch } from './Dialogs';
import { reconcileView, type View } from './selection';
import Terminal from './Terminal';
import type { Action, Group, Rule, Session, Settings, Snapshot } from './types';

type Dialog = { kind: 'rename'; session: Session } | { kind: 'session-settings'; session: Session } | { kind: 'rule'; rule?: Rule } | { kind: 'search' } | null;
const statusNames: Record<Session['status'], string> = { starting: 'Starting', running: 'Working', ready: 'Ready for you', idle: 'Idle', stopped: 'Stopped', error: 'Needs attention' };
const live = (session: Session) => ['starting', 'running', 'ready', 'idle'].includes(session.status);
const ignore = () => {};

export function Status({ session, text = false }: { session: Session; text?: boolean }) {
  const busy = session.status === 'running' || session.status === 'starting';
  return <span className={`session-status status-${session.status}`} title={statusNames[session.status]}>{busy ? <Loader2 size={13} className="spin" aria-label={statusNames[session.status]} /> : <span className="status-dot" aria-label={statusNames[session.status]} />}{text && <span>{statusNames[session.status]}</span>}</span>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [transport, setTransport] = useState<RelayTransport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState(0);
  const [view, setView] = useState<View>({ kind: 'workspace' });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState('');
  const initialized = useRef(false);
  const latestVersion = useRef(-1);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const retryRef = useRef<(() => void) | null>(null);
  const previousStatuses = useRef(new Map<string, Session['status']>());
  const [generations, setGenerations] = useState<Record<string, number>>({});
  const closeDialog = useCallback(() => setDialog(null), []);

  const accept = useCallback((next: Snapshot) => {
    // An invoke response can arrive after a newer committed state event.
    if (next.version < latestVersion.current) return;
    latestVersion.current = next.version;
    const restarted: string[] = [];
    next.sessions.forEach(session => {
      const previous = previousStatuses.current.get(session.id);
      if (previous && ['stopped', 'error'].includes(previous) && live(session)) restarted.push(session.id);
      previousStatuses.current.set(session.id, session.status);
    });
    if (restarted.length) setGenerations(previous => { const next = { ...previous }; restarted.forEach(id => { next[id] = (next[id] || 0) + 1; }); return next; });
    setSnapshot(next);
    const initialize = !initialized.current;
    initialized.current = true;
    setView(previous => {
      if (initialize) return next.activeSessionId && next.sessions.some(s => s.id === next.activeSessionId && !s.archived) ? { kind: 'session', id: next.activeSessionId } : { kind: 'workspace' };
      return reconcileView(previous, next);
    });
  }, []);

  useEffect(() => {
    let cancelled = false; let unlisten: (() => void) | undefined;
    setLoading(true); setError('');
    void (async () => {
      const api = await getTransport();
      if (cancelled) return;
      const unsubscribe = await api.onState(next => { if (!cancelled) accept(next); });
      if (cancelled) { unsubscribe(); return; } unlisten = unsubscribe;
      const next = await api.snapshot();
      if (!cancelled) { setTransport(api); accept(next); setLoading(false); }
    })().catch(error => {
      if (!cancelled) { setLoading(false); setError(errorText(error)); retryRef.current = () => setReload(value => value + 1); }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [accept, reload]);

  const dispatch: Dispatch = useCallback((action: Action) => {
    if (!transport) return Promise.reject(new Error('The desktop connection is unavailable.'));
    setPending(value => value + 1);
    const task = queue.current.catch(ignore).then(() => transport.action(action));
    queue.current = task;
    return task.then(next => { accept(next); setError(''); return next; }).catch(error => {
      setError(errorText(error)); retryRef.current = () => { void dispatch(action).catch(ignore); }; throw error;
    }).finally(() => setPending(value => value - 1));
  }, [accept, transport]);

  const select = useCallback((id: string) => {
    setView({ kind: 'session', id }); setMenu(null);
    void dispatch({ type: 'select_session', id }).catch(ignore);
  }, [dispatch]);

  const newTerminal = useCallback((groupId?: string) => {
    if (!snapshot?.settings.setupComplete) return;
    const target = groupId || (view.kind === 'session' ? snapshot.sessions.find(session => session.id === view.id)?.groupId : undefined) || snapshot.groups[0]?.id;
    void dispatch({ type: 'new_terminal', groupId: target }).then(next => { if (next.activeSessionId) setView({ kind: 'session', id: next.activeSessionId }); }).catch(ignore);
  }, [dispatch, snapshot, view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !snapshot) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); newTerminal(); }
      if (!snapshot.settings.setupComplete) return;
      if (key === 'k') { event.preventDefault(); setDialog({ kind: 'search' }); }
      if (key === 'i') { event.preventDefault(); setView({ kind: 'inbox' }); }
      if (key === ',') { event.preventDefault(); setView({ kind: 'settings' }); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [snapshot, newTerminal]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest('[data-menu]')) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); };
  }, [menu]);

  const drop = (event: DragEvent, groupId: string, beforeId?: string) => {
    event.preventDefault(); event.stopPropagation(); setDropTarget('');
    const id = event.dataTransfer.getData('application/relay-session');
    if (id && id !== beforeId) void dispatch({ type: 'move_session', id, groupId, beforeId }).catch(ignore);
  };
  const dragOver = (event: DragEvent, target: string) => {
    if (!event.dataTransfer.types.includes('application/relay-session')) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setDropTarget(target);
  };

  if (!snapshot) return <div className="boot"><div className="brand-mark"><Command size={23} /></div><h1>Relay</h1>{loading ? <><Loader2 className="spin" size={20} /><p>Connecting to your workspace…</p></> : <><p className="boot-error" role="alert">{error}</p><button className="primary" onClick={() => retryRef.current?.()}>Try again</button></>}</div>;

  const sessions = snapshot.sessions.filter(session => !session.archived);
  const groups = snapshot.groups;
  const modifierLabel = snapshot.platform === 'macos' ? 'Cmd' : 'Ctrl';
  const notifications = snapshot.notifications.filter(notification => !notification.dismissed);
  const selected = view.kind === 'session' ? sessions.find(s => s.id === view.id) : undefined;
  const workspaceName = selected ? snapshot.groups.find(group => group.id === selected.groupId)?.title : 'Workspace';

  if (!snapshot.settings.setupComplete) return <Setup snapshot={snapshot} dispatch={dispatch} completed={id => setView({ kind: 'session', id })} />;

  function sessionMenu(session: Session, menuId: string) {
    return <div className="menu" role="menu" data-menu>
      <button role="menuitem" onClick={() => { setMenu(null); setDialog({ kind: 'rename', session }); }}>Rename session</button>
      {(session.provider === 'claude' || session.provider === 'codex') && <button role="menuitem" onClick={() => { setMenu(null); setDialog({ kind: 'session-settings', session }); }}>Agent settings</button>}
      <label className="menu-move">Move to<select aria-label="Move session to group" value={session.groupId} onChange={event => { void dispatch({ type: 'move_session', id: session.id, groupId: event.target.value }).catch(ignore); setMenu(null); }}>{groups.map(group => <option key={group.id} value={group.id}>{group.title}</option>)}</select></label>
      <div className="menu-divider" />
      <button role="menuitem" onClick={() => { setMenu(null); void dispatch({ type: live(session) ? 'stop_session' : 'start_session', id: session.id }).catch(ignore); }}>{live(session) ? <Square size={14} /> : <Play size={14} />}{live(session) ? 'Stop session' : 'Resume session'}</button>
      <button role="menuitem" onClick={() => { setMenu(null); void dispatch({ type: 'archive_session', id: session.id }).catch(ignore); }}><Archive size={14} />Archive session</button>
      <span className="sr-only">{menuId}</span>
    </div>;
  }

  return <div className="relay-app">
    <aside className="sidebar" aria-label="Workspace sidebar">
      <div className="sidebar-brand"><button onClick={() => { const id = snapshot.activeSessionId || sessions[0]?.id; setView(id ? { kind: 'session', id } : { kind: 'workspace' }); }} className="brand-button"><span className="brand-mark"><Command size={18} /></span><span>Relay</span></button><button className="icon-button" aria-label="Search sessions" title={`Search sessions · ${modifierLabel}+K`} onClick={() => setDialog({ kind: 'search' })}><Search size={16} /></button></div>
      <button className="new-session" onClick={() => newTerminal()}><Plus size={16} /><span>New tab</span><kbd>{modifierLabel} N</kbd></button>
      <nav className="sidebar-nav" aria-label="Workspace panels"><button className={view.kind === 'inbox' ? 'active' : ''} onClick={() => setView({ kind: 'inbox' })}><Inbox size={16} /><span>Notifications</span>{notifications.length > 0 && <span className="count">{notifications.length}</span>}</button><button className={view.kind === 'rules' ? 'active' : ''} onClick={() => setView({ kind: 'rules' })}><Zap size={16} /><span>Background rules</span>{snapshot.rules.filter(rule => rule.enabled).length > 0 && <span className="quiet-count">{snapshot.rules.filter(rule => rule.enabled).length}</span>}</button></nav>
      <div className="groups-heading"><span>SESSIONS</span><button className="icon-button" aria-label="Create group" title="Create group" onClick={() => { let number = snapshot.groups.length + 1; while (snapshot.groups.some(group => group.title === `Group ${number}`)) number++; void dispatch({ type: 'create_group', title: `Group ${number}` }).catch(ignore); }}><Plus size={14} /></button></div>
      <div className="session-groups">
        {snapshot.groups.map(group => {
          const groupSessions = sessions.filter(session => session.groupId === group.id);
          return <section key={group.id} className={`session-group ${dropTarget === group.id ? 'drop-group' : ''}`} onDragOver={event => dragOver(event, group.id)} onDrop={event => drop(event, group.id)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(''); }}>
            <div className="group-header"><button className="group-chevron" onClick={() => void dispatch({ type: 'update_group', id: group.id, collapsed: !group.collapsed }).catch(ignore)} aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} ${group.title}`} aria-expanded={!group.collapsed}>{group.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button><GroupName group={group} dispatch={dispatch} /><span className="group-count">{groupSessions.length}</span><button className="icon-button group-add" aria-label={`New tab in ${group.title}`} title={`New tab in ${group.title}`} onClick={() => newTerminal(group.id)}><Plus size={13} /></button>{!groupSessions.length && <div className="menu-anchor" data-menu><button className="icon-button group-options" aria-label={`Options for ${group.title}`} onClick={() => setMenu(menu === group.id ? null : group.id)}><MoreHorizontal size={15} /></button>{menu === group.id && <div className="menu" role="menu"><button role="menuitem" onClick={() => { setMenu(null); void dispatch({ type: 'delete_group', id: group.id }).catch(ignore); }}>Delete empty group</button></div>}</div>}</div>
            {!group.collapsed && <div className="group-sessions">{groupSessions.map(session => <div key={session.id} className={`session-row ${selected?.id === session.id ? 'active' : ''} ${dropTarget === `before:${session.id}` ? 'drop-before' : ''}`} draggable onDragStart={event => { event.dataTransfer.setData('application/relay-session', session.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDropTarget('')} onDragOver={event => dragOver(event, `before:${session.id}`)} onDrop={event => drop(event, group.id, session.id)}>
              <button className="session-select" onClick={() => select(session.id)} title={`${session.title}\n${providerNames[session.provider]} · ${statusNames[session.status]}`}><Status session={session} /><span className="session-title">{session.title}</span>{session.unread && <span className="unread-dot" aria-label="Unread activity" />}</button><div className="menu-anchor" data-menu><button className="session-options icon-button" aria-label={`Options for ${session.title}`} onClick={() => setMenu(menu === session.id ? null : session.id)}><MoreHorizontal size={15} /></button>{menu === session.id && sessionMenu(session, session.id)}</div>
            </div>)}{!groupSessions.length && <p className="empty-group">Drop a session here</p>}</div>}
          </section>;
        })}
        {!snapshot.groups.length && <p className="sidebar-empty">Create a group, or open a new tab.</p>}
      </div>
      <div className="sidebar-footer"><button className={view.kind === 'settings' ? 'active' : ''} onClick={() => setView({ kind: 'settings' })}><Settings2 size={16} /><span>Settings</span></button><div className="local-indicator"><span className="status-dot" /><span>{isDemo ? 'Design preview' : 'On this device'}</span>{pending > 0 && <Loader2 className="spin" size={12} />}</div></div>
    </aside>
    <main className="main">
      {isDemo && <div className="preview-banner">Browser preview · simulated sessions and output</div>}
      {error && <div role="alert" className="error-banner"><span>{error}</span><button onClick={() => retryRef.current?.()}>Retry</button><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      {selected && transport ? <>
        <header className="session-header"><div className="header-context"><span className="eyebrow">{workspaceName} <ChevronRight size={12} /> {providerNames[selected.provider]}</span><h1 title={selected.title}>{selected.title}</h1></div><div className="header-actions"><Status session={selected} text />{(selected.provider === 'claude' || selected.provider === 'codex') && <button className="icon-button" aria-label="Session model and effort" title="Agent settings" onClick={() => setDialog({ kind: 'session-settings', session: selected })}><Settings2 size={17} /></button>}<div className="menu-anchor" data-menu><button className="icon-button" aria-label="Session actions" onClick={() => setMenu(menu === 'header' ? null : 'header')}><MoreHorizontal size={19} /></button>{menu === 'header' && sessionMenu(selected, 'header')}</div></div></header>
        <div className="session-meta"><span><Folder size={12} />{selected.shellIntegrated ? selected.shellCwd || selected.cwd : selected.cwd}</span>{(selected.provider === 'claude' || selected.provider === 'codex') && <button onClick={() => setDialog({ kind: 'session-settings', session: selected })}>{selected.model || 'Provider default'}{selected.effort && <> · {selected.effort}</>}</button>}</div>
        {selected.error && <div className="session-alert" role="alert">{selected.error}</div>}
        {selected.kind === 'assistant' && <div className="assistant-context">{snapshot.notifications.filter(notification => notification.sessionId === selected.id).slice(-5).map(notification => <article key={notification.id}><div className="eyebrow">{notification.source} · {formatTime(notification.createdAt)}</div><h2>{notification.title}</h2><p>{notification.body}</p></article>)}</div>}
        {!live(selected) && <div className="session-stopped"><span>{selected.kind === 'assistant' ? 'This assistant is ready when you are.' : 'Your tab is saved. Open it when you’re ready.'}</span><button onClick={() => select(selected.id)}><Play size={13} />Restore tab</button></div>}
        <Terminal key={selected.id} sessionId={selected.id} transport={transport} generation={generations[selected.id] || 0} interactive={live(selected)} />
        <footer className="terminal-footer"><span><TerminalSquare size={12} />{providerNames[selected.provider]}</span><span>{modifierLabel} F <span className="footer-separator">Find</span> {modifierLabel} K <span className="footer-separator">Sessions</span></span></footer>
      </> : view.kind === 'inbox' ? <Panel icon={<Inbox size={18} />} title="Notifications" subtitle="Updates that stay until you dismiss them." action={notifications.length ? <span className="panel-count">{notifications.length} saved</span> : undefined}>
        {!notifications.length ? <Empty icon={<Bell size={26} />} title="You’re all caught up" body="Agent updates, reminders, and incoming events will appear here." /> : <div className="notification-list">{[...notifications].sort((a, b) => b.createdAt - a.createdAt).map(notification => <article className="notification-card" key={notification.id}><div className="notification-icon"><Bell size={17} /></div><div className="notification-content"><div className="eyebrow">{notification.source || 'Relay'}<span>·</span><time dateTime={new Date(notification.createdAt).toISOString()}>{formatTime(notification.createdAt)}</time></div><h2>{notification.title}</h2><p>{notification.body}</p><button className="text-button" onClick={() => void dispatch({ type: 'open_notification', id: notification.id }).then(next => { if (next.activeSessionId) setView({ kind: 'session', id: next.activeSessionId }); }).catch(ignore)}>Open session<ArrowRight size={13} /></button></div><button className="icon-button" aria-label={`Dismiss ${notification.title}`} title="Dismiss notification" onClick={() => void dispatch({ type: 'dismiss_notification', id: notification.id }).catch(ignore)}><X size={16} /></button></article>)}</div>}
      </Panel> : view.kind === 'rules' ? <Panel icon={<Zap size={18} />} title="Background rules" subtitle="Keep useful work moving while the window is closed." action={<button className="primary small" onClick={() => setDialog({ kind: 'rule' })}><Plus size={14} />New rule</button>}>
        {!snapshot.rules.length ? <Empty icon={<Zap size={26} />} title="A quiet place for recurring work" body="Add a reminder, a recurring notification, a command, or an incoming webhook." action={<button className="secondary" onClick={() => setDialog({ kind: 'rule' })}>Create your first rule</button>} /> : <div className="rule-list">{snapshot.rules.map(rule => <article key={rule.id} className="rule-card"><div className="rule-top"><div><div className="eyebrow">{ruleKind(rule)}{rule.enabled ? <span className="enabled-label">Enabled</span> : <span>Paused</span>}</div><h2>{rule.title}</h2></div><button className={`toggle ${rule.enabled ? 'on' : ''}`} role="switch" aria-checked={rule.enabled} aria-label={`Enable ${rule.title}`} onClick={() => void dispatch({ type: 'save_rule', rule: { ...rule, enabled: !rule.enabled } }).catch(ignore)}><span /></button></div><p className="rule-description">{rule.kind === 'command' ? `${rule.command} ${rule.args.join(' ')}` : rule.body || `Listen for events from ${rule.source}`}</p><div className="rule-bottom"><span>{rule.kind === 'webhook' ? `Source: ${rule.source}` : rule.nextRunAt ? `Next: ${formatTime(rule.nextRunAt)}` : 'No run scheduled'}{rule.lastRunAt && ` · Last: ${formatTime(rule.lastRunAt)}`}</span><div><button className="text-button" onClick={() => setDialog({ kind: 'rule', rule })}>Edit</button><button className="text-button" onClick={() => void dispatch({ type: 'run_rule', id: rule.id }).catch(ignore)}><Play size={12} />Run now</button><button className="icon-button" aria-label={`Delete ${rule.title}`} onClick={() => void dispatch({ type: 'delete_rule', id: rule.id }).catch(ignore)}><Trash2 size={14} /></button></div></div>{rule.lastError && <p className="rule-error" role="alert">{rule.lastError}</p>}</article>)}</div>}
      </Panel> : view.kind === 'settings' ? <Panel icon={<Settings2 size={18} />} title="Settings" subtitle="Your workspace, on your terms."><SettingsPanel snapshot={snapshot} dispatch={dispatch} /></Panel> : <div className="no-terminal"><TerminalSquare size={27} /><p>{sessions.length ? 'Choose a tab to restore its terminal.' : 'Open a terminal to get started.'}</p><button className="secondary" onClick={() => newTerminal()}><Plus size={14} />New tab</button><span><kbd>{modifierLabel} N</kbd></span></div>}
    </main>
    {dialog?.kind === 'rename' && <TextDialog title="Rename session" label="Session title" initial={dialog.session.title} close={closeDialog} save={title => dispatch({ type: 'update_session', id: dialog.session.id, title })} />}
    {dialog?.kind === 'session-settings' && <SessionSettings session={snapshot.sessions.find(session => session.id === dialog.session.id) || dialog.session} dispatch={dispatch} close={closeDialog} />}
    {dialog?.kind === 'rule' && <RuleEditor rule={dialog.rule} snapshot={snapshot} dispatch={dispatch} close={closeDialog} />}
    {dialog?.kind === 'search' && <SessionSearch sessions={sessions} groups={snapshot.groups} close={closeDialog} select={select} />}
  </div>;
}

function formatTime(time: number) { return new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function ruleKind(rule: Rule) { return rule.kind === 'interval' ? `Every ${rule.intervalMinutes} min` : rule.kind === 'reminder' ? 'One-time reminder' : rule.kind === 'command' ? `Command · every ${rule.intervalMinutes} min` : 'Incoming webhook'; }
function Panel({ icon, title, subtitle, action, children }: { icon: ReactNode; title: string; subtitle: string; action?: ReactNode; children: ReactNode }) {
  return <><header className="panel-header"><div><h1>{icon}{title}</h1><p>{subtitle}</p></div>{action}</header><div className="panel-body">{children}</div></>;
}
function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return <div className="panel-empty"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{body}</p>{action}</div>;
}
function Setup({ snapshot, dispatch, completed }: { snapshot: Snapshot; dispatch: Dispatch; completed: (id: string) => void }) {
  const [cwd, setCwd] = useState(snapshot.settings.defaultCwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!cwd.trim()) return; setBusy(true); setError('');
    try { const next = await dispatch({ type: 'complete_setup', cwd: cwd.trim() }); if (next.activeSessionId) completed(next.activeSessionId); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  return <div className="setup"><div className="setup-card"><div className="setup-brand"><span className="brand-mark"><Command size={22} /></span><span>Relay</span></div><h1>Choose your starting folder.</h1><p>Your terminals open here. You can move anywhere with <code>cd</code>.</p><form className="form" onSubmit={event => void submit(event)}><FolderField value={cwd} change={setCwd} required />{error && <p className="form-error" role="alert">{error}</p>}<button className="primary" disabled={busy || !cwd.trim()}>{busy ? 'Opening terminal…' : 'Open terminal'}<ArrowRight size={14} /></button></form><span className="setup-note">One setup. Then just your shell.</span></div></div>;
}
function GroupName({ group, dispatch }: { group: Group; dispatch: Dispatch }) {
  const [editing, setEditing] = useState(false); const [title, setTitle] = useState(group.title); const [busy, setBusy] = useState(false);
  const saving = useRef(false); const cancel = useRef(false); const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  const save = async () => {
    if (cancel.current || saving.current) return;
    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === group.title) { setEditing(false); return; }
    saving.current = true; setBusy(true);
    try { await dispatch({ type: 'update_group', id: group.id, title: nextTitle }); setEditing(false); }
    catch { input.current?.focus(); } finally { saving.current = false; setBusy(false); }
  };
  return editing ? <span className="group-name-editor"><input ref={input} aria-label="Group name" value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} onBlur={() => void save()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setEditing(false); } }} /></span> : <button className="group-name" aria-label={`Rename group ${group.title}`} title="Click to rename group" onClick={() => { cancel.current = false; setTitle(group.title); setEditing(true); }}>{group.title}</button>;
}
function SettingsPanel({ snapshot, dispatch }: { snapshot: Snapshot; dispatch: Dispatch }) {
  const [settings, setSettings] = useState<Settings>(snapshot.settings); const [busy, setBusy] = useState(false); const [saved, setSaved] = useState(false); const [error, setError] = useState('');
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => { setSettings(current => ({ ...current, [key]: value })); setSaved(false); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await dispatch({ type: 'settings', settings }); setSaved(true); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } };
  return <form className="settings-form form" onSubmit={event => void submit(event)}><section className="settings-section"><h2>New terminals</h2><FolderField value={settings.defaultCwd} change={value => update('defaultCwd', value)} /><label>Shell executable<input value={settings.shellExecutable} onChange={event => update('shellExecutable', event.target.value)} placeholder={snapshot.platform === 'windows' ? 'powershell.exe' : '/bin/zsh'} /></label><p className="form-help">Open a tab, use cd, and start claude, claude-code, or codex from your shell.</p></section><section className="settings-section"><h2>Workspace behavior</h2><p className="form-help">Saved tabs stay stopped until you open them. Each tab restores its own shell and identified conversation.</p><label className="setting-toggle"><span><strong>Keep running in the tray</strong><span>Closing the window keeps your terminals and rules running.</span></span><input type="checkbox" checked={settings.closeToTray} onChange={e => update('closeToTray', e.target.checked)} /></label></section><section className="settings-section"><h2>Local storage & integrations</h2><p className="form-help">Tabs, notifications, and rules are saved on this device.</p><label>Data folder<code className="settings-path">{snapshot.dataDir}</code></label><label>Local event endpoint<code className="settings-path">{snapshot.hookEndpoint}</code></label><p className="form-help">Agent hooks connect automatically. Local integrations can use the private connection.json file in the data folder.</p></section>{error && <p className="form-error" role="alert">{error}</p>}<footer>{saved && <span className="save-confirm"><Check size={14} />Saved</span>}<button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button></footer></form>;
}
function SessionSearch({ sessions, groups, close, select }: { sessions: Session[]; groups: Group[]; close: () => void; select: (id: string) => void }) {
  const [query, setQuery] = useState(''); const [index, setIndex] = useState(0);
  const found = sessions.filter(session => `${session.title} ${session.cwd} ${providerNames[session.provider]} ${groups.find(g => g.id === session.groupId)?.title || ''}`.toLowerCase().includes(query.toLowerCase()));
  const open = (id: string) => { select(id); close(); };
  return <Modal title="Find a session" close={close}><div className="search-input"><Search size={17} /><input autoFocus placeholder="Search titles, agents, or folders…" aria-label="Search sessions" value={query} onChange={e => { setQuery(e.target.value); setIndex(0); }} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(value => Math.min(value + 1, found.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(value => Math.max(0, value - 1)); } if (e.key === 'Enter' && found[index]) open(found[index].id); }} /></div><div className="search-results">{found.map((session, i) => <button key={session.id} className={i === index ? 'highlight' : ''} onMouseEnter={() => setIndex(i)} onClick={() => open(session.id)}><Status session={session} /><span><strong>{session.title}</strong><small>{groups.find(g => g.id === session.groupId)?.title} · {providerNames[session.provider]}</small></span><ArrowRight size={14} /></button>)}{!found.length && <p>No sessions match your search.</p>}</div><footer className="search-footer"><span>↑ ↓ to navigate</span><span>↵ to open</span><span>Esc to close</span></footer></Modal>;
}

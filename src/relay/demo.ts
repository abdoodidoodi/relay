// Browser preview only. Never imported by the native app or a normal browser launch.
import type { RelayTransport } from './api';
import type { Session, Snapshot } from './types';
const now = Date.now();
const session = (id: string, title: string, groupId: string, provider: Session['provider'], status: Session['status']): Session => ({
  id, title, groupId, provider, status, cwd: 'C:\\Projects\\workspace', model: '', effort: '', executable: '', args: [], providerSessionId: null,
  titleLocked: false, unread: status === 'ready', archived: false, createdAt: now, updatedAt: now, lastActivityAt: now, error: null, initialPrompt: '', kind: 'work',
});
let state: Snapshot = {
  version: 1, groups: [{ id: 'workspace', title: 'Workspace', collapsed: false }, { id: 'research', title: 'Research', collapsed: false }],
  sessions: [session('one', 'Refine the onboarding flow', 'workspace', 'claude', 'running'), session('two', 'Investigate the build failure', 'workspace', 'codex', 'ready'), session('three', 'Explore local-first sync', 'research', 'claude', 'idle')],
  notifications: [{ id: 'notification', title: 'Build investigation ready', body: 'The preview inbox demonstrates how an agent update stays available until you dismiss it.', source: 'codex', sessionId: 'two', createdAt: now - 180000, dismissed: false, dedupeKey: null }],
  rules: [{ id: 'rule', title: 'Daily project check-in', source: 'project-check', kind: 'interval', enabled: true, intervalMinutes: 1440, nextRunAt: now + 3600000, command: '', args: [], cwd: '', body: 'Review your active projects.', sessionId: null, lastRunAt: null, lastError: null }],
  settings: { autoResume: true, closeToTray: true, defaultCwd: 'C:\\Projects\\workspace', defaultProvider: 'claude' }, activeSessionId: 'one', dataDir: 'Preview only', hookEndpoint: 'Preview only', platform: 'windows',
};
const callbacks = new Set<(state: Snapshot) => void>();
const copy = () => structuredClone(state);
export const demo: RelayTransport = {
  snapshot: async () => copy(), onState: async callback => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
  onOutput: async () => () => {},
  attach: async () => ({ sequence: 0, data: Array.from(new TextEncoder().encode('\x1b[38;2;159;193;175mRelay · browser preview\x1b[0m\r\n\r\nThis is an isolated design preview.\r\nLive agent output appears here in the desktop app.\r\n')) }),
  write: async () => {}, resize: async () => {},
  action: async action => {
    switch (action.type) {
      case 'create_group': state.groups.push({ id: crypto.randomUUID(), title: action.title, collapsed: false }); break;
      case 'update_group': state.groups = state.groups.map(g => g.id === action.id ? { ...g, ...action } : g); break;
      case 'delete_group': state.groups = state.groups.filter(g => g.id !== action.id); break;
      case 'create_session': { const s = { ...session(crypto.randomUUID(), action.session.title || 'New session', action.session.groupId, action.session.provider, 'stopped'), ...action.session }; state.sessions.push(s); state.activeSessionId = s.id; break; }
      case 'update_session': state.sessions = state.sessions.map(s => s.id === action.id ? { ...s, ...action, titleLocked: action.title === undefined ? s.titleLocked : true } : s); break;
      case 'move_session': { const i = state.sessions.findIndex(s => s.id === action.id); const [s] = state.sessions.splice(i, 1); if (s) { s.groupId = action.groupId; const before = state.sessions.findIndex(s => s.id === action.beforeId); state.sessions.splice(before < 0 ? state.sessions.length : before, 0, s); } break; }
      case 'select_session': state.activeSessionId = action.id; state.sessions = state.sessions.map(s => s.id === action.id ? { ...s, unread: false } : s); break;
      case 'start_session': state.sessions = state.sessions.map(s => s.id === action.id ? { ...s, status: 'running' } : s); break;
      case 'stop_session': state.sessions = state.sessions.map(s => s.id === action.id ? { ...s, status: 'stopped' } : s); break;
      case 'archive_session': state.sessions = state.sessions.map(s => s.id === action.id ? { ...s, archived: true } : s); state.activeSessionId = null; break;
      case 'dismiss_notification': state.notifications = state.notifications.map(n => n.id === action.id ? { ...n, dismissed: true } : n); break;
      case 'open_notification': state.activeSessionId = state.notifications.find(n => n.id === action.id)?.sessionId || null; break;
      case 'settings': state.settings = action.settings; break;
      case 'save_rule': state.rules = [...state.rules.filter(r => r.id !== action.rule.id), action.rule]; break;
      case 'delete_rule': state.rules = state.rules.filter(r => r.id !== action.id); break;
      case 'run_rule': { const rule = state.rules.find(r => r.id === action.id); if (rule) { rule.lastRunAt = Date.now(); state.notifications.unshift({ id: crypto.randomUUID(), title: rule.title, body: rule.body, source: rule.source, sessionId: rule.sessionId || '', createdAt: Date.now(), dismissed: false, dedupeKey: null }); } break; }
    }
    state.version += 1;
    callbacks.forEach(callback => callback(copy())); return copy();
  },
};

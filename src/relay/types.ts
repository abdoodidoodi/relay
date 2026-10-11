export type Provider = 'claude' | 'codex' | 'shell' | 'custom';
export type SessionStatus = 'starting' | 'running' | 'ready' | 'idle' | 'stopped' | 'error';
export interface Group { id: string; title: string; collapsed: boolean; }
export interface Session {
  id: string; groupId: string; title: string; titleLocked: boolean;
  provider: Provider; cwd: string; model: string; effort: string;
  executable: string; args: string[]; providerSessionId: string | null;
  status: SessionStatus; unread: boolean; archived: boolean;
  createdAt: number; updatedAt: number; lastActivityAt: number;
  error: string | null; initialPrompt: string; kind: 'work' | 'assistant';
}
export interface Notification {
  id: string; title: string; body: string; source: string;
  sessionId: string; createdAt: number; dismissed: boolean; dedupeKey: string | null;
}
export interface Rule {
  id: string; title: string; source: string; kind: 'interval' | 'reminder' | 'command' | 'webhook';
  enabled: boolean; intervalMinutes: number; nextRunAt: number | null;
  command: string; args: string[]; cwd: string; body: string;
  sessionId: string | null; lastRunAt: number | null; lastError: string | null;
}
export interface Settings { autoResume: boolean; closeToTray: boolean; defaultCwd: string; defaultProvider: Provider; }
export interface Snapshot {
  version: number; groups: Group[]; sessions: Session[]; notifications: Notification[];
  rules: Rule[]; settings: Settings; activeSessionId: string | null;
  dataDir: string; hookEndpoint: string; platform: string;
}
export interface CreateSession {
  groupId: string; provider: Provider; cwd: string; title?: string; model?: string;
  effort?: string; executable?: string; args?: string[]; initialPrompt?: string;
  kind?: 'work' | 'assistant'; providerSessionId?: string;
}
export type Action =
  | { type: 'create_group'; title: string }
  | { type: 'update_group'; id: string; title?: string; collapsed?: boolean }
  | { type: 'delete_group'; id: string }
  | { type: 'create_session'; session: CreateSession }
  | { type: 'update_session'; id: string; title?: string; model?: string; effort?: string; providerSessionId?: string }
  | { type: 'move_session'; id: string; groupId: string; beforeId?: string }
  | { type: 'start_session'; id: string }
  | { type: 'stop_session'; id: string }
  | { type: 'archive_session'; id: string }
  | { type: 'select_session'; id: string }
  | { type: 'dismiss_notification'; id: string }
  | { type: 'open_notification'; id: string }
  | { type: 'save_rule'; rule: Rule }
  | { type: 'delete_rule'; id: string }
  | { type: 'run_rule'; id: string }
  | { type: 'settings'; settings: Settings };
export interface TerminalOutput { sessionId: string; sequence: number; data: number[]; }
export interface TerminalReplay { sequence: number; data: number[]; }

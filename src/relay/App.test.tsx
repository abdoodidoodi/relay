import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Snapshot } from './types';

const mock = vi.hoisted(() => ({ getTransport: vi.fn() }));
vi.mock('./api', () => ({ getTransport: mock.getTransport, errorText: (e: unknown) => e instanceof Error ? e.message : String(e), isNative: false, isDemo: false }));
vi.mock('./Terminal', () => ({ default: ({ sessionId }: { sessionId: string }) => <div data-testid="terminal">{sessionId}</div> }));
import App from './App';

function initial(): Snapshot {
  const base = { titleLocked: false, provider: 'codex' as const, cwd: 'C:\\work', model: '', effort: '', executable: '', args: [], providerSessionId: 'opaque-thread-id', status: 'ready' as const, unread: true, archived: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1, error: null, initialPrompt: '', kind: 'work' as const, groupId: 'g' };
  return { version: 1, groups: [{ id: 'g', title: 'Projects', collapsed: false }], sessions: [{ ...base, id: 'one', title: 'First task' }, { ...base, id: 'two', title: 'Second task' }], notifications: [{ id: 'n', title: 'Useful update', body: 'Keep me until I am dismissed.', source: 'test', sessionId: 'two', createdAt: 1, dismissed: false, dedupeKey: null }], rules: [], settings: { autoResume: true, closeToTray: true, defaultCwd: 'C:\\work', defaultProvider: 'codex' }, activeSessionId: 'one', dataDir: 'C:\\relay-data', hookEndpoint: 'http://127.0.0.1:9000/events', platform: 'windows' };
}

describe('Relay workspace actions', () => {
  let state: Snapshot;
  let notify: (next: Snapshot) => void;
  let action: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    state = initial(); notify = () => {};
    action = vi.fn(async (next: Action) => {
      if (next.type === 'open_notification') state = { ...state, activeSessionId: 'two' };
      if (next.type === 'dismiss_notification') state = { ...state, notifications: state.notifications.map(n => ({ ...n, dismissed: true })) };
      if (next.type === 'select_session') state = { ...state, activeSessionId: next.id };
      if (next.type === 'update_session') state = { ...state, sessions: state.sessions.map(s => s.id === next.id ? { ...s, ...next } : s) };
      return state;
    });
    mock.getTransport.mockResolvedValue({ snapshot: async () => state, action, onState: async (callback: (snapshot: Snapshot) => void) => { notify = callback; return () => {}; }, onOutput: async () => () => {} });
  });
  afterEach(cleanup);

  it('restores the persisted active session under React StrictMode', async () => {
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(screen.getByTestId('terminal').textContent).toBe('one'));
    expect(screen.getByRole('heading', { name: 'First task' })).toBeTruthy();
    expect(screen.queryByText('Room for your next idea.')).toBeNull();
  });

  it('opening a notification selects its own tab and keeps it until explicit dismissal', async () => {
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    await waitFor(() => expect(screen.getByTestId('terminal').textContent).toBe('two'));
    expect(state.notifications[0].dismissed).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(screen.getByText('Keep me until I am dismissed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Useful update' }));
    await screen.findByText('You’re all caught up');
    expect(action).toHaveBeenCalledWith({ type: 'dismiss_notification', id: 'n' });
  });

  it('background state events preserve the panel being read and gracefully remove archived selections', async () => {
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    act(() => notify({ ...state, activeSessionId: 'two' }));
    expect(screen.queryByTestId('terminal')).toBeNull();
    expect(screen.getByText('Keep me until I am dismissed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Ready for you First task/ }));
    await waitFor(() => expect(screen.getByTestId('terminal').textContent).toBe('one'));
    act(() => notify({ ...state, activeSessionId: 'two', sessions: state.sessions.map(s => s.id === 'one' ? { ...s, archived: true } : s) }));
    await waitFor(() => expect(screen.getByTestId('terminal').textContent).toBe('two'));
  });

  it('persists edited model and effort through the native action contract', async () => {
    state.sessions[0].status = 'stopped';
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Session model and effort' }));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'my-agent-model' } });
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(action).toHaveBeenCalledWith({ type: 'update_session', id: 'one', model: 'my-agent-model', effort: 'high' });
    expect(screen.getByRole('button', { name: 'my-agent-model · high' })).toBeTruthy();
  });

  it('shows authoritative live settings and prevents editing until the session stops', async () => {
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Session model and effort' }));
    expect((screen.getByLabelText('Model') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Reasoning effort') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Provider conversation ID') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Use the agent’s model controls, or stop this session to change launch settings.')).toBeTruthy();
    fireEvent.submit(screen.getByRole('button', { name: 'Save settings' }).closest('form')!);
    expect(action).not.toHaveBeenCalled();
    act(() => notify({ ...state, version: 2, sessions: state.sessions.map(session => session.id === 'one' ? { ...session, model: 'agent-selected-model', effort: 'max' } : session) }));
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('agent-selected-model');
    act(() => notify({ ...state, version: 3, sessions: state.sessions.map(session => session.id === 'one' ? { ...session, status: 'stopped', model: 'agent-selected-model', effort: 'max' } : session) }));
    expect((screen.getByLabelText('Model') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('binds a stopped tab to the exact existing provider conversation ID for manual recovery', async () => {
    state.sessions[0].status = 'stopped'; state.sessions[0].providerSessionId = null;
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Session model and effort' }));
    const id = '774953ab-8501-4ea7-a4e7-a930f62e1ce5';
    fireEvent.change(screen.getByLabelText('Provider conversation ID'), { target: { value: ` ${id} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(action).toHaveBeenCalledWith({ type: 'update_session', id: 'one', model: '', effort: '', providerSessionId: id }));
    expect(state.sessions[0].providerSessionId).toBe(id);
  });

  it('does not clear an existing conversation binding with an empty manual edit', async () => {
    state.sessions[0].status = 'error';
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Session model and effort' }));
    fireEvent.change(screen.getByLabelText('Provider conversation ID'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByText('Enter an existing conversation ID from this provider.')).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
    expect(state.sessions[0].providerSessionId).toBe('opaque-thread-id');
  });

  it('uses native Command shortcut labels on macOS', async () => {
    state.platform = 'macos';
    render(<App />); await screen.findByTestId('terminal');
    expect(screen.getByRole('button', { name: 'New session Cmd N' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search sessions' }).getAttribute('title')).toBe('Search sessions · Cmd+K');
    expect(screen.getByText(/Cmd F/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Relay' }));
    expect(screen.getByText('Cmd K')).toBeTruthy();
    expect(screen.queryByText(/Ctrl/)).toBeNull();
  });

  it('shows native failures and retries the exact failed mutation', async () => {
    render(<App />); await screen.findByTestId('terminal');
    action.mockRejectedValueOnce(new Error('Database temporarily unavailable'));
    fireEvent.click(screen.getByRole('button', { name: /^Ready for you Second task/ }));
    await screen.findByText('Database temporarily unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action.mock.calls[1][0]).toEqual({ type: 'select_session', id: 'two' });
    await waitFor(() => expect(screen.queryByText('Database temporarily unavailable')).toBeNull());
  });

  it('does not replace a newer committed state with a delayed older snapshot', async () => {
    render(<App />); await screen.findByTestId('terminal');
    act(() => notify({ ...state, version: 3, sessions: state.sessions.map(session => session.id === 'one' ? { ...session, title: 'Latest committed title' } : session) }));
    expect(screen.getByRole('heading', { name: 'Latest committed title' })).toBeTruthy();
    act(() => notify({ ...state, version: 2 }));
    expect(screen.getByRole('heading', { name: 'Latest committed title' })).toBeTruthy();
  });

  it('schedules a new recurring rule using the chosen interval rather than the initial default', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000000);
    try {
      render(<App />); await screen.findByTestId('terminal');
      fireEvent.click(screen.getByRole('button', { name: 'Background rules' }));
      fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Check my project' } });
      fireEvent.change(screen.getByLabelText('Every (minutes)'), { target: { value: '1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
      await waitFor(() => expect(action).toHaveBeenCalledWith(expect.objectContaining({ type: 'save_rule', rule: expect.objectContaining({ intervalMinutes: 1, nextRunAt: 1060000 }) })));
    } finally { clock.mockRestore(); }
  });
});

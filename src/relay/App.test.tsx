import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, Snapshot } from './types';

const mock = vi.hoisted(() => ({ getTransport: vi.fn() }));
vi.mock('./api', () => ({ getTransport: mock.getTransport, errorText: (e: unknown) => e instanceof Error ? e.message : String(e), isNative: false, isDemo: false }));
vi.mock('./Terminal', () => ({ default: ({ sessionId }: { sessionId: string }) => <div data-testid="terminal">{sessionId}</div> }));
import App from './App';

function initial(): Snapshot {
  const base = { titleLocked: false, provider: 'codex' as const, cwd: 'C:\\work', model: '', effort: '', executable: '', args: [], providerSessionId: 'opaque-thread-id', status: 'ready' as const, unread: true, archived: false, createdAt: 1, updatedAt: 1, lastActivityAt: 1, error: null, initialPrompt: '', kind: 'work' as const, groupId: 'g', shellIntegrated: true, shellCwd: 'C:\\work' };
  return { version: 1, groups: [{ id: 'g', title: 'Projects', collapsed: false }], sessions: [{ ...base, id: 'one', title: 'First task' }, { ...base, id: 'two', title: 'Second task' }], notifications: [{ id: 'n', title: 'Useful update', body: 'Keep me until I am dismissed.', source: 'test', sessionId: 'two', createdAt: 1, dismissed: false, dedupeKey: null }], rules: [], settings: { autoResume: false, closeToTray: true, defaultCwd: 'C:\\work', defaultProvider: 'shell', setupComplete: true, shellExecutable: 'powershell.exe' }, activeSessionId: 'one', dataDir: 'C:\\relay-data', hookEndpoint: 'http://127.0.0.1:9000/events', platform: 'windows' };
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
      if (next.type === 'select_session') state = { ...state, activeSessionId: next.id, sessions: state.sessions.map(session => session.id === next.id && session.status === 'stopped' ? { ...session, status: 'idle' } : session) };
      if (next.type === 'update_session') state = { ...state, sessions: state.sessions.map(s => s.id === next.id ? { ...s, ...next } : s) };
      if (next.type === 'update_group') state = { ...state, groups: state.groups.map(group => group.id === next.id ? { ...group, ...next } : group) };
      if (next.type === 'new_terminal' || next.type === 'complete_setup') {
        const sample = initial().sessions[0];
        const cwd = next.type === 'complete_setup' ? next.cwd : state.settings.defaultCwd;
        const terminal = { ...sample, id: `terminal-${state.sessions.length + 1}`, title: `Terminal ${state.sessions.length + 1}`, provider: 'shell' as const, status: 'idle' as const, unread: false, groupId: next.type === 'new_terminal' ? next.groupId || state.groups[0].id : state.groups[0].id, cwd, shellCwd: cwd, model: '', effort: '', providerSessionId: null };
        state = { ...state, activeSessionId: terminal.id, sessions: [...state.sessions, terminal], settings: next.type === 'complete_setup' ? { ...state.settings, setupComplete: true, defaultCwd: next.cwd } : state.settings };
      }
      return state;
    });
    mock.getTransport.mockResolvedValue({ snapshot: async () => state, action, onState: async (callback: (snapshot: Snapshot) => void) => { notify = callback; return () => {}; }, onOutput: async () => () => {} });
  });
  afterEach(cleanup);

  it('asks only for a folder once, then immediately shows the normal shell', async () => {
    state = { ...state, sessions: [], activeSessionId: null, notifications: [], groups: [{ id: 'g', title: 'Group 1', collapsed: false }], settings: { ...state.settings, setupComplete: false } };
    const rendered = render(<StrictMode><App /></StrictMode>);
    await screen.findByRole('heading', { name: 'Choose your starting folder.' });
    expect(screen.queryByLabelText('Agent')).toBeNull();
    expect(screen.queryByLabelText('Model')).toBeNull();
    fireEvent.change(screen.getByLabelText('Working folder'), { target: { value: 'D:\\project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    await waitFor(() => expect(screen.getByTestId('terminal').textContent).toBe('terminal-1'));
    expect(action).toHaveBeenCalledWith({ type: 'complete_setup', cwd: 'D:\\project' });
    expect(screen.getByRole('button', { name: 'Rename group Group 1' })).toBeTruthy();
    expect(state.sessions[0].provider).toBe('shell');
    expect(screen.queryByRole('dialog')).toBeNull();
    rendered.unmount(); render(<StrictMode><App /></StrictMode>);
    await screen.findByTestId('terminal');
    expect(screen.queryByText('Choose your starting folder.')).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('creates default shell tabs immediately from plus and the new-tab shortcut without a creation dialog', async () => {
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: 'New tab in Projects' }));
    await waitFor(() => expect(screen.getByTestId('terminal').textContent).toBe('terminal-3'));
    expect(action).toHaveBeenCalledWith({ type: 'new_terminal', groupId: 'g' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('Agent')).toBeNull();
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('terminal').textContent).toBe('terminal-4'));
    expect(action.mock.calls.every(([mutation]) => mutation.type === 'new_terminal')).toBe(true);
    expect(state.sessions.slice(-2).every(session => session.provider === 'shell' && session.model === '')).toBe(true);
  });

  it('does not start restored tabs until one is clicked, then selects only that tab', async () => {
    state.sessions = state.sessions.map(session => ({ ...session, status: 'stopped' }));
    render(<StrictMode><App /></StrictMode>); await screen.findByTestId('terminal');
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Restore tab' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Stopped Second task/ }));
    await waitFor(() => expect(state.sessions[1].status).toBe('idle'));
    expect(state.sessions[0].status).toBe('stopped');
    expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'select_session', id: 'two' });
    expect(screen.getByTestId('terminal').textContent).toBe('two');
  });

  it('renames groups inline without collapsing them and keeps the chevron independent', async () => {
    render(<App />); await screen.findByTestId('terminal');
    fireEvent.click(screen.getByRole('button', { name: 'Rename group Projects' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: '  My project  ' } });
    fireEvent.keyDown(screen.getByLabelText('Group name'), { key: 'Enter' });
    await screen.findByRole('button', { name: 'Rename group My project' });
    expect(action).toHaveBeenCalledExactlyOnceWith({ type: 'update_group', id: 'g', title: 'My project' });
    expect(state.groups[0].collapsed).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse My project' }));
    await screen.findByRole('button', { name: 'Expand My project' });
    expect(action).toHaveBeenLastCalledWith({ type: 'update_group', id: 'g', collapsed: true });
  });

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
    expect(screen.getByRole('button', { name: 'New tab Cmd N' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Search sessions' }).getAttribute('title')).toBe('Search sessions · Cmd+K');
    expect(screen.getByText(/Cmd F/)).toBeTruthy();
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

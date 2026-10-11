import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Action, Snapshot, TerminalOutput, TerminalReplay } from './types';

export interface RelayTransport {
  snapshot(): Promise<Snapshot>;
  action(action: Action): Promise<Snapshot>;
  onState(callback: (state: Snapshot) => void): Promise<() => void>;
  onOutput(callback: (output: TerminalOutput) => void): Promise<() => void>;
  attach(sessionId: string): Promise<TerminalReplay>;
  write(sessionId: string, data: number[]): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
}
export const isNative = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const isDemo = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
const native: RelayTransport = {
  snapshot: () => invoke('relay_snapshot'),
  action: action => invoke('relay_action', { action }),
  onState: callback => listen<Snapshot>('relay-state', event => callback(event.payload)),
  onOutput: callback => listen<TerminalOutput>('relay-output', event => callback(event.payload)),
  attach: sessionId => invoke('relay_attach', { sessionId }),
  write: (sessionId, data) => invoke('relay_write', { sessionId, data }),
  resize: (sessionId, cols, rows) => invoke('relay_resize', { sessionId, cols, rows }),
};
export async function getTransport(): Promise<RelayTransport> {
  if (isNative) return native;
  if (isDemo) return (await import('./demo')).demo;
  throw new Error('Relay needs its desktop runtime to manage local terminals. Launch the installed Relay application.');
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

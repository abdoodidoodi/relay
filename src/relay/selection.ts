import type { Snapshot } from './types';
export type View = { kind: 'session'; id: string } | { kind: 'inbox' } | { kind: 'rules' } | { kind: 'settings' } | { kind: 'home' };
export function reconcileView(view: View, snapshot: Snapshot): View {
  if (view.kind === 'session' && !snapshot.sessions.some(session => session.id === view.id && !session.archived)) {
    const next = snapshot.sessions.find(session => session.id === snapshot.activeSessionId && !session.archived);
    return next ? { kind: 'session', id: next.id } : { kind: 'home' };
  }
  return view;
}

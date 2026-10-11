import { describe, expect, it } from 'vitest';
import { ReplayGate } from './replay';

describe('terminal attachment reconciliation', () => {
  it('writes replay once and only output newer than its sequence', () => {
    const written: number[][] = [];
    const gate = new ReplayGate('one', data => written.push(data));
    gate.output({ sessionId: 'one', sequence: 4, data: [4] });
    gate.output({ sessionId: 'one', sequence: 3, data: [3] });
    gate.output({ sessionId: 'one', sequence: 2, data: [2] });
    expect(written).toEqual([]);
    gate.replay({ sequence: 3, data: [1, 2, 3] });
    gate.output({ sessionId: 'one', sequence: 4, data: [4] });
    gate.output({ sessionId: 'one', sequence: 5, data: [5] });
    expect(written).toEqual([[1, 2, 3], [4], [5]]);
  });
  it('isolates session output and suppresses late writes after teardown', () => {
    const written: number[][] = [];
    const gate = new ReplayGate('one', data => written.push(data));
    gate.output({ sessionId: 'two', sequence: 8, data: [8] });
    gate.output({ sessionId: 'one', sequence: 9, data: [9] });
    gate.dispose();
    gate.replay({ sequence: 0, data: [0] });
    gate.output({ sessionId: 'one', sequence: 10, data: [10] });
    expect(written).toEqual([]);
  });
  it('accepts a fresh gate for a restarted process whose counter reset', () => {
    const written: number[][] = [];
    const old = new ReplayGate('one', data => written.push(data));
    old.replay({ sequence: 100, data: [100] }); old.dispose();
    const restarted = new ReplayGate('one', data => written.push(data));
    restarted.output({ sessionId: 'one', sequence: 2, data: [2] });
    restarted.replay({ sequence: 1, data: [1] });
    expect(written).toEqual([[100], [1], [2]]);
  });
});

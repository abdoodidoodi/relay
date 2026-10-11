import type { TerminalOutput, TerminalReplay } from './types';

/** Establish an output listener before attach, then reconcile overlapping replay. */
export class ReplayGate {
  private pending: TerminalOutput[] = [];
  private attached = false;
  private sequence = -1;
  private disposed = false;
  constructor(private readonly sessionId: string, private readonly write: (data: number[]) => void) {}
  output(output: TerminalOutput) {
    if (this.disposed || output.sessionId !== this.sessionId) return;
    if (!this.attached) { this.pending.push(output); return; }
    this.accept(output);
  }
  replay(replay: TerminalReplay) {
    if (this.disposed || this.attached) return;
    if (replay.data.length) this.write(replay.data);
    this.sequence = replay.sequence;
    this.attached = true;
    this.pending.sort((a, b) => a.sequence - b.sequence).forEach(output => this.accept(output));
    this.pending = [];
  }
  private accept(output: TerminalOutput) {
    if (output.sequence <= this.sequence) return;
    this.sequence = output.sequence;
    this.write(output.data);
  }
  dispose() { this.disposed = true; this.pending = []; }
}

import type { LogLine } from '../../shared/types';

/** Where LogStore publishes each line (injected, so tests spy / prod -> LOG_LINE). */
export interface LogEmitter {
  emitLine(line: LogLine): void;
}

const DEFAULT_CAP = 5000;

/**
 * Best-effort level token regex (Spring/Logback/npm friendly). Matches the level
 * word ANYWHERE in the line (not head-anchored), so prose containing "error" can
 * false-match — an intentionally cheap filter aid, not authoritative parsing.
 */
const LEVEL_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

/** One worktree's independent ring + split state. */
interface Partition {
  buffer: LogLine[];
  seq: number;
  carry: Record<'stdout' | 'stderr', string>;
}

/**
 * In-memory bounded ring buffer of LogLine, PARTITIONED per worktree (V2 parallel
 * servers). One instance owns a Map<worktreeId, Partition> (implicit-create), so N
 * worktrees each run a concurrent server with an independent buffer + monotonic seq
 * + partial-line carry, capped at DEFAULT_CAP lines EACH. Splits chunked
 * stdout/stderr into lines (carrying partials across chunks), best-effort parses a
 * level, stamps every line with its worktreeId, and emits via the injected
 * LogEmitter. No file persistence in MVP — in-memory only.
 */
export class LogStore {
  private readonly emitter: LogEmitter;
  private readonly cap: number;
  private readonly partitions = new Map<string, Partition>();

  constructor(emitter: LogEmitter, cap: number = DEFAULT_CAP) {
    this.emitter = emitter;
    this.cap = cap;
  }

  /** Returns the worktree's partition, creating an empty one on first touch. */
  private partition(worktreeId: string): Partition {
    let p = this.partitions.get(worktreeId);
    if (!p) {
      p = { buffer: [], seq: 0, carry: { stdout: '', stderr: '' } };
      this.partitions.set(worktreeId, p);
    }
    return p;
  }

  /** Feeds a raw chunk for one worktree; emits a LogLine per COMPLETE line. */
  append(worktreeId: string, stream: 'stdout' | 'stderr', chunk: string): void {
    const p = this.partition(worktreeId);
    const combined = p.carry[stream] + chunk;
    const parts = combined.split('\n');
    p.carry[stream] = parts.pop() ?? '';
    for (const part of parts) {
      this.push(worktreeId, p, stream, part.endsWith('\r') ? part.slice(0, -1) : part);
    }
  }

  /** Emits one worktree's buffered partials (call on its process exit). */
  flush(worktreeId: string): void {
    const p = this.partition(worktreeId);
    for (const stream of ['stdout', 'stderr'] as const) {
      const partial = p.carry[stream];
      p.carry[stream] = '';
      if (partial.length > 0) this.push(worktreeId, p, stream, partial);
    }
  }

  /** Shallow copy of one worktree's ring (newest last); [] if unseen. */
  snapshot(worktreeId: string): LogLine[] {
    return [...(this.partitions.get(worktreeId)?.buffer ?? [])];
  }

  /** Clears ONE worktree's buffer, partials, and seq for a NEW run. */
  reset(worktreeId: string): void {
    this.partitions.set(worktreeId, { buffer: [], seq: 0, carry: { stdout: '', stderr: '' } });
  }

  /** Drops a worktree's partition entirely (e.g. on worktree removal). */
  removeWorktree(worktreeId: string): void {
    this.partitions.delete(worktreeId);
  }

  private push(worktreeId: string, p: Partition, stream: 'stdout' | 'stderr', text: string): void {
    const line: LogLine = {
      worktreeId,
      seq: p.seq++,
      ts: Date.now(),
      stream,
      level: this.parseLevel(stream, text),
      text,
    };
    p.buffer.push(line);
    if (p.buffer.length > this.cap) p.buffer.shift();
    this.emitter.emitLine(line);
  }

  private parseLevel(stream: 'stdout' | 'stderr', text: string): LogLine['level'] {
    const m = LEVEL_RE.exec(text);
    if (m) {
      const token = m[1].toUpperCase();
      if (token === 'ERROR') return 'error';
      if (token === 'WARN' || token === 'WARNING') return 'warn';
      if (token === 'INFO') return 'info';
      return 'debug'; // DEBUG | TRACE
    }
    // stderr without a level token is almost always an error/stack trace.
    return stream === 'stderr' ? 'error' : 'raw';
  }
}

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

/**
 * In-memory bounded ring buffer of LogLine for ONE server run. Splits chunked
 * stdout/stderr into lines (carrying partials across chunks), best-effort parses
 * a level, assigns a monotonic per-run seq, drops oldest past the cap, and emits
 * every line via the injected LogEmitter. No file persistence in MVP — in-memory
 * only (keeps src/shared pure; a file sink is optional/deferred to a later plan).
 */
export class LogStore {
  private readonly emitter: LogEmitter;
  private readonly cap: number;
  private worktreeId = '';
  private buffer: LogLine[] = [];
  private seq = 0;
  private carry: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

  constructor(emitter: LogEmitter, cap: number = DEFAULT_CAP) {
    this.emitter = emitter;
    this.cap = cap;
  }

  /** Feeds a raw chunk for a worktree; emits a LogLine per COMPLETE line. */
  append(worktreeId: string, stream: 'stdout' | 'stderr', chunk: string): void {
    this.worktreeId = worktreeId;
    const combined = this.carry[stream] + chunk;
    const parts = combined.split('\n');
    this.carry[stream] = parts.pop() ?? '';
    for (const part of parts) {
      this.push(stream, part.endsWith('\r') ? part.slice(0, -1) : part);
    }
  }

  /** Emits any buffered partials (call on process exit so the last line survives). */
  flush(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const partial = this.carry[stream];
      this.carry[stream] = '';
      if (partial.length > 0) this.push(stream, partial);
    }
  }

  /** Returns a shallow copy of the current ring (newest last). */
  snapshot(): LogLine[] {
    return [...this.buffer];
  }

  /** Clears the buffer, partials, and seq for a NEW run. */
  reset(worktreeId: string): void {
    this.worktreeId = worktreeId;
    this.buffer = [];
    this.seq = 0;
    this.carry = { stdout: '', stderr: '' };
  }

  private push(stream: 'stdout' | 'stderr', text: string): void {
    const line: LogLine = {
      worktreeId: this.worktreeId,
      seq: this.seq++,
      ts: Date.now(),
      stream,
      level: this.parseLevel(stream, text),
      text,
    };
    this.buffer.push(line);
    if (this.buffer.length > this.cap) this.buffer.shift();
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

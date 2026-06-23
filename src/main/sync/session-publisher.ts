import type { CrossMachineSessionPointer } from '../../shared/types';
import type { MachineIdentity } from './machine-identity';

/** One live local session reduced to what a pointer needs. */
export interface LiveSession {
  readonly branch: string;
  readonly hasActiveTurn: boolean;
}

/**
 * Maps THIS machine's currently-live sessions to publishable pointers. A live session
 * is `running` while a turn is in flight, else `idle`; an ENDED session is simply
 * absent from this list (and therefore from the machine's published file), which is
 * how "ended" is represented to other machines — no explicit tombstone needed.
 */
export function buildPointers(
  sessions: readonly LiveSession[],
  identity: MachineIdentity,
  now: number,
): CrossMachineSessionPointer[] {
  return sessions.map((s) => ({
    branch: s.branch,
    status: s.hasActiveTurn ? 'running' : 'idle',
    hasActiveTurn: s.hasActiveTurn,
    machineId: identity.machineId,
    machineLabel: identity.machineLabel,
    updatedAt: now,
  }));
}

/** Injected effects for the publisher (so the gate + coalescing are unit-testable). */
export interface SessionPublisherDeps {
  /** True iff cross-machine sync is opted in (settings.crossMachineSessions === 'on'). */
  readonly isEnabled: () => boolean;
  /** This machine's stable identity. */
  readonly identity: () => MachineIdentity;
  /** This machine's currently-live sessions (branch + turn state). */
  readonly liveSessions: () => Promise<LiveSession[]>;
  /** Publishes the pointers (SessionRefSync.publish). */
  readonly publish: (machineId: string, pointers: CrossMachineSessionPointer[]) => Promise<boolean>;
  /** Clock for pointer timestamps. */
  readonly now: () => number;
  /** Optional sink for best-effort failures (default: swallow). */
  readonly onError?: (error: unknown) => void;
}

/**
 * Publishes this machine's session pointers on each lifecycle change (spawn / kill /
 * exit), gated on opt-in. BEST-EFFORT: a publish failure never propagates (sync is a
 * convenience, never on the critical path). Concurrent notifications COALESCE — a
 * change arriving mid-publish sets a dirty flag and triggers exactly one more publish
 * when the in-flight one finishes, so a burst of events yields at most one extra
 * round-trip (no overlapping pushes, no unbounded fan-out, no timers).
 */
export class SessionPublisher {
  private running = false;
  private dirty = false;

  constructor(private readonly deps: SessionPublisherDeps) {}

  /** Signals that the live-session set may have changed. No-op when opted out. */
  notifyChanged(): void {
    if (!this.deps.isEnabled()) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      do {
        this.dirty = false;
        // Re-check the gate each loop: the user may have toggled sync off mid-burst.
        if (!this.deps.isEnabled()) break;
        const sessions = await this.deps.liveSessions();
        const identity = this.deps.identity();
        const pointers = buildPointers(sessions, identity, this.deps.now());
        await this.deps.publish(identity.machineId, pointers);
      } while (this.dirty);
    } catch (error) {
      this.deps.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}

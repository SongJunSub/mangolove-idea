import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { useSession } from '../../hooks/use-session';

/** Max serialized scrollback lines captured per persist (bounds buffer size). */
const SERIALIZE_SCROLLBACK_LINES = 1000;
/** Min interval between throttled persists (ms). A crash loses at most this much screen. */
const PERSIST_THROTTLE_MS = 1500;

/** Props for the embedded agent terminal (one per selected worktree). */
export interface AgentTerminalProps {
  /** The worktree whose `claude` PTY this terminal is bound to. */
  readonly worktreeId: string;
  /** When true, spawn `claude --continue` to rehydrate (b-lite restart, MVP item 6). */
  readonly continueSession?: boolean;
}

/**
 * Embedded xterm.js terminal bound to a worktree's claude PTY. On mount it builds a
 * Terminal + FitAddon + SerializeAddon, REPLAYS the worktree's last serialized screen
 * (instant restore that fills the spawn gap), spawns the session at the fitted cols/rows,
 * and bridges: term.onData -> session.sendInput, session.onOutput -> term.write,
 * ResizeObserver -> fit() + session.resize.
 *
 * CONFLICT-FREE REPLAY: the replayed screen is a disposable placeholder. The FIRST live
 * output byte triggers term.reset() exactly once (`liveStarted` latch) BEFORE writing it, so
 * the restored screen is cleanly REPLACED by claude's `--continue` redraw with zero overlap.
 * If no live output ever arrives, the restored screen simply stays (acceptable).
 *
 * RESET DRAIN-GATE: term.write(saved) parses ASYNCHRONOUSLY through xterm's WriteBuffer; a
 * write that takes >12ms yields via setTimeout, leaving the rest of `saved` QUEUED. term.reset()
 * clears the screen but does NOT clear that queue, so a live byte arriving mid-replay would
 * sequence as [stale queued `saved`] -> reset -> [live] -> [stale remainder repaints over live]
 * = the exact double-render this feature avoids. To GUARANTEE the invariant we gate the reset on
 * the replay write's completion callback (`replayDrained`): the first live byte resets+writes
 * IMMEDIATELY if the replay has already drained, otherwise it DEFERS reset+first-write into the
 * replay's completion callback. Either way reset() runs only after every replay byte is parsed
 * and live bytes land strictly after — no stale `saved` remainder can survive the reset.
 *
 * CAPTURE: after output, a serialize+persist is scheduled at most once per PERSIST_THROTTLE_MS
 * (never per byte — serialize is O(buffer)); a FINAL serialize+persist runs in the cleanup so
 * switching/closing a worktree captures its latest screen. On unmount it kills the PTY and
 * disposes the terminal. Re-mounts (worktreeId change) tear down and rebuild via the effect's
 * cleanup + the key in App.tsx.
 */
export function AgentTerminal({
  worktreeId,
  continueSession = false,
}: AgentTerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { spawn, kill, sendInput, resize } = useSession(worktreeId);

  // Keep the latest glue callbacks without retriggering the heavy mount effect.
  const spawnRef = useRef(spawn);
  const killRef = useRef(kill);
  const sendInputRef = useRef(sendInput);
  const resizeRef = useRef(resize);
  spawnRef.current = spawn;
  killRef.current = kill;
  sendInputRef.current = sendInput;
  resizeRef.current = resize;

  const continueRef = useRef(continueSession);
  continueRef.current = continueSession;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Guards mutated across this effect's closures; reset per (re)mount.
    let disposed = false;
    let liveStarted = false;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    // Drain-gate state for reset-before-live (see the RESET DRAIN-GATE doc above).
    // `replayWritten`: a replay write was issued (so its callback owns the not-yet-drained reset).
    // `replayDrained`: the replay write's parser callback has fired (the queue is empty).
    // `resetDone`: the reset-before-live has actually run; after this, live chunks pipe straight.
    // `pendingLive`: live chunks that arrived AFTER the first byte but BEFORE the replay drained,
    //   accumulated IN ORDER so the deferred reset flushes them all post-reset with zero overlap.
    let replayWritten = false;
    let replayDrained = false;
    let resetDone = false;
    let pendingLive = '';

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      convertEol: true,
      theme: { background: '#1e1e1e' },
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.open(host);
    fit.fit();

    /** Serialize the current screen + persist it (bounded). Swallows errors (best-effort). */
    const persistNow = (): void => {
      try {
        const data = serialize.serialize({ scrollback: SERIALIZE_SCROLLBACK_LINES });
        void window.mango.scrollback.set({ worktreeId, data });
      } catch {
        // best-effort capture — a serialize/IPC hiccup must never break the terminal
      }
    };

    /** Schedule a persist at most once per PERSIST_THROTTLE_MS (trailing-edge). */
    const schedulePersist = (): void => {
      if (persistTimer !== null) return; // already scheduled within this window
      persistTimer = setTimeout(() => {
        persistTimer = null;
        if (!disposed) persistNow();
      }, PERSIST_THROTTLE_MS);
    };

    /**
     * Reset-before-live: wipe the restored placeholder ONCE, then write all live output buffered
     * so far (the first chunk plus any that raced in while the replay was still draining), in
     * order. MUST be called only once the replay write (if any) has fully drained, so reset()
     * cannot leave stale `saved` bytes queued ahead of the live output (post-reset repaint).
     */
    const runResetBeforeLive = (): void => {
      resetDone = true;
      const buffered = pendingLive;
      pendingLive = '';
      term.reset();
      if (buffered.length > 0) term.write(buffered);
    };

    // REPLAY: restore the last screen instantly, BEFORE the session spawns/redraws. The
    // completion callback marks the parser queue drained and, if the first live byte already
    // arrived mid-replay, runs the deferred reset (which lands AFTER the last replay byte).
    void window.mango.scrollback.get(worktreeId).then((saved) => {
      // Only valid before live output begins; once reset-before-live has fired, a late
      // restore would re-introduce the stale screen. Guard on !liveStarted && !disposed.
      if (saved && !liveStarted && !disposed) {
        replayWritten = true;
        term.write(saved, () => {
          replayDrained = true;
          if (disposed) return;
          // If live output already started, its chunks are parked in pendingLive; now that the
          // replay queue is empty, perform the deferred reset-before-live with FIFO ordering.
          if (liveStarted && !resetDone) runResetBeforeLive();
        });
      } else {
        // No replay was issued (nothing saved, or live/unmount already won the race): the write
        // queue holds no `saved` bytes, so a (possibly already-latched) first live byte can reset
        // immediately. Flush any chunk parked before this resolved.
        replayDrained = true;
        if (liveStarted && !resetDone && !disposed) runResetBeforeLive();
      }
    });

    const onData = term.onData((data) => sendInputRef.current(data));

    const offOutput = window.mango.session.onOutput((e) => {
      if (e.worktreeId !== worktreeId) return;
      if (!resetDone) {
        // Before the placeholder has been wiped: latch live (so a late replay no-ops) and
        // accumulate every chunk IN ORDER. If the replay queue is already drained, wipe + flush
        // now; otherwise the replay completion callback flushes pendingLive after it drains.
        liveStarted = true;
        pendingLive += e.data;
        if (!replayWritten || replayDrained) runResetBeforeLive();
        schedulePersist();
        return;
      }
      term.write(e.data);
      schedulePersist();
    });
    const offExit = window.mango.session.onExit((e) => {
      if (e.worktreeId === worktreeId) {
        term.writeln(`\r\n\x1b[2m[claude exited: code ${e.exitCode}]\x1b[0m`);
      }
    });

    void spawnRef.current(term.cols, term.rows, continueRef.current);

    const observer = new ResizeObserver(() => {
      fit.fit();
      resizeRef.current(term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
      disposed = true;
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      // FINAL capture BEFORE dispose: persist the latest screen so reselecting this worktree
      // restores it. Runs even if no throttled persist had fired yet (e.g. quick switch).
      persistNow();
      observer.disconnect();
      offOutput();
      offExit();
      onData.dispose();
      void killRef.current();
      term.dispose();
    };
  }, [worktreeId]);

  return (
    <div
      data-testid="agent-terminal"
      ref={hostRef}
      style={{ width: '100%', height: 420, background: '#1e1e1e', borderRadius: 4 }}
    />
  );
}

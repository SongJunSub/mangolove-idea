import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/i18n-context';
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
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { spawn, kill, sendInput, resize } = useSession(worktreeId);

  // Keep the latest glue callbacks without retriggering the heavy mount effect.
  // tRef lets the exit notice read the current locale without t being an effect dep
  // (which would re-create the whole terminal on a language switch).
  const tRef = useRef(t);
  tRef.current = t;
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

    // REPLAY: restore the last screen instantly, BEFORE the session spawns/redraws.
    void window.mango.scrollback.get(worktreeId).then((saved) => {
      // Only valid before live output begins; once reset-before-live has fired, a late
      // restore would re-introduce the stale screen. Guard on !liveStarted && !disposed.
      if (saved && !liveStarted && !disposed) term.write(saved);
    });

    const onData = term.onData((data) => sendInputRef.current(data));

    const offOutput = window.mango.session.onOutput((e) => {
      if (e.worktreeId !== worktreeId) return;
      if (!liveStarted) {
        // FIRST live byte: wipe the restored placeholder ONCE, then pipe live output so
        // claude's --continue redraw (or a fresh session) replaces it with zero overlap.
        term.reset();
        liveStarted = true;
      }
      term.write(e.data);
      schedulePersist();
    });
    const offExit = window.mango.session.onExit((e) => {
      if (e.worktreeId === worktreeId) {
        term.writeln(
          `\r\n\x1b[2m[${tRef.current('terminal.claudeExited', { code: e.exitCode })}]\x1b[0m`,
        );
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

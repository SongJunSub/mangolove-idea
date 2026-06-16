import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSession } from '../../hooks/use-session';

/** Props for the embedded agent terminal (one per selected worktree). */
export interface AgentTerminalProps {
  /** The worktree whose `claude` PTY this terminal is bound to. */
  readonly worktreeId: string;
}

/**
 * Embedded xterm.js terminal bound to a worktree's claude PTY. On mount it
 * builds a Terminal + FitAddon, spawns the session at the fitted cols/rows, and
 * bridges: term.onData -> session.sendInput, session.onOutput -> term.write,
 * ResizeObserver -> fit() + session.resize. On unmount it kills the PTY and
 * disposes the terminal. Re-mounts (worktreeId change) tear down and rebuild via
 * the effect's cleanup + the key in App.tsx.
 */
export function AgentTerminal({ worktreeId }: AgentTerminalProps): React.JSX.Element {
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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      convertEol: true,
      theme: { background: '#1e1e1e' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const onData = term.onData((data) => sendInputRef.current(data));

    const offOutput = window.mango.session.onOutput((e) => {
      if (e.worktreeId === worktreeId) term.write(e.data);
    });
    const offExit = window.mango.session.onExit((e) => {
      if (e.worktreeId === worktreeId) {
        term.writeln(`\r\n\x1b[2m[claude exited: code ${e.exitCode}]\x1b[0m`);
      }
    });

    void spawnRef.current(term.cols, term.rows, false);

    const observer = new ResizeObserver(() => {
      fit.fit();
      resizeRef.current(term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
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

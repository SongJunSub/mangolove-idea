import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useI18n } from '../../i18n/i18n-context';

/** Props for one plain shell terminal in the multi-terminal panel. */
export interface ShellTerminalProps {
  /** Stable id for this shell PTY (renderer-generated; survives tab switches). */
  readonly terminalId: string;
  /** Absolute cwd the $SHELL was/will be spawned in (a worktree path). */
  readonly cwd: string;
}

/**
 * Embedded xterm.js bound to a plain `$SHELL` PTY (window.mango.term). Mirrors AgentTerminal
 * but MINIMAL: no scrollback replay, no session status, no b-full. On mount it builds a
 * Terminal + FitAddon, spawns the shell at the fitted size, and bridges term.onData ->
 * term.sendInput, term.onOutput -> term.write, ResizeObserver -> fit() + term.resize. On
 * unmount it kills the PTY and disposes the terminal. Re-mounts (terminalId change via the key
 * in the panel) tear down and rebuild.
 */
export function ShellTerminal({ terminalId, cwd }: ShellTerminalProps): React.JSX.Element {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

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

    const onData = term.onData((data) => window.mango.term.sendInput({ terminalId, data }));
    const offOutput = window.mango.term.onOutput((e) => {
      if (e.terminalId === terminalId && !disposed) term.write(e.data);
    });
    const offExit = window.mango.term.onExit((e) => {
      if (e.terminalId === terminalId && !disposed) {
        term.writeln(
          `\r\n\x1b[2m[${tRef.current('terminal.shellExited', { code: e.exitCode })}]\x1b[0m`,
        );
      }
    });

    void window.mango.term.spawn({
      terminalId,
      cwd: cwdRef.current,
      cols: term.cols,
      rows: term.rows,
    });

    let lastCols = term.cols;
    let lastRows = term.rows;
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        window.mango.term.resize({ terminalId, cols: term.cols, rows: term.rows });
      }
    });
    observer.observe(host);

    return () => {
      disposed = true;
      observer.disconnect();
      offOutput();
      offExit();
      onData.dispose();
      void window.mango.term.kill(terminalId);
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div
      data-testid="shell-terminal"
      ref={hostRef}
      style={{ flex: 1, minHeight: 0, width: '100%', background: '#1e1e1e', borderRadius: 4 }}
    />
  );
}

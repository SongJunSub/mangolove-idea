import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { AppInfo, QuitWarningEvent, Worktree } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { useWorktrees } from './hooks/use-worktrees';
import { useServer } from './hooks/use-server';
import { useLogs } from './hooks/use-logs';
import { useWorktreeStatus } from './hooks/use-worktree-status';
import { useMerge } from './hooks/use-merge';
import { useSessionRecords } from './hooks/use-session-records';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';
// Lazy-loaded so the xterm.js bundle (+ addon-fit + its CSS) is only fetched when
// a worktree is first selected — keeps the initial renderer chunk smaller.
const AgentTerminal = lazy(() =>
  import('./components/terminal/agent-terminal').then((m) => ({ default: m.AgentTerminal })),
);
import { ServerControls } from './components/toolbar/server-controls';
import { MergeControls } from './components/toolbar/merge-controls';
import { LogPanel } from './components/logs/log-panel';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { worktrees, loading, error, create, remove, refresh } = useWorktrees();
  const { status: serverStatus, start: startServer, stop: stopServer } = useServer();
  const logLines = useLogs();
  const statuses = useWorktreeStatus(worktrees, serverStatus);
  const { progress: mergeProgress, running: merging, run: runMerge } = useMerge();

  const sessionRecords = useSessionRecords();
  const [quitWarning, setQuitWarning] = useState<QuitWarningEvent | null>(null);

  useEffect(() => {
    return window.mango.app.onQuitWarning((e) => setQuitWarning(e));
  }, []);

  const onQuitDecision = useCallback(async (quit: boolean): Promise<void> => {
    setQuitWarning(null);
    await window.mango.app.sendQuitDecision(quit);
  }, []);

  const selectedWorktree = worktrees.find((w) => w.id === selectedId) ?? null;

  const onMerge = useCallback(
    async (worktree: Worktree): Promise<void> => {
      const result = await runMerge({
        worktreeId: worktree.id,
        targetBranch: 'main',
        runVerifyHook: true,
        cleanup: true,
      });
      if (result.merged) {
        if (worktree.id === selectedId) setSelectedId(null);
        await refresh();
      }
    },
    [runMerge, refresh, selectedId],
  );

  const onPing = useCallback(async () => {
    setPingError(null);
    try {
      setInfo(await window.mango.app.ping());
    } catch (e) {
      setPingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>MangoLove IDEA</h1>
      <p>Plan 4: merge + cleanup + unified status sidebar.</p>

      <Toolbar onCreate={create} />
      <ServerControls
        selectedId={selectedId}
        status={serverStatus}
        onStart={(id) => void startServer(id)}
        onStop={() => void stopServer()}
      />
      <MergeControls
        selected={selectedWorktree}
        running={merging}
        progress={mergeProgress}
        onMerge={(wt) => void onMerge(wt)}
      />
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <WorktreeList
          worktrees={worktrees}
          loading={loading}
          error={error}
          selectedId={selectedId}
          statuses={statuses}
          onSelect={setSelectedId}
          onRemove={(id) => void remove(id)}
        />
        <section style={{ flex: 1, minWidth: 0 }}>
          {selectedId ? (
            <Suspense fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading terminal…</p>}>
              <AgentTerminal
                key={selectedId}
                worktreeId={selectedId}
                continueSession={!sessionRecords.loading && sessionRecords.has(selectedId)}
              />
            </Suspense>
          ) : (
            <p style={{ fontSize: 13, color: '#888' }}>Select a worktree to start its agent.</p>
          )}
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={onPing}>
              Ping main
            </button>
            {pingError && <pre style={{ color: 'crimson' }}>error: {pingError}</pre>}
            {info && (
              <pre data-testid="ping-result" style={{ marginTop: 16 }}>
                {formatVersions(info)}
              </pre>
            )}
          </div>
          <LogPanel lines={logLines} />
        </section>
      </div>
      {quitWarning && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="quit-warning"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ background: '#fff', borderRadius: 8, padding: 24, maxWidth: 380 }}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Quit MangoLove IDEA?</h2>
            <p style={{ fontSize: 13 }}>
              {quitWarning.activeWorktreeIds.length} agent session(s) are live. They will be
              terminated (their conversations are saved by claude and resume with{' '}
              <code>--continue</code> next time). Quit anyway?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={() => void onQuitDecision(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void onQuitDecision(true)}>
                Quit anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

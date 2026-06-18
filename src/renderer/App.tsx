import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { AppInfo, QuitWarningEvent, Worktree } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { useWorktrees } from './hooks/use-worktrees';
import { useServer } from './hooks/use-server';
import { useLogs } from './hooks/use-logs';
import { useWorktreeStatus } from './hooks/use-worktree-status';
import { useMerge } from './hooks/use-merge';
import { useSessionRecords } from './hooks/use-session-records';
import { useSettings } from './hooks/use-settings';
import { SettingsModal } from './components/settings/settings-modal';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';
import { ServerControls } from './components/toolbar/server-controls';
import { MergeControls } from './components/toolbar/merge-controls';
import { GhStatusPanel } from './components/toolbar/gh-status-panel';
import { useGhStatus } from './hooks/use-gh-status';
import { LogPanel } from './components/logs/log-panel';

// Lazy-loaded so the xterm.js bundle (+ addon-fit + its CSS) is only fetched when
// a worktree is first selected — keeps the initial renderer chunk smaller.
const AgentTerminal = lazy(() =>
  import('./components/terminal/agent-terminal').then((m) => ({ default: m.AgentTerminal })),
);
// Lazy so monaco's ~3.9 MB bundle is a SEPARATE async chunk, fetched only when the
// Diff tab is first opened (mirrors AgentTerminal's React.lazy treatment of xterm).
const DiffView = lazy(() =>
  import('./components/diff/diff-view').then((m) => ({ default: m.DiffView })),
);
// Lazy so monaco stays in the existing ~7 MB diff chunk; the conflict editor shares it.
const ConflictView = lazy(() =>
  import('./components/diff/conflict-view').then((m) => ({ default: m.ConflictView })),
);

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { worktrees, loading, error, create, remove, refresh } = useWorktrees();
  const { status: serverStatus, start: startServer, stop: stopServer } = useServer();
  const logLines = useLogs();
  const statuses = useWorktreeStatus(worktrees, serverStatus);
  const { progress: mergeProgress, running: merging, run: runMerge } = useMerge();
  const { status: ghStatus, loading: ghLoading, error: ghError, refresh: refreshGh } =
    useGhStatus(selectedId);

  const sessionRecords = useSessionRecords();
  const { settings, loading: settingsLoading, save: saveSettings } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quitWarning, setQuitWarning] = useState<QuitWarningEvent | null>(null);
  const [paneMode, setPaneMode] = useState<'terminal' | 'diff' | 'conflict'>('terminal');
  // Worktree currently holding an in-progress (paused) merge conflict, or null.
  const [conflictWorktreeId, setConflictWorktreeId] = useState<string | null>(null);

  useEffect(() => {
    return window.mango.app.onQuitWarning((e) => setQuitWarning(e));
  }, []);

  // On selecting a worktree, reset the pane: to 'conflict' if THE in-progress merge
  // belongs to the SELECTED worktree (covers app-restart resume — truth comes from
  // MERGE_HEAD in the primary tree), otherwise back to 'terminal'. ONE effect owns
  // the reset so there is no race between a sync reset and an async probe.
  //
  // There is exactly ONE global MERGE_HEAD (single-MERGE_HEAD design), so we MUST
  // ask main which worktree actually owns it — `merge.conflicts()` ignores its
  // worktreeId argument and reports the same non-empty list for ANY selection while
  // a merge is paused. Attributing that to `selectedId` would open the Conflicts
  // pane against the WRONG worktree and make Continue/Abort clean up the wrong
  // worktree/branch. `merge.owner()` returns the worktreeId of MERGE_HEAD's feature
  // branch; we set conflictWorktreeId to THAT, and only flip to the pane when it is
  // the worktree currently selected.
  useEffect(() => {
    if (!selectedId) {
      setPaneMode('terminal');
      return;
    }
    let cancelled = false;
    setPaneMode('terminal'); // optimistic default until the probe resolves
    void window.mango.merge
      .owner()
      .then((ownerId) => {
        if (cancelled) return;
        setConflictWorktreeId(ownerId);
        if (ownerId !== null && ownerId === selectedId) {
          setPaneMode('conflict');
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const onQuitDecision = useCallback(async (quit: boolean): Promise<void> => {
    setQuitWarning(null);
    await window.mango.app.sendQuitDecision(quit);
  }, []);

  const selectedWorktree = worktrees.find((w) => w.id === selectedId) ?? null;
  const baseBranch = settings.baseBranch ?? 'main';

  const onMerge = useCallback(
    async (worktree: Worktree): Promise<void> => {
      const result = await runMerge({
        worktreeId: worktree.id,
        targetBranch: baseBranch,
        runVerifyHook: true,
        cleanup: true,
      });
      if (result.status === 'conflict') {
        // There is exactly ONE global MERGE_HEAD. A second merge while one is paused
        // re-surfaces the EXISTING conflict, which may belong to a DIFFERENT worktree
        // than the one just clicked. Attribute the Conflicts pane to the TRUE owner —
        // ask merge.owner() rather than trusting worktree.id — so Continue never
        // commits one worktree's merge and cleans up another's tree/branch. Only flip
        // to the Conflicts pane when the owner is the worktree currently selected.
        const ownerId = (await window.mango.merge.owner()) ?? result.worktreeId;
        setConflictWorktreeId(ownerId);
        if (ownerId === selectedId) setPaneMode('conflict');
        return;
      }
      if (result.merged) {
        if (worktree.id === selectedId) setSelectedId(null);
        await refresh();
      }
    },
    [runMerge, refresh, selectedId, baseBranch],
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Toolbar onCreate={create} />
        <button
          type="button"
          data-testid="settings-open"
          aria-label="settings"
          title="Settings"
          disabled={settingsLoading}
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </div>
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
      <GhStatusPanel
        selectedId={selectedId}
        status={ghStatus}
        loading={ghLoading}
        error={ghError}
        onRefresh={refreshGh}
        onOpen={(url) => void window.mango.app.openExternal({ url })}
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
            <>
              <div
                role="tablist"
                aria-label="worktree view"
                style={{ display: 'flex', gap: 4, marginBottom: 8 }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={paneMode === 'terminal'}
                  data-testid="tab-terminal"
                  onClick={() => setPaneMode('terminal')}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={paneMode === 'diff'}
                  data-testid="tab-diff"
                  onClick={() => setPaneMode('diff')}
                >
                  Diff
                </button>
                {conflictWorktreeId === selectedId && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={paneMode === 'conflict'}
                    data-testid="tab-conflict"
                    style={{ color: '#e0a030' }}
                    onClick={() => setPaneMode('conflict')}
                  >
                    Conflicts
                  </button>
                )}
              </div>
              {/* Terminal stays mounted (live PTY) but hidden when Diff is active. */}
              <div style={{ display: paneMode === 'terminal' ? 'block' : 'none' }}>
                <Suspense
                  fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading terminal…</p>}
                >
                  <AgentTerminal
                    key={selectedId}
                    worktreeId={selectedId}
                    continueSession={!sessionRecords.loading && sessionRecords.has(selectedId)}
                  />
                </Suspense>
              </div>
              {paneMode === 'diff' && (
                <Suspense fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading diff…</p>}>
                  <DiffView key={`diff-${selectedId}`} worktreeId={selectedId} base={baseBranch} />
                </Suspense>
              )}
              {paneMode === 'conflict' && conflictWorktreeId === selectedId && (
                <Suspense
                  fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading conflicts…</p>}
                >
                  <ConflictView
                    key={`conflict-${selectedId}`}
                    worktreeId={selectedId}
                    targetBranch={baseBranch}
                    cleanup={true}
                    onResolved={(merged) => {
                      setConflictWorktreeId(null);
                      setPaneMode('terminal');
                      if (merged) {
                        if (selectedId === selectedWorktree?.id) setSelectedId(null);
                      }
                      void refresh();
                    }}
                  />
                </Suspense>
              )}
            </>
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
      {settingsOpen && !settingsLoading && (
        <SettingsModal
          settings={settings}
          onSave={(partial) => {
            void saveSettings(partial);
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
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

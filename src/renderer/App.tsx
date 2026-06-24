import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { AppInfo, QuitWarningEvent, SessionPersistenceInfo, Worktree } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { applyTheme } from './lib/theme';
import { useWorktrees } from './hooks/use-worktrees';
import { useServer } from './hooks/use-server';
import { useLogs } from './hooks/use-logs';
import { useWorktreeStatus } from './hooks/use-worktree-status';
import { useMerge } from './hooks/use-merge';
import { useSessionRecords } from './hooks/use-session-records';
import { useSettings } from './hooks/use-settings';
import { useCrossMachine } from './hooks/use-cross-machine';
import { CrossMachinePanel } from './components/cross-machine/cross-machine-panel';
import { useRepo } from './hooks/use-repo';
import { Titlebar } from './components/titlebar/titlebar';
import { SettingsModal } from './components/settings/settings-modal';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';
import { ServerControls } from './components/toolbar/server-controls';
import { MergeControls } from './components/toolbar/merge-controls';
import { GhStatusPanel } from './components/toolbar/gh-status-panel';
import { useGhStatus } from './hooks/use-gh-status';
import { LogPanel } from './components/logs/log-panel';
import { detectServerUrl } from './lib/detect-server-url';
import { BrowserPane } from './components/browser/browser-pane';

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
// Lazy so the fan-out panel (which pulls the shared monaco diff chunk per-lane) is
// only fetched when the user opens it; keeps the initial renderer chunk smaller.
const FanoutView = lazy(() =>
  import('./components/fanout/fanout-view').then((m) => ({ default: m.FanoutView })),
);

export function App(): React.JSX.Element {
  const repo = useRepo();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { worktrees, loading, error, create, remove, refresh } = useWorktrees();
  const { servers, start: startServer, stop: stopServer } = useServer();
  const selectedServer = selectedId ? (servers.get(selectedId) ?? null) : null;
  const logLines = useLogs(selectedId);
  const detectedServerUrl = detectServerUrl(logLines);
  const statuses = useWorktreeStatus(worktrees, servers);
  const { progress: mergeProgress, running: merging, run: runMerge } = useMerge();
  const {
    status: ghStatus,
    loading: ghLoading,
    error: ghError,
    refresh: refreshGh,
  } = useGhStatus(selectedId);

  const sessionRecords = useSessionRecords();
  const { settings, loading: settingsLoading, save: saveSettings } = useSettings();
  const crossMachine = useCrossMachine();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [crossMachineOpen, setCrossMachineOpen] = useState(false);
  const [quitWarning, setQuitWarning] = useState<QuitWarningEvent | null>(null);
  // Effective session-persistence mode (b-full). Drives the quit dialog's wording:
  // under 'full' a quit does NOT lose the turn — it keeps running in the background.
  const [persistenceInfo, setPersistenceInfo] = useState<SessionPersistenceInfo | null>(null);
  const [paneMode, setPaneMode] = useState<'terminal' | 'diff' | 'conflict' | 'browser'>(
    'terminal',
  );
  // Worktree currently holding an in-progress (paused) merge conflict, or null.
  const [conflictWorktreeId, setConflictWorktreeId] = useState<string | null>(null);

  // Apply the persisted theme to <html data-theme>; 'system'/unset tracks the OS.
  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  useEffect(() => {
    return window.mango.app.onQuitWarning((e) => setQuitWarning(e));
  }, []);

  useEffect(() => {
    let alive = true;
    void window.mango.session.persistenceInfo().then((i) => {
      if (alive) setPersistenceInfo(i);
    });
    return () => {
      alive = false;
    };
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

  // b-full "Stop all & quit": end every surviving background session FIRST (so the
  // turn does NOT keep running), then proceed with the quit. Composed in the
  // renderer so APP_QUIT_DECISION stays a simple boolean.
  const onQuitStopAll = useCallback(async (): Promise<void> => {
    setQuitWarning(null);
    await window.mango.session.stopAllBackground();
    await window.mango.app.sendQuitDecision(true);
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

  // Repo-picker gate: until a git repo is selected, show a centered empty-state
  // INSTEAD of the worktree UI. While loading the initial REPO_GET, render nothing
  // (avoids a flash of the empty-state before a persisted repo resolves).
  if (repo.loading) {
    return <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }} />;
  }
  if (repo.repoRoot === null) {
    return (
      <div className="app-shell">
        <Titlebar />
        <main
          className="app-body"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <p data-testid="repo-empty-state" style={{ fontSize: 14, color: 'var(--muted)' }}>
            Select your git repository to begin
          </p>
          <button type="button" data-testid="repo-pick" onClick={() => void repo.pick()}>
            Select repository…
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Titlebar
        right={
          <div className="titlebar-actions">
            <span className="titlebar-repo" data-testid="repo-name">
              {repo.repoRoot.split('/').filter(Boolean).pop() ?? repo.repoRoot}
            </span>
            <button type="button" data-testid="repo-change" onClick={() => void repo.pick()}>
              change repo
            </button>
            <button
              type="button"
              data-testid="fanout-open"
              aria-pressed={fanoutOpen}
              title="Multimodel fan-out"
              onClick={() => setFanoutOpen((v) => !v)}
            >
              ⑃ Fan-out
            </button>
            <button
              type="button"
              data-testid="cross-machine-open"
              title="Cross-machine sessions"
              onClick={() => {
                setCrossMachineOpen(true);
                void crossMachine.refresh();
              }}
            >
              ⌘ Machines
            </button>
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
        }
      />
      <main className="app-body">
        <div className="workspace">
          {/* top-left: project file tree (A3) */}
          <div className="ws-pane ws-tree">
            <div className="pane-head">📁 Project</div>
            <div className="pane-placeholder">파일 트리는 곧 추가됩니다 (A3)</div>
          </div>
          {/* top-right: code editor (A4) */}
          <div className="ws-pane ws-editor">
            <div className="pane-head">Editor</div>
            <div className="pane-placeholder">파일을 선택하면 여기에서 편집합니다 (A4)</div>
          </div>
          {/* bottom-left: worktree management (create + list + per-worktree controls) */}
          <div className="ws-pane ws-worktrees">
            <div className="pane-head">🌿 Worktrees</div>
            <div className="pane-body">
              <Toolbar onCreate={create} />
              <ServerControls
                selectedId={selectedId}
                status={selectedServer}
                onStart={(id) => void startServer(id)}
                onStop={(id) => void stopServer(id)}
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
              <WorktreeList
                worktrees={worktrees}
                loading={loading}
                error={error}
                selectedId={selectedId}
                statuses={statuses}
                onSelect={setSelectedId}
                onRemove={(id) => void remove(id)}
              />
            </div>
          </div>
          {/* bottom-right: terminal / diff / browser / conflict + logs */}
          <div className="ws-pane ws-terminal">
            <section
              className="pane-body"
              style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
            >
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
                    <button
                      type="button"
                      role="tab"
                      aria-selected={paneMode === 'browser'}
                      data-testid="tab-browser"
                      onClick={() => setPaneMode('browser')}
                    >
                      Browser
                    </button>
                    {conflictWorktreeId === selectedId && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={paneMode === 'conflict'}
                        data-testid="tab-conflict"
                        style={{ color: 'var(--warn)' }}
                        onClick={() => setPaneMode('conflict')}
                      >
                        Conflicts
                      </button>
                    )}
                  </div>
                  {/* Terminal stays mounted (live PTY) but hidden when Diff is active. */}
                  <div style={{ display: paneMode === 'terminal' ? 'block' : 'none' }}>
                    <Suspense
                      fallback={
                        <p style={{ fontSize: 13, color: 'var(--muted)' }}>Loading terminal…</p>
                      }
                    >
                      <AgentTerminal
                        key={selectedId}
                        worktreeId={selectedId}
                        continueSession={!sessionRecords.loading && sessionRecords.has(selectedId)}
                      />
                    </Suspense>
                  </div>
                  {paneMode === 'diff' && (
                    <Suspense
                      fallback={
                        <p style={{ fontSize: 13, color: 'var(--muted)' }}>Loading diff…</p>
                      }
                    >
                      <DiffView
                        key={`diff-${selectedId}`}
                        worktreeId={selectedId}
                        base={baseBranch}
                      />
                    </Suspense>
                  )}
                  {paneMode === 'browser' && (
                    <BrowserPane key={`browser-${selectedId}`} detectedUrl={detectedServerUrl} />
                  )}
                  {paneMode === 'conflict' && conflictWorktreeId === selectedId && (
                    <Suspense
                      fallback={
                        <p style={{ fontSize: 13, color: 'var(--muted)' }}>Loading conflicts…</p>
                      }
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
                <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                  Select a worktree to start its agent.
                </p>
              )}
              <div style={{ marginTop: 16 }}>
                <button type="button" onClick={onPing}>
                  Ping main
                </button>
                {pingError && <pre style={{ color: 'var(--err)' }}>error: {pingError}</pre>}
                {info && (
                  <pre data-testid="ping-result" style={{ marginTop: 16 }}>
                    {formatVersions(info)}
                  </pre>
                )}
              </div>
              <LogPanel lines={logLines} />
            </section>
          </div>
        </div>
        {fanoutOpen && (
          <div className="fanout-overlay" data-testid="fanout-overlay">
            <Suspense
              fallback={<p style={{ fontSize: 13, color: 'var(--muted)' }}>Loading fan-out…</p>}
            >
              <FanoutView base={baseBranch} onMerged={() => void refresh()} />
            </Suspense>
          </div>
        )}
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
        {crossMachineOpen && (
          <CrossMachinePanel
            pointers={crossMachine.pointers}
            loading={crossMachine.loading}
            error={crossMachine.error}
            enabled={settings.crossMachineSessions === 'on'}
            selfMachineId={settings.machineId}
            onRefresh={() => void crossMachine.refresh()}
            onStartHere={(branch) => {
              void crossMachine.startHere(branch).then((wt) => {
                if (!wt) return; // failure surfaced via crossMachine.error in the panel
                setCrossMachineOpen(false);
                // Refresh the worktree list, then select the (new) worktree — selecting it
                // mounts AgentTerminal with continueSession=false (no record), a FRESH session.
                void refresh().then(() => setSelectedId(wt.id));
              });
            }}
            onClose={() => setCrossMachineOpen(false)}
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
            <div
              style={{
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 24,
                maxWidth: 380,
              }}
            >
              <h2 style={{ marginTop: 0, fontSize: 16 }}>Quit MangoLove IDEA?</h2>
              {persistenceInfo?.effective === 'full' ? (
                <p style={{ fontSize: 13 }}>
                  {quitWarning.activeWorktreeIds.length} agent turn(s) are running. With background
                  persistence on, they will <strong>keep running in the background</strong> and
                  re-attach when you reopen — nothing is lost. You can also stop them now.
                </p>
              ) : (
                <p style={{ fontSize: 13 }}>
                  {quitWarning.activeWorktreeIds.length} running agent turn(s) are in flight and
                  would be interrupted. (Conversations are saved by claude and resume with{' '}
                  <code>--continue</code> next time — only the in-flight turn is lost.) Quit anyway?
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button type="button" onClick={() => void onQuitDecision(false)}>
                  Cancel
                </button>
                {persistenceInfo?.effective === 'full' ? (
                  <>
                    <button
                      type="button"
                      data-testid="quit-stop-all"
                      onClick={() => void onQuitStopAll()}
                    >
                      Stop all &amp; quit
                    </button>
                    <button
                      type="button"
                      data-testid="quit-keep-running"
                      onClick={() => void onQuitDecision(true)}
                    >
                      Keep running &amp; quit
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => void onQuitDecision(true)}>
                    Quit anyway
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

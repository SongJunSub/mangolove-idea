import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuitWarningEvent, SessionPersistenceInfo, Worktree } from '../shared/types';
import { applyTheme, resolveTheme } from './lib/theme';
import { useFileEditor } from './hooks/use-file-editor';
import { ConfirmDiscardModal } from './components/editor/confirm-discard-modal';
import { NavBack } from './components/editor/nav-back';
import { UsagesPanel } from './components/editor/usages-panel';
import type { UsageLocation } from './lib/code-nav/find-usages';
import { registerCodeNav } from './lib/code-nav/register-code-nav';
import { applyTsconfigToNav } from './lib/code-nav/ts-nav';
import { loadTsconfigNav } from './lib/code-nav/tsconfig-loader';
import { WorktreeModelRegistry } from './lib/code-nav/worktree-model-registry';
import { useWorktrees } from './hooks/use-worktrees';
import { useServer } from './hooks/use-server';
import { useLogs } from './hooks/use-logs';
import { useWorktreeStatus } from './hooks/use-worktree-status';
import { isRepoBusy } from './state/app-store';
import { useMerge } from './hooks/use-merge';
import { useSessionRecords } from './hooks/use-session-records';
import { useSettings } from './hooks/use-settings';
import { useCrossMachine } from './hooks/use-cross-machine';
import { CrossMachinePanel } from './components/cross-machine/cross-machine-panel';
import { useRepo } from './hooks/use-repo';
import { Titlebar } from './components/titlebar/titlebar';
import { FileTree } from './components/tree/file-tree';
import { FolderIcon } from './components/tree/tree-icons';
import { RepoList } from './components/sidebar/repo-list';
import { useRecentRepos } from './hooks/use-recent-repos';
import { SettingsModal } from './components/settings/settings-modal';
import { UpdateBanner, UpdateProgressInline } from './components/update/update-banner';
import { StatusBar } from './components/statusbar/status-bar';
import { UsageWidget } from './components/usage/usage-widget';
import { useUpdateCheck } from './hooks/use-update-check';
import { useSelfUpdate } from './hooks/use-self-update';
import { useUsage } from './hooks/use-usage';
import { openExternal } from './lib/open-external';
import { I18nContext } from './i18n/i18n-context';
import { makeT, type TranslateFn } from './i18n/messages';
import { resolveLocale } from './i18n/resolve-locale';
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
// Lazy so the editor folds into the shared monaco chunk (A4) — fetched only when a file
// is first opened, like DiffView/ConflictView.
const CodeEditor = lazy(() =>
  import('./components/editor/code-editor').then((m) => ({ default: m.CodeEditor })),
);

/** Human-readable reason a file opened view-only (mirrors FileReadResult.reason). */
function readOnlyReason(
  reason: 'binary' | 'tooLarge' | 'encoding' | undefined,
  t: TranslateFn,
): string {
  if (reason === 'binary') return t('app.readonly.binary');
  if (reason === 'tooLarge') return t('app.readonly.tooLarge');
  if (reason === 'encoding') return t('app.readonly.encoding');
  return t('app.readonly.default');
}

/** A queued selection change held while the editor is dirty (resolved via the modal). */
type PendingSwitch = { kind: 'file'; relPath: string } | { kind: 'worktree'; id: string | null };

/** The titlebar Settings glyph: a crisp 16px gear (currentColor), inlined like ClaudeMark. */
function GearIcon(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function App(): React.JSX.Element {
  const repo = useRepo();
  const recentRepos = useRecentRepos();
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
  // Resolve the UI locale (explicit setting wins; otherwise follow the OS) and build the
  // i18n value App both provides (for child screens) and consumes (for its own titlebar).
  const locale = resolveLocale(settings.locale, navigator.language);
  const i18n = useMemo(() => ({ locale, t: makeT(locale) }), [locale]);
  const { t } = i18n;
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const crossMachine = useCrossMachine();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [crossMachineOpen, setCrossMachineOpen] = useState(false);
  const [quitWarning, setQuitWarning] = useState<QuitWarningEvent | null>(null);
  // Pending in-place repo switch awaiting confirmation (set only when the current repo is
  // busy — a running agent turn or an unsaved file — since the switch tears those down).
  const [pendingRepoSwitch, setPendingRepoSwitch] = useState<string | null>(null);
  // In-app update notice (macOS, unsigned): one silent check on launch feeds the banner. A
  // failed check yields a status with `error` set, which the banner predicate excludes (so it
  // stays hidden). The app never auto-installs — the banner just links the download.
  const { status: update } = useUpdateCheck(true);
  const selfUpdate = useSelfUpdate();
  const usage = useUsage();
  // Effective session-persistence mode (b-full). Drives the quit dialog's wording:
  // under 'full' a quit does NOT lose the turn — it keeps running in the background.
  const [persistenceInfo, setPersistenceInfo] = useState<SessionPersistenceInfo | null>(null);
  const [paneMode, setPaneMode] = useState<
    'terminal' | 'diff' | 'conflict' | 'browser' | 'references'
  >('terminal');
  // Worktree currently holding an in-progress (paused) merge conflict, or null.
  const [conflictWorktreeId, setConflictWorktreeId] = useState<string | null>(null);
  // relPath of the file open in the editor pane (A4 edits + saves it), or null.
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // The A4 editor state for (selectedId, selectedFile). dirty drives the unsaved-guard.
  const editor = useFileEditor(selectedId, selectedFile);
  // A selection change queued while the editor is dirty, awaiting the save/discard prompt.
  const [pending, setPending] = useState<PendingSwitch | null>(null);

  // In-place repo switch (the sidebar): main tears down THIS window's agents/servers/LSP and
  // rebinds it to the new repo. Confirm first if anything live would be lost; else switch now.
  const requestRepoSwitch = (path: string): void => {
    if (isRepoBusy(editor.dirty, statuses)) setPendingRepoSwitch(path);
    else void recentRepos.open(path);
  };

  // Code-nav (Phase B): the position to reveal in the editor after a go-to-definition jump
  // (scoped to its relPath so a normal open never jumps), plus a Back-navigation stack.
  const [pendingReveal, setPendingReveal] = useState<{
    relPath: string;
    line: number;
    column: number;
  } | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const navHistoryRef = useRef<Array<{ relPath: string; line: number; column: number }>>([]);
  const currentPosRef = useRef<{ line: number; column: number }>({ line: 1, column: 1 });

  // App's resolved theme ('dark'/'light'), fed to ALL monaco panes (process-global
  // theme). Initialized synchronously so there is no first-paint flash.
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() =>
    resolveTheme(settings.theme, window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
  // ONE matchMedia listener (inside applyTheme) owns BOTH <html data-theme> and
  // resolvedTheme — 'system'/unset tracks the OS; explicit modes set once.
  useEffect(() => applyTheme(settings.theme, setResolvedTheme), [settings.theme]);

  // ── Unsaved-changes guard: the SINGLE chokepoint for every selection mutation. ──
  // Raw setSelectedId/setSelectedFile are forbidden outside applyWorktree/applyPending,
  // so no low-level channel can drop a dirty buffer without prompting first.

  /** Apply a worktree selection AND clear the open file (replaces the old line-86 effect,
   *  which nulled selectedFile on ANY selectedId change — unmounting a dirty editor). */
  const applyWorktree = useCallback((id: string | null): void => {
    setSelectedId(id);
    setSelectedFile(null);
    // A worktree switch resets code-nav: its history + reveal belonged to the old worktree.
    setPendingReveal(null);
    navHistoryRef.current = [];
    setCanGoBack(false);
    // Clear find-usages too: it stores worktree-relative paths (not mango URIs), so leaving
    // OLD-worktree rows around would let a later click re-bind them to the NEW selectedId and
    // open the wrong worktree's path (stale cross-worktree nav).
    setUsages([]);
    setUsagesLoading(false);
  }, []);

  const applyPending = useCallback(
    (p: PendingSwitch): void => {
      if (p.kind === 'file') setSelectedFile(p.relPath);
      else applyWorktree(p.id);
      setPending(null);
    },
    [applyWorktree],
  );

  /** Open a file in the editor; prompts first if the current file is dirty. A normal open
   *  (file tree click) clears any pending nav-reveal so it never jumps the cursor. */
  const requestOpenFile = useCallback(
    (relPath: string): void => {
      if (relPath === selectedFile) return;
      setPendingReveal(null);
      if (editor.dirty) setPending({ kind: 'file', relPath });
      else setSelectedFile(relPath);
    },
    [selectedFile, editor.dirty],
  );

  /** Select a worktree; prompts first if a dirty file is open. */
  const requestSelectWorktree = useCallback(
    (id: string | null): void => {
      if (id === selectedId) return;
      if (editor.dirty) setPending({ kind: 'worktree', id });
      else applyWorktree(id);
    },
    [selectedId, editor.dirty, applyWorktree],
  );

  // Modal handlers. On save FAILURE keep the modal open (editor.saveError shows inside it)
  // so the queued navigation is never silently dropped and Save can be retried.
  const onGuardSave = useCallback(async (): Promise<void> => {
    const ok = await editor.save();
    if (ok && pending) applyPending(pending);
  }, [editor, pending, applyPending]);
  const onGuardDiscard = useCallback((): void => {
    if (pending) applyPending(pending);
  }, [pending, applyPending]);
  const onGuardCancel = useCallback((): void => setPending(null), []);

  // ── Code navigation (Phase B) ──
  // Stable snapshot for the once-registered, process-global code-nav opener (reads refs so
  // it never goes stale despite [] deps).
  const navSelRef = useRef({ selectedId, selectedFile, dirty: editor.dirty });
  navSelRef.current = { selectedId, selectedFile, dirty: editor.dirty };

  /** Cross-file go-to-definition target (from monaco's editor-opener). Pushes the current
   *  location for Back, then opens the target through the dirty-guard with a reveal. */
  const onCodeNavOpen = useCallback(
    (worktreeId: string, relPath: string, position?: { line: number; column: number }): void => {
      const s = navSelRef.current;
      if (worktreeId !== s.selectedId) return; // only within the selected worktree (defense)
      if (s.selectedFile && s.selectedFile !== relPath) {
        navHistoryRef.current.push({ relPath: s.selectedFile, ...currentPosRef.current });
        setCanGoBack(true);
      }
      setPendingReveal(position ? { relPath, line: position.line, column: position.column } : null);
      if (relPath !== s.selectedFile) {
        if (s.dirty) setPending({ kind: 'file', relPath });
        else setSelectedFile(relPath);
      }
    },
    [],
  );

  // Find-usages panel (Phase B). CodeEditor reports loading, then the results; a row click
  // routes back through onCodeNavOpen (dirty-guard + reveal + Back history).
  const [usages, setUsages] = useState<readonly UsageLocation[]>([]);
  const [usagesLoading, setUsagesLoading] = useState(false);
  const onFindUsages = useCallback((list: UsageLocation[] | null, loading: boolean): void => {
    setUsagesLoading(loading);
    if (!loading) setUsages(list ?? []);
    setPaneMode('references');
  }, []);

  /** Back: return to the previously-jumped-from location through the dirty-guard. */
  const onNavBack = useCallback((): void => {
    const prev = navHistoryRef.current.pop();
    setCanGoBack(navHistoryRef.current.length > 0);
    if (!prev) return;
    const s = navSelRef.current;
    setPendingReveal({ relPath: prev.relPath, line: prev.line, column: prev.column });
    if (prev.relPath !== s.selectedFile) {
      if (s.dirty) setPending({ kind: 'file', relPath: prev.relPath });
      else setSelectedFile(prev.relPath);
    }
  }, []);

  // Register the process-global code-nav providers + editor-opener ONCE (idempotent).
  useEffect(() => {
    registerCodeNav({ onOpen: onCodeNavOpen });
  }, [onCodeNavOpen]);

  // Seed first-party TS/JS models for the selected worktree (cross-file nav); dispose on switch.
  // Also layer this worktree's tsconfig path aliases onto the shared TS service so '@/foo'
  // style imports resolve. The compiler options are process-global, so this re-applies per
  // worktree in lockstep with the registry; an empty/missing tsconfig is a harmless no-op.
  useEffect(() => {
    if (!selectedId) return;
    let reg: WorktreeModelRegistry | null = null;
    let cancelled = false;
    // Apply the tsconfig aliases BEFORE seeding so the registry's models land in an
    // already-configured worker — avoids setCompilerOptions rebuilding + reprocessing
    // the (up to 2000) seeded models a second time on every worktree switch.
    void loadTsconfigNav(selectedId).then((nav) => {
      if (cancelled) return;
      applyTsconfigToNav(selectedId, nav);
      void WorktreeModelRegistry.create(selectedId).then((r) => {
        if (cancelled) r.dispose();
        else reg = r;
      });
    });
    return () => {
      cancelled = true;
      reg?.dispose();
    };
  }, [selectedId]);

  useEffect(() => {
    return window.mango.app.onQuitWarning((e) => setQuitWarning(e));
  }, []);

  // Report this window's unsaved editor count to main so a quit with a dirty buffer — even
  // with no active agent turn — still warns before the change is lost (A4). The editor
  // tracks one open file, so this is 0 or 1; main sums it across windows.
  useEffect(() => {
    window.mango.app.setUnsaved(editor.dirty ? 1 : 0);
  }, [editor.dirty]);

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

  // A5 graft — rising-edge auto-switch to the Browser tab. When the SELECTED worktree's
  // server first reaches 'running' WITH a detected URL, switch the bottom-right pane to
  // Browser exactly once per run, so a Run drops to zero clicks. Keyed by (worktreeId,
  // startedAt) so: (a) a restart (new startedAt) re-opens; (b) it fires once, not on
  // every re-render, so a later manual tab change is never re-asserted; (c) merely
  // SELECTING an already-running worktree only adopts the baseline (no yank). Anchored
  // strictly to selectedServer + detectedServerUrl (both demuxed to selectedId), so a
  // background worktree's server can never hijack the pane. Independently revertable.
  const autoOpenRef = useRef<{ id: string | null; key: string | null }>({ id: null, key: null });
  useEffect(() => {
    const running = selectedServer?.process.state === 'running';
    const key =
      running && detectedServerUrl
        ? `${selectedId}:${selectedServer?.process.startedAt ?? ''}`
        : null;
    const prev = autoOpenRef.current;
    if (prev.id !== selectedId) {
      // Worktree switch: adopt the current run as baseline WITHOUT opening (selecting an
      // already-running worktree must not yank the pane to Browser).
      autoOpenRef.current = { id: selectedId, key };
      return;
    }
    if (key !== prev.key) {
      autoOpenRef.current = { id: selectedId, key };
      // Rising edge for THIS worktree's server (stopped/starting -> running + URL).
      if (key) setPaneMode('browser');
    }
  }, [
    selectedId,
    selectedServer?.process.state,
    selectedServer?.process.startedAt,
    detectedServerUrl,
  ]);

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
        if (worktree.id === selectedId) requestSelectWorktree(null);
        await refresh();
      }
    },
    [runMerge, refresh, selectedId, baseBranch, requestSelectWorktree],
  );

  // Repo-picker gate: until a git repo is selected, show a centered empty-state
  // INSTEAD of the worktree UI. While loading the initial REPO_GET, render nothing
  // (avoids a flash of the empty-state before a persisted repo resolves).
  if (repo.loading) {
    return <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }} />;
  }
  if (repo.repoRoot === null) {
    return (
      <I18nContext.Provider value={i18n}>
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
              {t('app.repoEmpty')}
            </p>
            {recentRepos.repos.length > 0 && (
              <div className="repo-launcher">
                <RepoList
                  repos={recentRepos.repos}
                  onOpen={(path) => void recentRepos.open(path)}
                  onAdd={() => void repo.pick()}
                />
              </div>
            )}
            <button type="button" data-testid="repo-pick" onClick={() => void repo.pick()}>
              {t('app.repoPick')}
            </button>
          </main>
        </div>
      </I18nContext.Provider>
    );
  }

  return (
    <I18nContext.Provider value={i18n}>
      <div className="app-shell">
        <Titlebar
          right={
            <div className="titlebar-actions">
              <span className="titlebar-repo" data-testid="repo-name">
                {repo.repoRoot.split('/').filter(Boolean).pop() ?? repo.repoRoot}
              </span>
              <button
                type="button"
                data-testid="fanout-open"
                aria-pressed={fanoutOpen}
                title={t('app.fanoutTip')}
                onClick={() => setFanoutOpen((v) => !v)}
              >
                {t('app.fanout')}
              </button>
              <button
                type="button"
                data-testid="cross-machine-open"
                title={t('app.machinesTip')}
                onClick={() => {
                  setCrossMachineOpen(true);
                  void crossMachine.refresh();
                }}
              >
                {t('app.machines')}
              </button>
              <button
                type="button"
                className="icon-btn"
                data-testid="settings-open"
                aria-label={t('settings.title')}
                title={t('settings.title')}
                disabled={settingsLoading}
                onClick={() => setSettingsOpen(true)}
              >
                <GearIcon />
              </button>
            </div>
          }
        />
        <main className="app-body">
          <div className="workspace">
            {/* top-left: repo switcher + project file tree (A3) */}
            <div className="ws-pane ws-tree">
              <RepoList
                repos={recentRepos.repos}
                onOpen={requestRepoSwitch}
                onAdd={() =>
                  void repo.pick().then((r) => {
                    if (r.ok) void recentRepos.refresh();
                  })
                }
              />
              <div className="pane-head">
                <span className="pane-head-ico">
                  <FolderIcon open={false} />
                </span>
                {t('app.project')}
              </div>
              <FileTree
                worktreeId={selectedId}
                selectedFile={selectedFile}
                onOpenFile={requestOpenFile}
              />
            </div>
            {/* top-right: code editor (A4) — edit + ⌘S save */}
            <div className="ws-pane ws-editor">
              <div className="pane-head">
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <NavBack canGoBack={canGoBack} onBack={onNavBack} />
                  {t('app.editor')}
                </span>
                {selectedFile && selectedId && !editor.readOnly && (
                  <button
                    type="button"
                    data-testid="editor-save"
                    className="editor-save-btn"
                    disabled={!editor.dirty || editor.saving}
                    title={t('app.saveTip')}
                    onClick={() => void editor.save()}
                  >
                    {editor.saving ? t('app.saving') : t('app.save')}
                  </button>
                )}
              </div>
              {!selectedFile || !selectedId ? (
                <div className="pane-placeholder">{t('app.editorEmpty')}</div>
              ) : editor.loadError ? (
                <div className="pane-placeholder" data-testid="editor-load-error">
                  {t('app.loadError', { error: editor.loadError })}
                </div>
              ) : (
                <div
                  className="pane-body"
                  style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 6 }}
                >
                  {editor.readOnly && (
                    <div className="editor-banner" data-testid="editor-readonly">
                      {readOnlyReason(editor.reason, t)} — {t('app.readonly.default')}
                    </div>
                  )}
                  {editor.saveError && (
                    <div className="editor-banner err" data-testid="editor-save-error">
                      {t('app.saveError', { error: editor.saveError })}
                    </div>
                  )}
                  <Suspense
                    fallback={<div className="pane-placeholder">{t('app.editorLoading')}</div>}
                  >
                    <CodeEditor
                      worktreeId={selectedId}
                      relPath={selectedFile}
                      theme={resolvedTheme}
                      content={editor.content}
                      readOnly={editor.readOnly}
                      dirty={editor.dirty}
                      reveal={
                        pendingReveal?.relPath === selectedFile
                          ? { line: pendingReveal.line, column: pendingReveal.column }
                          : null
                      }
                      onChange={editor.setValue}
                      onSaveRequested={() => void editor.save()}
                      onCursor={(line, column) => {
                        currentPosRef.current = { line, column };
                      }}
                      onUsages={onFindUsages}
                    />
                  </Suspense>
                </div>
              )}
            </div>
            {/* bottom-left: worktree management (create + list + per-worktree controls) */}
            <div className="ws-pane ws-worktrees">
              <div className="pane-head">🌿 {t('app.worktrees')}</div>
              <div className="pane-body">
                <Toolbar onCreate={create} />
                <ServerControls
                  selectedId={selectedId}
                  status={selectedServer}
                  serverUrl={detectedServerUrl}
                  onStart={(id) => void startServer(id)}
                  onStop={(id) => void stopServer(id)}
                  onOpen={() => setPaneMode('browser')}
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
                  onOpen={openExternal}
                />
                <WorktreeList
                  worktrees={worktrees}
                  loading={loading}
                  error={error}
                  selectedId={selectedId}
                  statuses={statuses}
                  onSelect={requestSelectWorktree}
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
                      aria-label={t('app.worktreeView')}
                      style={{ display: 'flex', gap: 4, marginBottom: 8 }}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={paneMode === 'terminal'}
                        data-testid="tab-terminal"
                        onClick={() => setPaneMode('terminal')}
                      >
                        {t('app.tab.terminal')}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={paneMode === 'diff'}
                        data-testid="tab-diff"
                        onClick={() => setPaneMode('diff')}
                      >
                        {t('app.tab.diff')}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={paneMode === 'browser'}
                        data-testid="tab-browser"
                        onClick={() => setPaneMode('browser')}
                      >
                        {t('app.tab.browser')}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={paneMode === 'references'}
                        data-testid="tab-references"
                        onClick={() => setPaneMode('references')}
                      >
                        {t('app.tab.usages')}
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
                          {t('app.tab.conflicts')}
                        </button>
                      )}
                    </div>
                    {/* Terminal stays mounted (live PTY) but hidden when Diff is active. */}
                    <div style={{ display: paneMode === 'terminal' ? 'block' : 'none' }}>
                      <Suspense
                        fallback={
                          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                            {t('app.loadingTerminal')}
                          </p>
                        }
                      >
                        <AgentTerminal
                          key={selectedId}
                          worktreeId={selectedId}
                          continueSession={
                            !sessionRecords.loading && sessionRecords.has(selectedId)
                          }
                        />
                      </Suspense>
                    </div>
                    {paneMode === 'diff' && (
                      <Suspense
                        fallback={
                          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                            {t('app.loadingDiff')}
                          </p>
                        }
                      >
                        <DiffView
                          key={`diff-${selectedId}`}
                          worktreeId={selectedId}
                          base={baseBranch}
                          theme={resolvedTheme}
                        />
                      </Suspense>
                    )}
                    {paneMode === 'browser' && (
                      <BrowserPane key={`browser-${selectedId}`} detectedUrl={detectedServerUrl} />
                    )}
                    {paneMode === 'references' && (
                      <UsagesPanel
                        usages={usages}
                        loading={usagesLoading}
                        onOpen={(relPath, line, column) => {
                          if (selectedId) onCodeNavOpen(selectedId, relPath, { line, column });
                        }}
                      />
                    )}
                    {paneMode === 'conflict' && conflictWorktreeId === selectedId && (
                      <Suspense
                        fallback={
                          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                            {t('app.loadingConflicts')}
                          </p>
                        }
                      >
                        <ConflictView
                          key={`conflict-${selectedId}`}
                          worktreeId={selectedId}
                          targetBranch={baseBranch}
                          cleanup={true}
                          theme={resolvedTheme}
                          onResolved={(merged) => {
                            setConflictWorktreeId(null);
                            setPaneMode('terminal');
                            if (merged) {
                              if (selectedId === selectedWorktree?.id) requestSelectWorktree(null);
                            }
                            void refresh();
                          }}
                        />
                      </Suspense>
                    )}
                  </>
                ) : (
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>{t('app.selectWorktree')}</p>
                )}
                <LogPanel lines={logLines} />
              </section>
            </div>
          </div>
          {fanoutOpen && (
            <div className="fanout-overlay" data-testid="fanout-overlay">
              <Suspense
                fallback={
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>{t('app.loadingFanout')}</p>
                }
              >
                <FanoutView
                  base={baseBranch}
                  theme={resolvedTheme}
                  onMerged={() => void refresh()}
                />
              </Suspense>
            </div>
          )}
          {settingsOpen && !settingsLoading && (
            <SettingsModal
              settings={settings}
              onChange={(partial) => void saveSettings(partial)}
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
                  void refresh().then(() => requestSelectWorktree(wt.id));
                });
              }}
              onClose={() => setCrossMachineOpen(false)}
            />
          )}
          {pending && selectedFile && (
            <ConfirmDiscardModal
              fileName={selectedFile}
              saving={editor.saving}
              saveError={editor.saveError}
              onSave={() => void onGuardSave()}
              onDiscard={onGuardDiscard}
              onCancel={onGuardCancel}
            />
          )}
          {pendingRepoSwitch && (
            <div
              role="dialog"
              aria-modal="true"
              data-testid="repo-switch-dialog"
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
                <h2 style={{ marginTop: 0, fontSize: 16 }}>{t('app.repoSwitch.title')}</h2>
                <p style={{ fontSize: 13 }}>{t('app.repoSwitch.body')}</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                  <button
                    type="button"
                    data-testid="repo-switch-cancel"
                    onClick={() => setPendingRepoSwitch(null)}
                  >
                    {t('app.quit.cancel')}
                  </button>
                  <button
                    type="button"
                    data-testid="repo-switch-confirm"
                    onClick={() => {
                      const path = pendingRepoSwitch;
                      setPendingRepoSwitch(null);
                      void recentRepos.open(path);
                    }}
                  >
                    {t('app.repoSwitch.confirm')}
                  </button>
                </div>
              </div>
            </div>
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
                <h2 style={{ marginTop: 0, fontSize: 16 }}>{t('app.quit.title')}</h2>
                {quitWarning.activeWorktreeIds.length > 0 &&
                  (persistenceInfo?.effective === 'full' ? (
                    <p style={{ fontSize: 13 }}>
                      {t('app.quit.fullPersist', { count: quitWarning.activeWorktreeIds.length })}
                    </p>
                  ) : (
                    <p style={{ fontSize: 13 }}>
                      {t('app.quit.lite', { count: quitWarning.activeWorktreeIds.length })}
                    </p>
                  ))}
                {quitWarning.unsavedFileCount > 0 && (
                  <p data-testid="quit-unsaved" style={{ fontSize: 13 }}>
                    {t('app.quit.unsaved', { count: quitWarning.unsavedFileCount })}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                  <button type="button" onClick={() => void onQuitDecision(false)}>
                    {t('app.quit.cancel')}
                  </button>
                  {quitWarning.activeWorktreeIds.length > 0 &&
                  persistenceInfo?.effective === 'full' ? (
                    <>
                      <button
                        type="button"
                        data-testid="quit-stop-all"
                        onClick={() => void onQuitStopAll()}
                      >
                        {t('app.quit.stopAll')}
                      </button>
                      <button
                        type="button"
                        data-testid="quit-keep-running"
                        onClick={() => void onQuitDecision(true)}
                      >
                        {t('app.quit.keepRunning')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid="quit-anyway"
                      onClick={() => void onQuitDecision(true)}
                    >
                      {t('app.quit.anyway')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
        <StatusBar
          left={
            <UsageWidget
              status={usage.status}
              loading={usage.loading}
              onRefresh={() => void usage.refresh()}
            />
          }
          right={
            <UpdateProgressInline
              applyState={selfUpdate.state}
              latestVersion={update?.latestVersion ?? null}
              releaseUrl={update?.releaseUrl ?? null}
              onOpen={openExternal}
              onDismiss={() => {
                if (update?.latestVersion) {
                  void saveSettings({ lastDismissedUpdateVersion: update.latestVersion });
                }
              }}
            />
          }
        />
        <UpdateBanner
          status={update}
          dismissedVersion={settings.lastDismissedUpdateVersion}
          onDismiss={(version) => void saveSettings({ lastDismissedUpdateVersion: version })}
          onOpen={openExternal}
          applyState={selfUpdate.state}
          onUpdate={() => {
            if (update?.dmgUrl && update.latestVersion) {
              selfUpdate.start({ dmgUrl: update.dmgUrl, sha256: update.sha256 });
            }
          }}
        />
      </div>
    </I18nContext.Provider>
  );
}

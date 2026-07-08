import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuitWarningEvent, SessionPersistenceInfo } from '../shared/types';
import type { TerminalLayout } from '../shared/terminal-layout';
import { applyTheme, resolveTheme } from './lib/theme';
import { useFileEditor } from './hooks/use-file-editor';
import { useOpenTabs } from './hooks/use-open-tabs';
import type { WorktreeTabs } from '../shared/open-tabs';
import { NavButtons } from './components/editor/nav-buttons';
import { EditorTabs } from './components/editor/editor-tabs';
import { UsagesOverlay } from './components/editor/usages-overlay';
import { NavStatusBadge, type NavIndicatorState } from './components/statusbar/nav-status-badge';
import type { UsageLocation } from './lib/code-nav/find-usages';
import { decideUsages } from './lib/code-nav/usages-routing';
import { languageForPath } from './lib/language-for-path';
import type { CodeNavStatus, CodeNavCapabilities } from '../shared/types';
import { registerCodeNav } from './lib/code-nav/register-code-nav';
import { applyTsconfigToNav } from './lib/code-nav/ts-nav';
import { loadTsconfigNav } from './lib/code-nav/tsconfig-loader';
import { WorktreeModelRegistry } from './lib/code-nav/worktree-model-registry';
import { useWorktrees } from './hooks/use-worktrees';
import { useServer } from './hooks/use-server';
import { useLogs } from './hooks/use-logs';
import { useWorktreeStatus } from './hooks/use-worktree-status';
import { isRepoBusy } from './state/app-store';
import { useSessionRecords } from './hooks/use-session-records';
import { useSettings } from './hooks/use-settings';
import { useRepo } from './hooks/use-repo';
import { Titlebar } from './components/titlebar/titlebar';
import { FileTree } from './components/tree/file-tree';
import { FolderIcon } from './components/tree/tree-icons';
import { RepoList } from './components/sidebar/repo-list';
import { ProjectTree } from './components/sidebar/project-tree';
import { useRecentRepos } from './hooks/use-recent-repos';
import { useProjectGroups } from './hooks/use-project-groups';
import { useWorktreesFor } from './hooks/use-worktrees-for';
import { useProjectTreeExpanded } from './hooks/use-project-tree-expanded';
import type { ProjectTreeExpanded } from '../shared/project-groups';
import { usePaneLayout } from './hooks/use-pane-layout';
import { Split } from './components/layout/split';
import { DEFAULT_PANE_LAYOUT, PANE_BOUNDS } from '../shared/pane-layout';
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
import { detectServerUrl } from './lib/detect-server-url';
import { BrowserPane } from './components/browser/browser-pane';

// Lazy-loaded so the xterm.js bundle (+ addon-fit + its CSS) is only fetched when
// a worktree is first selected — keeps the initial renderer chunk smaller.
// The multi-terminal panel (agent + tiled $SHELL terminals) — pulls the xterm chunk, so it's
// lazy and only fetched once a worktree is selected.
const TerminalPanel = lazy(() =>
  import('./components/terminal/terminal-panel').then((m) => ({ default: m.TerminalPanel })),
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
  // Project tree (bottom-left): groups + lazy per-repo worktree listing for repos other than the
  // active one. The active repo's worktrees still come from useWorktrees (live status) below.
  const projectGroups = useProjectGroups();
  const worktreesFor = useWorktreesFor();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { worktrees, loading, error, remove, refresh } = useWorktrees();
  // `servers` still feeds the worktree status dots; the start/stop controls were removed from
  // the worktree pane (the list shows ONLY worktrees now). selectedServer + detectedServerUrl
  // still drive the browser-pane auto-open + BrowserPane.
  const { servers } = useServer();
  const selectedServer = selectedId ? (servers.get(selectedId) ?? null) : null;
  const logLines = useLogs(selectedId);
  const detectedServerUrl = detectServerUrl(logLines);
  const statuses = useWorktreeStatus(worktrees, servers);

  const sessionRecords = useSessionRecords();
  const { settings, loading: settingsLoading, save: saveSettings } = useSettings();
  // Four independent drag-resizable workspace splitters (A2d): live geometry + persist-on-end.
  const paneLayout = usePaneLayout(
    settings.paneLayout,
    (l) => void saveSettings({ paneLayout: l }),
  );
  // Project-tree expand/collapse state, persisted (a repo switch reloads the renderer, so the tree
  // needs to remember which groups/repos were open).
  const saveTreeExpanded = useCallback(
    (e: ProjectTreeExpanded): void => void saveSettings({ projectTreeExpanded: e }),
    [saveSettings],
  );
  const treeExpanded = useProjectTreeExpanded(settings.projectTreeExpanded, saveTreeExpanded);
  // Auto-reveal the active repo (and its containing group) the first time it appears, so the user
  // lands with their current worktree visible. One-shot per active path (a manual collapse sticks);
  // waits for groups to load so the group isn't missed by a race.
  const revealedActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const active = repo.repoRoot;
    if (!active || projectGroups.loading || revealedActiveRef.current === active) return;
    revealedActiveRef.current = active;
    const groupId = projectGroups.groups.find((g) => g.repoPaths.includes(active))?.id ?? null;
    treeExpanded.reveal(groupId, active);
  }, [repo.repoRoot, projectGroups.loading, projectGroups.groups, treeExpanded]);
  // Resolve the UI locale (explicit setting wins; otherwise follow the OS) and build the
  // i18n value App both provides (for child screens) and consumes (for its own titlebar).
  const locale = resolveLocale(settings.locale, navigator.language);
  const i18n = useMemo(() => ({ locale, t: makeT(locale) }), [locale]);
  const { t } = i18n;
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [paneMode, setPaneMode] = useState<'terminal' | 'diff' | 'conflict' | 'browser'>(
    'terminal',
  );
  // Worktree currently holding an in-progress (paused) merge conflict, or null.
  const [conflictWorktreeId, setConflictWorktreeId] = useState<string | null>(null);
  // relPath of the file open in the editor pane (A4 edits + saves it), or null.
  // Per-worktree editor tabs. active drives the editor; persisted per worktreeId (merged per key
  // so windows don't stomp). openTabsRef lets the stable/[]-dep switch callbacks mutate tabs.
  const saveOpenTabs = useCallback(
    (wt: string, tabs: WorktreeTabs): void => void saveSettings({ openTabs: { [wt]: tabs } }),
    [saveSettings],
  );
  const openTabs = useOpenTabs(selectedId, settings.openTabs, saveOpenTabs);
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  // The active tab IS the open file — a read-only alias so every existing read site is unchanged;
  // writes go through openTabs (open/activate/close) instead of a setter.
  const selectedFile = openTabs.active;
  // The A4 editor state for (selectedId, active tab). Auto-saves; App flushes it before any
  // switch/quit. editorRef lets the switch callbacks flush without taking `editor` as a dep.
  const editor = useFileEditor(selectedId, selectedFile);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // In-place repo switch (the sidebar): main tears down THIS window's agents/servers/LSP and
  // rebinds it to the new repo. Auto-save flushes the open file first; a live agent turn still
  // warrants a confirm (the editor no longer gates it — its buffer is already persisted).
  const requestRepoSwitch = async (path: string): Promise<void> => {
    // Await the flush so the open file is persisted BEFORE the window teardown/reload races it;
    // on write failure stay put (the saveError banner shows why) so the edit isn't lost.
    if (!(await editor.flush())) return;
    if (isRepoBusy(statuses)) setPendingRepoSwitch(path);
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
  const [canGoForward, setCanGoForward] = useState(false);
  // Back/forward stacks for code-nav jumps. navBusyRef serializes the async nav ops so a second
  // one that fires during a flush await can't pop the wrong entry off a stale snapshot.
  const navHistoryRef = useRef<Array<{ relPath: string; line: number; column: number }>>([]);
  const navForwardRef = useRef<Array<{ relPath: string; line: number; column: number }>>([]);
  const navBusyRef = useRef(false);
  const currentPosRef = useRef<{ line: number; column: number }>({ line: 1, column: 1 });

  // App's resolved theme ('dark'/'light'), fed to ALL monaco panes (process-global
  // theme). Initialized synchronously so there is no first-paint flash.
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() =>
    resolveTheme(settings.theme, window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
  // ONE matchMedia listener (inside applyTheme) owns BOTH <html data-theme> and
  // resolvedTheme — 'system'/unset tracks the OS; explicit modes set once.
  useEffect(() => applyTheme(settings.theme, setResolvedTheme), [settings.theme]);

  // ── Selection mutation: every worktree switch routes through applyWorktree; the active tab is
  // per-worktree (useOpenTabs keys on selectedId), so switching a worktree shows ITS tab set. Every
  // file/tab switch flushes the outgoing buffer first (auto-save), so no channel drops unsaved edits.

  /** Apply a worktree selection. The open file follows automatically (openTabs is keyed by the new
   *  selectedId); only the code-nav history/reveal + find-usages (worktree-scoped) are reset. */
  const applyWorktree = useCallback((id: string | null): void => {
    setSelectedId(id);
    // A worktree switch resets code-nav: its history + reveal belonged to the old worktree.
    setPendingReveal(null);
    navHistoryRef.current = [];
    navForwardRef.current = [];
    setCanGoBack(false);
    setCanGoForward(false);
    // Clear find-usages too: it stores worktree-relative paths (not mango URIs), so leaving
    // OLD-worktree rows around would let a later click re-bind them to the NEW selectedId and
    // open the wrong worktree's path (stale cross-worktree nav).
    setUsages([]);
    setUsagesLoading(false);
    setUsagesOverlayOpen(false);
    usagesPendingRef.current = false; // drop any in-flight find-usages so its late result can't nav
  }, []);

  /** Open a file in the editor. Auto-save flushes the outgoing file and only switches once it is
   *  durably persisted; on write failure it stays put (the saveError banner shows why), so edits
   *  are never silently dropped. A normal open also clears any pending nav-reveal. */
  const requestOpenFile = useCallback(
    async (relPath: string, opts?: { preview?: boolean }): Promise<void> => {
      // Switching files flushes the outgoing buffer first (block on failure). Re-opening the ACTIVE
      // file doesn't switch, but a pinned re-open can still promote a preview tab, so always
      // forward to open() — it is a no-op when nothing actually changes.
      if (relPath !== selectedFile && !(await editorRef.current.flush())) return;
      setPendingReveal(null);
      openTabsRef.current.open(relPath, opts); // preview: single-click; pinned: double-click / nav
    },
    [selectedFile],
  );

  /** Switch to an already-open tab (click). Flush the outgoing file first (block on failure); a tab
   *  click activates WITHOUT changing its preview/pinned status. */
  const onTabActivate = useCallback(async (relPath: string): Promise<void> => {
    if (relPath === openTabsRef.current.active) return;
    if (!(await editorRef.current.flush())) return;
    setPendingReveal(null);
    openTabsRef.current.activate(relPath);
  }, []);

  /** Promote a preview tab to pinned (double-clicking the tab). No file switch, so no flush. */
  const onPinTab = useCallback((relPath: string): void => {
    openTabsRef.current.pin(relPath);
  }, []);

  /** Close a tab. Closing the ACTIVE tab changes the shown file, so flush first (block on failure);
   *  closing a background tab leaves the active editor untouched. */
  const onTabClose = useCallback(async (relPath: string): Promise<void> => {
    if (relPath === openTabsRef.current.active && !(await editorRef.current.flush())) return;
    openTabsRef.current.close(relPath);
  }, []);

  /** Close every tab except `relPath` (context menu). If the active tab is among those closed, the
   *  shown file switches to `relPath`, so flush the outgoing buffer first (block on failure). */
  const onCloseOthers = useCallback(async (relPath: string): Promise<void> => {
    if (relPath !== openTabsRef.current.active && !(await editorRef.current.flush())) return;
    openTabsRef.current.closeOthers(relPath);
  }, []);

  /** Close every tab (context menu). The active file goes away, so flush it first. */
  const onCloseAll = useCallback(async (): Promise<void> => {
    if (openTabsRef.current.active && !(await editorRef.current.flush())) return;
    openTabsRef.current.closeAll();
  }, []);

  /** Select a worktree. Auto-save flushes the open file first and only switches on success. */
  const requestSelectWorktree = useCallback(
    async (id: string | null): Promise<void> => {
      if (id === selectedId) return;
      if (!(await editorRef.current.flush())) return;
      applyWorktree(id);
    },
    [selectedId, applyWorktree],
  );

  // ── Code navigation (Phase B) ──
  // Stable snapshot for the once-registered, process-global code-nav opener (reads refs so
  // it never goes stale despite [] deps).
  const navSelRef = useRef({ selectedId, selectedFile });
  navSelRef.current = { selectedId, selectedFile };

  /** Cross-file go-to-definition target (from monaco's editor-opener). Auto-saves the current
   *  file first (aborting the jump if that write fails), pushes the location for Back, then
   *  reveals the target. */
  const onCodeNavOpen = useCallback(
    async (
      worktreeId: string,
      relPath: string,
      position?: { line: number; column: number },
    ): Promise<void> => {
      if (worktreeId !== navSelRef.current.selectedId) return; // only within the selected worktree
      if (navBusyRef.current) return; // serialize with an in-flight nav op
      navBusyRef.current = true;
      try {
        const switching = relPath !== navSelRef.current.selectedFile;
        if (switching && !(await editorRef.current.flush())) return;
        const from = navSelRef.current.selectedFile; // re-read after the await
        if (from && from !== relPath) {
          navHistoryRef.current.push({ relPath: from, ...currentPosRef.current });
          setCanGoBack(true);
        }
        // A NEW jump invalidates the forward history (browser back/forward semantics).
        if (navForwardRef.current.length > 0) {
          navForwardRef.current = [];
          setCanGoForward(false);
        }
        setPendingReveal(
          position ? { relPath, line: position.line, column: position.column } : null,
        );
        if (relPath !== from) openTabsRef.current.open(relPath);
      } finally {
        navBusyRef.current = false;
      }
    },
    [],
  );

  // Find-usages (Phase B) shown in a FLOATING overlay (IntelliJ "Show Usages") that never
  // hijacks the terminal pane. CodeEditor reports loading then results; exactly one usage jumps
  // straight there, 0/2+ open the overlay. A row (click or Enter) routes through onCodeNavOpen.
  const [usages, setUsages] = useState<readonly UsageLocation[]>([]);
  const [usagesLoading, setUsagesLoading] = useState(false);
  const [usagesOverlayOpen, setUsagesOverlayOpen] = useState(false);
  // True while a find-usages request is in flight AND still wanted. collectUsages is async with no
  // cancellation, so a result that resolves AFTER the user dismissed the loading popup or switched
  // worktrees must be DROPPED — otherwise it re-opens the popup (stealing focus behind the backdrop)
  // or force-jumps the editor, possibly to the OLD worktree's paths. Dismiss / switch clears this.
  const usagesPendingRef = useRef(false);
  const closeUsages = useCallback((): void => {
    usagesPendingRef.current = false;
    setUsagesOverlayOpen(false);
  }, []);
  const onFindUsages = useCallback(
    (list: UsageLocation[] | null, loading: boolean): void => {
      if (loading) {
        usagesPendingRef.current = true;
        setUsagesLoading(true);
        setUsages([]);
        setUsagesOverlayOpen(true);
        return;
      }
      if (!usagesPendingRef.current) return; // dismissed or superseded while loading → drop the result
      usagesPendingRef.current = false;
      setUsagesLoading(false);
      const action = decideUsages(list ?? []);
      if (action.kind === 'jump') {
        setUsagesOverlayOpen(false);
        const wt = navSelRef.current.selectedId;
        if (wt) {
          const target = action.target;
          onCodeNavOpen(wt, target.relPath, { line: target.line, column: target.column });
        }
        return;
      }
      setUsages(action.usages);
      setUsagesOverlayOpen(true);
    },
    [onCodeNavOpen],
  );

  /** Traverse the code-nav history one step. `from`/`to` are the stack we pop the target off and
   *  the stack we push the current location onto (Back: history→forward, Forward: forward→history).
   *  Auto-saves first (block on failure — a failed write keeps the stacks) and serializes via
   *  navBusyRef so a concurrent nav can't act on a stale snapshot. */
  const navStep = useCallback(
    async (
      popStack: React.MutableRefObject<Array<{ relPath: string; line: number; column: number }>>,
      pushStack: React.MutableRefObject<Array<{ relPath: string; line: number; column: number }>>,
      setPopEnabled: (v: boolean) => void,
      setPushEnabled: (v: boolean) => void,
    ): Promise<void> => {
      if (navBusyRef.current || popStack.current.length === 0) return;
      navBusyRef.current = true;
      try {
        if (!(await editorRef.current.flush())) return; // failed write: keep stacks, stay put
        const target = popStack.current.pop();
        if (!target) return;
        const from = navSelRef.current.selectedFile; // re-read after the await
        if (from) {
          pushStack.current.push({ relPath: from, ...currentPosRef.current });
          setPushEnabled(true);
        }
        setPopEnabled(popStack.current.length > 0);
        setPendingReveal({ relPath: target.relPath, line: target.line, column: target.column });
        if (target.relPath !== from) openTabsRef.current.open(target.relPath);
      } finally {
        navBusyRef.current = false;
      }
    },
    [],
  );
  const onNavBack = useCallback(
    (): Promise<void> => navStep(navHistoryRef, navForwardRef, setCanGoBack, setCanGoForward),
    [navStep],
  );
  const onNavForward = useCallback(
    (): Promise<void> => navStep(navForwardRef, navHistoryRef, setCanGoForward, setCanGoBack),
    [navStep],
  );

  // Register the process-global code-nav providers + editor-opener ONCE (idempotent).
  useEffect(() => {
    registerCodeNav({ onOpen: onCodeNavOpen });
  }, [onCodeNavOpen]);

  // Java/Kotlin LSP status surface: a nav that returns [] is otherwise indistinguishable from a
  // starting/indexing/failed server. Track the latest per-(worktree,lang) runtime state (pushed
  // on CODENAV_STATUS) + the selected worktree's capabilities (for the "not installed" case).
  const [navStatus, setNavStatus] = useState<Record<string, CodeNavStatus>>({});
  const [navCaps, setNavCaps] = useState<CodeNavCapabilities | null>(null);
  useEffect(() => {
    return window.mango.codenav.onStatus((s) => {
      setNavStatus((prev) => ({ ...prev, [`${s.worktreeId}:${s.lang}`]: s }));
    });
  }, []);
  useEffect(() => {
    if (!selectedId) {
      setNavCaps(null);
      return;
    }
    let cancelled = false;
    window.mango.codenav
      .capabilities(selectedId)
      .then((c) => {
        if (!cancelled) setNavCaps(c);
      })
      .catch(() => {
        /* capability probe failure just leaves the badge silent */
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

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

  // Report this window's unsaved editor state to main for the quit warning (A4). `dirty` covers
  // BOTH windows a quit could lose work in: the ~400ms auto-save debounce (edits not yet written)
  // AND a write that FAILED (buffer kept, still != baseline). The beforeunload flush is only a
  // best-effort backstop — it can't await the async write — so this warning is the real safety
  // net. The editor tracks one open file, so this is 0 or 1; main sums it across windows.
  useEffect(() => {
    window.mango.app.setUnsaved(editor.dirty ? 1 : 0);
  }, [editor.dirty]);

  // Editing a preview tab promotes it to a pinned tab (IntelliJ behaviour): the first keystroke
  // makes it dirty, and a file you've started changing is no longer a throwaway preview.
  useEffect(() => {
    const o = openTabsRef.current;
    if (editor.dirty && o.active && o.active === o.preview) o.pin(o.active);
  }, [editor.dirty]);

  // Best-effort flush of a pending auto-save when the window is torn down (quit / reload), so a
  // keystroke typed inside the last debounce window is persisted. Switch/blur flushes cover the
  // rest; this is the final backstop.
  useEffect(() => {
    const onUnload = (): void => void editorRef.current.flush();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
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

  // Persist a worktree's terminal tile layout (TerminalPanel debounces to structural-change-end).
  // Prunes entries for worktrees that no longer exist so the map can't grow unbounded.
  const onTerminalPersist = useCallback(
    (wtId: string, layout: TerminalLayout): void => {
      const known = new Set(worktrees.map((w) => w.id));
      const next: Record<string, TerminalLayout> = { [wtId]: layout };
      for (const [k, v] of Object.entries(settings.terminalLayouts ?? {})) {
        if (known.has(k)) next[k] = v;
      }
      next[wtId] = layout;
      void saveSettings({ terminalLayouts: next });
    },
    [saveSettings, settings.terminalLayouts, worktrees],
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

  // Code-nav status badge: the active file's LSP language (Java/Kotlin only) + its current state.
  // Runtime status (from CODENAV_STATUS) wins; else fall back to "not installed" from capabilities.
  const navFileLang = selectedFile ? languageForPath(selectedFile) : null;
  const navLang: 'java' | 'kotlin' | null =
    navFileLang === 'java' || navFileLang === 'kotlin' ? navFileLang : null;
  const navIndicator: { state: NavIndicatorState | null; detail?: string } = (() => {
    if (!navLang || !selectedId) return { state: null };
    const runtime = navStatus[`${selectedId}:${navLang}`];
    if (runtime) return { state: runtime.state, detail: runtime.detail };
    const cap = navCaps?.[navLang];
    if (cap && !cap.available) return { state: 'unavailable', detail: cap.reason };
    return { state: null };
  })();

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
          {/* Four INDEPENDENT splitters (A2d): a main horizontal row split, and INSIDE each
              row its own vertical column split, plus a repo/tree split inside the top-left.
              Each <Split> owns its own drag + ResizeObserver re-clamp; the hook owns the 4
              persisted sizes. Monaco (automaticLayout) and the terminal (its own ResizeObserver)
              re-fit when their pane changes. */}
          <div className="workspace">
            <Split
              axis="y"
              unit="fraction"
              size={paneLayout.topRow.size}
              onResize={paneLayout.topRow.onResize}
              onResizeEnd={paneLayout.topRow.onResizeEnd}
              min={PANE_BOUNDS.minRowFraction}
              max={PANE_BOUNDS.maxRowFraction}
              minFirstPx={200}
              minSecondPx={160}
              defaultSize={DEFAULT_PANE_LAYOUT.topRowFraction}
              label={t('app.resizeRows')}
              testId="split-row-main"
              first={
                <Split
                  axis="x"
                  unit="px"
                  size={paneLayout.topLeft.size}
                  onResize={paneLayout.topLeft.onResize}
                  onResizeEnd={paneLayout.topLeft.onResizeEnd}
                  min={PANE_BOUNDS.minWidth}
                  max={PANE_BOUNDS.maxWidth}
                  minSecondPx={240}
                  defaultSize={DEFAULT_PANE_LAYOUT.topLeftWidth}
                  label={t('app.resizeColumns')}
                  testId="split-col-top"
                  first={
                    // Top-left is now the file tree ALONE (the repo switcher moved into the unified
                    // project tree at bottom-left), so it fills the full column height.
                    <div className="ws-pane ws-tree">
                      <div className="pane-head">
                        <span className="pane-head-ico">
                          <FolderIcon open={false} />
                        </span>
                        {t('app.project')}
                      </div>
                      <FileTree
                        worktreeId={selectedId}
                        selectedFile={selectedFile}
                        onOpenFile={(p, opts) => void requestOpenFile(p, opts)}
                      />
                    </div>
                  }
                  second={
                    <div className="ws-pane ws-editor">
                      <div className="pane-head">
                        <NavButtons
                          canGoBack={canGoBack}
                          canGoForward={canGoForward}
                          onBack={() => void onNavBack()}
                          onForward={() => void onNavForward()}
                        />
                        <EditorTabs
                          tabs={openTabs.tabs}
                          active={openTabs.active}
                          preview={openTabs.preview}
                          dirty={editor.dirty}
                          saveError={editor.saveError !== null}
                          onActivate={(p) => void onTabActivate(p)}
                          onPin={onPinTab}
                          onClose={(p) => void onTabClose(p)}
                          onCloseOthers={(p) => void onCloseOthers(p)}
                          onCloseAll={() => void onCloseAll()}
                        />
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
                            fallback={
                              <div className="pane-placeholder">{t('app.editorLoading')}</div>
                            }
                          >
                            <CodeEditor
                              worktreeId={selectedId}
                              relPath={selectedFile}
                              theme={resolvedTheme}
                              content={editor.content}
                              readOnly={editor.readOnly}
                              openPaths={openTabs.tabs}
                              reveal={
                                pendingReveal?.relPath === selectedFile
                                  ? { line: pendingReveal.line, column: pendingReveal.column }
                                  : null
                              }
                              onChange={editor.setValue}
                              onSaveRequested={() => void editor.flush()}
                              onBlur={() => void editor.flush()}
                              onCursor={(line, column) => {
                                currentPosRef.current = { line, column };
                              }}
                              onUsages={onFindUsages}
                            />
                          </Suspense>
                        </div>
                      )}
                    </div>
                  }
                />
              }
              second={
                <Split
                  axis="x"
                  unit="px"
                  size={paneLayout.bottomLeft.size}
                  onResize={paneLayout.bottomLeft.onResize}
                  onResizeEnd={paneLayout.bottomLeft.onResizeEnd}
                  min={PANE_BOUNDS.minWidth}
                  max={PANE_BOUNDS.maxWidth}
                  minSecondPx={240}
                  defaultSize={DEFAULT_PANE_LAYOUT.bottomLeftWidth}
                  label={t('app.resizeColumns')}
                  testId="split-col-bottom"
                  first={
                    <div className="ws-pane ws-projects">
                      <ProjectTree
                        repos={recentRepos.repos}
                        groups={projectGroups.groups}
                        activeWorktrees={worktrees}
                        activeLoading={loading}
                        activeError={error}
                        statuses={statuses}
                        selectedId={selectedId}
                        worktreesFor={worktreesFor}
                        expanded={treeExpanded}
                        onSelectWorktree={requestSelectWorktree}
                        onSwitchRepo={requestRepoSwitch}
                        onRemoveWorktree={(id) => {
                          void remove(id);
                          // Prune the removed worktree's persisted tabs so the openTabs map can't
                          // grow unbounded across create/delete cycles (store deletes an empty key).
                          saveOpenTabs(id, { open: [], active: null });
                        }}
                        onAddRepo={() =>
                          void repo.pick().then((r) => {
                            if (r.ok) void recentRepos.refresh();
                          })
                        }
                      />
                    </div>
                  }
                  second={
                    <div className="ws-pane ws-terminal">
                      <section
                        className="pane-body"
                        style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
                      >
                        {selectedId ? (
                          <>
                            {/* A merge conflict (when present) overlays the terminal panel
                                full-area; this switch toggles back to the terminals. */}
                            {conflictWorktreeId === selectedId && (
                              <div
                                role="tablist"
                                aria-label={t('app.worktreeView')}
                                className="ws-tabs term-conflict-switch"
                              >
                                <button
                                  type="button"
                                  role="tab"
                                  className="ws-tab"
                                  aria-selected={paneMode !== 'conflict'}
                                  data-testid="tab-terminal"
                                  onClick={() => setPaneMode('terminal')}
                                >
                                  {t('app.tab.terminal')}
                                </button>
                                <button
                                  type="button"
                                  role="tab"
                                  className="ws-tab ws-tab-warn"
                                  aria-selected={paneMode === 'conflict'}
                                  data-testid="tab-conflict"
                                  onClick={() => setPaneMode('conflict')}
                                >
                                  {t('app.tab.conflicts')}
                                </button>
                              </div>
                            )}
                            {/* The multi-terminal tile panel: agent + $SHELL terminals, drag a tab
                                onto a tile edge to split (up to 4), layout persisted per worktree.
                                Hidden (kept mounted) only while the conflict view is up. */}
                            <div
                              style={{
                                display: paneMode === 'conflict' ? 'none' : 'flex',
                                flexDirection: 'column',
                                flex: 1,
                                minHeight: 0,
                              }}
                            >
                              <Suspense
                                fallback={
                                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                                    {t('app.loadingTerminal')}
                                  </p>
                                }
                              >
                                {sessionRecords.loading ? (
                                  // Wait for the session records before mounting: the panel decides
                                  // agent-vs-shell from continueAgent at mount, and a loading-window
                                  // false would wrongly open a shell for a worktree that has a session.
                                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                                    {t('app.loadingTerminal')}
                                  </p>
                                ) : (
                                  <TerminalPanel
                                    key={selectedId}
                                    worktreeId={selectedId}
                                    worktreePath={selectedWorktree?.path ?? selectedId}
                                    continueAgent={sessionRecords.has(selectedId)}
                                    persisted={settings.terminalLayouts?.[selectedId]}
                                    onPersist={(layout) => onTerminalPersist(selectedId, layout)}
                                  />
                                )}
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
                              <BrowserPane
                                key={`browser-${selectedId}`}
                                detectedUrl={detectedServerUrl}
                              />
                            )}
                            {/* Find-usages is shown in a floating overlay (mounted below), not
                                this pane — the terminal pane stays terminal-only. */}
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
                                      if (selectedId === selectedWorktree?.id)
                                        requestSelectWorktree(null);
                                    }
                                    void refresh();
                                  }}
                                />
                              </Suspense>
                            )}
                          </>
                        ) : (
                          <p style={{ fontSize: 13, color: 'var(--muted)' }}>
                            {t('app.selectWorktree')}
                          </p>
                        )}
                      </section>
                    </div>
                  }
                />
              }
            />
          </div>
          {settingsOpen && !settingsLoading && (
            <SettingsModal
              settings={settings}
              onChange={(partial) => void saveSettings(partial)}
              onClose={() => setSettingsOpen(false)}
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
            <>
              <UsageWidget
                status={usage.status}
                loading={usage.loading}
                onRefresh={() => void usage.refresh()}
              />
              <NavStatusBadge
                lang={navLang}
                state={navIndicator.state}
                detail={navIndicator.detail}
              />
            </>
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
        {usagesOverlayOpen && (
          <UsagesOverlay
            usages={usages}
            loading={usagesLoading}
            onOpen={(relPath, line, column) => {
              if (selectedId) onCodeNavOpen(selectedId, relPath, { line, column });
            }}
            onClose={closeUsages}
          />
        )}
      </div>
    </I18nContext.Provider>
  );
}

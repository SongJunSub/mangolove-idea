import { useEffect } from 'react';
import type { AgentStatus, RecentRepo, Worktree } from '../../../shared/types';
import type { ProjectGroup } from '../../../shared/project-groups';
import type { WorktreeRowStatus } from '../../state/app-store';
import type { UseWorktreesFor } from '../../hooks/use-worktrees-for';
import type { UseProjectTreeExpanded } from '../../hooks/use-project-tree-expanded';
import { useI18n } from '../../i18n/i18n-context';
import { AGENT_STATUS_KEY } from '../../i18n/status-keys';
import { Chevron, FolderIcon } from '../tree/tree-icons';
import { ServerDot } from './server-dot';

/** Agent-status dot colors — mirrors the worktree row idiom (STATUS_COLOR). */
const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'var(--faint)',
  starting: 'var(--warn)',
  running: 'var(--ok)',
  exited: 'var(--muted)',
  error: 'var(--err)',
};

/** Last path segment as the repo's display name (matches RepoList). */
function repoName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** Enter/Space activates a row; Arrow keys expand/collapse a branch node (partial WAI-ARIA tree). */
function rowKeyHandler(opts: {
  activate(): void;
  expand?(): void;
  collapse?(): void;
}): (e: React.KeyboardEvent) => void {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      opts.activate();
    } else if (e.key === 'ArrowRight') {
      opts.expand?.();
    } else if (e.key === 'ArrowLeft') {
      opts.collapse?.();
    }
  };
}

/** A collapse/expand chevron that never propagates its click to the row (so it won't switch repos). */
function ChevronButton({ open, onToggle }: { open: boolean; onToggle(): void }): React.JSX.Element {
  return (
    <span
      className="pt-chev"
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Chevron open={open} />
    </span>
  );
}

/** One worktree leaf. Active-repo rows carry the live status dot + optional Remove; static otherwise. */
function WorktreeRow({
  worktree,
  level,
  repoActive,
  selected,
  status,
  onActivate,
  onRemove,
}: {
  readonly worktree: Worktree;
  readonly level: number;
  readonly repoActive: boolean;
  readonly selected: boolean;
  readonly status: WorktreeRowStatus | undefined;
  onActivate(): void;
  onRemove?(id: string): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const agent = status?.agent ?? 'idle';
  const agentLabel = t('worktree.agentDot', { status: t(AGENT_STATUS_KEY[agent]) });
  const removable = onRemove && !worktree.isPrimary && !worktree.isLocked;
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={selected}
      tabIndex={0}
      data-testid="worktree-item"
      className={`pt-row pt-wt${selected ? ' sel' : ''}`}
      title={worktree.branch}
      onClick={onActivate}
      onKeyDown={rowKeyHandler({ activate: onActivate })}
    >
      <span className="pt-indent" style={{ width: level * 14 }} />
      {repoActive ? (
        <span
          className="pt-dot"
          aria-label={agentLabel}
          title={agentLabel}
          style={{ background: STATUS_COLOR[agent] }}
        />
      ) : (
        <span className="pt-dot pt-dot--static" aria-hidden="true" />
      )}
      {repoActive && status?.ownsServer && <ServerDot state={status.server} />}
      <span className="pt-branch">{worktree.branch}</span>
      {worktree.isPrimary && <span className="pt-badge">{t('worktree.primary')}</span>}
      {worktree.isLocked && <span className="pt-badge pt-badge--warn">{t('worktree.locked')}</span>}
      {worktree.head && <span className="pt-head">{worktree.head}</span>}
      {removable && (
        <button
          type="button"
          className="pt-remove"
          title={t('worktree.removeTip.default')}
          aria-label={t('worktree.remove')}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(worktree.id);
          }}
        >
          {t('worktree.remove')}
        </button>
      )}
    </div>
  );
}

/** Shared props threaded from ProjectTree down to each repo node. */
interface RepoNodeContext {
  readonly activeWorktrees: readonly Worktree[];
  readonly activeLoading: boolean;
  readonly activeError: string | null;
  readonly statuses: ReadonlyMap<string, WorktreeRowStatus>;
  readonly selectedId: string | null;
  readonly worktreesFor: UseWorktreesFor;
  readonly expanded: UseProjectTreeExpanded;
  onSelectWorktree(id: string): void;
  onSwitchRepo(path: string): void;
  onRemoveWorktree(id: string): void;
}

/** A repo node: header (switch when non-active / toggle when active) + lazily-loaded worktrees. */
function RepoNode({
  repo,
  level,
  ctx,
}: {
  readonly repo: RecentRepo;
  readonly level: number;
  readonly ctx: RepoNodeContext;
}): React.JSX.Element {
  const { t } = useI18n();
  const open = ctx.expanded.isRepoExpanded(repo.path);
  const active = repo.active;
  const { ensureLoaded } = ctx.worktreesFor;

  // Lazy-load a non-active repo's worktrees whenever it is (or becomes) expanded — covers both a
  // fresh toggle and a repo already expanded from persisted state on mount. ensureLoaded is a no-op
  // once loaded, so this is safe to run on every open change.
  useEffect(() => {
    if (open && !active) ensureLoaded(repo.path);
  }, [open, active, repo.path, ensureLoaded]);

  const remote = active ? null : ctx.worktreesFor.stateFor(repo.path);
  const worktrees = active ? ctx.activeWorktrees : (remote?.worktrees ?? []);
  const loading = active ? ctx.activeLoading : remote?.status === 'loading';
  const error = active ? ctx.activeError : (remote?.error ?? null);

  const toggle = (): void => ctx.expanded.toggleRepo(repo.path);
  // A non-active repo row SWITCHES to that repo; the active repo's row just toggles its worktrees.
  const activateRow = (): void => {
    if (active) toggle();
    else ctx.onSwitchRepo(repo.path);
  };

  return (
    <div className="pt-repo-wrap">
      <div
        role="treeitem"
        aria-level={level}
        aria-expanded={open}
        aria-current={active ? 'true' : undefined}
        tabIndex={0}
        data-testid={`repo-node-${repoName(repo.path)}`}
        className={`pt-row pt-repo${active ? ' active' : ''}`}
        title={repo.path}
        onClick={activateRow}
        onKeyDown={rowKeyHandler({
          activate: activateRow,
          expand: () => {
            if (!open) toggle();
          },
          collapse: () => {
            if (open) toggle();
          },
        })}
      >
        <span className="pt-indent" style={{ width: (level - 1) * 14 }} />
        <ChevronButton open={open} onToggle={toggle} />
        <span className="pt-ico pt-repo-ico">
          <FolderIcon open={active} />
        </span>
        <span className="pt-name">{repoName(repo.path)}</span>
        {active && <span className="pt-here">{t('projectTree.here')}</span>}
        {worktrees.length > 0 && <span className="pt-chip">{worktrees.length}</span>}
      </div>
      {open && (
        <div role="group">
          {error && (
            <p className="pt-note pt-error" style={{ paddingLeft: level * 14 + 22 }}>
              {t('projectTree.error')}
            </p>
          )}
          {loading && worktrees.length === 0 && (
            <p className="pt-note" style={{ paddingLeft: level * 14 + 22 }}>
              {t('projectTree.loading')}
            </p>
          )}
          {!loading && !error && worktrees.length === 0 && (
            <p className="pt-note" style={{ paddingLeft: level * 14 + 22 }}>
              {t('projectTree.noWorktrees')}
            </p>
          )}
          {worktrees.map((wt) => (
            <WorktreeRow
              key={wt.id}
              worktree={wt}
              level={level + 1}
              repoActive={active}
              selected={active && wt.id === ctx.selectedId}
              status={active ? ctx.statuses.get(wt.id) : undefined}
              onActivate={() =>
                active ? ctx.onSelectWorktree(wt.id) : ctx.onSwitchRepo(repo.path)
              }
              onRemove={active ? ctx.onRemoveWorktree : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A project group: header (toggle) + its member repos (nested one level deeper). */
function GroupNode({
  group,
  repos,
  ctx,
}: {
  readonly group: ProjectGroup;
  readonly repos: readonly RecentRepo[];
  readonly ctx: RepoNodeContext;
}): React.JSX.Element {
  const { t } = useI18n();
  const open = ctx.expanded.isGroupExpanded(group.id);
  const toggle = (): void => ctx.expanded.toggleGroup(group.id);
  return (
    <div className="pt-group-wrap">
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={open}
        tabIndex={0}
        data-testid={`group-node-${group.name}`}
        className="pt-row pt-group"
        onClick={toggle}
        onKeyDown={rowKeyHandler({
          activate: toggle,
          expand: () => {
            if (!open) toggle();
          },
          collapse: () => {
            if (open) toggle();
          },
        })}
      >
        <ChevronButton open={open} onToggle={toggle} />
        <span className="pt-ico pt-group-ico">
          <FolderIcon open={open} />
        </span>
        <span className="pt-name pt-group-name">{group.name}</span>
        <span className="pt-chip">{group.repoPaths.length}</span>
      </div>
      {open && (
        <div role="group">
          {repos.map((r) => (
            <RepoNode key={r.path} repo={r} level={2} ctx={ctx} />
          ))}
          {repos.length === 0 && (
            <p className="pt-note" style={{ paddingLeft: 36 }}>
              {t('projectTree.emptyGroup')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Props for the unified project tree (groups → repos → worktrees). */
export interface ProjectTreeProps {
  /** Known repos (canonical, active flagged) — the source of truth for what exists. */
  readonly repos: readonly RecentRepo[];
  /** Project groups (a view over repos); ungrouped repos render at the top level. */
  readonly groups: readonly ProjectGroup[];
  /** The active repo's LIVE worktrees (real status), from useWorktrees. */
  readonly activeWorktrees: readonly Worktree[];
  readonly activeLoading: boolean;
  readonly activeError: string | null;
  /** Live agent/server status for the active repo's worktrees. */
  readonly statuses: ReadonlyMap<string, WorktreeRowStatus>;
  /** The selected worktree id (only meaningful within the active repo). */
  readonly selectedId: string | null;
  /** Lazy loader for NON-active repos' worktrees (static snapshot, no live status). */
  readonly worktreesFor: UseWorktreesFor;
  /** Expand/collapse state (persisted). */
  readonly expanded: UseProjectTreeExpanded;
  onSelectWorktree(id: string): void;
  onSwitchRepo(path: string): void;
  onRemoveWorktree(id: string): void;
  onAddRepo(): void;
}

/**
 * The unified project navigator: project groups → repositories → worktrees, each level
 * independently collapsible (Orca-style). Replaces the separate repo switcher + worktree list.
 * Repos not in any group render at the top level; the active repo's worktrees are live while other
 * repos are lazily listed read-only. Clicking a non-active repo (or one of its worktrees) switches
 * to it; clicking an active-repo worktree selects it.
 */
export function ProjectTree({
  repos,
  groups,
  activeWorktrees,
  activeLoading,
  activeError,
  statuses,
  selectedId,
  worktreesFor,
  expanded,
  onSelectWorktree,
  onSwitchRepo,
  onRemoveWorktree,
  onAddRepo,
}: ProjectTreeProps): React.JSX.Element {
  const { t } = useI18n();
  const byPath = new Map(repos.map((r) => [r.path, r]));
  const grouped = new Set(groups.flatMap((g) => [...g.repoPaths]));
  const ungrouped = repos.filter((r) => !grouped.has(r.path));

  const ctx: RepoNodeContext = {
    activeWorktrees,
    activeLoading,
    activeError,
    statuses,
    selectedId,
    worktreesFor,
    expanded,
    onSelectWorktree,
    onSwitchRepo,
    onRemoveWorktree,
  };

  return (
    <div className="project-tree" data-testid="project-tree">
      <div className="pane-head pane-head--count">
        <span className="pane-head-ico">
          <FolderIcon open={false} />
        </span>
        <span className="pt-title">{t('app.projects')}</span>
        <span className="wt-count" data-testid="project-count">
          {repos.length}
        </span>
        <button
          type="button"
          className="repo-add"
          data-testid="repo-add"
          title={t('app.repoAdd')}
          aria-label={t('app.repoAdd')}
          onClick={onAddRepo}
        >
          +
        </button>
      </div>
      <div className="project-tree-body" role="tree" aria-label={t('app.projects')}>
        {groups.map((g) => (
          <GroupNode
            key={g.id}
            group={g}
            repos={g.repoPaths.map((p) => byPath.get(p)).filter((r): r is RecentRepo => Boolean(r))}
            ctx={ctx}
          />
        ))}
        {ungrouped.map((r) => (
          <RepoNode key={r.path} repo={r} level={1} ctx={ctx} />
        ))}
        {repos.length === 0 && <p className="wt-empty">{t('projectTree.empty')}</p>}
      </div>
    </div>
  );
}

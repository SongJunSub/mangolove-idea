import { useEffect, useState } from 'react';
import type { AgentStatus, RecentRepo, Worktree } from '../../../shared/types';
import type { ProjectGroup } from '../../../shared/project-groups';
import type { WorktreeRowStatus } from '../../state/app-store';
import type { UseWorktreesFor } from '../../hooks/use-worktrees-for';
import type { UseProjectTreeExpanded } from '../../hooks/use-project-tree-expanded';
import { useI18n } from '../../i18n/i18n-context';
import { AGENT_STATUS_KEY } from '../../i18n/status-keys';
import { Chevron, FolderIcon } from '../tree/tree-icons';
import { ServerDot } from './server-dot';

/** Custom drag payload type so a repo drag never collides with file/text drops. */
const DRAG_TYPE = 'application/x-mango-repo';
/** Sentinel drop-target id for "drop here to ungroup" (the tree body outside any group). */
const UNGROUPED = '__ungrouped__';

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

/** True when a drag event carries a repo payload (so we only accept repo drops). */
function isRepoDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(DRAG_TYPE);
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

/** Inline text field for creating/renaming a group: Enter submits, Escape/blur cancels. */
function InlineNameInput({
  initial,
  placeholder,
  testId,
  onSubmit,
  onCancel,
}: {
  readonly initial: string;
  readonly placeholder: string;
  readonly testId: string;
  onSubmit(value: string): void;
  onCancel(): void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      className="pt-name-input"
      data-testid={testId}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onSubmit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCancel}
    />
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

/** Shared props threaded from ProjectTree down to each node. */
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
  // ── interactive (Phase 4): grouping via drag + context menu ──
  onRepoMenu(e: React.MouseEvent, repoPath: string): void;
  onGroupMenu(e: React.MouseEvent, groupId: string): void;
  onRepoDragStart(e: React.DragEvent, repoPath: string): void;
  onDragEnd(): void;
  renamingGroupId: string | null;
  onRenameSubmit(id: string, name: string): void;
  onRenameCancel(): void;
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
        draggable
        data-testid={`repo-node-${repoName(repo.path)}`}
        className={`pt-row pt-repo${active ? ' active' : ''}`}
        title={repo.path}
        onClick={activateRow}
        onContextMenu={(e) => ctx.onRepoMenu(e, repo.path)}
        onDragStart={(e) => ctx.onRepoDragStart(e, repo.path)}
        onDragEnd={ctx.onDragEnd}
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

/** A project group: header (toggle / rename) + its member repos; a drop target for repo drags. */
function GroupNode({
  group,
  repos,
  ctx,
  dropActive,
  onDropRepo,
  onDragOverGroup,
}: {
  readonly group: ProjectGroup;
  readonly repos: readonly RecentRepo[];
  readonly ctx: RepoNodeContext;
  readonly dropActive: boolean;
  onDropRepo(e: React.DragEvent, groupId: string): void;
  onDragOverGroup(e: React.DragEvent, groupId: string): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const open = ctx.expanded.isGroupExpanded(group.id);
  const toggle = (): void => ctx.expanded.toggleGroup(group.id);
  const renaming = ctx.renamingGroupId === group.id;
  return (
    <div
      className={`pt-group-wrap${dropActive ? ' pt-drop' : ''}`}
      onDragOver={(e) => onDragOverGroup(e, group.id)}
      onDrop={(e) => onDropRepo(e, group.id)}
    >
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={open}
        tabIndex={0}
        data-testid={`group-node-${group.name}`}
        className="pt-row pt-group"
        onClick={renaming ? undefined : toggle}
        onContextMenu={(e) => ctx.onGroupMenu(e, group.id)}
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
        {renaming ? (
          <InlineNameInput
            initial={group.name}
            placeholder={t('projectTree.newGroupPlaceholder')}
            testId={`group-rename-${group.id}`}
            onSubmit={(v) => ctx.onRenameSubmit(group.id, v)}
            onCancel={ctx.onRenameCancel}
          />
        ) : (
          <span className="pt-name pt-group-name">{group.name}</span>
        )}
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
  // ── grouping mutations (from useProjectGroups) ──
  onCreateGroup(name: string): Promise<string | null>;
  onRenameGroup(id: string, name: string): void;
  onRemoveGroup(id: string): void;
  onAssignRepo(repoPath: string, groupId: string | null): void;
}

type Menu =
  | { readonly kind: 'header'; readonly x: number; readonly y: number }
  | { readonly kind: 'repo'; readonly repoPath: string; readonly x: number; readonly y: number }
  | { readonly kind: 'group'; readonly groupId: string; readonly x: number; readonly y: number };

/**
 * The unified project navigator: project groups → repositories → worktrees, each level
 * independently collapsible (Orca-style). Replaces the separate repo switcher + worktree list.
 * Repos not in any group render at the top level; the active repo's worktrees are live while other
 * repos are lazily listed read-only. Clicking a non-active repo (or one of its worktrees) switches
 * to it; clicking an active-repo worktree selects it. Repos are dragged onto a group to join it (or
 * to the empty area to ungroup); right-click a repo/group for the same actions + new-group/rename.
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
  onCreateGroup,
  onRenameGroup,
  onRemoveGroup,
  onAssignRepo,
}: ProjectTreeProps): React.JSX.Element {
  const { t } = useI18n();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  // When non-null, an inline "create group" input is shown; repoPath (if set) joins the new group.
  const [creating, setCreating] = useState<{ repoPath: string | null } | null>(null);
  // The current drop target during a repo drag (a group id or UNGROUPED); drives the highlight.
  const [dragTarget, setDragTarget] = useState<string | null>(null);

  const byPath = new Map(repos.map((r) => [r.path, r]));
  const grouped = new Set(groups.flatMap((g) => [...g.repoPaths]));
  const ungrouped = repos.filter((r) => !grouped.has(r.path));
  const groupOf = (repoPath: string): ProjectGroup | undefined =>
    groups.find((g) => g.repoPaths.includes(repoPath));

  const submitCreate = async (name: string): Promise<void> => {
    const repoPath = creating?.repoPath ?? null;
    setCreating(null);
    const id = await onCreateGroup(name);
    if (id && repoPath) onAssignRepo(repoPath, id);
  };

  const onDropRepo = (e: React.DragEvent, groupId: string | null): void => {
    if (!isRepoDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const path = e.dataTransfer.getData(DRAG_TYPE);
    if (path) onAssignRepo(path, groupId);
    setDragTarget(null);
  };
  const onDragOver = (e: React.DragEvent, target: string): void => {
    if (!isRepoDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragTarget(target);
  };

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
    onRepoMenu: (e, repoPath) => {
      e.preventDefault();
      setMenu({ kind: 'repo', repoPath, x: e.clientX, y: e.clientY });
    },
    onGroupMenu: (e, groupId) => {
      e.preventDefault();
      setMenu({ kind: 'group', groupId, x: e.clientX, y: e.clientY });
    },
    onRepoDragStart: (e, repoPath) => {
      e.dataTransfer.setData(DRAG_TYPE, repoPath);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => setDragTarget(null),
    renamingGroupId,
    onRenameSubmit: (id, name) => {
      setRenamingGroupId(null);
      onRenameGroup(id, name);
    },
    onRenameCancel: () => setRenamingGroupId(null),
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
          data-testid="project-add"
          title={t('projectTree.menu.add')}
          aria-label={t('projectTree.menu.add')}
          onClick={(e) => setMenu({ kind: 'header', x: e.clientX, y: e.clientY })}
        >
          +
        </button>
      </div>
      <div
        className={`project-tree-body${dragTarget === UNGROUPED ? ' pt-drop-root' : ''}`}
        role="tree"
        aria-label={t('app.projects')}
        onDragOver={(e) => onDragOver(e, UNGROUPED)}
        onDrop={(e) => onDropRepo(e, null)}
      >
        {creating && (
          <InlineNameInput
            initial=""
            placeholder={t('projectTree.newGroupPlaceholder')}
            testId="new-group-input"
            onSubmit={(v) => void submitCreate(v)}
            onCancel={() => setCreating(null)}
          />
        )}
        {groups.map((g) => (
          <GroupNode
            key={g.id}
            group={g}
            repos={g.repoPaths.map((p) => byPath.get(p)).filter((r): r is RecentRepo => Boolean(r))}
            ctx={ctx}
            dropActive={dragTarget === g.id}
            onDropRepo={(e) => onDropRepo(e, g.id)}
            onDragOverGroup={(e) => onDragOver(e, g.id)}
          />
        ))}
        {ungrouped.map((r) => (
          <RepoNode key={r.path} repo={r} level={1} ctx={ctx} />
        ))}
        {repos.length === 0 && <p className="wt-empty">{t('projectTree.empty')}</p>}
      </div>

      {menu && (
        <>
          <div
            className="tab-menu-backdrop"
            data-testid="project-menu-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="tab-menu"
            data-testid="project-menu"
            style={{ left: menu.x, top: menu.y }}
          >
            {menu.kind === 'header' && (
              <>
                <button
                  type="button"
                  className="tab-menu-item"
                  data-testid="menu-add-repo"
                  onClick={() => {
                    setMenu(null);
                    onAddRepo();
                  }}
                >
                  {t('app.repoAdd')}
                </button>
                <button
                  type="button"
                  className="tab-menu-item"
                  data-testid="menu-new-group"
                  onClick={() => {
                    setMenu(null);
                    setCreating({ repoPath: null });
                  }}
                >
                  {t('projectTree.menu.newGroup')}
                </button>
              </>
            )}
            {menu.kind === 'repo' &&
              (() => {
                const current = groupOf(menu.repoPath);
                return (
                  <>
                    <button
                      type="button"
                      className="tab-menu-item"
                      data-testid="menu-new-group"
                      onClick={() => {
                        setCreating({ repoPath: menu.repoPath });
                        setMenu(null);
                      }}
                    >
                      {t('projectTree.menu.newGroupWithRepo')}
                    </button>
                    {groups
                      .filter((g) => g.id !== current?.id)
                      .map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          className="tab-menu-item"
                          onClick={() => {
                            onAssignRepo(menu.repoPath, g.id);
                            setMenu(null);
                          }}
                        >
                          {t('projectTree.menu.addTo', { name: g.name })}
                        </button>
                      ))}
                    {current && (
                      <button
                        type="button"
                        className="tab-menu-item"
                        data-testid="menu-remove-from-group"
                        onClick={() => {
                          onAssignRepo(menu.repoPath, null);
                          setMenu(null);
                        }}
                      >
                        {t('projectTree.menu.removeFromGroup')}
                      </button>
                    )}
                  </>
                );
              })()}
            {menu.kind === 'group' && (
              <>
                <button
                  type="button"
                  className="tab-menu-item"
                  data-testid="menu-rename-group"
                  onClick={() => {
                    setRenamingGroupId(menu.groupId);
                    setMenu(null);
                  }}
                >
                  {t('projectTree.menu.rename')}
                </button>
                <button
                  type="button"
                  className="tab-menu-item"
                  data-testid="menu-ungroup"
                  onClick={() => {
                    onRemoveGroup(menu.groupId);
                    setMenu(null);
                  }}
                >
                  {t('projectTree.menu.ungroup')}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

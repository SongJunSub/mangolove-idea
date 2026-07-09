import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProjectTree } from '../../src/renderer/components/sidebar/project-tree';
import { useWorktreesFor } from '../../src/renderer/hooks/use-worktrees-for';
import { useProjectTreeExpanded } from '../../src/renderer/hooks/use-project-tree-expanded';
import { renderWithI18n } from './i18n-test-util';
import type { RecentRepo, Worktree } from '../../src/shared/types';
import type { ProjectGroup, ProjectTreeExpanded } from '../../src/shared/project-groups';
import type { WorktreeRowStatus } from '../../src/renderer/state/app-store';

const ACTIVE = '/Users/me/crs';
const OTHER = '/Users/me/mangolove-idea';
const DRAG_TYPE = 'application/x-mango-repo';

const repos: RecentRepo[] = [
  { path: ACTIVE, active: true },
  { path: OTHER, active: false },
];
const groups: ProjectGroup[] = [{ id: 'g1', name: 'CRS', repoPaths: [ACTIVE] }];

function wt(id: string, branch: string, isPrimary = false): Worktree {
  return { id, path: id, branch, isPrimary, isLocked: false };
}
const activeWorktrees: Worktree[] = [
  wt(`${ACTIVE}/main`, 'main', true),
  wt(`${ACTIVE}/feat`, 'feature/x'),
];
const statuses = new Map<string, WorktreeRowStatus>([
  [`${ACTIVE}/feat`, { agent: 'running', server: 'stopped', ownsServer: false }],
]);

/** A minimal DataTransfer carrying a repo path (jsdom lacks a real one). */
function repoDrag(path: string): Partial<DataTransfer> {
  const store: Record<string, string> = { [DRAG_TYPE]: path };
  return {
    types: [DRAG_TYPE],
    getData: (t: string) => store[t] ?? '',
    setData: (t: string, v: string) => {
      store[t] = v;
    },
  } as unknown as DataTransfer;
}

interface HarnessProps {
  repos?: RecentRepo[];
  groups?: ProjectGroup[];
  selectedId?: string | null;
  expandedInit?: ProjectTreeExpanded;
  onSelectWorktree?: (id: string) => void;
  onSwitchRepo?: (path: string) => void;
  onOpenNewWindow?: (path: string) => void;
  onRemoveWorktree?: (id: string) => void;
  onAddRepo?: () => void;
  onCreateGroup?: (name: string) => Promise<string | null>;
  onRenameGroup?: (id: string, name: string) => void;
  onRemoveGroup?: (id: string) => void;
  onAssignRepo?: (repoPath: string, groupId: string | null) => void;
  onForgetRepo?: (path: string) => void;
}

/** Drives ProjectTree with the REAL expand + lazy-load hooks so toggles/loads actually re-render. */
function Harness(props: HarnessProps) {
  const worktreesFor = useWorktreesFor();
  const expanded = useProjectTreeExpanded(props.expandedInit, vi.fn());
  return (
    <ProjectTree
      repos={props.repos ?? repos}
      groups={props.groups ?? groups}
      activeWorktrees={activeWorktrees}
      activeLoading={false}
      activeError={null}
      statuses={statuses}
      selectedId={props.selectedId ?? null}
      worktreesFor={worktreesFor}
      expanded={expanded}
      onSelectWorktree={props.onSelectWorktree ?? vi.fn()}
      onSwitchRepo={props.onSwitchRepo ?? vi.fn()}
      onOpenNewWindow={props.onOpenNewWindow ?? vi.fn()}
      onRemoveWorktree={props.onRemoveWorktree ?? vi.fn()}
      onAddRepo={props.onAddRepo ?? vi.fn()}
      onCreateGroup={props.onCreateGroup ?? vi.fn(async () => null)}
      onRenameGroup={props.onRenameGroup ?? vi.fn()}
      onRemoveGroup={props.onRemoveGroup ?? vi.fn()}
      onAssignRepo={props.onAssignRepo ?? vi.fn()}
      onForgetRepo={props.onForgetRepo ?? vi.fn()}
    />
  );
}

/** Stub window.mango.worktree.listFor for the non-active repo lazy-load path. */
function stubListFor(impl: (repoPath: string) => Promise<Worktree[]>) {
  Object.defineProperty(window, 'mango', {
    value: { worktree: { listFor: vi.fn(impl) } },
    configurable: true,
  });
  return window.mango.worktree.listFor as ReturnType<typeof vi.fn>;
}

describe('<ProjectTree>', () => {
  beforeEach(() => stubListFor(async () => []));

  // ── rendering + navigation ──────────────────────────────────────────────────

  it('renders groups + ungrouped repos at the top level; grouped repos hide until expanded', () => {
    renderWithI18n(<Harness />);
    expect(screen.getByTestId('project-count')).toHaveTextContent('2');
    expect(screen.getByTestId('group-node-CRS')).toBeInTheDocument();
    expect(screen.getByTestId('repo-node-mangolove-idea')).toBeInTheDocument(); // ungrouped, top-level
    expect(screen.queryByTestId('repo-node-crs')).toBeNull(); // inside the collapsed CRS group
  });

  it('expanding the group reveals the active repo with the "here" affordance', () => {
    renderWithI18n(<Harness expandedInit={{ groups: ['g1'], repos: [] }} />);
    const crs = screen.getByTestId('repo-node-crs');
    expect(crs).toHaveClass('active');
    expect(crs).toHaveAttribute('aria-current', 'true');
    expect(crs.querySelector('.pt-here')).not.toBeNull();
  });

  it('an expanded active repo lists its live worktrees; the selected one is highlighted', () => {
    renderWithI18n(
      <Harness expandedInit={{ groups: ['g1'], repos: [ACTIVE] }} selectedId={`${ACTIVE}/feat`} />,
    );
    const rows = screen.getAllByTestId('worktree-item');
    expect(rows).toHaveLength(2);
    const selected = rows.find((r) => r.classList.contains('sel'));
    expect(selected).toBeDefined();
    expect(within(selected!).getByText('feature/x')).toBeInTheDocument();
  });

  it('clicking an active-repo worktree selects it (not a repo switch)', () => {
    const onSelectWorktree = vi.fn();
    const onSwitchRepo = vi.fn();
    renderWithI18n(
      <Harness
        expandedInit={{ groups: ['g1'], repos: [ACTIVE] }}
        onSelectWorktree={onSelectWorktree}
        onSwitchRepo={onSwitchRepo}
      />,
    );
    fireEvent.click(
      within(screen.getByText('feature/x').closest('.pt-wt')!).getByText('feature/x'),
    );
    expect(onSelectWorktree).toHaveBeenCalledWith(`${ACTIVE}/feat`);
    expect(onSwitchRepo).not.toHaveBeenCalled();
  });

  it('clicking a NON-active repo row switches to it (does not select a worktree)', () => {
    const onSwitchRepo = vi.fn();
    const onSelectWorktree = vi.fn();
    renderWithI18n(<Harness onSwitchRepo={onSwitchRepo} onSelectWorktree={onSelectWorktree} />);
    fireEvent.click(screen.getByTestId('repo-node-mangolove-idea'));
    expect(onSwitchRepo).toHaveBeenCalledWith(OTHER);
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('the active repo Remove button removes a non-primary worktree; primary has none', () => {
    const onRemoveWorktree = vi.fn();
    renderWithI18n(
      <Harness
        expandedInit={{ groups: ['g1'], repos: [ACTIVE] }}
        onRemoveWorktree={onRemoveWorktree}
      />,
    );
    const rows = screen.getAllByTestId('worktree-item');
    const mainRow = rows.find((r) => within(r).queryByText('main'))!;
    const featRow = rows.find((r) => within(r).queryByText('feature/x'))!;
    expect(within(mainRow).queryByRole('button')).toBeNull(); // primary: not removable
    fireEvent.click(within(featRow).getByRole('button'));
    expect(onRemoveWorktree).toHaveBeenCalledWith(`${ACTIVE}/feat`);
  });

  it('lazily lists a non-active repo on expand (static rows, no live dot) and switches on click', async () => {
    const listFor = stubListFor(async (p) =>
      p === OTHER ? [wt(`${OTHER}/main`, 'main', true)] : [],
    );
    const onSwitchRepo = vi.fn();
    renderWithI18n(
      <Harness expandedInit={{ groups: [], repos: [OTHER] }} onSwitchRepo={onSwitchRepo} />,
    );
    await waitFor(() => expect(listFor).toHaveBeenCalledWith(OTHER));
    const row = await screen.findByTestId('worktree-item');
    expect(row.querySelector('.pt-dot--static')).not.toBeNull(); // non-active: static, no live status
    fireEvent.click(row);
    // Cross-repo select: the click carries THIS worktree's id so the target window lands on it.
    expect(onSwitchRepo).toHaveBeenCalledWith(OTHER, `${OTHER}/main`);
  });

  it('shows the empty state when there are no repos', () => {
    renderWithI18n(<Harness repos={[]} groups={[]} />);
    expect(screen.getByTestId('project-count')).toHaveTextContent('0');
    expect(screen.getByText('No repositories yet')).toBeInTheDocument();
  });

  // ── filter / search (PR-1) ──────────────────────────────────────────────────

  it('filtering by repo name shows only matching repos (others hidden)', async () => {
    renderWithI18n(<Harness />);
    fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'mango' } });
    await waitFor(() => expect(screen.getByTestId('repo-node-mangolove-idea')).toBeInTheDocument());
    expect(screen.queryByTestId('group-node-CRS')).toBeNull(); // CRS group has no match -> hidden
    expect(screen.queryByTestId('repo-node-crs')).toBeNull();
  });

  it('filtering by branch reveals the repo force-expanded with only the matching worktree', () => {
    renderWithI18n(<Harness />);
    fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'feature' } });
    // crs matches on its feature/x branch -> group + repo force-open, only that worktree shown.
    expect(screen.getByTestId('group-node-CRS')).toBeInTheDocument();
    expect(screen.getByTestId('repo-node-crs')).toBeInTheDocument();
    const rows = screen.getAllByTestId('worktree-item');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('feature/x')).toBeInTheDocument();
    expect(screen.queryByTestId('repo-node-mangolove-idea')).toBeNull(); // no match -> hidden
  });

  it('a non-matching filter shows the "no matches" state; clear restores the tree', () => {
    renderWithI18n(<Harness />);
    const input = screen.getByTestId('project-filter');
    fireEvent.change(input, { target: { value: 'zzz-nothing' } });
    expect(screen.getByTestId('project-filter-none')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('project-filter-clear'));
    expect(screen.queryByTestId('project-filter-none')).toBeNull();
    expect(screen.getByTestId('group-node-CRS')).toBeInTheDocument(); // tree back
  });

  it('starting a filter eager-loads non-active repos so their branches are searchable', async () => {
    const listFor = stubListFor(async () => []);
    renderWithI18n(<Harness />);
    fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'x' } });
    await waitFor(() => expect(listFor).toHaveBeenCalledWith(OTHER));
  });

  // ── keyboard navigation (PR-2) ──────────────────────────────────────────────

  it('ArrowDown/ArrowUp move focus between rows; Home/End jump; clamps at the ends', () => {
    renderWithI18n(<Harness expandedInit={{ groups: ['g1'], repos: [ACTIVE] }} />);
    const tree = screen.getByRole('tree');
    const items = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    expect(items.length).toBeGreaterThanOrEqual(4); // group + repo + 2 worktrees + ungrouped repo
    items[0].focus();
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(tree, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(tree, { key: 'ArrowDown' }); // clamp at bottom
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(tree, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(tree, { key: 'ArrowUp' }); // clamp at top
    expect(document.activeElement).toBe(items[0]);
  });

  it('vertical nav coexists with per-row Arrow Right/Left expand/collapse', () => {
    renderWithI18n(<Harness />); // CRS group collapsed
    const group = screen.getByTestId('group-node-CRS');
    group.focus();
    fireEvent.keyDown(group, { key: 'ArrowRight' }); // per-row handler expands
    expect(screen.getByTestId('repo-node-crs')).toBeInTheDocument(); // group opened
  });

  it('a chevron toggle WHILE filtering does not flip the persisted expand state', () => {
    renderWithI18n(<Harness />);
    fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'mango' } });
    const node = screen.getByTestId('repo-node-mangolove-idea');
    expect(node).toHaveAttribute('aria-expanded', 'true'); // force-open while filtering
    fireEvent.click(node.querySelector('.pt-chev')!); // invisible + must be a no-op (guarded)
    fireEvent.click(screen.getByTestId('project-filter-clear'));
    // Back to its pre-filter COLLAPSED state — the invisible toggle did not persist.
    expect(screen.getByTestId('repo-node-mangolove-idea')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  // ── header menu (Phase 4) ────────────────────────────────────────────────────

  it('the + button opens a menu; "add repository" triggers onAddRepo', () => {
    const onAddRepo = vi.fn();
    renderWithI18n(<Harness onAddRepo={onAddRepo} />);
    fireEvent.click(screen.getByTestId('project-add'));
    fireEvent.click(screen.getByTestId('menu-add-repo'));
    expect(onAddRepo).toHaveBeenCalledOnce();
  });

  it('header menu "new group" creates an empty group from the inline input', async () => {
    const onCreateGroup = vi.fn(async () => 'newid');
    renderWithI18n(<Harness onCreateGroup={onCreateGroup} />);
    fireEvent.click(screen.getByTestId('project-add'));
    fireEvent.click(screen.getByTestId('menu-new-group'));
    const input = screen.getByTestId('new-group-input');
    fireEvent.change(input, { target: { value: 'Backend' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCreateGroup).toHaveBeenCalledWith('Backend', undefined); // no repo to seed
  });

  // ── repo context menu (Phase 4) ──────────────────────────────────────────────

  it('repo menu → "add to CRS" assigns the ungrouped repo to that group', () => {
    const onAssignRepo = vi.fn();
    renderWithI18n(<Harness onAssignRepo={onAssignRepo} />);
    fireEvent.contextMenu(screen.getByTestId('repo-node-mangolove-idea'));
    fireEvent.click(screen.getByText('Add to “CRS”'));
    expect(onAssignRepo).toHaveBeenCalledWith(OTHER, 'g1');
  });

  it('repo menu → "new group with this repo" creates + seeds the repo in ONE atomic call', async () => {
    const onCreateGroup = vi.fn(async () => 'gnew');
    const onAssignRepo = vi.fn();
    renderWithI18n(<Harness onCreateGroup={onCreateGroup} onAssignRepo={onAssignRepo} />);
    fireEvent.contextMenu(screen.getByTestId('repo-node-mangolove-idea'));
    fireEvent.click(screen.getByTestId('menu-new-group'));
    const input = screen.getByTestId('new-group-input');
    fireEvent.change(input, { target: { value: 'Infra' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Atomic: createGroup carries the repo; NO separate assign (that pair would clobber via stale groups).
    expect(onCreateGroup).toHaveBeenCalledWith('Infra', OTHER);
    expect(onAssignRepo).not.toHaveBeenCalled();
  });

  it('repo menu on a grouped repo → "remove from group" ungroups it', () => {
    const onAssignRepo = vi.fn();
    renderWithI18n(
      <Harness expandedInit={{ groups: ['g1'], repos: [] }} onAssignRepo={onAssignRepo} />,
    );
    fireEvent.contextMenu(screen.getByTestId('repo-node-crs'));
    fireEvent.click(screen.getByTestId('menu-remove-from-group'));
    expect(onAssignRepo).toHaveBeenCalledWith(ACTIVE, null);
  });

  // ── group context menu (Phase 4) ─────────────────────────────────────────────

  it('group menu → rename shows an inline input that commits on Enter', () => {
    const onRenameGroup = vi.fn();
    renderWithI18n(<Harness onRenameGroup={onRenameGroup} />);
    fireEvent.contextMenu(screen.getByTestId('group-node-CRS'));
    fireEvent.click(screen.getByTestId('menu-rename-group'));
    const input = screen.getByTestId('group-rename-g1');
    fireEvent.change(input, { target: { value: 'CRS Platform' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameGroup).toHaveBeenCalledWith('g1', 'CRS Platform');
  });

  it('repo menu → "forget" drops a NON-active repo from the list', () => {
    const onForgetRepo = vi.fn();
    renderWithI18n(<Harness onForgetRepo={onForgetRepo} />);
    fireEvent.contextMenu(screen.getByTestId('repo-node-mangolove-idea')); // non-active, ungrouped
    fireEvent.click(screen.getByTestId('menu-forget-repo'));
    expect(onForgetRepo).toHaveBeenCalledWith(OTHER);
  });

  it('repo menu offers NO "forget" for the active repo (this window is on it)', () => {
    renderWithI18n(<Harness expandedInit={{ groups: ['g1'], repos: [] }} />);
    fireEvent.contextMenu(screen.getByTestId('repo-node-crs')); // active
    expect(screen.queryByTestId('menu-forget-repo')).toBeNull();
  });

  // ── multi-window: open a non-active repo in a new window ─────────────────────

  it('Cmd/Ctrl+click a NON-active repo row opens it in a new window (not an in-place switch)', () => {
    const onOpenNewWindow = vi.fn();
    const onSwitchRepo = vi.fn();
    renderWithI18n(<Harness onOpenNewWindow={onOpenNewWindow} onSwitchRepo={onSwitchRepo} />);
    fireEvent.click(screen.getByTestId('repo-node-mangolove-idea'), { metaKey: true });
    expect(onOpenNewWindow).toHaveBeenCalledWith(OTHER);
    expect(onSwitchRepo).not.toHaveBeenCalled();
    // ctrlKey (Windows/Linux) takes the same path.
    fireEvent.click(screen.getByTestId('repo-node-mangolove-idea'), { ctrlKey: true });
    expect(onOpenNewWindow).toHaveBeenCalledTimes(2);
  });

  it('repo menu → "open in new window" / "open here" route a NON-active repo', () => {
    const onOpenNewWindow = vi.fn();
    const onSwitchRepo = vi.fn();
    renderWithI18n(<Harness onOpenNewWindow={onOpenNewWindow} onSwitchRepo={onSwitchRepo} />);
    fireEvent.contextMenu(screen.getByTestId('repo-node-mangolove-idea')); // non-active
    fireEvent.click(screen.getByTestId('menu-open-new-window'));
    expect(onOpenNewWindow).toHaveBeenCalledWith(OTHER);
    fireEvent.contextMenu(screen.getByTestId('repo-node-mangolove-idea'));
    fireEvent.click(screen.getByTestId('menu-open-here'));
    expect(onSwitchRepo).toHaveBeenCalledWith(OTHER);
  });

  it('repo menu offers NO open items for the ACTIVE repo (already open in this window)', () => {
    renderWithI18n(<Harness expandedInit={{ groups: ['g1'], repos: [] }} />);
    fireEvent.contextMenu(screen.getByTestId('repo-node-crs')); // active
    expect(screen.queryByTestId('menu-open-new-window')).toBeNull();
    expect(screen.queryByTestId('menu-open-here')).toBeNull();
  });

  it('Cmd/Ctrl+click on the ACTIVE repo row does nothing (active branch precedes the modifier check)', () => {
    const onOpenNewWindow = vi.fn();
    const onSwitchRepo = vi.fn();
    renderWithI18n(
      <Harness
        expandedInit={{ groups: ['g1'], repos: [] }}
        onOpenNewWindow={onOpenNewWindow}
        onSwitchRepo={onSwitchRepo}
      />,
    );
    fireEvent.click(screen.getByTestId('repo-node-crs'), { metaKey: true }); // active row
    expect(onOpenNewWindow).not.toHaveBeenCalled(); // active row never opens a new window
    expect(onSwitchRepo).not.toHaveBeenCalled(); // (only toggles its worktrees)
  });

  it('re-expanding a non-active repo RELOADS its worktree snapshot (not frozen)', async () => {
    const listFor = stubListFor(async () => []);
    renderWithI18n(<Harness />);
    const chevron = () => screen.getByTestId('repo-node-mangolove-idea').querySelector('.pt-chev')!;
    fireEvent.click(chevron()); // expand -> first load
    await waitFor(() => expect(listFor).toHaveBeenCalledTimes(1));
    fireEvent.click(chevron()); // collapse
    fireEvent.click(chevron()); // re-expand -> reload (fresh), not a no-op
    await waitFor(() => expect(listFor).toHaveBeenCalledTimes(2));
    expect(listFor).toHaveBeenNthCalledWith(2, OTHER);
  });

  it('group menu → ungroup removes the group', () => {
    const onRemoveGroup = vi.fn();
    renderWithI18n(<Harness onRemoveGroup={onRemoveGroup} />);
    fireEvent.contextMenu(screen.getByTestId('group-node-CRS'));
    fireEvent.click(screen.getByTestId('menu-ungroup'));
    expect(onRemoveGroup).toHaveBeenCalledWith('g1');
  });

  // ── drag to group / drag to ungroup (Phase 4) ────────────────────────────────

  it('dropping a repo on a group assigns it to that group', () => {
    const onAssignRepo = vi.fn();
    renderWithI18n(<Harness onAssignRepo={onAssignRepo} />);
    const wrap = screen.getByTestId('group-node-CRS').closest('.pt-group-wrap')!;
    const dataTransfer = repoDrag(OTHER);
    fireEvent.dragOver(wrap, { dataTransfer });
    fireEvent.drop(wrap, { dataTransfer });
    expect(onAssignRepo).toHaveBeenCalledWith(OTHER, 'g1');
  });

  it('dropping a repo on the empty tree body ungroups it', () => {
    const onAssignRepo = vi.fn();
    renderWithI18n(
      <Harness expandedInit={{ groups: ['g1'], repos: [] }} onAssignRepo={onAssignRepo} />,
    );
    const body = screen.getByRole('tree');
    const dataTransfer = repoDrag(ACTIVE);
    fireEvent.dragOver(body, { dataTransfer });
    fireEvent.drop(body, { dataTransfer });
    expect(onAssignRepo).toHaveBeenCalledWith(ACTIVE, null);
  });

  // ── roving tabindex (WAI-ARIA tree: one tab stop, arrows move it) ─────────────

  const tabbableRows = () =>
    screen.getAllByRole('treeitem').filter((el) => el.getAttribute('tabindex') === '0');

  it('roving tabindex: exactly the FIRST row is tabbable initially; the rest are -1', () => {
    renderWithI18n(<Harness />);
    const tabbable = tabbableRows();
    expect(tabbable).toHaveLength(1); // one tab stop, not one-per-row
    expect(tabbable[0]).toBe(screen.getByTestId('group-node-CRS')); // groups render before ungrouped
    expect(screen.getByTestId('repo-node-mangolove-idea').getAttribute('tabindex')).toBe('-1');
  });

  it('roving tabindex: focusing a row makes IT the only tabbable one', () => {
    renderWithI18n(<Harness />);
    const other = screen.getByTestId('repo-node-mangolove-idea');
    fireEvent.focus(other);
    expect(other.getAttribute('tabindex')).toBe('0');
    expect(tabbableRows()).toEqual([other]);
  });

  it('ArrowDown moves focus to the next row and the roving tabindex follows it', () => {
    renderWithI18n(<Harness />);
    const first = screen.getByTestId('group-node-CRS'); // collapsed group, starts tabbable
    first.focus();
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowDown' });
    const next = screen.getByTestId('repo-node-mangolove-idea');
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute('tabindex')).toBe('0');
    expect(tabbableRows()).toEqual([next]);
  });

  it('shows the "open in another window" badge only for repos flagged openElsewhere', () => {
    renderWithI18n(
      <Harness
        repos={[
          { path: ACTIVE, active: true },
          { path: OTHER, active: false, openElsewhere: true },
        ]}
      />,
    );
    const other = screen.getByTestId('repo-node-mangolove-idea');
    expect(within(other).getByTestId('repo-open-elsewhere')).toBeInTheDocument();
    expect(screen.getAllByTestId('repo-open-elsewhere')).toHaveLength(1); // only the flagged repo
  });

  it('roving falls back to the first visible row when the roving row is filtered out', async () => {
    renderWithI18n(<Harness />);
    fireEvent.focus(screen.getByTestId('repo-node-mangolove-idea')); // roving = the ungrouped repo
    fireEvent.change(screen.getByTestId('project-filter'), { target: { value: 'crs' } }); // hides it
    await waitFor(() => {
      // its row is gone, but a tab stop still exists (the self-correcting fallback re-armed one)
      expect(screen.queryByTestId('repo-node-mangolove-idea')).toBeNull();
      expect(tabbableRows()).toHaveLength(1);
    });
  });
});

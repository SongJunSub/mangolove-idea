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

interface HarnessProps {
  repos?: RecentRepo[];
  groups?: ProjectGroup[];
  selectedId?: string | null;
  expandedInit?: ProjectTreeExpanded;
  onSelectWorktree?: (id: string) => void;
  onSwitchRepo?: (path: string) => void;
  onRemoveWorktree?: (id: string) => void;
  onAddRepo?: () => void;
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
      onRemoveWorktree={props.onRemoveWorktree ?? vi.fn()}
      onAddRepo={props.onAddRepo ?? vi.fn()}
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
    expect(onSwitchRepo).toHaveBeenCalledWith(OTHER);
  });

  it('the + button triggers onAddRepo', () => {
    const onAddRepo = vi.fn();
    renderWithI18n(<Harness onAddRepo={onAddRepo} />);
    fireEvent.click(screen.getByTestId('repo-add'));
    expect(onAddRepo).toHaveBeenCalledOnce();
  });

  it('shows the empty state when there are no repos', () => {
    renderWithI18n(<Harness repos={[]} groups={[]} />);
    expect(screen.getByTestId('project-count')).toHaveTextContent('0');
    expect(screen.getByText('No repositories yet')).toBeInTheDocument();
  });
});

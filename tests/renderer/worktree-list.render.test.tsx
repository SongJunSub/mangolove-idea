import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { WorktreeList } from '../../src/renderer/components/sidebar/worktree-list';
import type { Worktree } from '../../src/shared/types';
import type { WorktreeRowStatus } from '../../src/renderer/state/app-store';

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  id: '/repo',
  path: '/repo',
  branch: 'main',
  isPrimary: true,
  isLocked: false,
  ...over,
});

function list(over: Partial<React.ComponentProps<typeof WorktreeList>> = {}) {
  const props = {
    worktrees: [] as readonly Worktree[],
    loading: false,
    error: null as string | null,
    selectedId: null as string | null,
    statuses: new Map<string, WorktreeRowStatus>(),
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    ...over,
  };
  return { props, ...render(wrapI18n(<WorktreeList {...props} />)) };
}

describe('<WorktreeList>', () => {
  it('shows the loading state', () => {
    list({ loading: true });
    expect(screen.getByText('loading…')).toBeInTheDocument();
  });

  it('shows the error state', () => {
    list({ error: 'boom' });
    expect(screen.getByText(/error: boom/)).toBeInTheDocument();
  });

  it('shows the empty state when not loading and there are no worktrees', () => {
    list({ loading: false, worktrees: [] });
    expect(screen.getByText('no worktrees')).toBeInTheDocument();
  });

  it('renders one row per worktree', () => {
    list({
      worktrees: [
        wt({ id: '/repo', branch: 'main' }),
        wt({ id: '/r/feat', branch: 'feat', isPrimary: false }),
      ],
    });
    expect(screen.getAllByTestId('worktree-item')).toHaveLength(2);
    expect(screen.getByText('feat')).toBeInTheDocument();
  });

  it('passes per-worktree status down (agent dot reflects the map)', () => {
    list({
      worktrees: [wt({ id: '/r/feat', branch: 'feat', isPrimary: false })],
      statuses: new Map([['/r/feat', { agent: 'error', server: 'stopped', ownsServer: false }]]),
    });
    expect(screen.getByLabelText('agent error')).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorktreeItem } from '../../src/renderer/components/sidebar/worktree-item';
import type { Worktree } from '../../src/shared/types';

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  id: '/repo/.worktrees/feat',
  path: '/repo/.worktrees/feat',
  branch: 'feature/x',
  head: 'abc1234',
  isPrimary: false,
  isLocked: false,
  ...over,
});

function item(over: Partial<React.ComponentProps<typeof WorktreeItem>> = {}) {
  const props = {
    worktree: wt(),
    selected: false,
    agentStatus: 'running' as const,
    serverState: 'stopped' as const,
    ownsServer: false,
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    ...over,
  };
  return { props, ...render(<WorktreeItem {...props} />) };
}

describe('<WorktreeItem>', () => {
  it('renders the branch, agent status dot, and short head', () => {
    item();
    expect(screen.getByText('feature/x')).toBeInTheDocument();
    expect(screen.getByLabelText('agent running')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('selecting the row fires onSelect with the worktree id', () => {
    const { props } = item();
    fireEvent.click(screen.getByTestId('worktree-item'));
    expect(props.onSelect).toHaveBeenCalledWith('/repo/.worktrees/feat');
  });

  it('Remove fires onRemove and does NOT bubble to onSelect (stopPropagation)', () => {
    const { props } = item();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(props.onRemove).toHaveBeenCalledWith('/repo/.worktrees/feat');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('disables Remove for the primary worktree (and shows the primary badge)', () => {
    item({ worktree: wt({ isPrimary: true }) });
    expect(screen.getByText('primary')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('disables Remove for a locked worktree (and shows the locked badge)', () => {
    item({ worktree: wt({ isLocked: true }) });
    expect(screen.getByText('locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('shows the server dot only when this worktree owns a server', () => {
    const { unmount } = item({ ownsServer: false });
    expect(screen.queryByLabelText(/^server /)).not.toBeInTheDocument();
    unmount();
    item({ ownsServer: true, serverState: 'running' });
    expect(screen.getByLabelText('server running')).toBeInTheDocument();
  });
});

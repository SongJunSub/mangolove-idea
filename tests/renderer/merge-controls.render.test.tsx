import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { MergeControls } from '../../src/renderer/components/toolbar/merge-controls';
import type { MergeProgressEvent, Worktree } from '../../src/shared/types';

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  id: '/r/feat',
  path: '/r/feat',
  branch: 'feat',
  isPrimary: false,
  isLocked: false,
  ...over,
});

function controls(over: Partial<React.ComponentProps<typeof MergeControls>> = {}) {
  const props = {
    selected: wt() as Worktree | null,
    running: false,
    progress: null as MergeProgressEvent | null,
    onMerge: vi.fn(),
    ...over,
  };
  return { props, ...render(wrapI18n(<MergeControls {...props} />)) };
}

const mergeButton = () => screen.getByRole('button', { name: /Merge|Merging/ });

describe('<MergeControls>', () => {
  it('enables Merge for a selected non-primary worktree and fires onMerge', () => {
    const { props } = controls();
    expect(mergeButton()).toBeEnabled();
    fireEvent.click(mergeButton());
    expect(props.onMerge).toHaveBeenCalledWith(props.selected);
  });

  it('disables Merge when nothing is selected', () => {
    controls({ selected: null });
    expect(mergeButton()).toBeDisabled();
  });

  it('disables Merge for the primary worktree', () => {
    controls({ selected: wt({ isPrimary: true }) });
    expect(mergeButton()).toBeDisabled();
  });

  it('disables Merge and shows "Merging…" while running', () => {
    controls({ running: true });
    expect(screen.getByRole('button', { name: 'Merging…' })).toBeDisabled();
  });

  it('renders a conflict stage line with the warning idiom', () => {
    controls({
      progress: { worktreeId: '/r/feat', stage: 'conflict', ok: false, message: '2 files' },
    });
    expect(screen.getByTestId('merge-stage')).toHaveTextContent('conflict ⚠: 2 files');
  });

  it('renders a failed stage line', () => {
    controls({
      progress: { worktreeId: '/r/feat', stage: 'verify', ok: false, message: 'tests failed' },
    });
    expect(screen.getByTestId('merge-stage')).toHaveTextContent('verify ✗: tests failed');
  });
});

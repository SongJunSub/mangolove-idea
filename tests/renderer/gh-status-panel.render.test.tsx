import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { GhStatusPanel } from '../../src/renderer/components/toolbar/gh-status-panel';
import type { GhStatus } from '../../src/shared/types';

const openPr = (over: Partial<GhStatus & { kind: 'open-pr' }> = {}): GhStatus => ({
  kind: 'open-pr',
  pr: {
    number: 42,
    state: 'OPEN',
    title: 'Add widget',
    url: 'https://github.com/o/r/pull/42',
    isDraft: false,
    reviewDecision: '',
  },
  ci: {
    summary: 'passing',
    counts: { pass: 3, fail: 0, pending: 0, skipping: 0, cancel: 0 },
    checks: [
      { name: 'build', bucket: 'pass', link: 'https://ci/build' },
      { name: 'lint', bucket: 'fail', link: '' },
    ],
  },
  ...over,
});

function panel(over: Partial<React.ComponentProps<typeof GhStatusPanel>> = {}) {
  const props = {
    selectedId: '/wt' as string | null,
    status: null as GhStatus | null,
    loading: false,
    error: null as string | null,
    onRefresh: vi.fn(),
    onOpen: vi.fn(),
    ...over,
  };
  return { props, ...render(wrapI18n(<GhStatusPanel {...props} />)) };
}

describe('<GhStatusPanel>', () => {
  it('prompts to select a worktree when none is selected', () => {
    panel({ selectedId: null });
    expect(screen.getByTestId('gh-status')).toHaveTextContent('select a worktree');
    expect(screen.queryByTestId('gh-status-line')).not.toBeInTheDocument();
  });

  it('shows loading and disables refresh while loading', () => {
    panel({ loading: true });
    expect(screen.getByTestId('gh-status-line')).toHaveTextContent('loading…');
    expect(screen.getByTestId('gh-refresh')).toBeDisabled();
  });

  it('renders an error line', () => {
    panel({ error: 'gh blew up' });
    expect(screen.getByTestId('gh-status-line')).toHaveTextContent('PR: gh blew up');
  });

  it('renders an open PR with number, CI, title + an Open button wired to the url', () => {
    const { props } = panel({ status: openPr() });
    const line = screen.getByTestId('gh-status-line');
    expect(line).toHaveTextContent('PR #42 OPEN');
    expect(line).toHaveTextContent('CI ✓');
    expect(line).toHaveTextContent('Add widget');
    fireEvent.click(screen.getByTestId('gh-open'));
    expect(props.onOpen).toHaveBeenCalledWith('https://github.com/o/r/pull/42');
  });

  it('marks a draft and a failing CI', () => {
    panel({
      status: openPr({
        pr: { number: 7, state: 'OPEN', title: 'WIP', url: 'u', isDraft: true, reviewDecision: '' },
        ci: {
          summary: 'failing',
          counts: { pass: 0, fail: 1, pending: 0, skipping: 0, cancel: 0 },
          checks: [{ name: 'lint', bucket: 'fail', link: '' }],
        },
      }),
    });
    const line = screen.getByTestId('gh-status-line');
    expect(line).toHaveTextContent('(draft)');
    expect(line).toHaveTextContent('CI ✗');
  });

  it('expands a per-check list on toggle and opens a check link', () => {
    const { props } = panel({ status: openPr() }); // checks: build(pass, link), lint(fail, no link)
    expect(screen.queryByTestId('gh-checks')).not.toBeInTheDocument(); // collapsed by default
    fireEvent.click(screen.getByTestId('gh-checks-toggle'));
    const list = screen.getByTestId('gh-checks');
    expect(list).toHaveTextContent('build');
    expect(list).toHaveTextContent('lint');
    // 'build' has a link -> an open button wired to it; 'lint' has no link -> no button.
    fireEvent.click(screen.getByTestId('gh-check-open-build'));
    expect(props.onOpen).toHaveBeenCalledWith('https://ci/build');
    expect(screen.queryByTestId('gh-check-open-lint')).not.toBeInTheDocument();
    // toggling again collapses it.
    fireEvent.click(screen.getByTestId('gh-checks-toggle'));
    expect(screen.queryByTestId('gh-checks')).not.toBeInTheDocument();
  });

  it('shows no checks toggle when there are no checks (none CI)', () => {
    panel({
      status: openPr({
        ci: {
          summary: 'none',
          counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 },
          checks: [],
        },
      }),
    });
    expect(screen.queryByTestId('gh-checks-toggle')).not.toBeInTheDocument();
  });

  it('shows a calm neutral state with NO Open button for the no-pr/common kinds', () => {
    for (const kind of ['gh-missing', 'not-authed', 'no-remote', 'not-pushed', 'no-pr'] as const) {
      const { unmount } = panel({ status: { kind } });
      expect(screen.queryByTestId('gh-open')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('refresh button fires onRefresh', () => {
    const { props } = panel({ status: { kind: 'no-pr' } });
    fireEvent.click(screen.getByTestId('gh-refresh'));
    expect(props.onRefresh).toHaveBeenCalled();
  });
});

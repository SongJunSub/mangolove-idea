import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { RepoList } from '../../src/renderer/components/sidebar/repo-list';
import { renderWithI18n } from './i18n-test-util';
import type { RecentRepo } from '../../src/shared/types';

const repos: RecentRepo[] = [
  { path: '/Users/me/mangolove-idea', active: true },
  { path: '/Users/me/other-project', active: false },
];

describe('<RepoList>', () => {
  it('renders each repo by basename and highlights the active one', () => {
    renderWithI18n(<RepoList repos={repos} onOpen={vi.fn()} onAdd={vi.fn()} />);
    expect(screen.getByTestId('repo-item-mangolove-idea')).toHaveClass('active');
    expect(screen.getByTestId('repo-item-other-project')).not.toHaveClass('active');
  });

  it('clicking a non-active repo calls onOpen with its path; the active one is a no-op', () => {
    const onOpen = vi.fn();
    renderWithI18n(<RepoList repos={repos} onOpen={onOpen} onAdd={vi.fn()} />);
    fireEvent.click(screen.getByTestId('repo-item-other-project'));
    expect(onOpen).toHaveBeenCalledWith('/Users/me/other-project');
    fireEvent.click(screen.getByTestId('repo-item-mangolove-idea')); // active -> no switch
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('the + button adds a repo via onAdd (native picker)', () => {
    const onAdd = vi.fn();
    renderWithI18n(<RepoList repos={repos} onOpen={vi.fn()} onAdd={onAdd} />);
    fireEvent.click(screen.getByTestId('repo-add'));
    expect(onAdd).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { Toolbar } from '../../src/renderer/components/toolbar/toolbar';

describe('<Toolbar>', () => {
  it('disables Create until a new-branch name is entered', () => {
    render(wrapI18n(<Toolbar onCreate={vi.fn()} />));
    const create = screen.getByRole('button', { name: 'New worktree' });
    expect(create).toBeDisabled(); // base defaults to 'main' but new-branch is empty
    fireEvent.change(screen.getByLabelText('new branch'), { target: { value: 'feat' } });
    expect(create).toBeEnabled();
  });

  it('creates with trimmed base + new branch and clears the new-branch input', () => {
    const onCreate = vi.fn();
    render(wrapI18n(<Toolbar onCreate={onCreate} />));
    fireEvent.change(screen.getByLabelText('base branch'), { target: { value: '  develop ' } });
    const newInput = screen.getByLabelText('new branch') as HTMLInputElement;
    fireEvent.change(newInput, { target: { value: ' feature/x ' } });
    fireEvent.click(screen.getByRole('button', { name: 'New worktree' }));
    expect(onCreate).toHaveBeenCalledWith({ baseBranch: 'develop', newBranch: 'feature/x' });
    expect(newInput.value).toBe(''); // cleared after submit
  });
});

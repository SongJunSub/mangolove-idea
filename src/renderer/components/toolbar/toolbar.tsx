import { useState } from 'react';
import type { CreateWorktreeRequest } from '../../../shared/types';

/** Props for the toolbar's New-worktree form. */
export interface ToolbarProps {
  onCreate(req: CreateWorktreeRequest): void;
}

/** Toolbar: base-branch + new-branch inputs and a Create action (MVP item 1). */
export function Toolbar({ onCreate }: ToolbarProps): React.JSX.Element {
  const [baseBranch, setBaseBranch] = useState<string>('main');
  const [newBranch, setNewBranch] = useState<string>('');

  const canCreate = baseBranch.trim().length > 0 && newBranch.trim().length > 0;

  const submit = (): void => {
    if (!canCreate) return;
    onCreate({ baseBranch: baseBranch.trim(), newBranch: newBranch.trim() });
    setNewBranch('');
  };

  return (
    <div
      data-testid="toolbar"
      style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }}
    >
      <label style={{ fontSize: 12 }}>
        base
        <input
          aria-label="base branch"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          style={{ marginLeft: 4, width: 120 }}
        />
      </label>
      <label style={{ fontSize: 12 }}>
        new branch
        <input
          aria-label="new branch"
          value={newBranch}
          placeholder="feature/login"
          onChange={(e) => setNewBranch(e.target.value)}
          style={{ marginLeft: 4, width: 160 }}
        />
      </label>
      <button type="button" disabled={!canCreate} onClick={submit}>
        New worktree
      </button>
    </div>
  );
}

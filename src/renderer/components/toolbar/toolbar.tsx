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
      style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '8px 0' }}
    >
      <label
        style={{
          fontSize: 12,
          flex: '1 1 84px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minWidth: 0,
        }}
      >
        base
        <input
          aria-label="base branch"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </label>
      <label
        style={{
          fontSize: 12,
          flex: '1 1 130px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minWidth: 0,
        }}
      >
        new
        <input
          aria-label="new branch"
          value={newBranch}
          placeholder="feature/login"
          onChange={(e) => setNewBranch(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </label>
      <button type="button" disabled={!canCreate} onClick={submit} style={{ flex: '0 0 auto' }}>
        New worktree
      </button>
    </div>
  );
}

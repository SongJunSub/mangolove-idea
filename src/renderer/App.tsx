import { useCallback, useState } from 'react';
import type { AppInfo } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { useWorktrees } from './hooks/use-worktrees';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const { worktrees, loading, error, create, remove } = useWorktrees();

  const onPing = useCallback(async () => {
    setPingError(null);
    try {
      const result = await window.mango.app.ping();
      setInfo(result);
    } catch (e) {
      setPingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>MangoLove IDEA</h1>
      <p>Plan 1: worktree CRUD over real simple-git.</p>

      <Toolbar onCreate={create} />
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <WorktreeList
          worktrees={worktrees}
          loading={loading}
          error={error}
          onRemove={(id) => void remove(id)}
        />
        <section>
          <button type="button" onClick={onPing}>
            Ping main
          </button>
          {pingError && <pre style={{ color: 'crimson' }}>error: {pingError}</pre>}
          {info && (
            <pre data-testid="ping-result" style={{ marginTop: 16 }}>
              {formatVersions(info)}
            </pre>
          )}
        </section>
      </div>
    </main>
  );
}

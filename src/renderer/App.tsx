import { useCallback, useEffect, useState } from 'react';
import type { AgentStatus, AppInfo } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { useWorktrees } from './hooks/use-worktrees';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';
import { AgentTerminal } from './components/terminal/agent-terminal';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<ReadonlyMap<string, AgentStatus>>(new Map());
  const { worktrees, loading, error, create, remove } = useWorktrees();

  // Aggregate every worktree's agent status from the global SESSION_STATUS stream.
  useEffect(() => {
    const off = window.mango.session.onStatus((s) => {
      setAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(s.worktreeId, s.status);
        return next;
      });
    });
    return off;
  }, []);

  const onPing = useCallback(async () => {
    setPingError(null);
    try {
      setInfo(await window.mango.app.ping());
    } catch (e) {
      setPingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>MangoLove IDEA</h1>
      <p>Plan 2: embedded agent terminal (claude via node-pty).</p>

      <Toolbar onCreate={create} />
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <WorktreeList
          worktrees={worktrees}
          loading={loading}
          error={error}
          selectedId={selectedId}
          agentStatuses={agentStatuses}
          onSelect={setSelectedId}
          onRemove={(id) => void remove(id)}
        />
        <section style={{ flex: 1, minWidth: 0 }}>
          {selectedId ? (
            <AgentTerminal key={selectedId} worktreeId={selectedId} />
          ) : (
            <p style={{ fontSize: 13, color: '#888' }}>Select a worktree to start its agent.</p>
          )}
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={onPing}>
              Ping main
            </button>
            {pingError && <pre style={{ color: 'crimson' }}>error: {pingError}</pre>}
            {info && (
              <pre data-testid="ping-result" style={{ marginTop: 16 }}>
                {formatVersions(info)}
              </pre>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

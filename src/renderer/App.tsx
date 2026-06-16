import { useCallback, useEffect, useState } from 'react';
import type { AgentStatus, AppInfo } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { useWorktrees } from './hooks/use-worktrees';
import { useServer } from './hooks/use-server';
import { useLogs } from './hooks/use-logs';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';
import { AgentTerminal } from './components/terminal/agent-terminal';
import { ServerControls } from './components/toolbar/server-controls';
import { LogPanel } from './components/logs/log-panel';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<ReadonlyMap<string, AgentStatus>>(new Map());
  const { worktrees, loading, error, create, remove } = useWorktrees();
  const { status: serverStatus, start: startServer, stop: stopServer } = useServer();
  const logLines = useLogs();

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
      <p>Plan 3: local server + live logs.</p>

      <Toolbar onCreate={create} />
      <ServerControls
        selectedId={selectedId}
        status={serverStatus}
        onStart={(id) => void startServer(id)}
        onStop={() => void stopServer()}
      />
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <WorktreeList
          worktrees={worktrees}
          loading={loading}
          error={error}
          selectedId={selectedId}
          agentStatuses={agentStatuses}
          serverState={serverStatus?.process.state ?? 'stopped'}
          serverWorktreeId={serverStatus?.process.worktreeId ?? null}
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
          <LogPanel lines={logLines} />
        </section>
      </div>
    </main>
  );
}

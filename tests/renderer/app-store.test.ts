import { describe, it, expect } from 'vitest';
import { aggregateStatus } from '../../src/renderer/state/app-store';
import type { Worktree, AgentStatus, ServerStatus } from '../../src/shared/types';

const wt = (id: string, branch: string, isPrimary = false): Worktree => ({
  id,
  path: id,
  branch,
  isPrimary,
  isLocked: false,
});

const serverOn = (id: string | null, state: ServerStatus['process']['state']): ServerStatus => ({
  process: { worktreeId: id, kind: 'npm', state },
});

describe('aggregateStatus', () => {
  it('defaults every worktree to idle/stopped when no events seen', () => {
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), null);
    expect(map.get('/a')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
    expect(map.get('/b')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
  });

  it('folds the agent status for the matching worktree', () => {
    const agents = new Map<string, AgentStatus>([['/b', 'running']]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], agents, null);
    expect(map.get('/b')!.agent).toBe('running');
    expect(map.get('/a')!.agent).toBe('idle');
  });

  it('assigns the server state ONLY to the owning worktree', () => {
    const map = aggregateStatus(
      [wt('/a', 'main', true), wt('/b', 'feat')],
      new Map(),
      serverOn('/b', 'running'),
    );
    expect(map.get('/b')).toMatchObject({ server: 'running', ownsServer: true });
    expect(map.get('/a')).toMatchObject({ server: 'stopped', ownsServer: false });
  });

  it('treats a null server worktreeId as nobody owning the server', () => {
    const map = aggregateStatus([wt('/a', 'main', true)], new Map(), serverOn(null, 'stopped'));
    expect(map.get('/a')).toMatchObject({ server: 'stopped', ownsServer: false });
  });
});

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

const serverOn = (id: string, state: ServerStatus['process']['state']): ServerStatus => ({
  process: { worktreeId: id, kind: 'npm', state },
});

describe('aggregateStatus (per-worktree server map)', () => {
  it('defaults every worktree to idle/stopped when no events seen', () => {
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), new Map());
    expect(map.get('/a')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
    expect(map.get('/b')).toEqual({ agent: 'idle', server: 'stopped', ownsServer: false });
  });

  it('folds the agent status for the matching worktree', () => {
    const agents = new Map<string, AgentStatus>([['/b', 'running']]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], agents, new Map());
    expect(map.get('/b')!.agent).toBe('running');
    expect(map.get('/a')!.agent).toBe('idle');
  });

  it('shows EACH worktree its OWN server state concurrently', () => {
    const servers = new Map<string, ServerStatus>([
      ['/a', serverOn('/a', 'running')],
      ['/b', serverOn('/b', 'crashed')],
    ]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), servers);
    expect(map.get('/a')).toMatchObject({ server: 'running', ownsServer: true });
    expect(map.get('/b')).toMatchObject({ server: 'crashed', ownsServer: true });
  });

  it('a stopped record is NOT owning (ownsServer false, server stopped)', () => {
    const servers = new Map<string, ServerStatus>([['/a', serverOn('/a', 'stopped')]]);
    const map = aggregateStatus([wt('/a', 'main', true)], new Map(), servers);
    expect(map.get('/a')).toMatchObject({ server: 'stopped', ownsServer: false });
  });

  it('an absent record defaults to stopped/not-owning (D8)', () => {
    const servers = new Map<string, ServerStatus>([['/a', serverOn('/a', 'running')]]);
    const map = aggregateStatus([wt('/a', 'main', true), wt('/b', 'feat')], new Map(), servers);
    expect(map.get('/b')).toMatchObject({ server: 'stopped', ownsServer: false });
  });
});

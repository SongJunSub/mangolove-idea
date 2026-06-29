import { describe, it, expect } from 'vitest';
import {
  aggregateStatus,
  isRepoBusy,
  type WorktreeRowStatus,
} from '../../src/renderer/state/app-store';
import type { Worktree, AgentStatus, ServerStatus, ServerState } from '../../src/shared/types';

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

describe('isRepoBusy (in-place repo-switch confirm gate)', () => {
  const row = (agent: AgentStatus, server: ServerState = 'stopped'): WorktreeRowStatus => ({
    agent,
    server,
    ownsServer: server !== 'stopped',
  });
  const statuses = (...rows: WorktreeRowStatus[]): ReadonlyMap<string, WorktreeRowStatus> =>
    new Map(rows.map((r, i) => [`/wt${i}`, r]));

  it('an unsaved editor alone makes the repo busy (even with all agents idle)', () => {
    expect(isRepoBusy(true, statuses(row('idle'), row('idle')))).toBe(true);
  });

  it('a clean editor with only idle/exited/error agents is NOT busy', () => {
    expect(isRepoBusy(false, statuses(row('idle'), row('exited'), row('error')))).toBe(false);
  });

  it("an in-flight agent turn ('running' or 'starting') makes the repo busy", () => {
    expect(isRepoBusy(false, statuses(row('idle'), row('running')))).toBe(true);
    expect(isRepoBusy(false, statuses(row('starting')))).toBe(true);
  });

  it('a live dev server alone does NOT make the repo busy (cheap to restart, no work lost)', () => {
    expect(isRepoBusy(false, statuses(row('idle', 'running')))).toBe(false);
  });

  it('no worktrees + clean editor is not busy', () => {
    expect(isRepoBusy(false, new Map())).toBe(false);
  });
});

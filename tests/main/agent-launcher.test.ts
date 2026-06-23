import { describe, it, expect } from 'vitest';
import { DirectLauncher } from '../../src/main/pty/agent-launcher';

const CTX = { worktreeId: '/repo/.worktrees/feat', cwd: '/repo/.worktrees/feat' };

describe('DirectLauncher', () => {
  it('launches the default agent command with no args in fresh mode', () => {
    const l = new DirectLauncher('claude');
    expect(l.resolveLaunch({ ...CTX, mode: 'fresh' })).toEqual({ file: 'claude', args: [] });
  });

  it('passes --continue in continue mode', () => {
    const l = new DirectLauncher('claude');
    expect(l.resolveLaunch({ ...CTX, mode: 'continue' })).toEqual({
      file: 'claude',
      args: ['--continue'],
    });
  });

  it('treats attach like continue (DirectLauncher owns no detached session to attach)', () => {
    const l = new DirectLauncher('claude');
    expect(l.resolveLaunch({ ...CTX, mode: 'attach' })).toEqual({
      file: 'claude',
      args: ['--continue'],
    });
  });

  it('honors a custom agent command (settings/env override)', () => {
    const l = new DirectLauncher('my-agent');
    expect(l.resolveLaunch({ ...CTX, mode: 'fresh' })).toEqual({ file: 'my-agent', args: [] });
  });
});

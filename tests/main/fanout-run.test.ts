import { describe, it, expect } from 'vitest';
import { slugModel, assertSafeModel, buildLaneArgs, runLane } from '../../src/main/git/fanout-run';
import type {
  ProcessRunner,
  IProcLike,
  ProcSpawnOptions,
} from '../../src/main/proc/process-runner';
import { makeFakeRunner, type FakeProcHandle } from '../helpers/fake-runner';

/** Records every spawnArgs call + hands back a controllable fake child. */
function makeRecordingRunner(handle: FakeProcHandle) {
  const calls: { file: string; args: string[]; opts: ProcSpawnOptions }[] = [];
  const runner: ProcessRunner = {
    spawn: () => {
      throw new Error('runLane must use spawnArgs, never spawn (no shell interpolation)');
    },
    spawnArgs: (file, args, opts): IProcLike => {
      calls.push({ file, args: [...args], opts });
      return handle;
    },
  };
  return { runner, calls };
}

describe('slugModel', () => {
  it('keeps a simple tier as-is', () => {
    expect(slugModel('haiku')).toBe('haiku');
  });
  it('slugs a fully-qualified model id to a branch/fs-safe token', () => {
    expect(slugModel('claude-opus-4-20250514')).toBe('claude-opus-4-20250514');
  });
  it('collapses unsafe characters and trims dashes', () => {
    expect(slugModel('us.anthropic/Sonnet 4')).toBe('us.anthropic-Sonnet-4');
  });
});

describe('assertSafeModel', () => {
  it('rejects a leading dash (option-injection guard)', () => {
    expect(() => assertSafeModel('--dangerously')).toThrow(/invalid model/i);
  });
  it('rejects an empty token', () => {
    expect(() => assertSafeModel('')).toThrow(/invalid model/i);
  });
  it('accepts a normal tier', () => {
    expect(() => assertSafeModel('opus')).not.toThrow();
  });
});

describe('buildLaneArgs', () => {
  it('builds the discrete claude -p argv with acceptEdits + model, prompt NOT interpolated', () => {
    expect(buildLaneArgs('fix the bug; rm -rf /', 'haiku', false)).toEqual([
      '-p',
      'fix the bug; rm -rf /',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'haiku',
    ]);
  });
  it('appends --dangerously-skip-permissions when skipPermissions is true', () => {
    expect(buildLaneArgs('do it', 'opus', true)).toEqual([
      '-p',
      'do it',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'opus',
      '--dangerously-skip-permissions',
    ]);
  });
});

describe('runLane', () => {
  it('spawns the agentCommand with buildLaneArgs in cwd and resolves the exit + stdout tail', async () => {
    const handle = makeFakeRunner();
    const { runner, calls } = makeRecordingRunner(handle);
    let spawned: IProcLike | undefined;
    const p = runLane({
      runner,
      agentCommand: 'fake-claude',
      prompt: 'write a haiku',
      model: 'haiku',
      cwd: '/tmp/lane',
      skipPermissions: false,
      onSpawn: (proc) => {
        spawned = proc;
      },
    });
    handle.emitStdout('working...\ndone\n');
    handle.emitExit(0);
    const result = await p;

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('fake-claude');
    expect(calls[0].args).toEqual([
      '-p',
      'write a haiku',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'haiku',
    ]);
    expect(calls[0].opts.cwd).toBe('/tmp/lane');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('done');
    expect(spawned).toBe(handle);
  });

  it('resolves with the spawn-error code when the binary is missing (ENOENT)', async () => {
    const handle = makeFakeRunner();
    const { runner } = makeRecordingRunner(handle);
    const p = runLane({
      runner,
      agentCommand: 'missing-bin',
      prompt: 'x',
      model: 'opus',
      cwd: '/tmp/lane',
      skipPermissions: false,
    });
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    handle.emitError(enoent);
    const result = await p;
    expect(result.code).toBe(null);
    expect(result.stderr).toMatch(/ENOENT|missing/i);
  });

  it('rejects an unsafe model token before spawning', async () => {
    const handle = makeFakeRunner();
    const { runner, calls } = makeRecordingRunner(handle);
    await expect(
      runLane({
        runner,
        agentCommand: 'fake-claude',
        prompt: 'x',
        model: '-evil',
        cwd: '/tmp/lane',
        skipPermissions: false,
      }),
    ).rejects.toThrow(/invalid model/i);
    expect(calls).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { makeFakeRunner } from '../helpers/fake-runner';

describe('IProcLike onError (gh-missing seam)', () => {
  it('delivers a spawn error to the onError callback', () => {
    const proc = makeFakeRunner();
    let received: Error | null = null;
    proc.onError((e) => {
      received = e;
    });
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT', errno: -2 });
    proc.emitError(err);
    expect(received).not.toBeNull();
    expect((received as unknown as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('does not also fire onExit when only an error was emitted', () => {
    const proc = makeFakeRunner();
    let exited = false;
    proc.onExit(() => {
      exited = true;
    });
    proc.emitError(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
    expect(exited).toBe(false);
  });
});

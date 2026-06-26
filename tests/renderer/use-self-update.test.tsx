import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSelfUpdate } from '../../src/renderer/hooks/use-self-update';
import type {
  UpdateProgress,
  UpdateApplyResult,
  UpdatePerformRequest,
} from '../../src/shared/types';

const req: UpdatePerformRequest = {
  dmgUrl: 'https://github.com/x/y/r/v0.2.0/a.dmg',
  sha256: 'abc',
};

/** Stub window.mango.update with controllable perform + a progress emitter. */
function stub(performResult?: UpdateApplyResult) {
  let progressCb: ((e: UpdateProgress) => void) | undefined;
  const perform = vi.fn(
    async (): Promise<UpdateApplyResult> => performResult ?? { status: 'error', reason: 'boom' },
  );
  const onProgress = vi.fn((cb: (e: UpdateProgress) => void) => {
    progressCb = cb;
    return () => {
      progressCb = undefined;
    };
  });
  Object.defineProperty(window, 'mango', {
    value: { update: { perform, onProgress } },
    configurable: true,
  });
  return { perform, onProgress, emit: (e: UpdateProgress) => progressCb?.(e) };
}

describe('useSelfUpdate', () => {
  it('starts idle and subscribes to progress', () => {
    const { onProgress } = stub();
    const { result } = renderHook(() => useSelfUpdate());
    expect(result.current.state).toEqual({ phase: 'idle' });
    expect(onProgress).toHaveBeenCalledOnce();
  });

  it('start() flips to downloading and calls perform with the request', () => {
    const { perform } = stub({ status: 'started', reason: '' });
    const { result } = renderHook(() => useSelfUpdate());
    act(() => result.current.start(req));
    expect(result.current.state.phase).toBe('downloading');
    expect(perform).toHaveBeenCalledWith(req);
  });

  it('reflects main-emitted progress events', () => {
    const { emit } = stub({ status: 'started', reason: '' });
    const { result } = renderHook(() => useSelfUpdate());
    act(() => result.current.start(req));
    act(() => emit({ phase: 'verifying' }));
    expect(result.current.state).toEqual({ phase: 'verifying' });
  });

  it('surfaces a non-success result as an error state (success would quit the app)', async () => {
    stub({ status: 'ineligible', reason: 'Installed via Homebrew' });
    const { result } = renderHook(() => useSelfUpdate());
    act(() => result.current.start(req));
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    expect(result.current.state).toEqual({ phase: 'error', reason: 'Installed via Homebrew' });
  });
});

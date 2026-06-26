import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUpdateCheck } from '../../src/renderer/hooks/use-update-check';
import type { UpdateStatus } from '../../src/shared/types';

const upToDate: UpdateStatus = {
  currentVersion: '0.1.1',
  latestVersion: '0.1.1',
  updateAvailable: false,
  releaseUrl: null,
  dmgUrl: null,
  sha256: null,
  publishedAt: null,
};

/** Installs a window.mango.update.check stub and returns the spy. */
function stubCheck(result: UpdateStatus = upToDate) {
  const check = vi.fn(async () => result);
  Object.defineProperty(window, 'mango', { value: { update: { check } }, configurable: true });
  return check;
}

describe('useUpdateCheck', () => {
  it('runs ONE silent check on mount when checkOnMount=true', async () => {
    const check = stubCheck();
    const { result } = renderHook(() => useUpdateCheck(true));
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(check).toHaveBeenCalledOnce();
    expect(result.current.checking).toBe(false); // the mount check never toggles `checking`
  });

  it('does NOT check on mount when checkOnMount=false', () => {
    const check = stubCheck();
    renderHook(() => useUpdateCheck(false));
    expect(check).not.toHaveBeenCalled();
  });

  it('manual check() sets status (and leaves checking false when settled)', async () => {
    const check = stubCheck();
    const { result } = renderHook(() => useUpdateCheck(false));
    await act(async () => {
      await result.current.check();
    });
    expect(check).toHaveBeenCalledOnce();
    expect(result.current.status).toEqual(upToDate);
    expect(result.current.checking).toBe(false);
  });
});

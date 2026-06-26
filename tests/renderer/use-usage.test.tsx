import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useUsage } from '../../src/renderer/hooks/use-usage';
import type { UsageStatus } from '../../src/shared/types';

const sample: UsageStatus = {
  limits: [
    { kind: 'session', label: '세션', percent: 3, severity: 'normal', resetsAt: null, model: null },
  ],
};

function stub(result: UsageStatus = sample) {
  const get = vi.fn(async () => result);
  Object.defineProperty(window, 'mango', { value: { usage: { get } }, configurable: true });
  return get;
}

describe('useUsage', () => {
  it('fetches on mount and exposes the status', async () => {
    const get = stub();
    const { result } = renderHook(() => useUsage());
    await waitFor(() => expect(result.current.status).not.toBeNull());
    expect(get).toHaveBeenCalledOnce();
    expect(result.current.status).toEqual(sample);
    expect(result.current.loading).toBe(false);
  });

  it('refresh() re-fetches', async () => {
    const get = stub();
    const { result } = renderHook(() => useUsage());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.refresh();
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

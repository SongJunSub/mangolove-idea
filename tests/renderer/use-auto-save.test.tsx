import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoSave } from '../../src/renderer/hooks/use-auto-save';

interface Demo {
  a?: string;
  b?: string;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useAutoSave', () => {
  it('debounces queued patches into one merged write after the delay', () => {
    const persist = vi.fn();
    const { result } = renderHook(() => useAutoSave<Demo>(persist, 400));

    result.current.queue({ a: '1' });
    result.current.queue({ b: '2' });
    expect(persist).not.toHaveBeenCalled(); // still within the debounce window

    vi.advanceTimersByTime(400);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ a: '1', b: '2' });
  });

  it('immediate=true flushes at once', () => {
    const persist = vi.fn();
    const { result } = renderHook(() => useAutoSave<Demo>(persist, 400));

    result.current.queue({ a: 'x' }, true);
    expect(persist).toHaveBeenCalledWith({ a: 'x' });
  });

  it('flush() writes a pending patch immediately and only once', () => {
    const persist = vi.fn();
    const { result } = renderHook(() => useAutoSave<Demo>(persist, 400));

    result.current.queue({ a: '1' });
    result.current.flush();
    expect(persist).toHaveBeenCalledTimes(1);

    // The cancelled debounce timer must not fire a second write.
    vi.advanceTimersByTime(400);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending patch on unmount (value typed right before close is not lost)', () => {
    const persist = vi.fn();
    const { result, unmount } = renderHook(() => useAutoSave<Demo>(persist, 400));

    result.current.queue({ a: 'last' });
    unmount();
    expect(persist).toHaveBeenCalledWith({ a: 'last' });
  });

  it('flush() with nothing pending is a no-op', () => {
    const persist = vi.fn();
    const { result } = renderHook(() => useAutoSave<Demo>(persist, 400));
    result.current.flush();
    expect(persist).not.toHaveBeenCalled();
  });
});

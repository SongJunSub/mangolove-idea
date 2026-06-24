import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveTheme, applyTheme } from '../../src/renderer/lib/theme';

describe('resolveTheme (pure)', () => {
  it('returns the explicit mode regardless of OS preference', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it("follows the OS for 'system' and for unset/unknown", () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme(undefined, true)).toBe('dark');
    expect(resolveTheme(undefined, false)).toBe('light');
  });
});

describe('applyTheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    vi.unstubAllGlobals();
  });

  /** Installs a matchMedia stub reporting the given OS dark-mode preference.
   *  jsdom has no matchMedia, so we DEFINE it (stubGlobal), not spy on it. */
  function stubMatchMedia(prefersDark: boolean) {
    const listeners: Array<() => void> = [];
    const mql = {
      matches: prefersDark,
      addEventListener: (_: string, cb: () => void) => listeners.push(cb),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mql),
    );
    return { mql, listeners };
  }

  it('sets data-theme to the explicit mode and does not subscribe to OS changes', () => {
    const { listeners } = stubMatchMedia(true); // OS=dark, but explicit light wins
    const cleanup = applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(listeners).toHaveLength(0); // explicit mode => no OS subscription
    cleanup();
  });

  it("resolves 'system' from the OS preference and tracks live changes", () => {
    const { mql, listeners } = stubMatchMedia(true);
    const cleanup = applyTheme('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(listeners).toHaveLength(1); // subscribed to OS changes

    // OS flips to light -> the listener re-applies.
    (mql as { matches: boolean }).matches = false;
    listeners[0]();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    cleanup();
  });
});

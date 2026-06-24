/** The persisted theme preference; 'system' (or unset) follows the OS. */
export type ThemeSetting = 'dark' | 'light' | 'system';

/**
 * Resolves a theme preference to the concrete mode. 'dark'/'light' are explicit;
 * 'system' (and any unset/unknown value) defers to the OS preference (prefersDark).
 * Pure — the DOM/matchMedia side lives in applyTheme.
 */
export function resolveTheme(
  setting: ThemeSetting | undefined,
  prefersDark: boolean,
): 'dark' | 'light' {
  if (setting === 'dark') return 'dark';
  if (setting === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

/**
 * Applies the resolved theme to <html data-theme>. For 'system' (or unset) it also
 * tracks live OS changes. Returns a cleanup that removes the OS listener (a no-op for
 * the explicit modes), so callers can run it from a React effect.
 */
export function applyTheme(setting: ThemeSetting | undefined): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (): void => {
    document.documentElement.setAttribute('data-theme', resolveTheme(setting, mq.matches));
  };
  apply();
  if (setting === 'dark' || setting === 'light') return () => {};
  mq.addEventListener('change', apply);
  return () => mq.removeEventListener('change', apply);
}

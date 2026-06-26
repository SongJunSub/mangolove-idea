import type { Locale } from './messages';

/** The persisted preference: an explicit language, or 'system' (follow the OS). */
export type LocaleSetting = 'system' | 'ko' | 'en';

/**
 * Resolves the effective UI locale. An explicit 'ko'/'en' wins; otherwise (unset or
 * 'system') it follows the OS — Korean when the OS locale starts with 'ko', else English.
 * `osLocale` is typically navigator.language (e.g. 'ko-KR', 'en-US').
 */
export function resolveLocale(setting: LocaleSetting | undefined, osLocale: string): Locale {
  if (setting === 'ko' || setting === 'en') return setting;
  return osLocale.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** Narrows an arbitrary persisted string to a valid LocaleSetting ('system' when unknown). */
export function asLocaleSetting(raw: string | undefined): LocaleSetting {
  return raw === 'ko' || raw === 'en' || raw === 'system' ? raw : 'system';
}

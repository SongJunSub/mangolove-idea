import { createContext, useContext } from 'react';
import type { Locale, TranslateFn } from './messages';

/** What every component reads from the i18n context. */
export interface I18n {
  /** The resolved UI locale ('ko' | 'en'). */
  readonly locale: Locale;
  /** Translate a message key, optionally filling {name} placeholders. */
  readonly t: TranslateFn;
}

/**
 * Provided by App (which both supplies and consumes the same value, so the titlebar it
 * renders can translate too). Null outside a provider so useI18n can fail loudly rather
 * than silently render raw keys.
 */
export const I18nContext = createContext<I18n | null>(null);

/** Reads the current locale + translate function. Throws if used outside the provider. */
export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (ctx === null) {
    throw new Error('useI18n must be used within an I18nContext provider');
  }
  return ctx;
}

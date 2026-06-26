import { render } from '@testing-library/react';
import { I18nContext } from '../../src/renderer/i18n/i18n-context';
import { makeT, type Locale } from '../../src/renderer/i18n/messages';

/** Wraps a UI tree in an i18n provider for the given locale (default English). */
export function wrapI18n(ui: React.ReactElement, locale: Locale = 'en'): React.JSX.Element {
  return <I18nContext.Provider value={{ locale, t: makeT(locale) }}>{ui}</I18nContext.Provider>;
}

/** render() with an i18n provider already wrapped around the tree. */
export function renderWithI18n(
  ui: React.ReactElement,
  locale: Locale = 'en',
): ReturnType<typeof render> {
  return render(wrapI18n(ui, locale));
}

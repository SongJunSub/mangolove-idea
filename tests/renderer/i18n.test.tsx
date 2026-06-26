import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { en, ko, makeT, format } from '../../src/renderer/i18n/messages';
import { resolveLocale, asLocaleSetting } from '../../src/renderer/i18n/resolve-locale';
import { I18nContext, useI18n } from '../../src/renderer/i18n/i18n-context';

describe('messages catalog', () => {
  it('ko covers exactly the same keys as en (no drift)', () => {
    const enKeys = Object.keys(en).sort();
    const koKeys = Object.keys(ko).sort();
    expect(koKeys).toEqual(enKeys);
  });

  it('no catalog value is an empty string', () => {
    for (const [key, value] of Object.entries({ ...en, ...ko })) {
      expect(value, `empty value for ${key}`).not.toBe('');
    }
  });
});

describe('format', () => {
  it('fills {name} placeholders and leaves missing ones untouched', () => {
    expect(format('v{version} is available.', { version: '1.2.3' })).toBe('v1.2.3 is available.');
    expect(format('hi {who}', {})).toBe('hi {who}');
    expect(format('no params')).toBe('no params');
  });
});

describe('makeT', () => {
  it('translates from the requested locale', () => {
    expect(makeT('ko')('settings.title')).toBe('설정');
    expect(makeT('en')('settings.title')).toBe('Settings');
  });

  it('interpolates params', () => {
    expect(makeT('en')('settings.updates.available', { version: '0.2.0' })).toBe(
      'v0.2.0 is available.',
    );
  });
});

describe('resolveLocale', () => {
  it('honors an explicit ko/en setting regardless of OS', () => {
    expect(resolveLocale('ko', 'en-US')).toBe('ko');
    expect(resolveLocale('en', 'ko-KR')).toBe('en');
  });

  it("follows the OS for 'system'/undefined", () => {
    expect(resolveLocale('system', 'ko-KR')).toBe('ko');
    expect(resolveLocale('system', 'en-US')).toBe('en');
    expect(resolveLocale(undefined, 'KO')).toBe('ko'); // case-insensitive
    expect(resolveLocale(undefined, 'fr-FR')).toBe('en'); // non-Korean => English
  });
});

describe('asLocaleSetting', () => {
  it('passes valid values and falls back to system', () => {
    expect(asLocaleSetting('ko')).toBe('ko');
    expect(asLocaleSetting('en')).toBe('en');
    expect(asLocaleSetting('system')).toBe('system');
    expect(asLocaleSetting('garbage')).toBe('system');
    expect(asLocaleSetting(undefined)).toBe('system');
  });
});

describe('useI18n', () => {
  it('throws when used outside a provider', () => {
    expect(() => renderHook(() => useI18n())).toThrow(/within an I18nContext provider/);
  });

  it('returns the provided locale + translate fn', () => {
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
      <I18nContext.Provider value={{ locale: 'ko', t: makeT('ko') }}>
        {children}
      </I18nContext.Provider>
    );
    const { result } = renderHook(() => useI18n(), { wrapper });
    expect(result.current.locale).toBe('ko');
    expect(result.current.t('settings.done')).toBe('닫기');
  });
});

import { describe, it, expect } from 'vitest';
import {
  languageForPath,
  NAV_LANGUAGES,
  TSJS_LANGUAGES,
} from '../../src/renderer/lib/language-for-path';

describe('languageForPath', () => {
  it('maps TS/JS extensions to typescript/javascript', () => {
    for (const p of ['a.ts', 'a.mts', 'a.cts', 'src/x.tsx'])
      expect(languageForPath(p)).toBe('typescript');
    for (const p of ['a.js', 'a.mjs', 'a.cjs', 'src/x.jsx'])
      expect(languageForPath(p)).toBe('javascript');
  });

  it('maps Java/Kotlin extensions', () => {
    expect(languageForPath('Main.java')).toBe('java');
    expect(languageForPath('App.kt')).toBe('kotlin');
    expect(languageForPath('build.gradle.kts')).toBe('kotlin');
  });

  it('falls back to plaintext for unknown extensions, dotfiles, and no extension', () => {
    expect(languageForPath('README.md')).toBe('plaintext');
    expect(languageForPath('Makefile')).toBe('plaintext');
    expect(languageForPath('.gitignore')).toBe('plaintext'); // leading dot is not an extension
    expect(languageForPath('dir.with.dots/file')).toBe('plaintext');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageForPath('A.TS')).toBe('typescript');
    expect(languageForPath('X.Java')).toBe('java');
  });

  it('NAV_LANGUAGES + TSJS_LANGUAGES describe the participating sets', () => {
    expect([...NAV_LANGUAGES].sort()).toEqual(['java', 'javascript', 'kotlin', 'typescript']);
    expect(TSJS_LANGUAGES.has('typescript')).toBe(true);
    expect(TSJS_LANGUAGES.has('java')).toBe(false);
  });
});

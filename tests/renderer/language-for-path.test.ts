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

  it('maps common non-nav languages for syntax highlighting (colors, no nav)', () => {
    expect(languageForPath('README.md')).toBe('markdown');
    expect(languageForPath('pkg/config.json')).toBe('json');
    expect(languageForPath('a.yaml')).toBe('yaml');
    expect(languageForPath('styles.css')).toBe('css');
    expect(languageForPath('main.py')).toBe('python');
    expect(languageForPath('server.go')).toBe('go');
    expect(languageForPath('lib.rs')).toBe('rust');
    expect(languageForPath('index.html')).toBe('html');
    expect(languageForPath('run.sh')).toBe('shell');
    expect(languageForPath('schema.sql')).toBe('sql');
    // none of these are nav languages
    for (const p of ['README.md', 'config.json', 'main.py'])
      expect(NAV_LANGUAGES.has(languageForPath(p))).toBe(false);
  });

  it('maps common extensionless files by name (Dockerfile, Gemfile)', () => {
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('services/Gemfile')).toBe('ruby');
  });

  it('maps common dotfiles + .env variants', () => {
    expect(languageForPath('.bashrc')).toBe('shell');
    expect(languageForPath('project/.zshrc')).toBe('shell');
    expect(languageForPath('.editorconfig')).toBe('ini');
    expect(languageForPath('.npmrc')).toBe('ini');
    expect(languageForPath('.env')).toBe('ini');
    expect(languageForPath('.env.production')).toBe('ini');
    expect(languageForPath('.envrc')).toBe('plaintext'); // direnv (shell), NOT an env file → not 'ini'
  });

  it('falls back to plaintext for unknown extensions, dotfiles, and no extension', () => {
    expect(languageForPath('Makefile')).toBe('plaintext'); // no monaco grammar
    expect(languageForPath('notes.unknownext')).toBe('plaintext');
    expect(languageForPath('.gitignore')).toBe('plaintext'); // leading dot is not an extension
    expect(languageForPath('dir.with.dots/file')).toBe('plaintext');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageForPath('A.TS')).toBe('typescript');
    expect(languageForPath('X.Java')).toBe('java');
    expect(languageForPath('READ.MD')).toBe('markdown');
  });

  it('NAV_LANGUAGES + TSJS_LANGUAGES describe the participating sets', () => {
    expect([...NAV_LANGUAGES].sort()).toEqual(['java', 'javascript', 'kotlin', 'typescript']);
    expect(TSJS_LANGUAGES.has('typescript')).toBe(true);
    expect(TSJS_LANGUAGES.has('java')).toBe(false);
  });
});

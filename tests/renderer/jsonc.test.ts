import { describe, it, expect } from 'vitest';
import { parseJsonc } from '../../src/renderer/lib/code-nav/jsonc';

describe('parseJsonc', () => {
  it('parses plain JSON unchanged', () => {
    expect(parseJsonc('{"a":1,"b":["x","y"]}')).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('strips // line comments', () => {
    const text = `{
      // leading comment
      "compilerOptions": { "baseUrl": "." } // trailing comment
    }`;
    expect(parseJsonc(text)).toEqual({ compilerOptions: { baseUrl: '.' } });
  });

  it('strips /* block */ comments, including multi-line', () => {
    const text = `{
      /* a
         multi-line block */
      "x": 1 /* inline */, "y": 2
    }`;
    expect(parseJsonc(text)).toEqual({ x: 1, y: 2 });
  });

  it('drops trailing commas before } and ]', () => {
    const text = `{
      "paths": { "@/*": ["src/*",], },
      "list": [1, 2, 3,],
    }`;
    expect(parseJsonc(text)).toEqual({ paths: { '@/*': ['src/*'] }, list: [1, 2, 3] });
  });

  it('preserves // and trailing-comma-looking characters INSIDE strings', () => {
    const text = `{ "url": "https://example.com/a,b", "glob": "src/**/*", "comma": "x,]" }`;
    expect(parseJsonc(text)).toEqual({
      url: 'https://example.com/a,b',
      glob: 'src/**/*',
      comma: 'x,]',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJsonc('{ "q": "a\\"b//c" }')).toEqual({ q: 'a"b//c' });
  });

  it('handles many/nested trailing commas correctly (O(n) array rebuild)', () => {
    const text = `{ "a": [1, 2,], "b": { "c": [3,], "d": 4, }, "e": [[5,], [6,],], }`;
    expect(parseJsonc(text)).toEqual({ a: [1, 2], b: { c: [3], d: 4 }, e: [[5], [6]] });
  });

  it('does not drop a comma that is followed by more content before the closer', () => {
    expect(parseJsonc('{ "a": 1, "b": 2 }')).toEqual({ a: 1, b: 2 });
    expect(parseJsonc('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('throws on genuinely malformed input (caller fails closed)', () => {
    expect(() => parseJsonc('{ not json }')).toThrow();
    expect(() => parseJsonc('')).toThrow();
  });
});

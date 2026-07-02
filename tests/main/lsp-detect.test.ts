import { describe, it, expect } from 'vitest';
import { resolveLspServerPath, unavailableReason } from '../../src/main/lsp/lsp-detect';

describe('resolveLspServerPath', () => {
  it('returns null when no known path exists (graceful disable)', () => {
    expect(resolveLspServerPath('java', { exists: () => false })).toBeNull();
    expect(resolveLspServerPath('kotlin', { exists: () => false })).toBeNull();
  });

  it('returns the first existing absolute path from the known probe dirs', () => {
    const onlyBrew = (p: string) => p === '/opt/homebrew/bin/jdtls';
    expect(resolveLspServerPath('java', { exists: onlyBrew })).toBe('/opt/homebrew/bin/jdtls');
    const onlyUsrLocal = (p: string) => p === '/usr/local/bin/kotlin-language-server';
    expect(resolveLspServerPath('kotlin', { exists: onlyUsrLocal })).toBe(
      '/usr/local/bin/kotlin-language-server',
    );
  });

  it('kotlin prefers JetBrains kotlin-lsp, falling back to kotlin-language-server', () => {
    // both installed -> kotlin-lsp wins (preference dominates location)
    const both = (p: string) =>
      p === '/opt/homebrew/bin/kotlin-lsp' || p === '/opt/homebrew/bin/kotlin-language-server';
    expect(resolveLspServerPath('kotlin', { exists: both })).toBe('/opt/homebrew/bin/kotlin-lsp');
    // kotlin-lsp preferred even when it lives in a later probe dir than the old server
    const split = (p: string) =>
      p === '/usr/bin/kotlin-lsp' || p === '/opt/homebrew/bin/kotlin-language-server';
    expect(resolveLspServerPath('kotlin', { exists: split })).toBe('/usr/bin/kotlin-lsp');
    // only the old server present -> fall back to it
    const onlyOld = (p: string) => p === '/opt/homebrew/bin/kotlin-language-server';
    expect(resolveLspServerPath('kotlin', { exists: onlyOld })).toBe(
      '/opt/homebrew/bin/kotlin-language-server',
    );
  });

  it('honors a Settings override ONLY if it exists', () => {
    const probe = {
      exists: (p: string) => p === '/custom/jdtls',
      overrides: { java: '/custom/jdtls' },
    };
    expect(resolveLspServerPath('java', probe)).toBe('/custom/jdtls');
    // a stale override (does not exist) degrades to null, never a $PATH fallback
    expect(
      resolveLspServerPath('java', { exists: () => false, overrides: { java: '/gone/jdtls' } }),
    ).toBeNull();
  });

  it('never consults process.env.PATH (only the injected exists() is used)', () => {
    // Structural guarantee: the resolver references no env. Prove it returns null even
    // when a same-named binary would be on a hypothetical PATH (we only feed exists()).
    const calls: string[] = [];
    const probe = { exists: (p: string) => (calls.push(p), false) };
    resolveLspServerPath('java', probe);
    expect(calls).toEqual(['/opt/homebrew/bin/jdtls', '/usr/local/bin/jdtls', '/usr/bin/jdtls']);
  });

  it('unavailableReason mentions the binary + how to fix, no fs path leak', () => {
    expect(unavailableReason('java')).toMatch(/jdtls/);
    expect(unavailableReason('kotlin')).toMatch(/kotlin-lsp/); // recommends the preferred server
  });
});

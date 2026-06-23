import { describe, it, expect } from 'vitest';
import { resolveAbducoPath } from '../../src/main/pty/abduco-path';

describe('resolveAbducoPath', () => {
  it('returns null on non-darwin (abduco is POSIX; the app ships --mac)', () => {
    expect(
      resolveAbducoPath({
        isPackaged: false,
        platform: 'win32',
        resourcesPath: '/r',
        exists: () => true,
      }),
    ).toBeNull();
  });

  it('packaged: returns the BUNDLED resources/bin/abduco when present', () => {
    expect(
      resolveAbducoPath({
        isPackaged: true,
        platform: 'darwin',
        resourcesPath: '/App/Contents/Resources',
        exists: (p) => p === '/App/Contents/Resources/bin/abduco',
      }),
    ).toBe('/App/Contents/Resources/bin/abduco');
  });

  it('packaged: returns null when the bundled binary is missing (=> b-lite fallback)', () => {
    expect(
      resolveAbducoPath({
        isPackaged: true,
        platform: 'darwin',
        resourcesPath: '/App/Contents/Resources',
        exists: () => false,
      }),
    ).toBeNull();
  });

  it('packaged: NEVER falls back to a $PATH/Homebrew location (hijack surface)', () => {
    // Even if a Homebrew abduco exists, a packaged app must use ONLY the bundle.
    expect(
      resolveAbducoPath({
        isPackaged: true,
        platform: 'darwin',
        resourcesPath: '/App/Contents/Resources',
        exists: (p) => p === '/opt/homebrew/bin/abduco',
      }),
    ).toBeNull();
  });

  it('dev: returns the first existing known absolute path', () => {
    expect(
      resolveAbducoPath({
        isPackaged: false,
        platform: 'darwin',
        resourcesPath: '/r',
        exists: (p) => p === '/opt/homebrew/bin/abduco',
      }),
    ).toBe('/opt/homebrew/bin/abduco');
  });

  it('dev: returns null when no known absolute path exists', () => {
    expect(
      resolveAbducoPath({
        isPackaged: false,
        platform: 'darwin',
        resourcesPath: '/r',
        exists: () => false,
      }),
    ).toBeNull();
  });
});

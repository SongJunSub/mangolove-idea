import { describe, it, expect } from 'vitest';
import {
  assessEligibility,
  eligibilityMessage,
  type EligibilityProbe,
  type EligibilityReason,
} from '../../src/main/update/update-eligibility';

const APP = '/Applications/MangoLove IDEA.app';
const EXE = `${APP}/Contents/MacOS/MangoLove IDEA`;

/** A probe with darwin/packaged defaults pointing at /Applications; override per test. */
function probe(over: Partial<EligibilityProbe> = {}): EligibilityProbe {
  return {
    platform: 'darwin',
    isPackaged: true,
    exePath: () => EXE,
    realpath: (p) => p,
    isWritableDir: () => true,
    isHomebrewManaged: () => false,
    ...over,
  };
}

describe('assessEligibility', () => {
  it('accepts a writable /Applications install and returns the canonical app path', () => {
    const e = assessEligibility(probe());
    expect(e).toEqual({ ok: true, appPath: APP });
  });

  it('resolves symlinks before judging (a Caskroom symlink is seen as homebrew)', () => {
    const real = '/opt/homebrew/Caskroom/mangolove-idea/0.1.1/MangoLove IDEA.app';
    const e = assessEligibility(probe({ realpath: () => real }));
    expect(e).toEqual({ ok: false, reason: 'homebrew' });
  });

  it.each<[string, Partial<EligibilityProbe>, EligibilityReason]>([
    ['non-macos', { platform: 'win32' }, 'not-macos'],
    ['dev build', { isPackaged: false }, 'dev'],
    ['exe not in a .app', { exePath: () => '/usr/local/bin/mango' }, 'not-app'],
    [
      'app translocation',
      { realpath: () => '/private/var/folders/x/AppTranslocation/ABC/d/MangoLove IDEA.app' },
      'translocated',
    ],
    [
      'caskroom-path install',
      { realpath: () => '/opt/homebrew/Caskroom/m/0.1.1/MangoLove IDEA.app' },
      'homebrew',
    ],
    ['brew cask copied to /Applications', { isHomebrewManaged: () => true }, 'homebrew'],
    ['read-only parent', { isWritableDir: () => false }, 'not-writable'],
  ])('refuses %s', (_label, over, reason) => {
    expect(assessEligibility(probe(over))).toEqual({ ok: false, reason });
  });

  it('refuses when realpath throws (missing bundle)', () => {
    const e = assessEligibility(
      probe({
        realpath: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(e).toEqual({ ok: false, reason: 'not-app' });
  });

  it('every reason has a non-empty user message', () => {
    const reasons: EligibilityReason[] = [
      'not-macos',
      'dev',
      'not-app',
      'translocated',
      'homebrew',
      'not-writable',
    ];
    for (const r of reasons) expect(eligibilityMessage(r).length).toBeGreaterThan(0);
    expect(eligibilityMessage('homebrew')).toContain('brew upgrade');
  });
});

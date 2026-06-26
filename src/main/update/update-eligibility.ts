/**
 * Decides whether the running macOS app can SAFELY replace its own .app bundle in place
 * (the one-click self-update). The app is unsigned, so we cannot use Squirrel; we swap the
 * bundle ourselves — but only when doing so won't corrupt the install or fight another
 * package manager. Pure + injectable so every branch is unit-tested without a real app.
 */

/** Why an in-place self-update is refused (each maps to a user-facing fallback message). */
export type EligibilityReason =
  | 'not-macos' // self-swap is macOS-only here
  | 'dev' // running unpackaged (electron-vite dev) — never swap the dev tree
  | 'not-app' // exe path is not inside a *.app bundle
  | 'translocated' // Gatekeeper App Translocation: running from a randomized read-only mount
  | 'homebrew' // installed via a Homebrew Caskroom — swapping out-of-band desyncs brew
  | 'not-writable'; // the .app's parent dir is not writable

export type Eligibility =
  | { readonly ok: true; readonly appPath: string }
  | { readonly ok: false; readonly reason: EligibilityReason };

/** Injected probes so the decision is pure + testable (no electron/fs at the call site). */
export interface EligibilityProbe {
  /** process.platform. */
  readonly platform: string;
  /** app.isPackaged (false in dev). */
  readonly isPackaged: boolean;
  /** app.getPath('exe') — .../Foo.app/Contents/MacOS/Foo. */
  exePath(): string;
  /** Canonicalizes a path (realpathSync); throws if missing. */
  realpath(p: string): string;
  /** True iff `dir` is writable by this process (accessSync W_OK). */
  isWritableDir(dir: string): boolean;
  /**
   * True iff this app appears to be a Homebrew cask install. A path-substring check is not
   * enough: a cask copies the .app into /Applications and keeps only metadata in the
   * Caskroom, so the running bundle's path has no '/Caskroom/' segment — this probes for a
   * Caskroom record instead (e.g. <caskroom>/mangolove-idea exists).
   */
  isHomebrewManaged(): boolean;
}

const APP_MARKER = '.app/Contents/MacOS/';

/**
 * Returns the canonical .app path when an in-place swap is safe, else a typed reason. The
 * parent dir's writability is checked here; the caller replaces `appPath` via the helper.
 */
export function assessEligibility(probe: EligibilityProbe): Eligibility {
  if (probe.platform !== 'darwin') return { ok: false, reason: 'not-macos' };
  if (!probe.isPackaged) return { ok: false, reason: 'dev' };

  const exe = probe.exePath();
  const markerAt = exe.indexOf(APP_MARKER);
  if (markerAt < 0) return { ok: false, reason: 'not-app' };
  const bundle = exe.slice(0, markerAt + '.app'.length); // .../Foo.app

  let appPath: string;
  try {
    appPath = probe.realpath(bundle); // resolve symlinks (e.g. a Caskroom symlink) to the truth
  } catch {
    return { ok: false, reason: 'not-app' };
  }

  // App Translocation mounts the app at a randomized, read-only path; the real bundle is
  // elsewhere and a swap here would be lost. Refuse rather than write into the mount.
  if (appPath.includes('/AppTranslocation/')) return { ok: false, reason: 'translocated' };
  // A Homebrew cask manages its own copy; swapping behind brew's back desyncs its state. The
  // path-substring catches an app run from inside the Caskroom; isHomebrewManaged() catches
  // the COMMON case (cask copied the .app to /Applications, only metadata left in Caskroom).
  if (appPath.includes('/Caskroom/') || probe.isHomebrewManaged()) {
    return { ok: false, reason: 'homebrew' };
  }

  const appDir = appPath.slice(0, appPath.lastIndexOf('/'));
  if (!probe.isWritableDir(appDir)) return { ok: false, reason: 'not-writable' };

  return { ok: true, appPath };
}

/** Short, user-facing explanation for a refused self-update (drives the fallback message). */
export function eligibilityMessage(reason: EligibilityReason): string {
  switch (reason) {
    case 'homebrew':
      return 'Installed via Homebrew — run `brew upgrade --cask mangolove-idea` to update.';
    case 'translocated':
      return 'Move MangoLove IDEA into Applications first (it is running from a read-only location).';
    case 'not-writable':
      return 'No permission to replace the app in place — download and install manually.';
    case 'dev':
      return 'Development build — self-update is disabled.';
    case 'not-macos':
      return 'Self-update is only supported on macOS.';
    case 'not-app':
      return 'Could not locate the app bundle — download and install manually.';
  }
}

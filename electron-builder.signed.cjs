/**
 * Signed + notarized build config for MangoLove IDEA (macOS, Developer ID,
 * NON-App-Store distribution).
 *
 * WHY a separate .cjs config instead of the package.json "build" block:
 *   - electron-builder 26 auto-loads the package.json "build" key, which pins
 *     mac.identity:null (signing DISABLED). Keeping that block intact means the
 *     default `npm run build`, `dist`, `dist:dir`, and CI stay UNSIGNED and green
 *     with zero secrets. (electron-builder discovery is a SHORT-CIRCUIT: if
 *     package.json has a "build" key it never reads a standalone config file —
 *     verified in app-builder-lib/out/util/config/load.js. So the signed path MUST
 *     be passed explicitly via `--config electron-builder.signed.cjs`.)
 *   - A .cjs (NOT .mjs — .mjs is NOT in electron-builder's discovery extension list)
 *     is executable JS, so it can read env vars, refuse a half-configured build, and
 *     run the post-build DMG notarization.
 *
 * Verified against the INSTALLED source (electron-builder 26.15.3 / @electron/notarize
 * 2.5.0), not from memory:
 *   - app-builder-lib/out/mac/MacTargetHelper.js getEntitlements(): the top-level .app
 *     gets `mac.entitlements`; EVERY nested Mach-O (Electron Helper.app bundles,
 *     node-pty's spawn-helper/pty.node, the abduco helper) gets `mac.entitlementsInherit`.
 *     The Electron Helpers run V8 JIT, so the inherit plist MUST carry the JIT
 *     entitlements — we point BOTH keys at the one proven default-shaped plist.
 *   - @electron/osx-sign walks all of Contents/ and re-signs every Mach-O with
 *     `codesign --force`, so abduco (currently adhoc/linker-signed) and spawn-helper
 *     are re-signed with Developer ID + hardened runtime + secure timestamp
 *     automatically — no afterSign hook needed. Verified in step 5.5 of the runbook.
 *   - @electron/notarize notarizes + staples the .APP only; electron-builder does NOT
 *     notarize/staple the .dmg (dmg.sign defaults false). We notarize + staple the dmg
 *     artifact ourselves below so the downloaded .dmg passes Gatekeeper on mount.
 *
 * Secrets: supplied via ENV VARS by NAME only. Never hardcoded. See docs/RELEASE-SIGNING.md.
 */

'use strict';

const base = require('./package.json').build;

// --- Gate 1: opt-in. Refuse to run unless explicitly asked, so an accidental
// `--config electron-builder.signed.cjs` can't silently attempt to sign. ----------
if (process.env.MANGO_SIGN !== '1') {
  throw new Error(
    'electron-builder.signed.cjs requires MANGO_SIGN=1 (the SIGNED + NOTARIZED path). ' +
      'For an unsigned local build use `npm run dist:dir`. See docs/RELEASE-SIGNING.md.',
  );
}

// --- Credential detection (notarytool, both supported paths). -----------------------
// COMPLETE sets only — a partial set must NOT half-enable notarization (electron-builder
// throws late on a partial App-Store-Connect set; we make the decision deterministic).
const hasApiKey = !!(
  process.env.APPLE_API_KEY &&
  process.env.APPLE_API_KEY_ID &&
  process.env.APPLE_API_ISSUER
);
const hasAppleId = !!(
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID
);

// Mutual exclusivity: electron-builder's getNotarizeOptions checks the Apple-ID branch
// FIRST and it WINS if APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD is present — silently
// overriding an intended API-key build. Refuse the ambiguous state loudly.
const anyAppleId = process.env.APPLE_ID || process.env.APPLE_APP_SPECIFIC_PASSWORD;
const anyApiKey =
  process.env.APPLE_API_KEY || process.env.APPLE_API_KEY_ID || process.env.APPLE_API_ISSUER;
if (anyAppleId && anyApiKey) {
  throw new Error(
    'Both Apple-ID and App-Store-Connect-API-key notary env vars are set. Export EXACTLY ONE ' +
      'path and unset the other (the Apple-ID path silently wins otherwise). See docs/RELEASE-SIGNING.md.',
  );
}

const willNotarize = hasApiKey || hasAppleId;

// Identity: undefined => auto-discover the single "Developer ID Application" cert in the
// keychain (or CSC_LINK/CSC_KEY_PASSWORD). MANGO_SIGN_IDENTITY pins an exact identity.
// We override package.json's mac.identity:null (null = signing disabled). Combined with
// forceCodeSigning below, a missing cert HARD-FAILS instead of silently shipping unsigned.
const identity = process.env.MANGO_SIGN_IDENTITY || undefined;

/** notarytool CLI flags for the DMG step (env-by-name; no secret value is constructed here). */
function notarytoolCredFlags() {
  if (hasApiKey) {
    // Only a FILE PATH + identifiers reach argv — the .p8 secret content never does.
    return [
      '--key',
      process.env.APPLE_API_KEY,
      '--key-id',
      process.env.APPLE_API_KEY_ID,
      '--issuer',
      process.env.APPLE_API_ISSUER,
    ];
  }
  return [
    '--apple-id',
    process.env.APPLE_ID,
    '--password',
    process.env.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id',
    process.env.APPLE_TEAM_ID,
  ];
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  ...base,
  // Hard-fail the SIGNED path if no Developer ID identity is found, instead of
  // electron-builder's default warn-and-ship-unsigned for non-MAS builds.
  forceCodeSigning: true,
  mac: {
    ...base.mac,
    identity,
    hardenedRuntime: true,
    // Skip the unreliable local spctl assess during the build; the real gate is
    // notarization + stapling, verified manually post-build (runbook §5).
    gatekeeperAssess: false,
    // One proven, default-shaped plist for BOTH the app and every nested Mach-O
    // (Electron Helpers need the JIT entitlements via the inherit path).
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // Boolean (electron-builder 26 types mac.notarize as boolean; an object is dead
    // config). true => electron-builder runs notarytool on the .app using the env creds.
    notarize: willNotarize,
  },

  /**
   * Notarize + staple the DMG ARTIFACT itself. electron-builder notarizes/staples the
   * .app but NOT the .dmg, so a downloaded .dmg would warn on mount. notarytool accepts
   * the dmg (it contains the already-signed app); stapler staples it for OFFLINE Gatekeeper.
   * Direct xcrun (not @electron/notarize, whose notarize() pre-checks an app signature the
   * unsigned dmg lacks). Degrades cleanly: no creds => warn + skip (app inside is still notarized).
   * NOTE: stapling rewrites the dmg AFTER its .blockmap is computed — harmless here (no
   * electron-updater differential downloads); regenerate the blockmap if that's ever added.
   */
  afterAllArtifactBuild: (buildResult) => {
    if (!willNotarize) {
      console.warn(
        '[signed] notary creds absent — DMG left un-notarized (the .app inside IS signed). ' +
          'Set the notary env vars to notarize the dmg too. See docs/RELEASE-SIGNING.md.',
      );
      return [];
    }
    const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
    if (dmgs.length === 0) return [];
    const { execFileSync } = require('node:child_process');
    const creds = notarytoolCredFlags();
    for (const dmg of dmgs) {
      console.log(`[signed] notarizing DMG (notarytool --wait, may take minutes): ${dmg}`);
      execFileSync('xcrun', ['notarytool', 'submit', dmg, ...creds, '--wait'], {
        stdio: 'inherit',
      });
      console.log(`[signed] stapling DMG: ${dmg}`);
      execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    }
    return []; // dmgs stapled in place; no NEW artifacts to register
  },
};

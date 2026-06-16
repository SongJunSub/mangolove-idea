import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface NodePtyProbe {
  readonly version: string;
  readonly loaded: boolean;
}

/**
 * Plan-0 node-pty health probe. Attempts to load node-pty (an N-API native addon
 * with ABI-stable prebuilds) and report its version. node-pty 1.1.0 normally loads
 * via its prebuild even without a rebuild; a failure in a real Electron run means
 * the addon is genuinely unloadable for this platform/Electron — re-run
 * `npm run rebuild` and check Xcode CLT. Spawning actual PTYs is Plan 2, not here.
 */
export function probeNodePty(): NodePtyProbe {
  try {
    // Touch the addon so an ABI mismatch surfaces as a throw, not a lazy crash.
    require('node-pty');
    const version: string = require('node-pty/package.json').version;
    return { version, loaded: true };
  } catch {
    return { version: 'unknown', loaded: false };
  }
}

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, accessSync, existsSync, constants } from 'node:fs';
import { rm, mkdir, readdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadToFile, sha256OfFile } from './update-downloader';
import type { UpdaterSystem } from './updater-service';
import type { EligibilityProbe } from './update-eligibility';

/**
 * The REAL macOS UpdaterSystem: hdiutil / ditto / xattr / a detached bash helper + a
 * coordinated quit. This is the only part of the self-update NOT unit-tested — it shells out
 * to macOS tools and replaces the running bundle, which can only be exercised by a MANUAL
 * smoke (build a .dmg, install, trigger an update to a newer build). All orchestration logic
 * lives in UpdaterService (tested with a fake of this interface). Electron is not imported
 * here; the electron-specific values are injected so this stays pure node.
 */

const execFileP = promisify(execFile);
const TOOL_TIMEOUT_MS = 120_000;

/** The Homebrew cask name this app is published under (SongJunSub/homebrew-tap). */
const CASK_NAME = 'mangolove-idea';

/** True iff a Homebrew Caskroom record for this app exists (i.e. it was `brew install`ed). */
function isHomebrewCaskInstalled(): boolean {
  const roots = process.env.HOMEBREW_CASKROOM
    ? [process.env.HOMEBREW_CASKROOM]
    : ['/opt/homebrew/Caskroom', '/usr/local/Caskroom'];
  return roots.some((root) => existsSync(join(root, CASK_NAME)));
}

export interface RealUpdaterSystemDeps {
  /** app.getPath('userData'). */
  readonly userDataDir: string;
  /** app.getPath('exe'). */
  readonly exePath: string;
  /** app.isPackaged. */
  readonly isPackaged: boolean;
  /** Coordinated quit: set confirmedQuit + dispose managers, then app.quit() (unsaved already guarded). */
  onQuit(): void;
}

export function createRealUpdaterSystem(deps: RealUpdaterSystemDeps): UpdaterSystem {
  const eligibilityProbe = (): EligibilityProbe => ({
    platform: process.platform,
    isPackaged: deps.isPackaged,
    exePath: () => deps.exePath,
    realpath: (p) => realpathSync(p),
    isWritableDir: (dir) => {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    isHomebrewManaged: isHomebrewCaskInstalled,
  });

  const prepareDir = async (dir: string): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  };

  return {
    pid: () => process.pid,
    eligibilityProbe,
    updatesDir: () => join(deps.userDataDir, 'updates'),
    prepareDir,
    download: (url, destPath, onProgress) => downloadToFile(url, destPath, { onProgress }),
    sha256: (path) => sha256OfFile(path),
    mountDmg: async (dmgPath, mountPoint) => {
      // Mount read-only at a directory WE own, so the mount point is deterministic (no parsing
      // of hdiutil's output) and detach is unambiguous.
      await execFileP(
        'hdiutil',
        ['attach', '-nobrowse', '-noverify', '-readonly', '-mountpoint', mountPoint, dmgPath],
        { timeout: TOOL_TIMEOUT_MS },
      );
    },
    unmountDmg: async (mountPoint) => {
      await execFileP('hdiutil', ['detach', mountPoint], { timeout: TOOL_TIMEOUT_MS });
    },
    findAppInMount: async (mountPoint) => {
      const entries = await readdir(mountPoint);
      const app = entries.find((n) => n.endsWith('.app'));
      if (!app) throw new Error('no .app found in the mounted dmg');
      return join(mountPoint, app);
    },
    copyApp: async (srcApp, destApp) => {
      await execFileP('ditto', [srcApp, destApp], { timeout: TOOL_TIMEOUT_MS });
    },
    clearExtendedAttributes: async (appPath) => {
      // -cr clears EVERY ext attr recursively (quarantine + provenance + …), not just
      // com.apple.quarantine — a manual browser-download leaves quarantine, and a swapped
      // unsigned bundle with leftover attrs opens as "damaged".
      await execFileP('xattr', ['-cr', appPath], { timeout: TOOL_TIMEOUT_MS });
    },
    resignAdHoc: async (appPath) => {
      // Re-apply an ad-hoc signature (--deep covers Electron's nested helpers/frameworks);
      // Apple Silicon requires a valid signature and the ditto swap can leave it unsealed.
      await execFileP('codesign', ['--force', '--deep', '--sign', '-', appPath], {
        timeout: TOOL_TIMEOUT_MS,
      });
    },
    writeExecutable: async (path, content) => {
      await writeFile(path, content);
      await chmod(path, 0o755); // chmod (not writeFile's mode) is what survives the umask
    },
    spawnDetached: (scriptPath) => {
      const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
      child.unref(); // let this process exit so the helper can swap the bundle
    },
    quit: () => deps.onQuit(),
  };
}

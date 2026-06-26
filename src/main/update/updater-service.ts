import { basename } from 'node:path';
import type { UpdatePerformRequest, UpdateProgress, UpdateApplyResult } from '../../shared/types';
import { assessEligibility, eligibilityMessage, type EligibilityProbe } from './update-eligibility';
import { buildSwapScript } from './swap-script';

/**
 * Orchestrates the one-click self-update (macOS, unsigned): guard unsaved work -> require a
 * checksum -> check eligibility -> download + sha256-verify the .dmg -> stage the new bundle
 * (mount/copy/clear-xattrs/ad-hoc-resign) -> launch a detached swap helper -> quit. Every native side
 * effect is behind `UpdaterSystem`, so this orchestration is unit-tested with a fake; the real
 * hdiutil/ditto/xattr/spawn impl (RealUpdaterSystem) is exercised only by a manual smoke.
 *
 * SAFETY: verify-before-stage (a checksum mismatch aborts before anything is mounted/swapped),
 * never auto-installs without a checksum, and the helper waits on our EXACT pid (no broad kill).
 */

/** The native side effects the orchestrator needs — injected so the flow is testable. */
export interface UpdaterSystem {
  /** This process's pid (process.pid) — the helper waits for exactly this to exit. */
  pid(): number;
  /** Eligibility inputs (platform / isPackaged / exePath / realpath / isWritableDir). */
  eligibilityProbe(): EligibilityProbe;
  /** The per-app updates working dir under userData. */
  updatesDir(): string;
  /** mkdir -p `dir`, removing any stale contents first. */
  prepareDir(dir: string): Promise<void>;
  /** Download `url` to `destPath` (follows redirects), reporting progress. */
  download(
    url: string,
    destPath: string,
    onProgress: (received: number, total?: number) => void,
  ): Promise<void>;
  /** Lowercase-hex sha256 of a file. */
  sha256(path: string): Promise<string>;
  /** Attach a .dmg read-only at `mountPoint` (a dir we own); resolves when mounted. */
  mountDmg(dmgPath: string, mountPoint: string): Promise<void>;
  /** Detach a mount point (best-effort). */
  unmountDmg(mountPoint: string): Promise<void>;
  /** The single `*.app` inside `mountPoint`. */
  findAppInMount(mountPoint: string): Promise<string>;
  /** `ditto srcApp destApp` (preserves bundle attributes). */
  copyApp(srcApp: string, destApp: string): Promise<void>;
  /**
   * `xattr -cr appPath` — clear ALL extended attributes (quarantine, provenance, …) so an
   * UNSIGNED bundle is never flagged "damaged" by Gatekeeper after the swap.
   */
  clearExtendedAttributes(appPath: string): Promise<void>;
  /**
   * `codesign --force --deep --sign - appPath` — re-apply an ad-hoc signature. Apple Silicon
   * requires a valid signature, and the mount→ditto swap of an ad-hoc bundle can leave it
   * unsealed; re-signing guarantees the swapped app launches without a "damaged" error.
   */
  resignAdHoc(appPath: string): Promise<void>;
  /** Write `content` to `path` and make it executable. */
  writeExecutable(path: string, content: string): Promise<void>;
  /** Spawn a detached, unref'd `/bin/bash scriptPath` that outlives this process. */
  spawnDetached(scriptPath: string): void;
  /** Quit the app (coordinated to bypass the unsaved-changes quit guard — already guarded above). */
  quit(): void;
}

export class UpdaterService {
  constructor(
    private readonly system: UpdaterSystem,
    private readonly emit: (p: UpdateProgress) => void,
    private readonly unsavedCount: () => number,
  ) {}

  /**
   * Runs the full flow. On success returns { status: 'started' } and the app quits (the helper
   * finishes the swap + relaunch); otherwise returns a typed non-success result and nothing on
   * disk or in the running app is changed.
   */
  async perform(req: UpdatePerformRequest): Promise<UpdateApplyResult> {
    if (this.unsavedCount() > 0) {
      return {
        status: 'blocked',
        reason: 'Save your open files first — installing the update restarts the app.',
      };
    }
    if (!req.sha256) {
      return {
        status: 'ineligible',
        reason: 'This release has no checksum to verify — download and install manually.',
      };
    }
    const eligibility = assessEligibility(this.system.eligibilityProbe());
    if (!eligibility.ok) {
      return { status: 'ineligible', reason: eligibilityMessage(eligibility.reason) };
    }

    const dir = this.system.updatesDir();
    const dmgPath = `${dir}/download.dmg`;
    const mountPoint = `${dir}/mnt`;
    const stagedParent = `${dir}/staged`;
    const stagedApp = `${stagedParent}/${basename(eligibility.appPath)}`;
    const backupPath = `${dir}/backup.app`;
    const logPath = `${dir}/swap.log`;
    const scriptPath = `${dir}/swap.sh`;

    try {
      await this.system.prepareDir(dir);

      this.emit({ phase: 'downloading', receivedBytes: 0 });
      let lastEmitted = 0;
      await this.system.download(req.dmgUrl, dmgPath, (received, total) => {
        // Throttle: a ~130MB download fires ~2000 chunks; emit every ~1MB + the final byte,
        // so the renderer gets a handful of updates instead of thousands of IPC sends/renders.
        if (received !== total && received - lastEmitted < 1_000_000) return;
        lastEmitted = received;
        this.emit({ phase: 'downloading', receivedBytes: received, totalBytes: total });
      });

      this.emit({ phase: 'verifying' });
      const actual = await this.system.sha256(dmgPath);
      if (actual.toLowerCase() !== req.sha256.toLowerCase()) {
        return {
          status: 'error',
          reason: 'Checksum mismatch — the download was corrupt or tampered with. Aborted.',
        };
      }

      this.emit({ phase: 'staging' });
      await this.system.prepareDir(stagedParent);
      await this.system.prepareDir(mountPoint);
      await this.system.mountDmg(dmgPath, mountPoint);
      try {
        const srcApp = await this.system.findAppInMount(mountPoint);
        await this.system.copyApp(srcApp, stagedApp);
      } finally {
        await this.system.unmountDmg(mountPoint).catch(() => {});
      }
      // Make the swapped bundle Gatekeeper-clean: clear all ext attrs (quarantine/provenance)
      // THEN re-apply an ad-hoc signature, so an UNSIGNED build never opens as "damaged".
      await this.system.clearExtendedAttributes(stagedApp);
      await this.system.resignAdHoc(stagedApp);

      const script = buildSwapScript({
        pid: this.system.pid(),
        appPath: eligibility.appPath,
        stagedPath: stagedApp,
        backupPath,
        logPath,
      });
      await this.system.writeExecutable(scriptPath, script);

      this.emit({ phase: 'applying' });
      this.system.spawnDetached(scriptPath);
      this.system.quit();
      return { status: 'started', reason: '' };
    } catch (err) {
      return { status: 'error', reason: err instanceof Error ? err.message : 'update failed' };
    }
  }
}

import { describe, it, expect, vi } from 'vitest';
import { UpdaterService, type UpdaterSystem } from '../../src/main/update/updater-service';
import type { EligibilityProbe } from '../../src/main/update/update-eligibility';
import type { UpdatePerformRequest, UpdateProgress } from '../../src/shared/types';

const EXE = '/Applications/MangoLove IDEA.app/Contents/MacOS/MangoLove IDEA';

function eligibleProbe(over: Partial<EligibilityProbe> = {}): EligibilityProbe {
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

/** A fake UpdaterSystem that records the ordered calls and a happy sha by default. */
function fakeSystem(over: Partial<UpdaterSystem> = {}): UpdaterSystem & { calls: string[] } {
  const calls: string[] = [];
  const sys: UpdaterSystem & { calls: string[] } = {
    calls,
    pid: () => 4321,
    eligibilityProbe: () => eligibleProbe(),
    updatesDir: () => '/u',
    prepareDir: async () => void calls.push('prepareDir'),
    download: async (_url, _dest, onProgress) => {
      calls.push('download');
      onProgress(50, 100);
      onProgress(100, 100);
    },
    sha256: async () => 'abc123',
    mountDmg: async () => void calls.push('mount'),
    unmountDmg: async () => void calls.push('unmount'),
    findAppInMount: async () => '/u/mnt/MangoLove IDEA.app',
    copyApp: async () => void calls.push('copy'),
    clearExtendedAttributes: async () => void calls.push('clearxattr'),
    resignAdHoc: async () => void calls.push('resign'),
    writeExecutable: async () => void calls.push('write'),
    spawnDetached: () => void calls.push('spawn'),
    quit: () => void calls.push('quit'),
    ...over,
  };
  return sys;
}

const req: UpdatePerformRequest = {
  dmgUrl:
    'https://github.com/SongJunSub/mangolove-idea/releases/download/v0.2.0/MangoLove.IDEA-0.2.0-arm64.dmg',
  sha256: 'ABC123', // uppercase on purpose: the compare is case-insensitive
};

function makeService(sys: UpdaterSystem, unsaved = 0) {
  const progress: UpdateProgress[] = [];
  const svc = new UpdaterService(
    sys,
    (p) => progress.push(p),
    () => unsaved,
  );
  return { svc, progress };
}

describe('UpdaterService.perform', () => {
  it('blocks (no download) when there are unsaved editors', async () => {
    const sys = fakeSystem();
    const { svc } = makeService(sys, 2);
    const r = await svc.perform(req);
    expect(r.status).toBe('blocked');
    expect(sys.calls).not.toContain('download');
  });

  it('refuses to auto-install without a checksum', async () => {
    const sys = fakeSystem();
    const { svc } = makeService(sys);
    const r = await svc.perform({ ...req, sha256: null });
    expect(r.status).toBe('ineligible');
    expect(sys.calls).not.toContain('download');
  });

  it('is ineligible (and downloads nothing) when the install location is unsafe', async () => {
    const sys = fakeSystem({ eligibilityProbe: () => eligibleProbe({ isPackaged: false }) });
    const { svc } = makeService(sys);
    const r = await svc.perform(req);
    expect(r.status).toBe('ineligible');
    expect(sys.calls).not.toContain('download');
  });

  it('downloads, verifies, stages, launches the helper, and quits — in order', async () => {
    const sys = fakeSystem();
    const { svc, progress } = makeService(sys);
    const r = await svc.perform(req);
    expect(r.status).toBe('started');
    expect(sys.calls).toEqual([
      'prepareDir', // updates dir
      'download',
      'prepareDir', // staged
      'prepareDir', // mnt
      'mount',
      'copy',
      'unmount',
      'clearxattr',
      'resign',
      'write',
      'spawn',
      'quit',
    ]);
    // Throttling may coalesce download events; assert the DISTINCT phase ORDER.
    const distinctPhases = progress.map((p) => p.phase).filter((p, i, a) => p !== a[i - 1]);
    expect(distinctPhases).toEqual(['downloading', 'verifying', 'staging', 'applying']);
  });

  it('aborts on a checksum mismatch — never mounts, spawns, or quits', async () => {
    const sys = fakeSystem({ sha256: async () => 'deadbeef' });
    const { svc } = makeService(sys);
    const r = await svc.perform(req);
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/checksum/i);
    expect(sys.calls).toContain('download');
    expect(sys.calls).not.toContain('mount');
    expect(sys.calls).not.toContain('spawn');
    expect(sys.calls).not.toContain('quit');
  });

  it('maps a download failure to an error result', async () => {
    const sys = fakeSystem({
      download: vi.fn(async () => {
        throw new Error('download timed out');
      }),
    });
    const { svc } = makeService(sys);
    const r = await svc.perform(req);
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/timed out/);
    expect(sys.calls).not.toContain('spawn');
  });

  it('unmounts even when staging fails mid-way', async () => {
    const sys = fakeSystem({
      copyApp: async () => {
        throw new Error('ditto failed');
      },
    });
    const { svc } = makeService(sys);
    const r = await svc.perform(req);
    expect(r.status).toBe('error');
    expect(sys.calls).toContain('mount');
    expect(sys.calls).toContain('unmount'); // the finally ran
    expect(sys.calls).not.toContain('spawn');
  });
});

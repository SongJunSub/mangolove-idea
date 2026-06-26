import { describe, it, expect } from 'vitest';
import { buildSwapScript, type SwapScriptParams } from '../../src/main/update/swap-script';

const base: SwapScriptParams = {
  pid: 4321,
  appPath: '/Applications/MangoLove IDEA.app',
  stagedPath:
    '/Users/x/Library/Application Support/MangoLove IDEA/updates/staged/MangoLove IDEA.app',
  backupPath: '/Users/x/Library/Application Support/MangoLove IDEA/updates/backup.app',
  logPath: '/Users/x/Library/Application Support/MangoLove IDEA/updates/swap.log',
};

describe('buildSwapScript', () => {
  it('waits for the EXACT pid via kill -0 (existence check) and never a broad kill', () => {
    const s = buildSwapScript(base);
    expect(s).toContain('PID=4321');
    expect(s).toContain('kill -0 "$PID"');
    expect(s).not.toMatch(/pkill|killall|kill -9/);
  });

  it('aborts (does NOT swap) if the app never exits', () => {
    const s = buildSwapScript(base);
    expect(s).toContain('app did not exit');
    // The abort path exits before the `mv "$APP"` swap line.
    const abortAt = s.indexOf('app did not exit');
    const swapAt = s.indexOf('mv "$APP"');
    expect(abortAt).toBeGreaterThan(0);
    expect(abortAt).toBeLessThan(swapAt);
  });

  it('rolls back the old bundle when ditto fails', () => {
    const s = buildSwapScript(base);
    expect(s).toContain('ditto "$STAGED" "$APP"');
    expect(s).toContain('rolling back');
    expect(s).toContain('mv "$BACKUP" "$APP"');
  });

  it('relaunches with open on success', () => {
    expect(buildSwapScript(base)).toContain('open "$APP"');
  });

  it('shell-quotes paths with spaces', () => {
    const s = buildSwapScript(base);
    expect(s).toContain(`APP='/Applications/MangoLove IDEA.app'`);
  });

  it('escapes an embedded single quote in a path', () => {
    const s = buildSwapScript({ ...base, appPath: `/Apps/Mac's IDEA.app` });
    expect(s).toContain(`APP='/Apps/Mac'\\''s IDEA.app'`);
  });

  it('truncates the pid to an integer (no non-numeric injection)', () => {
    const s = buildSwapScript({ ...base, pid: 12.9 });
    expect(s).toContain('PID=12');
  });
});

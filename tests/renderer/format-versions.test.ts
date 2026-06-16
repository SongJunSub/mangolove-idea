import { describe, it, expect } from 'vitest';
import { formatVersions } from '../../src/renderer/lib/format-versions';
import type { AppInfo } from '../../src/shared/types';

const sample: AppInfo = {
  appVersion: '0.1.0',
  electronVersion: '42.4.0',
  nodeVersion: '22.12.0',
  chromeVersion: '136.0.0.0',
  nodePtyVersion: '1.1.0',
  nodePtyLoaded: true,
};

describe('formatVersions', () => {
  it('renders each version on its own line in a fixed order', () => {
    expect(formatVersions(sample)).toBe(
      [
        'app 0.1.0',
        'electron 42.4.0',
        'node 22.12.0',
        'chrome 136.0.0.0',
        'node-pty 1.1.0 (loaded)',
      ].join('\n'),
    );
  });

  it('marks node-pty as FAILED when it did not load', () => {
    const broken: AppInfo = { ...sample, nodePtyLoaded: false, nodePtyVersion: 'unknown' };
    expect(formatVersions(broken)).toContain('node-pty unknown (FAILED)');
  });
});

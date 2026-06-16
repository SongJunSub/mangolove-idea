import type { AppInfo } from '../../shared/types';

/**
 * Pure formatter for the Plan-0 ping result. One `name version` per line, fixed
 * order; node-pty line is annotated (loaded)/(FAILED) so the ABI trap is visible.
 */
export function formatVersions(info: AppInfo): string {
  const ptyFlag = info.nodePtyLoaded ? 'loaded' : 'FAILED';
  return [
    `app ${info.appVersion}`,
    `electron ${info.electronVersion}`,
    `node ${info.nodeVersion}`,
    `chrome ${info.chromeVersion}`,
    `node-pty ${info.nodePtyVersion} (${ptyFlag})`,
  ].join('\n');
}

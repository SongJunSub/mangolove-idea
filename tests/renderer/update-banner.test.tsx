import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { UpdateBanner } from '../../src/renderer/components/update/update-banner';
import type { UpdateStatus } from '../../src/shared/types';

const SHA = 'f0ee74ef6337440a469f7532dd73d74eac2fc789431cc9740ed6c268b9a34abd';

const available: UpdateStatus = {
  currentVersion: '0.1.1',
  latestVersion: '0.2.0',
  updateAvailable: true,
  releaseUrl: 'https://github.com/SongJunSub/mangolove-idea/releases/tag/v0.2.0',
  dmgUrl:
    'https://github.com/SongJunSub/mangolove-idea/releases/download/v0.2.0/MangoLove.IDEA-0.2.0-arm64.dmg',
  sha256: SHA,
  publishedAt: '2026-06-26T00:00:00Z',
};

function renderBanner(props: Partial<React.ComponentProps<typeof UpdateBanner>> = {}) {
  cleanup(); // allow several renders within one test (afterEach also cleans up)
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  const onUpdate = vi.fn();
  render(
    <UpdateBanner
      status={available}
      dismissedVersion={undefined}
      onDismiss={onDismiss}
      onOpen={onOpen}
      applyState={{ phase: 'idle' }}
      onUpdate={onUpdate}
      {...props}
    />,
  );
  return { onOpen, onDismiss, onUpdate };
}

describe('<UpdateBanner> (available card)', () => {
  it('shows the new + current version', () => {
    renderBanner();
    const card = screen.getByTestId('update-banner');
    expect(card).toHaveTextContent('v0.2.0');
    expect(card).toHaveTextContent('0.1.1');
  });

  it('renders nothing before the check resolves / when no update / when dismissed', () => {
    renderBanner({ status: null });
    expect(screen.queryByTestId('update-banner')).toBeNull();
    renderBanner({ status: { ...available, updateAvailable: false } });
    expect(screen.queryByTestId('update-banner')).toBeNull();
    renderBanner({ dismissedVersion: '0.2.0' });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('hides while an update is in progress or errored (that shows in the status bar)', () => {
    renderBanner({ applyState: { phase: 'downloading', receivedBytes: 1, totalBytes: 2 } });
    expect(screen.queryByTestId('update-banner')).toBeNull();
    renderBanner({ applyState: { phase: 'error', reason: 'x' } });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('offers one-click only with a .dmg AND a checksum', () => {
    renderBanner();
    expect(screen.getByTestId('update-now')).toBeInTheDocument();
    renderBanner({ status: { ...available, sha256: null } });
    expect(screen.queryByTestId('update-now')).toBeNull();
    renderBanner({ status: { ...available, dmgUrl: null } });
    expect(screen.queryByTestId('update-now')).toBeNull();
  });

  it('wires the actions: 지금 업데이트, What’s new icon, dismiss', () => {
    const { onUpdate, onOpen, onDismiss } = renderBanner();
    fireEvent.click(screen.getByTestId('update-now'));
    expect(onUpdate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('update-notes'));
    expect(onOpen).toHaveBeenCalledWith(available.releaseUrl);
    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('0.2.0');
  });
});

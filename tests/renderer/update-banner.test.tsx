import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('<UpdateBanner>', () => {
  it('shows the new + current version when an update is available and not dismissed', () => {
    renderBanner();
    const banner = screen.getByTestId('update-banner');
    expect(banner).toHaveTextContent('v0.2.0');
    expect(banner).toHaveTextContent('0.1.1');
  });

  it('renders nothing before the check resolves (null status)', () => {
    renderBanner({ status: null });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('renders nothing when no update is available', () => {
    renderBanner({ status: { ...available, updateAvailable: false } });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('stays hidden once the user dismissed that exact version', () => {
    renderBanner({ dismissedVersion: '0.2.0' });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('offers one-click update when there is a .dmg AND a checksum', () => {
    renderBanner();
    expect(screen.getByTestId('update-now')).toBeInTheDocument();
  });

  it('hides one-click update when there is no checksum to verify', () => {
    renderBanner({ status: { ...available, sha256: null } });
    expect(screen.queryByTestId('update-now')).toBeNull();
    expect(screen.getByTestId('update-download')).toBeInTheDocument(); // manual fallback remains
  });

  it('hides one-click update when there is no .dmg asset', () => {
    renderBanner({ status: { ...available, dmgUrl: null } });
    expect(screen.queryByTestId('update-now')).toBeNull();
  });

  it('clicking 지금 업데이트 starts the one-click flow', () => {
    const { onUpdate } = renderBanner();
    fireEvent.click(screen.getByTestId('update-now'));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('shows live progress and hides the action buttons while updating', () => {
    renderBanner({ applyState: { phase: 'downloading', receivedBytes: 50, totalBytes: 100 } });
    expect(screen.getByTestId('update-progress')).toHaveTextContent('50%');
    expect(screen.queryByTestId('update-now')).toBeNull();
    expect(screen.queryByTestId('update-dismiss')).toBeNull();
  });

  it('shows the verifying / applying phases', () => {
    renderBanner({ applyState: { phase: 'applying' } });
    expect(screen.getByTestId('update-progress')).toHaveTextContent('재시작');
  });

  it('shows an error + keeps the manual download fallback when the update fails', () => {
    renderBanner({ applyState: { phase: 'error', reason: 'Checksum mismatch' } });
    expect(screen.getByTestId('update-error')).toHaveTextContent('Checksum mismatch');
    expect(screen.getByTestId('update-download')).toBeInTheDocument();
    expect(screen.queryByTestId('update-now')).toBeNull(); // no retry-as-one-click in the error state
  });

  it('Download opens the dmg, What is new opens the release page, Later dismisses', () => {
    const { onOpen, onDismiss } = renderBanner();
    fireEvent.click(screen.getByTestId('update-download'));
    expect(onOpen).toHaveBeenCalledWith(available.dmgUrl);
    fireEvent.click(screen.getByTestId('update-notes'));
    expect(onOpen).toHaveBeenCalledWith(available.releaseUrl);
    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('0.2.0');
  });
});

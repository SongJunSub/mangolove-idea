import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpdateBanner } from '../../src/renderer/components/update/update-banner';
import type { UpdateStatus } from '../../src/shared/types';

const available: UpdateStatus = {
  currentVersion: '0.1.1',
  latestVersion: '0.2.0',
  updateAvailable: true,
  releaseUrl: 'https://github.com/SongJunSub/mangolove-idea/releases/tag/v0.2.0',
  dmgUrl:
    'https://github.com/SongJunSub/mangolove-idea/releases/download/v0.2.0/MangoLove.IDEA-0.2.0-arm64.dmg',
  sha256: null,
  publishedAt: '2026-06-26T00:00:00Z',
};

/** Render with sensible default callbacks; override per test. */
function renderBanner(props: Partial<React.ComponentProps<typeof UpdateBanner>> = {}) {
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  render(
    <UpdateBanner
      status={available}
      dismissedVersion={undefined}
      onDismiss={onDismiss}
      onOpen={onOpen}
      {...props}
    />,
  );
  return { onOpen, onDismiss };
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

  it('reappears for a newer version than the dismissed one', () => {
    renderBanner({ dismissedVersion: '0.1.5' });
    expect(screen.getByTestId('update-banner')).toBeInTheDocument();
  });

  it('Download opens the .dmg url', () => {
    const { onOpen } = renderBanner();
    fireEvent.click(screen.getByTestId('update-download'));
    expect(onOpen).toHaveBeenCalledWith(available.dmgUrl);
  });

  it('Download falls back to the release page when there is no .dmg asset', () => {
    const { onOpen } = renderBanner({ status: { ...available, dmgUrl: null } });
    fireEvent.click(screen.getByTestId('update-download'));
    expect(onOpen).toHaveBeenCalledWith(available.releaseUrl);
  });

  it("What's new opens the release notes page", () => {
    const { onOpen } = renderBanner();
    fireEvent.click(screen.getByTestId('update-notes'));
    expect(onOpen).toHaveBeenCalledWith(available.releaseUrl);
  });

  it('Later dismisses the current latest version', () => {
    const { onDismiss } = renderBanner();
    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('0.2.0');
  });
});

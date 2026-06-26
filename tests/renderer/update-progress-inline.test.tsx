import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UpdateProgressInline } from '../../src/renderer/components/update/update-banner';
import { wrapI18n } from './i18n-test-util';

function renderInline(props: Partial<React.ComponentProps<typeof UpdateProgressInline>> = {}) {
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  render(
    wrapI18n(
      <UpdateProgressInline
        applyState={{ phase: 'idle' }}
        latestVersion="0.2.0"
        releaseUrl="https://github.com/x/y/releases/tag/v0.2.0"
        onOpen={onOpen}
        onDismiss={onDismiss}
        {...props}
      />,
      'ko',
    ),
  );
  return { onOpen, onDismiss };
}

describe('<UpdateProgressInline>', () => {
  it('renders nothing when idle', () => {
    renderInline();
    expect(screen.queryByTestId('update-progress')).toBeNull();
    expect(screen.queryByTestId('update-error')).toBeNull();
  });

  it('shows the download percent', () => {
    renderInline({ applyState: { phase: 'downloading', receivedBytes: 50, totalBytes: 100 } });
    expect(screen.getByTestId('update-progress')).toHaveTextContent('50%');
  });

  it('shows the installing phase', () => {
    renderInline({ applyState: { phase: 'applying' } });
    expect(screen.getByTestId('update-progress')).toHaveTextContent('다시 시작');
  });

  it('shows an error with What’s new + dismiss; dismiss fires', () => {
    const { onDismiss } = renderInline({
      applyState: { phase: 'error', reason: 'Checksum mismatch' },
    });
    expect(screen.getByTestId('update-error')).toHaveTextContent('Checksum mismatch');
    expect(screen.getByTestId('update-notes')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

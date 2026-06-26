import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UsageWidget } from '../../src/renderer/components/usage/usage-widget';
import type { UsageStatus } from '../../src/shared/types';

const usage: UsageStatus = {
  limits: [
    {
      kind: 'session',
      label: '세션 (5시간)',
      percent: 3,
      severity: 'normal',
      resetsAt: '2026-06-26T10:59:59+00:00',
      model: null,
    },
    {
      kind: 'weekly_all',
      label: '주간 (전체)',
      percent: 51,
      severity: 'warning',
      resetsAt: '2026-06-30T10:59:59+00:00',
      model: null,
    },
    {
      kind: 'weekly_scoped',
      label: '주간 (Sonnet)',
      percent: 1,
      severity: 'normal',
      resetsAt: '2026-06-30T10:59:59+00:00',
      model: 'Sonnet',
    },
  ],
};

describe('<UsageWidget>', () => {
  it('renders the session + weekly chips, but NOT the per-model (Sonnet) chip', () => {
    render(<UsageWidget status={usage} loading={false} onRefresh={vi.fn()} />);
    expect(screen.getByTestId('usage-session')).toHaveTextContent('세션 3%');
    expect(screen.getByTestId('usage-weekly_all')).toHaveTextContent('주간 51%');
    expect(screen.queryByTestId('usage-weekly_scoped')).toBeNull();
  });

  it('shows a Claude mark', () => {
    const { container } = render(
      <UsageWidget status={usage} loading={false} onRefresh={vi.fn()} />,
    );
    expect(container.querySelector('.usage-claude')).not.toBeNull();
  });

  it('puts the reset time in the chip tooltip', () => {
    render(<UsageWidget status={usage} loading={false} onRefresh={vi.fn()} />);
    expect(screen.getByTestId('usage-session').getAttribute('title')).toMatch(/리셋/);
  });

  it('shows a loading placeholder before the first fetch', () => {
    render(<UsageWidget status={null} loading={true} onRefresh={vi.fn()} />);
    expect(screen.getByTestId('usage-widget')).toHaveTextContent('Claude 사용량');
    expect(screen.getByTestId('usage-refresh').className).toContain('spin');
  });

  it('shows a friendly message when not logged in', () => {
    render(
      <UsageWidget
        status={{ limits: [], error: 'no-login' }}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByTestId('usage-error')).toHaveTextContent('Claude 미연결');
  });

  it('refresh button calls onRefresh', () => {
    const onRefresh = vi.fn();
    render(<UsageWidget status={usage} loading={false} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByTestId('usage-refresh'));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

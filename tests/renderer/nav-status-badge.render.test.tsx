import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { NavStatusBadge } from '../../src/renderer/components/statusbar/nav-status-badge';

describe('<NavStatusBadge>', () => {
  it('renders nothing when the file is not Java/Kotlin', () => {
    render(wrapI18n(<NavStatusBadge lang={null} state="indexing" />));
    expect(screen.queryByTestId('nav-status')).not.toBeInTheDocument();
  });

  it('renders nothing when ready (no clutter when nav works)', () => {
    render(wrapI18n(<NavStatusBadge lang="kotlin" state="ready" />));
    expect(screen.queryByTestId('nav-status')).not.toBeInTheDocument();
  });

  it('shows a busy badge (with the pulsing dot) while starting/indexing', () => {
    const { rerender } = render(wrapI18n(<NavStatusBadge lang="kotlin" state="indexing" />));
    const badge = screen.getByTestId('nav-status');
    expect(badge.textContent).toMatch(/Kotlin/);
    expect(badge.querySelector('.nav-status__dot')).toBeTruthy();
    rerender(wrapI18n(<NavStatusBadge lang="java" state="starting" />));
    expect(screen.getByTestId('nav-status').querySelector('.nav-status__dot')).toBeTruthy();
  });

  it('shows the failure state with the reason in the tooltip', () => {
    render(wrapI18n(<NavStatusBadge lang="kotlin" state="failed" detail="exited (code 1)" />));
    const badge = screen.getByTestId('nav-status');
    expect(badge.className).toMatch(/nav-status--failed/);
    expect(badge.getAttribute('title')).toBe('exited (code 1)');
    expect(badge.querySelector('.nav-status__dot')).toBeNull(); // not busy
  });

  it('shows "not installed" from capabilities', () => {
    render(
      wrapI18n(<NavStatusBadge lang="kotlin" state="unavailable" detail="kotlin-lsp not found" />),
    );
    const badge = screen.getByTestId('nav-status');
    expect(badge.className).toMatch(/nav-status--unavailable/);
    expect(badge.getAttribute('title')).toBe('kotlin-lsp not found');
  });

  it('failed/unavailable become an actionable button that invokes onAction (open Settings)', () => {
    const onAction = vi.fn();
    render(
      wrapI18n(
        <NavStatusBadge lang="java" state="failed" detail="exited (code 1)" onAction={onAction} />,
      ),
    );
    const badge = screen.getByTestId('nav-status');
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.className).toMatch(/nav-status--action/);
    expect(badge.getAttribute('title')).toMatch(/exited \(code 1\)/); // detail + "open Settings" hint
    fireEvent.click(badge);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('a busy badge stays a static span even with onAction (only failed/unavailable act)', () => {
    render(wrapI18n(<NavStatusBadge lang="java" state="indexing" onAction={vi.fn()} />));
    expect(screen.getByTestId('nav-status').tagName).toBe('SPAN');
  });
});

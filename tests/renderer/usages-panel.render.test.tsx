import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { UsagesPanel } from '../../src/renderer/components/editor/usages-panel';
import type { UsageLocation } from '../../src/renderer/lib/code-nav/find-usages';

const U = (relPath: string, line: number, column: number, preview: string): UsageLocation => ({
  relPath,
  line,
  column,
  preview,
});

describe('UsagesPanel', () => {
  it('shows a loading placeholder while searching', () => {
    render(wrapI18n(<UsagesPanel usages={[]} loading={true} onOpen={() => {}} />));
    expect(screen.getByTestId('usages-loading').textContent).toContain('Finding usages');
  });

  it('shows an empty state when there are no usages', () => {
    render(wrapI18n(<UsagesPanel usages={[]} loading={false} onOpen={() => {}} />));
    expect(screen.getByTestId('usages-empty')).toBeTruthy();
  });

  it('groups usages by file and renders a row per usage with line:col + preview', () => {
    const usages = [
      U('src/a.ts', 3, 5, 'const x = foo()'),
      U('src/a.ts', 9, 1, 'foo()'),
      U('src/b.ts', 2, 10, 'import { foo }'),
    ];
    render(wrapI18n(<UsagesPanel usages={usages} loading={false} onOpen={() => {}} />));
    expect(screen.getByTestId('usages-count').textContent).toContain('3 usage(s) in 2 file(s)');
    expect(screen.getAllByTestId('usage-row')).toHaveLength(3);
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    const first = screen.getAllByTestId('usage-row')[0];
    expect(first.textContent).toContain('3:5');
    expect(first.textContent).toContain('const x = foo()');
  });

  it('calls onOpen with the clicked row location', () => {
    const onOpen = vi.fn();
    render(
      wrapI18n(<UsagesPanel usages={[U('src/a.ts', 3, 5, 'x')]} loading={false} onOpen={onOpen} />),
    );
    fireEvent.click(screen.getByTestId('usage-row'));
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', 3, 5);
  });

  it('renders an ellipsis placeholder when the preview is empty (unseeded target)', () => {
    render(
      wrapI18n(
        <UsagesPanel usages={[U('src/a.ts', 1, 1, '')]} loading={false} onOpen={() => {}} />,
      ),
    );
    expect(screen.getByTestId('usage-row').textContent).toContain('…');
  });
});

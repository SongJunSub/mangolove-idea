import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { UsagesOverlay } from '../../src/renderer/components/editor/usages-overlay';
import { decideUsages } from '../../src/renderer/lib/code-nav/usages-routing';
import type { UsageLocation } from '../../src/renderer/lib/code-nav/find-usages';

const U = (relPath: string, line: number, column: number, preview = 'x'): UsageLocation => ({
  relPath,
  line,
  column,
  preview,
});

describe('decideUsages', () => {
  it('exactly one usage → jump to it', () => {
    const u = U('a.java', 3, 5);
    expect(decideUsages([u])).toEqual({ kind: 'jump', target: u });
  });
  it('zero or 2+ usages → show the panel', () => {
    expect(decideUsages([])).toEqual({ kind: 'show', usages: [] });
    const list = [U('a.java', 1, 1), U('b.java', 2, 2)];
    expect(decideUsages(list)).toEqual({ kind: 'show', usages: list });
  });
});

describe('<UsagesOverlay>', () => {
  const many = [
    U('src/A.java', 10, 3, 'foo()'),
    U('src/A.java', 22, 7, 'foo()'),
    U('src/B.java', 4, 1, 'foo()'),
  ];
  const setup = (usages: UsageLocation[], loading = false) => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      wrapI18n(
        <UsagesOverlay usages={usages} loading={loading} onOpen={onOpen} onClose={onClose} />,
      ),
    );
    return { onOpen, onClose };
  };

  it('shows the count header and a row per usage', () => {
    setup(many);
    expect(screen.getByTestId('usages-count').textContent).toMatch(/3.*2/); // 3 usages in 2 files
    expect(screen.getAllByTestId('usage-row')).toHaveLength(3);
  });

  it('clicking a row navigates to it and closes', () => {
    const { onOpen, onClose } = setup(many);
    fireEvent.click(screen.getAllByTestId('usage-row')[2]); // src/B.java 4:1
    expect(onOpen).toHaveBeenCalledWith('src/B.java', 4, 1);
    expect(onClose).toHaveBeenCalled();
  });

  it('keyboard: ↓ moves the cursor, Enter opens the active row', () => {
    const { onOpen, onClose } = setup(many);
    const card = screen.getByRole('dialog'); // the focusable card owns the key handler
    fireEvent.keyDown(card, { key: 'ArrowDown' }); // active 0 → 1 (A.java 22:7)
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('src/A.java', 22, 7);
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape and backdrop click close it; a click inside the card does not', () => {
    const { onClose } = setup(many);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    // clicking the card body (the count header's container) must NOT close
    fireEvent.mouseDown(screen.getByTestId('usages-count'));
    expect(onClose).toHaveBeenCalledTimes(1);
    // clicking the backdrop closes
    fireEvent.mouseDown(screen.getByTestId('usages-overlay'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('the × button closes', () => {
    const { onClose } = setup(many);
    fireEvent.click(screen.getByTestId('usages-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Enter on the × button does NOT navigate (keys stop at the button)', () => {
    const { onOpen } = setup(many);
    fireEvent.keyDown(screen.getByTestId('usages-close'), { key: 'Enter' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Tab is trapped inside the card (focus cannot escape)', () => {
    setup(many);
    const notPrevented = fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(notPrevented).toBe(false); // fireEvent returns false when preventDefault() was called
  });

  it('keyboard cursor is not hijacked by a row the scroll slides under the pointer', () => {
    const { onOpen } = setup(many);
    const card = screen.getByRole('dialog');
    fireEvent.keyDown(card, { key: 'ArrowDown' }); // active 0 → 1
    fireEvent.mouseEnter(screen.getAllByTestId('usage-row')[0]); // no real move → must NOT reset active to 0
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('src/A.java', 22, 7); // still the keyboard-chosen row
  });

  it('loading state shows a message and no rows', () => {
    setup([], true);
    expect(screen.getByTestId('usages-count').textContent).toMatch(/Finding/i);
    expect(screen.queryByTestId('usage-row')).not.toBeInTheDocument();
  });

  it('empty result shows the "no usages" feedback', () => {
    setup([]);
    expect(screen.getByTestId('usages-count').textContent).toMatch(/No usages/i);
    expect(screen.queryByTestId('usage-row')).not.toBeInTheDocument();
  });
});

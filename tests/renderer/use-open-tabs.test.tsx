import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useOpenTabs } from '../../src/renderer/hooks/use-open-tabs';
import type { OpenTabs, WorktreeTabs } from '../../src/shared/open-tabs';

/** Drives the hook for one worktree and exposes state + buttons for each action. */
function Harness({
  worktreeId,
  persisted,
  save,
}: {
  worktreeId: string | null;
  persisted?: OpenTabs;
  save: (wt: string, t: WorktreeTabs) => void;
}) {
  const o = useOpenTabs(worktreeId, persisted, save);
  return (
    <div>
      <span data-testid="tabs">{o.tabs.join(',')}</span>
      <span data-testid="active">{o.active ?? ''}</span>
      <span data-testid="preview">{o.preview ?? ''}</span>
      <button data-testid="open-a" onClick={() => o.open('a.ts')} />
      <button data-testid="open-b" onClick={() => o.open('b.ts')} />
      <button data-testid="open-c" onClick={() => o.open('c.ts')} />
      <button data-testid="prev-a" onClick={() => o.open('a.ts', { preview: true })} />
      <button data-testid="prev-b" onClick={() => o.open('b.ts', { preview: true })} />
      <button data-testid="prev-c" onClick={() => o.open('c.ts', { preview: true })} />
      <button data-testid="pin-a" onClick={() => o.pin('a.ts')} />
      <button data-testid="act-a" onClick={() => o.activate('a.ts')} />
      <button data-testid="close-b" onClick={() => o.close('b.ts')} />
      <button data-testid="close-active" onClick={() => o.active && o.close(o.active)} />
    </div>
  );
}

const tabs = () => screen.getByTestId('tabs').textContent;
const active = () => screen.getByTestId('active').textContent;
const preview = () => screen.getByTestId('preview').textContent;

describe('useOpenTabs', () => {
  it('open appends a tab and activates it; re-opening just activates (no duplicate)', () => {
    render(<Harness worktreeId="/wt" save={vi.fn()} />);
    fireEvent.click(screen.getByTestId('open-a'));
    fireEvent.click(screen.getByTestId('open-b'));
    expect(tabs()).toBe('a.ts,b.ts');
    expect(active()).toBe('b.ts');
    fireEvent.click(screen.getByTestId('open-a')); // already open -> just activate
    expect(tabs()).toBe('a.ts,b.ts');
    expect(active()).toBe('a.ts');
  });

  it('closing the active tab activates its right neighbour (else left, else none)', () => {
    render(<Harness worktreeId="/wt" save={vi.fn()} />);
    fireEvent.click(screen.getByTestId('open-a'));
    fireEvent.click(screen.getByTestId('open-b'));
    fireEvent.click(screen.getByTestId('open-c')); // a,b,c active=c
    fireEvent.click(screen.getByTestId('act-a')); // active=a
    fireEvent.click(screen.getByTestId('close-active')); // close a -> right neighbour b
    expect(tabs()).toBe('b.ts,c.ts');
    expect(active()).toBe('b.ts');
    fireEvent.click(screen.getByTestId('close-active')); // close b -> right neighbour c
    expect(active()).toBe('c.ts');
    fireEvent.click(screen.getByTestId('close-active')); // close last -> none
    expect(tabs()).toBe('');
    expect(active()).toBe('');
  });

  it('closing a NON-active tab leaves the active unchanged', () => {
    render(<Harness worktreeId="/wt" save={vi.fn()} />);
    fireEvent.click(screen.getByTestId('open-a'));
    fireEvent.click(screen.getByTestId('open-b'));
    fireEvent.click(screen.getByTestId('act-a')); // active=a, tabs a,b
    fireEvent.click(screen.getByTestId('close-b')); // close non-active b
    expect(tabs()).toBe('a.ts');
    expect(active()).toBe('a.ts');
  });

  it('persists only the changed worktree entry on each mutation', () => {
    const save = vi.fn();
    render(<Harness worktreeId="/wt" save={save} />);
    fireEvent.click(screen.getByTestId('open-a'));
    expect(save).toHaveBeenLastCalledWith('/wt', { open: ['a.ts'], active: 'a.ts' });
    fireEvent.click(screen.getByTestId('open-b'));
    expect(save).toHaveBeenLastCalledWith('/wt', { open: ['a.ts', 'b.ts'], active: 'b.ts' });
  });

  it('seeds the current worktree from persisted, and switching worktree shows its own set', () => {
    const persisted: OpenTabs = {
      '/wt/a': { open: ['x.ts', 'y.ts'], active: 'y.ts' },
      '/wt/b': { open: ['z.ts'], active: 'z.ts' },
    };
    const { rerender } = render(
      <Harness worktreeId="/wt/a" persisted={persisted} save={vi.fn()} />,
    );
    expect(tabs()).toBe('x.ts,y.ts');
    expect(active()).toBe('y.ts');
    rerender(<Harness worktreeId="/wt/b" persisted={persisted} save={vi.fn()} />);
    expect(tabs()).toBe('z.ts');
    expect(active()).toBe('z.ts');
  });

  it('adopts persisted that arrives asynchronously after mount (settings fetch)', () => {
    const later: OpenTabs = { '/wt': { open: ['late.ts'], active: 'late.ts' } };
    const { rerender } = render(<Harness worktreeId="/wt" persisted={undefined} save={vi.fn()} />);
    expect(tabs()).toBe('');
    act(() => {
      rerender(<Harness worktreeId="/wt" persisted={later} save={vi.fn()} />);
    });
    expect(tabs()).toBe('late.ts');
  });

  it('a local open before persisted arrives is NOT stomped by a late (stale) persisted', () => {
    // Fresh install: persisted is undefined until the first save round-trips back. The user opens
    // A then B locally in that window; a stale early save carrying only [a] must not clobber [a,b].
    const { rerender } = render(<Harness worktreeId="/wt" persisted={undefined} save={vi.fn()} />);
    fireEvent.click(screen.getByTestId('open-a'));
    fireEvent.click(screen.getByTestId('open-b'));
    expect(tabs()).toBe('a.ts,b.ts');
    act(() => {
      rerender(
        <Harness
          worktreeId="/wt"
          persisted={{ '/wt': { open: ['a.ts'], active: 'a.ts' } }}
          save={vi.fn()}
        />,
      );
    });
    expect(tabs()).toBe('a.ts,b.ts'); // local state wins — B survives
    expect(active()).toBe('b.ts');
  });

  it('is a no-op when no worktree is selected', () => {
    const save = vi.fn();
    render(<Harness worktreeId={null} save={save} />);
    fireEvent.click(screen.getByTestId('open-a'));
    expect(tabs()).toBe('');
    expect(save).not.toHaveBeenCalled();
  });

  describe('preview tabs', () => {
    it('a preview open marks the tab as the preview; a pinned open leaves preview null', () => {
      render(<Harness worktreeId="/wt" save={vi.fn()} />);
      fireEvent.click(screen.getByTestId('prev-a')); // single-click preview
      expect(tabs()).toBe('a.ts');
      expect(preview()).toBe('a.ts');
      fireEvent.click(screen.getByTestId('open-b')); // double-click pinned
      expect(tabs()).toBe('a.ts,b.ts');
      expect(preview()).toBe('a.ts'); // b is pinned, a still the preview
    });

    it('previewing a new file REPLACES the preview slot in place (no accumulation)', () => {
      render(<Harness worktreeId="/wt" save={vi.fn()} />);
      fireEvent.click(screen.getByTestId('open-a')); // pinned a
      fireEvent.click(screen.getByTestId('prev-b')); // preview b
      expect(tabs()).toBe('a.ts,b.ts');
      expect(preview()).toBe('b.ts');
      fireEvent.click(screen.getByTestId('prev-c')); // preview c replaces b in the SAME slot
      expect(tabs()).toBe('a.ts,c.ts');
      expect(preview()).toBe('c.ts');
      expect(active()).toBe('c.ts');
    });

    it('pin() promotes the preview tab to pinned', () => {
      render(<Harness worktreeId="/wt" save={vi.fn()} />);
      fireEvent.click(screen.getByTestId('prev-a'));
      expect(preview()).toBe('a.ts');
      fireEvent.click(screen.getByTestId('pin-a'));
      expect(preview()).toBe('');
      expect(tabs()).toBe('a.ts'); // still open, now pinned
    });

    it('a pinned open of the current preview tab promotes it (double-click a preview)', () => {
      render(<Harness worktreeId="/wt" save={vi.fn()} />);
      fireEvent.click(screen.getByTestId('prev-a')); // preview a
      fireEvent.click(screen.getByTestId('open-a')); // pinned open of a -> promote
      expect(preview()).toBe('');
      expect(tabs()).toBe('a.ts');
    });

    it('closing the preview tab clears the preview slot', () => {
      render(<Harness worktreeId="/wt" save={vi.fn()} />);
      fireEvent.click(screen.getByTestId('open-a')); // pinned a
      fireEvent.click(screen.getByTestId('prev-b')); // preview b (active)
      expect(preview()).toBe('b.ts');
      fireEvent.click(screen.getByTestId('close-active')); // close b
      expect(tabs()).toBe('a.ts');
      expect(preview()).toBe('');
    });

    it('preview is in-memory only — persistence still saves just {open, active}', () => {
      const save = vi.fn();
      render(<Harness worktreeId="/wt" save={save} />);
      fireEvent.click(screen.getByTestId('prev-a'));
      expect(save).toHaveBeenLastCalledWith('/wt', { open: ['a.ts'], active: 'a.ts' });
    });
  });
});

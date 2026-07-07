import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useFileEditor } from '../../src/renderer/hooks/use-file-editor';
import type { FileReadResult, FileWriteResult } from '../../src/shared/types';

// window.mango is read-only — install a configurable stub whose read/write delegate to
// per-test impls (mirrors tests/renderer/file-tree.render.test.tsx).
let readImpl: (req: { worktreeId: string; relPath: string }) => Promise<FileReadResult>;
let writeImpl: (req: {
  worktreeId: string;
  relPath: string;
  content: string;
  baseToken?: string;
}) => Promise<FileWriteResult>;
beforeEach(() => {
  readImpl = async () => ({ content: '', readOnly: false, size: 0, baseToken: 't0' });
  writeImpl = async () => ({ ok: true, baseToken: 't1' });
  Object.defineProperty(window, 'mango', {
    configurable: true,
    value: { file: { read: (r: never) => readImpl(r), write: (r: never) => writeImpl(r) } },
  });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Renders the hook for one (worktree,file) and exposes its state as text nodes. */
function Harness({ worktreeId, relPath }: { worktreeId: string | null; relPath: string | null }) {
  const e = useFileEditor(worktreeId, relPath);
  return (
    <div>
      <span data-testid="content">{e.content === null ? 'LOADING' : e.content}</span>
      <span data-testid="dirty">{String(e.dirty)}</span>
      <span data-testid="saving">{String(e.saving)}</span>
      <span data-testid="readonly">{String(e.readOnly)}</span>
      <span data-testid="saveerr">{e.saveError ?? ''}</span>
      <input data-testid="edit" value={e.value} onChange={(ev) => e.setValue(ev.target.value)} />
      <button type="button" data-testid="flush" onClick={() => void e.flush()}>
        flush
      </button>
    </div>
  );
}

const content = () => screen.getByTestId('content').textContent;
const dirty = () => screen.getByTestId('dirty').textContent;

describe('useFileEditor', () => {
  it('loads editable text; editing marks it dirty', async () => {
    readImpl = async () => ({ content: 'hello', readOnly: false, size: 5, baseToken: 't1' });
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await waitFor(() => expect(content()).toBe('hello'));
    expect(dirty()).toBe('false');
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'hello!' } });
    expect(dirty()).toBe('true');
    // Flush the pending debounced write so no timer/setState dangles past the test.
    fireEvent.click(screen.getByTestId('flush'));
    await waitFor(() => expect(dirty()).toBe('false'));
  });

  it('auto-saves after the debounce idle gap (no explicit save)', async () => {
    vi.useFakeTimers();
    readImpl = async () => ({ content: 'hello', readOnly: false, size: 5, baseToken: 't1' });
    const write = vi.fn(async () => ({ ok: true, baseToken: 't2' }) as FileWriteResult);
    writeImpl = write;
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await act(async () => {}); // resolve the read microtask
    expect(content()).toBe('hello');

    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'auto' } });
    expect(write).not.toHaveBeenCalled(); // still inside the debounce window
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await act(async () => {}); // resolve the write promise + setContent
    expect(write).toHaveBeenCalledWith({
      worktreeId: '/wt',
      relPath: 'a.txt',
      content: 'auto',
      baseToken: 't1',
    });
    expect(dirty()).toBe('false');
  });

  it('flush persists immediately then clears dirty (write ok)', async () => {
    readImpl = async () => ({ content: 'hello', readOnly: false, size: 5, baseToken: 't1' });
    const write = vi.fn(async () => ({ ok: true, baseToken: 't2' }) as FileWriteResult);
    writeImpl = write;
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await waitFor(() => expect(content()).toBe('hello'));
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'saved!' } });
    fireEvent.click(screen.getByTestId('flush'));
    await waitFor(() => expect(dirty()).toBe('false'));
    expect(write).toHaveBeenCalledWith({
      worktreeId: '/wt',
      relPath: 'a.txt',
      content: 'saved!',
      baseToken: 't1',
    });
    expect(content()).toBe('saved!');
  });

  it('DATA-LOSS contract: a failed write keeps dirty + the buffer, surfaces saveError', async () => {
    readImpl = async () => ({ content: 'hello', readOnly: false, size: 5, baseToken: 't1' });
    writeImpl = async () => ({ ok: false, error: 'EACCES' });
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await waitFor(() => expect(content()).toBe('hello'));
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByTestId('flush'));
    await waitFor(() => expect(screen.getByTestId('saveerr').textContent).toBe('EACCES'));
    expect(dirty()).toBe('true'); // STILL dirty
    expect((screen.getByTestId('edit') as HTMLInputElement).value).toBe('edited'); // buffer kept
  });

  it('a readOnly file never becomes dirty nor schedules a write, even after setValue', async () => {
    vi.useFakeTimers();
    readImpl = async () => ({
      content: '',
      readOnly: true,
      reason: 'binary',
      size: 9,
      baseToken: 't1',
    });
    const write = vi.fn(async () => ({ ok: true, baseToken: 't2' }) as FileWriteResult);
    writeImpl = write;
    render(<Harness worktreeId="/wt" relPath="x.png" />);
    await act(async () => {});
    expect(screen.getByTestId('readonly').textContent).toBe('true');
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'typed' } });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(dirty()).toBe('false');
    expect(write).not.toHaveBeenCalled();
  });

  it('serializes writes: an edit during an in-flight write coalesces into one re-write', async () => {
    vi.useFakeTimers();
    readImpl = async () => ({ content: 'x', readOnly: false, size: 1, baseToken: 't1' });
    const writes: Array<{ content: string; baseToken?: string }> = [];
    let resolveFirst!: (r: FileWriteResult) => void;
    writeImpl = (req) => {
      writes.push({ content: req.content, baseToken: req.baseToken });
      if (writes.length === 1) return new Promise<FileWriteResult>((res) => (resolveFirst = res));
      return Promise.resolve({ ok: true, baseToken: 't3' });
    };
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await act(async () => {});

    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'x1' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(writes).toHaveLength(1); // write #1 in flight (unresolved)

    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'x2' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(writes).toHaveLength(1); // coalesced: no second write races the first

    await act(async () => {
      resolveFirst({ ok: true, baseToken: 't2' });
    });
    await act(async () => {}); // the queued re-write runs from the finally block
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual({ content: 'x1', baseToken: 't1' });
    expect(writes[1]).toEqual({ content: 'x2', baseToken: 't2' }); // uses the token #1 returned
  });

  it('race guard: a slow read for the OLD file does not clobber the new file', async () => {
    let resolveA!: (r: FileReadResult) => void;
    readImpl = (req) => {
      if (req.relPath === 'a.txt') return new Promise<FileReadResult>((res) => (resolveA = res));
      return Promise.resolve({ content: 'B-content', readOnly: false, size: 9, baseToken: 'tb' });
    };
    const { rerender } = render(<Harness worktreeId="/wt" relPath="a.txt" />);
    expect(content()).toBe('LOADING');
    rerender(<Harness worktreeId="/wt" relPath="b.txt" />);
    await waitFor(() => expect(content()).toBe('B-content'));
    // A's slow read resolves LAST — it must be dropped (key no longer matches).
    await act(async () => {
      resolveA({ content: 'A-content', readOnly: false, size: 9, baseToken: 'ta' });
    });
    expect(content()).toBe('B-content');
  });
});

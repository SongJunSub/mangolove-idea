import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useFileEditor } from '../../src/renderer/hooks/use-file-editor';
import type { FileReadResult, FileWriteResult } from '../../src/shared/types';

// window.mango is read-only — install a configurable stub whose read/write delegate to
// per-test impls (mirrors tests/renderer/file-tree.render.test.tsx).
let readImpl: (req: { worktreeId: string; relPath: string }) => Promise<FileReadResult>;
let writeImpl: (req: unknown) => Promise<FileWriteResult>;
beforeEach(() => {
  readImpl = async () => ({ content: '', readOnly: false, size: 0, baseToken: 't0' });
  writeImpl = async () => ({ ok: true, baseToken: 't1' });
  Object.defineProperty(window, 'mango', {
    configurable: true,
    value: { file: { read: (r: never) => readImpl(r), write: (r: never) => writeImpl(r) } },
  });
});

/** Renders the hook for one (worktree,file) and exposes its state as text nodes. */
function Harness({ worktreeId, relPath }: { worktreeId: string | null; relPath: string | null }) {
  const e = useFileEditor(worktreeId, relPath);
  return (
    <div>
      <span data-testid="content">{e.content === null ? 'LOADING' : e.content}</span>
      <span data-testid="dirty">{String(e.dirty)}</span>
      <span data-testid="readonly">{String(e.readOnly)}</span>
      <span data-testid="saveerr">{e.saveError ?? ''}</span>
      <input data-testid="edit" value={e.value} onChange={(ev) => e.setValue(ev.target.value)} />
      <button type="button" data-testid="save" onClick={() => void e.save()}>
        save
      </button>
    </div>
  );
}

describe('useFileEditor', () => {
  it('loads editable text; editing marks it dirty', async () => {
    readImpl = async () => ({ content: 'hello', readOnly: false, size: 5, baseToken: 't1' });
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await waitFor(() => expect(screen.getByTestId('content').textContent).toBe('hello'));
    expect(screen.getByTestId('dirty').textContent).toBe('false');
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'hello!' } });
    expect(screen.getByTestId('dirty').textContent).toBe('true');
  });

  it('save persists then clears dirty (write ok)', async () => {
    readImpl = async () => ({ content: 'hello', readOnly: false, size: 5, baseToken: 't1' });
    const write = vi.fn(async () => ({ ok: true, baseToken: 't2' }) as FileWriteResult);
    writeImpl = write;
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await waitFor(() => expect(screen.getByTestId('content').textContent).toBe('hello'));
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'saved!' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
    expect(write).toHaveBeenCalledWith({
      worktreeId: '/wt',
      relPath: 'a.txt',
      content: 'saved!',
      baseToken: 't1',
    });
    expect(screen.getByTestId('content').textContent).toBe('saved!');
  });

  it('DATA-LOSS contract: a failed write keeps dirty + the buffer, surfaces saveError', async () => {
    readImpl = async () => ({ content: 'hello', readOnly: false, size: 5, baseToken: 't1' });
    writeImpl = async () => ({ ok: false, error: 'EACCES' });
    render(<Harness worktreeId="/wt" relPath="a.txt" />);
    await waitFor(() => expect(screen.getByTestId('content').textContent).toBe('hello'));
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByTestId('save'));
    await waitFor(() => expect(screen.getByTestId('saveerr').textContent).toBe('EACCES'));
    expect(screen.getByTestId('dirty').textContent).toBe('true'); // STILL dirty
    expect((screen.getByTestId('edit') as HTMLInputElement).value).toBe('edited'); // buffer kept
  });

  it('a readOnly file never becomes dirty, even after setValue', async () => {
    readImpl = async () => ({
      content: '',
      readOnly: true,
      reason: 'binary',
      size: 9,
      baseToken: 't1',
    });
    render(<Harness worktreeId="/wt" relPath="x.png" />);
    await waitFor(() => expect(screen.getByTestId('readonly').textContent).toBe('true'));
    fireEvent.change(screen.getByTestId('edit'), { target: { value: 'typed' } });
    expect(screen.getByTestId('dirty').textContent).toBe('false');
  });

  it('race guard: a slow read for the OLD file does not clobber the new file', async () => {
    let resolveA!: (r: FileReadResult) => void;
    readImpl = (req) => {
      if (req.relPath === 'a.txt') return new Promise<FileReadResult>((res) => (resolveA = res));
      return Promise.resolve({ content: 'B-content', readOnly: false, size: 9, baseToken: 'tb' });
    };
    const { rerender } = render(<Harness worktreeId="/wt" relPath="a.txt" />);
    expect(screen.getByTestId('content').textContent).toBe('LOADING');
    rerender(<Harness worktreeId="/wt" relPath="b.txt" />);
    await waitFor(() => expect(screen.getByTestId('content').textContent).toBe('B-content'));
    // A's slow read resolves LAST — it must be dropped (key no longer matches).
    await act(async () => {
      resolveA({ content: 'A-content', readOnly: false, size: 9, baseToken: 'ta' });
    });
    expect(screen.getByTestId('content').textContent).toBe('B-content');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { wrapI18n } from './i18n-test-util';
import { FileTree } from '../../src/renderer/components/tree/file-tree';
import type { TreeEntry } from '../../src/shared/types';

/** Installs a window.mango.tree.list stub backed by a relPath→entries map. */
function stubTree(map: Record<string, TreeEntry[]>) {
  const list = vi.fn(async ({ relPath }: { relPath?: string }) => map[relPath ?? ''] ?? []);
  Object.defineProperty(window, 'mango', { value: { tree: { list } }, configurable: true });
  return list;
}

beforeEach(() => {
  stubTree({
    '': [
      { name: 'src', isDir: true },
      { name: 'README.md', isDir: false },
    ],
    src: [{ name: 'App.tsx', isDir: false }],
  });
});

describe('<FileTree>', () => {
  it('prompts when no worktree is selected', () => {
    render(wrapI18n(<FileTree worktreeId={null} selectedFile={null} onOpenFile={vi.fn()} />));
    expect(screen.getByText(/Select a worktree/)).toBeInTheDocument();
  });

  it('loads + renders the root entries (dirs + files) for the selected worktree', async () => {
    render(wrapI18n(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={vi.fn()} />));
    expect(await screen.findByTestId('tree-node-src')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-README.md')).toBeInTheDocument();
  });

  it('single-click PREVIEWS a file (temporary tab); a folder just selects, no open/expand', async () => {
    const onOpenFile = vi.fn();
    render(
      wrapI18n(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={onOpenFile} />),
    );
    fireEvent.click(await screen.findByTestId('tree-node-README.md'));
    expect(onOpenFile).toHaveBeenCalledWith('README.md', { preview: true }); // single-click = preview
    expect(screen.getByTestId('tree-node-README.md')).toHaveAttribute('aria-selected', 'true');

    onOpenFile.mockClear();
    fireEvent.click(screen.getByTestId('tree-node-src')); // folder: select only, no open, no expand
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tree-node-src/App.tsx')).not.toBeInTheDocument();
  });

  it('DOUBLE-click opens a file PINNED / toggles a folder', async () => {
    const onOpenFile = vi.fn();
    render(
      wrapI18n(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={onOpenFile} />),
    );
    fireEvent.doubleClick(await screen.findByTestId('tree-node-README.md'));
    expect(onOpenFile).toHaveBeenCalledWith('README.md', { preview: false }); // double-click = pinned

    fireEvent.doubleClick(screen.getByTestId('tree-node-src')); // folder expands
    expect(await screen.findByTestId('tree-node-src/App.tsx')).toBeInTheDocument();
    expect(onOpenFile).toHaveBeenCalledTimes(1); // the folder did NOT open a file
  });

  it('clicking the chevron toggles the folder (without opening a file)', async () => {
    render(wrapI18n(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={vi.fn()} />));
    fireEvent.click(await screen.findByTestId('tree-chevron-src'));
    expect(await screen.findByTestId('tree-node-src/App.tsx')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tree-chevron-src')); // collapse
    await waitFor(() =>
      expect(screen.queryByTestId('tree-node-src/App.tsx')).not.toBeInTheDocument(),
    );
  });

  it('keyboard: focus lands the cursor, ↓ moves it, Enter opens the focused file', async () => {
    const onOpenFile = vi.fn();
    render(
      wrapI18n(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={onOpenFile} />),
    );
    const tree = await screen.findByTestId('file-tree');
    fireEvent.focus(tree); // cursor → first row (src)
    expect(screen.getByTestId('tree-node-src')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tree, { key: 'ArrowDown' }); // → README.md
    expect(screen.getByTestId('tree-node-README.md')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onOpenFile).toHaveBeenCalledWith('README.md', { preview: false }); // Enter = pinned
  });

  it('keyboard: → expands a folder then steps into its child, ← collapses / goes to parent', async () => {
    render(wrapI18n(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={vi.fn()} />));
    const tree = await screen.findByTestId('file-tree');
    fireEvent.focus(tree); // cursor → src
    fireEvent.keyDown(tree, { key: 'ArrowRight' }); // expand src
    expect(await screen.findByTestId('tree-node-src/App.tsx')).toBeInTheDocument();
    fireEvent.keyDown(tree, { key: 'ArrowRight' }); // step into first child
    expect(screen.getByTestId('tree-node-src/App.tsx')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // child (a file) → parent
    expect(screen.getByTestId('tree-node-src')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tree, { key: 'ArrowLeft' }); // parent (expanded dir) → collapse
    await waitFor(() =>
      expect(screen.queryByTestId('tree-node-src/App.tsx')).not.toBeInTheDocument(),
    );
  });

  it('keyboard: Enter on a folder toggles it (does not open a file)', async () => {
    const onOpenFile = vi.fn();
    render(
      wrapI18n(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={onOpenFile} />),
    );
    const tree = await screen.findByTestId('file-tree');
    fireEvent.focus(tree); // cursor → src (folder)
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(await screen.findByTestId('tree-node-src/App.tsx')).toBeInTheDocument();
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});

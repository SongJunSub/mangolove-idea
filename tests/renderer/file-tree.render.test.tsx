import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    render(<FileTree worktreeId={null} selectedFile={null} onOpenFile={vi.fn()} />);
    expect(screen.getByText(/worktree를 선택/)).toBeInTheDocument();
  });

  it('loads + renders the root entries (dirs + files) for the selected worktree', async () => {
    render(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={vi.fn()} />);
    expect(await screen.findByTestId('tree-node-src')).toBeInTheDocument();
    expect(screen.getByTestId('tree-node-README.md')).toBeInTheDocument();
  });

  it('expands a folder on click and shows its children', async () => {
    render(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('tree-node-src'));
    expect(await screen.findByTestId('tree-node-src/App.tsx')).toBeInTheDocument();
  });

  it('clicking a FILE calls onOpenFile with its relPath (folders do not)', async () => {
    const onOpenFile = vi.fn();
    render(<FileTree worktreeId="/repo/wt" selectedFile={null} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByTestId('tree-node-README.md'));
    expect(onOpenFile).toHaveBeenCalledWith('README.md');

    fireEvent.click(screen.getByTestId('tree-node-src')); // a folder => no onOpenFile
    await waitFor(() => expect(screen.getByTestId('tree-node-src/App.tsx')).toBeInTheDocument());
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });
});

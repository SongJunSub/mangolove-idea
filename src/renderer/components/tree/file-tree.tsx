import { useEffect, useState } from 'react';
import type { TreeEntry } from '../../../shared/types';

interface Node extends TreeEntry {
  /** Path relative to the worktree root (POSIX-style, what the IPC expects). */
  readonly relPath: string;
}

export interface FileTreeProps {
  /** Selected worktree (its id IS its absolute path); null => prompt. */
  readonly worktreeId: string | null;
  /** relPath of the currently-open file (for highlight), or null. */
  readonly selectedFile: string | null;
  /** Called with a file's relPath when a file (not a folder) is clicked. */
  onOpenFile(relPath: string): void;
}

const toNodes = (entries: TreeEntry[], parent: string): Node[] =>
  entries.map((e) => ({ ...e, relPath: parent ? `${parent}/${e.name}` : e.name }));

/**
 * Lazy-expanding file explorer for the selected worktree (A3). Loads the root on
 * worktree change; each folder fetches its children on first expand. Files emit
 * onOpenFile (the editor — A4 — consumes it); folders toggle. The main process scopes
 * every read to the worktree (see FileTreeReader), so a relPath cannot escape it.
 */
export function FileTree({
  worktreeId,
  selectedFile,
  onOpenFile,
}: FileTreeProps): React.JSX.Element {
  const [roots, setRoots] = useState<Node[] | null>(null);
  const [children, setChildren] = useState<Record<string, Node[] | 'loading'>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!worktreeId) return;
    let alive = true;
    setRoots(null);
    setChildren({});
    setError(null);
    window.mango.tree
      .list({ worktreeId, relPath: '' })
      .then((entries) => {
        if (alive) setRoots(toNodes(entries, ''));
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [worktreeId]);

  const toggle = (node: Node): void => {
    if (!worktreeId) return;
    if (children[node.relPath]) {
      setChildren((m) => {
        const next = { ...m };
        delete next[node.relPath];
        return next;
      });
      return;
    }
    setChildren((m) => ({ ...m, [node.relPath]: 'loading' }));
    window.mango.tree
      .list({ worktreeId, relPath: node.relPath })
      .then((entries) => {
        setChildren((m) => ({ ...m, [node.relPath]: toNodes(entries, node.relPath) }));
      })
      .catch(() => {
        setChildren((m) => {
          const next = { ...m };
          delete next[node.relPath];
          return next;
        });
      });
  };

  const renderNodes = (nodes: Node[], depth: number): React.JSX.Element[] =>
    nodes.map((node) => {
      const kids = node.isDir ? children[node.relPath] : undefined;
      return (
        <div key={node.relPath}>
          <div
            className={`tree-node${selectedFile === node.relPath ? ' sel' : ''}`}
            data-testid={`tree-node-${node.relPath}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (node.isDir ? toggle(node) : onOpenFile(node.relPath))}
          >
            <span className="tree-tw">{node.isDir ? (kids ? '▾' : '▸') : ''}</span>
            <span className="tree-name">
              {node.isDir ? '📁' : '📄'} {node.name}
            </span>
          </div>
          {Array.isArray(kids) && renderNodes(kids, depth + 1)}
        </div>
      );
    });

  if (!worktreeId) return <div className="pane-placeholder">worktree를 선택하세요</div>;
  if (error) return <div className="pane-placeholder">트리 로드 실패: {error}</div>;
  if (roots === null) return <div className="pane-placeholder">로딩…</div>;
  if (roots.length === 0) return <div className="pane-placeholder">빈 디렉토리</div>;
  return (
    <div className="tree" data-testid="file-tree">
      {renderNodes(roots, 0)}
    </div>
  );
}

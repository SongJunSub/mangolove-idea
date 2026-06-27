import { useEffect, useState } from 'react';
import type { TreeEntry } from '../../../shared/types';
import { useI18n } from '../../i18n/i18n-context';
import { Chevron, FileIcon, FolderIcon, fileAccent } from './tree-icons';

/** Indent step (px) per nesting depth — also where the indent guide line sits. */
const INDENT = 16;

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
  const { t } = useI18n();
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
      const expanded = node.isDir && kids !== undefined; // expanded once children are requested
      return (
        <div key={node.relPath}>
          <div
            className={`tree-node${selectedFile === node.relPath ? ' sel' : ''}`}
            data-testid={`tree-node-${node.relPath}`}
            style={{ paddingLeft: 8 + depth * INDENT }}
            onClick={() => (node.isDir ? toggle(node) : onOpenFile(node.relPath))}
          >
            {Array.from({ length: depth }, (_, i) => (
              <span key={i} className="tree-guide" style={{ left: 8 + i * INDENT + 7 }} />
            ))}
            {node.isDir ? (
              <Chevron open={expanded} />
            ) : (
              <span className="tree-chevron tree-chevron--leaf" aria-hidden="true" />
            )}
            <span
              className="tree-ico"
              style={node.isDir ? undefined : { color: fileAccent(node.name) }}
            >
              {node.isDir ? <FolderIcon open={expanded} /> : <FileIcon />}
            </span>
            <span className="tree-name">{node.name}</span>
          </div>
          {Array.isArray(kids) && renderNodes(kids, depth + 1)}
        </div>
      );
    });

  if (!worktreeId) return <div className="pane-placeholder">{t('tree.selectWorktree')}</div>;
  if (error) return <div className="pane-placeholder">{t('tree.loadError', { error })}</div>;
  if (roots === null) return <div className="pane-placeholder">{t('tree.loading')}</div>;
  if (roots.length === 0) return <div className="pane-placeholder">{t('tree.empty')}</div>;
  return (
    <div className="tree" data-testid="file-tree">
      {renderNodes(roots, 0)}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** Called with a file's relPath when a file (not a folder) is opened. A single-click opens a
   *  PREVIEW tab (temporary); a double-click / Enter opens a pinned tab. */
  onOpenFile(relPath: string, opts: { preview: boolean }): void;
}

const toNodes = (entries: TreeEntry[], parent: string): Node[] =>
  entries.map((e) => ({ ...e, relPath: parent ? `${parent}/${e.name}` : e.name }));

/** A DOM id for a row's relPath (aria-activedescendant target). */
const rowId = (relPath: string): string => `tree-row:${relPath}`;

/**
 * Lazy-expanding file explorer for the selected worktree (A3). Loads the root on
 * worktree change; each folder fetches its children on first expand. The main process
 * scopes every read to the worktree (see FileTreeReader), so a relPath cannot escape it.
 *
 * IntelliJ-style interaction: single-click SELECTS a row (keyboard cursor), double-click
 * OPENS a file (onOpenFile) / toggles a folder, the chevron toggles a folder. Fully
 * keyboard-operable: ↑/↓ move, → expands a collapsed folder then steps into it, ← collapses
 * then steps to the parent, Enter opens the file / toggles the folder, Home/End jump.
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
  /** The keyboard cursor / clicked row (distinct from selectedFile, the open file). */
  const [activePath, setActivePath] = useState<string | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!worktreeId) return;
    let alive = true;
    setRoots(null);
    setChildren({});
    setError(null);
    setActivePath(null);
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

  // Flatten the currently-VISIBLE rows in display order — the model for ↑/↓ navigation.
  const visibleRows = useMemo(() => {
    const out: { node: Node; depth: number }[] = [];
    const walk = (nodes: Node[], depth: number): void => {
      for (const node of nodes) {
        out.push({ node, depth });
        const kids = node.isDir ? children[node.relPath] : undefined;
        if (Array.isArray(kids)) walk(kids, depth + 1);
      }
    };
    if (roots) walk(roots, 0);
    return out;
  }, [roots, children]);

  // Keep the active row scrolled into view as the cursor moves (guarded — jsdom lacks it).
  useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activePath]);

  const isExpanded = (node: Node): boolean => node.isDir && children[node.relPath] !== undefined;

  const expand = (node: Node): void => {
    if (!worktreeId || children[node.relPath]) return;
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

  const collapse = (node: Node): void => {
    setChildren((m) => {
      const next = { ...m };
      delete next[node.relPath];
      return next;
    });
    // If the cursor was inside the folder being collapsed, pull it up to the folder.
    setActivePath((p) => (p && p.startsWith(`${node.relPath}/`) ? node.relPath : p));
  };

  const toggle = (node: Node): void => {
    if (isExpanded(node)) collapse(node);
    else expand(node);
  };

  /** Single-click a row: move the cursor there, and PREVIEW-open a file (folders just select). */
  const select = (node: Node): void => {
    setActivePath(node.relPath);
    if (!node.isDir) onOpenFile(node.relPath, { preview: true });
  };

  /** Activate a row: PIN-open a file, toggle a folder (double-click / Enter). */
  const activate = (node: Node): void => {
    setActivePath(node.relPath);
    if (node.isDir) toggle(node);
    else onOpenFile(node.relPath, { preview: false });
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!visibleRows.length) return;
    const nav = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', 'Home', 'End'];
    if (!nav.includes(e.key)) return;
    const idx = visibleRows.findIndex((r) => r.node.relPath === activePath);
    const go = (i: number): void =>
      setActivePath(visibleRows[Math.max(0, Math.min(visibleRows.length - 1, i))].node.relPath);
    e.preventDefault();
    if (idx < 0) {
      go(0); // nothing active yet → land on the first row
      return;
    }
    const { node, depth } = visibleRows[idx];
    switch (e.key) {
      case 'ArrowDown':
        go(idx + 1);
        break;
      case 'ArrowUp':
        go(idx - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(visibleRows.length - 1);
        break;
      case 'ArrowRight':
        if (node.isDir && !isExpanded(node)) expand(node);
        else if (visibleRows[idx + 1]?.depth === depth + 1) go(idx + 1); // step into first child
        break;
      case 'ArrowLeft':
        if (isExpanded(node)) collapse(node);
        else {
          for (let i = idx - 1; i >= 0; i--) {
            if (visibleRows[i].depth === depth - 1) {
              setActivePath(visibleRows[i].node.relPath);
              break;
            }
          }
        }
        break;
      case 'Enter':
        activate(node);
        break;
    }
  };

  const onFocus = (): void => {
    if (activePath && visibleRows.some((r) => r.node.relPath === activePath)) return;
    const initial =
      selectedFile && visibleRows.some((r) => r.node.relPath === selectedFile)
        ? selectedFile
        : (visibleRows[0]?.node.relPath ?? null);
    if (initial) setActivePath(initial);
  };

  const renderNodes = (nodes: Node[], depth: number): React.JSX.Element[] =>
    nodes.map((node, i) => {
      const kids = node.isDir ? children[node.relPath] : undefined;
      const expanded = node.isDir && kids !== undefined; // expanded once children are requested
      const active = activePath === node.relPath;
      const open = selectedFile === node.relPath;
      return (
        <div key={node.relPath}>
          <div
            id={rowId(node.relPath)}
            role="treeitem"
            aria-selected={active}
            aria-expanded={node.isDir ? expanded : undefined}
            aria-level={depth + 1}
            aria-setsize={nodes.length}
            aria-posinset={i + 1}
            ref={active ? activeRowRef : undefined}
            className={`tree-node${open ? ' sel' : ''}${active ? ' tree-node--active' : ''}`}
            data-testid={`tree-node-${node.relPath}`}
            style={{ paddingLeft: 8 + depth * INDENT }}
            onClick={() => select(node)}
            onDoubleClick={() => activate(node)}
          >
            {Array.from({ length: depth }, (_, i) => (
              <span key={i} className="tree-guide" style={{ left: 8 + i * INDENT + 7 }} />
            ))}
            {node.isDir ? (
              <span
                className="tree-chevron-hit"
                data-testid={`tree-chevron-${node.relPath}`}
                onClick={(e) => {
                  e.stopPropagation(); // the chevron toggles; the row-click select is redundant here
                  select(node); // a folder node: just moves the cursor (never opens a file)
                  toggle(node);
                }}
                onDoubleClick={(e) => e.stopPropagation()} // never let a chevron dbl-click reach activate()
              >
                <Chevron open={expanded} />
              </span>
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
    <div
      className="tree"
      role="tree"
      tabIndex={0}
      aria-label={t('tree.ariaLabel')}
      aria-activedescendant={activePath ? rowId(activePath) : undefined}
      data-testid="file-tree"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {renderNodes(roots, 0)}
    </div>
  );
}

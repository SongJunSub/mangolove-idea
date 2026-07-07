import { useI18n } from '../../i18n/i18n-context';

export interface EditorTabsProps {
  /** Ordered open file relPaths. */
  readonly tabs: readonly string[];
  /** The active relPath, or null. */
  readonly active: string | null;
  /** The single preview (temporary) tab, rendered italic; null when all tabs are pinned. */
  readonly preview: string | null;
  /** The active tab has unsaved edits (auto-save debounce window) — shows a dot. */
  readonly dirty: boolean;
  /** The active tab's last write failed — shows the dot in the error colour. */
  readonly saveError: boolean;
  onActivate(relPath: string): void;
  /** Promote a preview tab to pinned (double-click the tab). */
  onPin(relPath: string): void;
  onClose(relPath: string): void;
}

/** Last path segment (the file name) shown on the tab; falls back to the whole path. */
function baseName(relPath: string): string {
  return relPath.split('/').filter(Boolean).pop() ?? relPath;
}

/**
 * IntelliJ-style tab strip for the editor pane. One tab per open file (active highlighted); click
 * to switch, the × button or a middle-click to close. The active tab shows a status dot while it
 * has unsaved edits (auto-save debounce) or in the error colour if its last write failed. Overflow
 * scrolls horizontally. Buffer/save state lives in the editor, so only the ACTIVE tab's dot is
 * driven here (an inactive tab is always clean on disk — it was flushed when deactivated).
 */
export function EditorTabs({
  tabs,
  active,
  preview,
  dirty,
  saveError,
  onActivate,
  onPin,
  onClose,
}: EditorTabsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="editor-tabs" data-testid="editor-tabs" role="tablist">
      {tabs.map((relPath) => {
        const isActive = relPath === active;
        const isPreview = relPath === preview;
        const showDot = isActive && (dirty || saveError);
        return (
          <div
            key={relPath}
            role="tab"
            aria-selected={isActive}
            data-testid={`editor-tab-${relPath}`}
            className={`editor-tab${isActive ? ' active' : ''}${isPreview ? ' preview' : ''}`}
            title={relPath}
            onClick={() => onActivate(relPath)}
            onDoubleClick={() => onPin(relPath)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(relPath); // middle-click closes
              }
            }}
          >
            <span className="editor-tab-name">{baseName(relPath)}</span>
            {showDot && (
              <span
                className={`editor-tab-dot${saveError ? ' err' : ''}`}
                data-testid={`editor-tab-dot-${relPath}`}
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              className="editor-tab-close"
              data-testid={`editor-tab-close-${relPath}`}
              aria-label={t('editor.closeTab', { name: baseName(relPath) })}
              title={t('editor.closeTab', { name: baseName(relPath) })}
              onClick={(e) => {
                e.stopPropagation(); // don't also activate the tab
                onClose(relPath);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

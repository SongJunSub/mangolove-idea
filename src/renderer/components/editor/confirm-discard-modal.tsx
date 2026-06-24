export interface ConfirmDiscardModalProps {
  /** File with unsaved edits (shown in the prompt). */
  readonly fileName: string;
  readonly saving: boolean;
  /** Surfaced inline; the modal STAYS OPEN on a failed save so the user can retry. */
  readonly saveError: string | null;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}

/**
 * Save / Discard / Cancel prompt shown when the user navigates away from a dirty file.
 * Mirrors the quit-warning dialog markup (role=dialog, aria-modal, surface/border
 * tokens). On a failed save the parent keeps `pending` set so this stays mounted and
 * shows saveError — Save can be retried; the queued navigation is never silently dropped.
 */
export function ConfirmDiscardModal({
  fileName,
  saving,
  saveError,
  onSave,
  onDiscard,
  onCancel,
}: ConfirmDiscardModalProps): React.JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="discard-modal"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 24,
          maxWidth: 400,
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Unsaved changes</h2>
        <p style={{ fontSize: 13 }}>
          <code>{fileName}</code> has unsaved changes. Save before switching?
        </p>
        {saveError && (
          <p data-testid="discard-save-error" style={{ color: 'var(--err)', fontSize: 12 }}>
            save failed: {saveError}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" data-testid="discard-cancel" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" data-testid="discard-discard" disabled={saving} onClick={onDiscard}>
            Discard
          </button>
          <button type="button" data-testid="discard-save" disabled={saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A transient bottom-center notification. Presentational only — the parent owns when it shows and
 * its auto-dismiss timer; this just renders the message + a manual close.
 */
export function Toast({
  message,
  closeLabel,
  onClose,
}: {
  readonly message: string;
  readonly closeLabel: string;
  onClose(): void;
}): React.JSX.Element {
  return (
    <div className="toast" role="status" data-testid="toast">
      <span className="toast-msg">{message}</span>
      <button type="button" className="toast-close" aria-label={closeLabel} onClick={onClose}>
        ×
      </button>
    </div>
  );
}

export interface StatusBarProps {
  /** Bottom-LEFT content (the Claude usage widget). */
  readonly left: React.ReactNode;
  /** Bottom-RIGHT content (the active-update progress/error, or nothing). */
  readonly right: React.ReactNode;
}

/**
 * The always-on bottom status bar: Claude usage on the left, the active-update progress on the
 * right. A pure shell — App injects both sides. (The update-available notification is a
 * separate floating card, not part of this bar.)
 */
export function StatusBar({ left, right }: StatusBarProps): React.JSX.Element {
  return (
    <div className="status-bar" data-testid="status-bar">
      <div className="status-bar__left">{left}</div>
      <div className="status-bar__right">{right}</div>
    </div>
  );
}

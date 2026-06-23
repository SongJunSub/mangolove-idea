import type { CrossMachineSessionPointer } from '../../../shared/types';

/** Props for the cross-machine sessions panel (modal overlay). */
export interface CrossMachinePanelProps {
  readonly pointers: readonly CrossMachineSessionPointer[];
  readonly loading: boolean;
  readonly error: string | null;
  /** Whether cross-machine sharing is opted in (settings.crossMachineSessions === 'on'). */
  readonly enabled: boolean;
  /** This machine's id, so its own sessions are marked and never offer "start here". */
  readonly selfMachineId?: string;
  onRefresh(): void;
  onStartHere(branch: string): void;
  onClose(): void;
}

export interface MachineGroup {
  readonly machineId: string;
  readonly label: string;
  readonly isSelf: boolean;
  readonly sessions: CrossMachineSessionPointer[];
}

/** Groups pointers by publishing machine (this machine first), preserving order otherwise. */
export function groupByMachine(
  pointers: readonly CrossMachineSessionPointer[],
  selfMachineId?: string,
): MachineGroup[] {
  const byId = new Map<string, MachineGroup>();
  for (const p of pointers) {
    let group = byId.get(p.machineId);
    if (!group) {
      group = {
        machineId: p.machineId,
        label: p.machineLabel,
        isSelf: p.machineId === selfMachineId,
        sessions: [],
      };
      byId.set(p.machineId, group);
    }
    group.sessions.push(p);
  }
  return [...byId.values()].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
}

/**
 * Lists every machine's live sessions (visibility-only). For a session on ANOTHER
 * machine, "Start here" checks out that branch locally and starts a FRESH session
 * (conversation is NOT carried over — cross-machine resume is out of scope).
 */
export function CrossMachinePanel({
  pointers,
  loading,
  error,
  enabled,
  selfMachineId,
  onRefresh,
  onStartHere,
  onClose,
}: CrossMachinePanelProps): React.JSX.Element {
  const groups = groupByMachine(pointers, selfMachineId);

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="cross-machine-panel"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{ background: '#fff', borderRadius: 8, padding: 24, width: 460, maxWidth: '90vw' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Cross-machine sessions</h2>
          <button
            type="button"
            data-testid="cross-machine-refresh"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>

        {!enabled && (
          <p data-testid="cross-machine-disabled" style={{ fontSize: 12, color: '#888' }}>
            Turn on “Share this machine’s sessions” in Settings to see sessions from your other
            machines.
          </p>
        )}
        {error && (
          <p data-testid="cross-machine-error" style={{ fontSize: 12, color: '#b00' }}>
            {error}
          </p>
        )}
        {enabled && !loading && groups.length === 0 && (
          <p data-testid="cross-machine-empty" style={{ fontSize: 12, color: '#888' }}>
            No sessions published from any machine yet.
          </p>
        )}

        {/* Only render the session list (and its "Start here" actions) while opted in, so
            toggling sharing off mid-open never leaves stale, actionable groups on screen. */}
        {enabled &&
          groups.map((g) => (
            <section
              key={g.machineId}
              data-testid={`cm-machine-${g.machineId}`}
              style={{ marginTop: 12 }}
            >
              <h4 style={{ margin: '0 0 4px', fontSize: 13 }}>
                {g.label}
                {g.isSelf && (
                  <span style={{ color: '#888', fontWeight: 400 }}> (this machine)</span>
                )}
              </h4>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12 }}>
                {g.sessions.map((s, i) => (
                  <li
                    key={`${s.branch}-${i}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <code>{s.branch}</code>
                    <span style={{ color: '#888' }}>
                      {s.status}
                      {s.hasActiveTurn ? ' · active turn' : ''}
                    </span>
                    {!g.isSelf && (
                      <button
                        type="button"
                        data-testid={`cm-start-${s.branch}`}
                        title="Check out this branch here and start a fresh session"
                        onClick={() => onStartHere(s.branch)}
                      >
                        Start here
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" data-testid="cross-machine-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

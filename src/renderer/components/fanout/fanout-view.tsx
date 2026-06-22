import { lazy, Suspense, useState } from 'react';
import type { FanoutLane, MergeResult } from '../../../shared/types';
import { useFanout } from '../../hooks/use-fanout';

// Reuse the existing Monaco diff view per-lane (a lane is a real worktree).
const DiffView = lazy(() => import('../diff/diff-view').then((m) => ({ default: m.DiffView })));

/** The preset model tiers the picker offers (max 4 selectable). */
const PRESET_MODELS = ['opus', 'sonnet', 'haiku'] as const;

export interface FanoutViewProps {
  /** Base branch lanes fork from + merge into (= settings.baseBranch ?? 'main'). */
  readonly base: string;
  /** Called after a lane is successfully merged so the parent refreshes worktrees. */
  readonly onMerged: () => void;
}

const STATUS_COLOR: Record<FanoutLane['status'], string> = {
  queued: '#888',
  running: '#e0a030',
  done: '#3ba55d',
  failed: 'crimson',
};

/**
 * Global Fan-out panel. Idle: a prompt textarea + a model picker (checkboxes, 1..4)
 * + a skipPermissions toggle (off; warns it bypasses ALL permission checks) + Start.
 * Running: one card per lane (model + status). Click a done lane -> its DiffView +
 * "Use this lane" (FANOUT_SELECT). An Abort button tears the whole run down. Not a
 * per-worktree pane — it CREATES N worktrees, so it lives at the app top level.
 */
export function FanoutView({ base, onMerged }: FanoutViewProps): React.JSX.Element {
  const { run, busy, error, start, select, abort } = useFanout();
  const [prompt, setPrompt] = useState('');
  const [models, setModels] = useState<string[]>(['opus', 'haiku']);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [selectedLaneId, setSelectedLaneId] = useState<string | null>(null);
  const [selectResult, setSelectResult] = useState<MergeResult | null>(null);

  const toggleModel = (m: string): void => {
    setModels((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m);
      if (prev.length >= 4) return prev; // cap at 4 (manager also enforces)
      return [...prev, m];
    });
  };

  const onStart = async (): Promise<void> => {
    setSelectResult(null);
    setSelectedLaneId(null);
    await start({ prompt, models, skipPermissions });
  };

  const onUseLane = async (laneId: string): Promise<void> => {
    const result = await select(laneId);
    setSelectResult(result);
    if (result.status === 'merged') {
      setSelectedLaneId(null);
      onMerged();
    }
  };

  const canStart = prompt.trim().length > 0 && models.length >= 1 && models.length <= 4 && !busy;
  const selectedLane = run?.lanes.find((l) => l.laneId === selectedLaneId) ?? null;

  return (
    <section
      data-testid="fanout-view"
      style={{ border: '1px solid #333', borderRadius: 8, padding: 16, marginTop: 12 }}
    >
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Multimodel Fan-out</h2>
      {error && <pre style={{ color: 'crimson', fontSize: 13 }}>error: {error}</pre>}

      {!run ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            data-testid="fanout-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="One prompt, sent to every selected model in its own worktree…"
            rows={4}
            style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#aaa' }}>Models (1–4):</span>
            {PRESET_MODELS.map((m) => (
              <label
                key={m}
                style={{ fontSize: 13, display: 'flex', gap: 4, alignItems: 'center' }}
              >
                <input
                  type="checkbox"
                  data-testid={`fanout-model-${m}`}
                  checked={models.includes(m)}
                  onChange={() => toggleModel(m)}
                />
                {m}
              </label>
            ))}
          </div>
          <label
            style={{
              fontSize: 13,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              color: skipPermissions ? 'crimson' : '#aaa',
            }}
          >
            <input
              type="checkbox"
              data-testid="fanout-skip-permissions"
              checked={skipPermissions}
              onChange={(e) => setSkipPermissions(e.target.checked)}
            />
            Skip permissions (--dangerously-skip-permissions) — bypasses ALL permission checks,
            incl. bash. Use only for bash-heavy tasks you trust.
          </label>
          <button
            type="button"
            data-testid="fanout-start"
            disabled={!canStart}
            onClick={() => void onStart()}
          >
            Start fan-out
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ fontSize: 12, color: '#888' }}>
              run {run.id} · base {run.base}
            </code>
            <button
              type="button"
              data-testid="fanout-abort"
              onClick={() => void abort()}
              disabled={busy}
            >
              Abort
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.lanes.map((lane) => (
              <button
                key={lane.laneId}
                type="button"
                data-testid={`fanout-lane-${lane.laneId}`}
                disabled={lane.status !== 'done'}
                onClick={() => setSelectedLaneId(lane.laneId)}
                style={{
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: `1px solid ${selectedLaneId === lane.laneId ? '#094771' : '#333'}`,
                  borderRadius: 6,
                  background: selectedLaneId === lane.laneId ? '#0b2a3f' : 'transparent',
                  color: '#ddd',
                  cursor: lane.status === 'done' ? 'pointer' : 'default',
                  minWidth: 160,
                }}
              >
                <div style={{ fontWeight: 600 }}>{lane.model}</div>
                <div style={{ fontSize: 12, color: STATUS_COLOR[lane.status] }}>{lane.status}</div>
                {lane.error && <div style={{ fontSize: 11, color: 'crimson' }}>{lane.error}</div>}
              </button>
            ))}
          </div>

          {selectResult && selectResult.status !== 'merged' && (
            <pre style={{ color: '#e0a030', fontSize: 12 }}>
              {selectResult.status === 'conflict'
                ? `merge conflict: ${(selectResult.conflicted ?? []).join(', ')}`
                : `merge failed: ${selectResult.error ?? 'unknown'}`}
            </pre>
          )}

          {selectedLane && selectedLane.status === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Suspense fallback={<p style={{ fontSize: 13, color: '#888' }}>Loading diff…</p>}>
                <DiffView
                  key={`fanout-diff-${selectedLane.laneId}`}
                  worktreeId={selectedLane.worktreeId}
                  base={base}
                />
              </Suspense>
              <button
                type="button"
                data-testid="fanout-use-lane"
                disabled={busy}
                onClick={() => void onUseLane(selectedLane.laneId)}
              >
                Use this lane ({selectedLane.model})
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

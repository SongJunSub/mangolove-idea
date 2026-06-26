import { lazy, Suspense, useState } from 'react';
import type { FanoutLane, MergeResult } from '../../../shared/types';
import { useFanout } from '../../hooks/use-fanout';
import { useI18n } from '../../i18n/i18n-context';
import { FANOUT_STATUS_KEY } from '../../i18n/status-keys';

// Reuse the existing Monaco diff view per-lane (a lane is a real worktree).
const DiffView = lazy(() => import('../diff/diff-view').then((m) => ({ default: m.DiffView })));

/** The preset model tiers the picker offers (max 4 selectable). */
const PRESET_MODELS = ['opus', 'sonnet', 'haiku'] as const;

export interface FanoutViewProps {
  /** Base branch lanes fork from + merge into (= settings.baseBranch ?? 'main'). */
  readonly base: string;
  /** App's resolved theme — forwarded to the lane DiffView (monaco theme is global). */
  readonly theme: 'dark' | 'light';
  /** Called after a lane is successfully merged so the parent refreshes worktrees. */
  readonly onMerged: () => void;
}

const STATUS_COLOR: Record<FanoutLane['status'], string> = {
  queued: 'var(--muted)',
  running: 'var(--warn)',
  done: 'var(--ok)',
  failed: 'var(--err)',
};

/**
 * Global Fan-out panel. Idle: a prompt textarea + a model picker (checkboxes, 1..4)
 * + a skipPermissions toggle (off; warns it bypasses ALL permission checks) + Start.
 * Running: one card per lane (model + status). Click a done lane -> its DiffView +
 * "Use this lane" (FANOUT_SELECT). An Abort button tears the whole run down. Not a
 * per-worktree pane — it CREATES N worktrees, so it lives at the app top level.
 */
export function FanoutView({ base, theme, onMerged }: FanoutViewProps): React.JSX.Element {
  const { t } = useI18n();
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
      <h2 style={{ marginTop: 0, fontSize: 16 }}>{t('fanout.title')}</h2>
      {error && (
        <pre style={{ color: 'var(--err)', fontSize: 13 }}>{t('worktree.error', { error })}</pre>
      )}

      {!run ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            data-testid="fanout-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('fanout.promptPlaceholder')}
            rows={4}
            style={{ width: '100%', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--faint)' }}>{t('fanout.modelsLabel')}</span>
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
              color: skipPermissions ? 'var(--err)' : 'var(--faint)',
            }}
          >
            <input
              type="checkbox"
              data-testid="fanout-skip-permissions"
              checked={skipPermissions}
              onChange={(e) => setSkipPermissions(e.target.checked)}
            />
            {t('fanout.skipPermissions')}
          </label>
          <button
            type="button"
            data-testid="fanout-start"
            disabled={!canStart}
            onClick={() => void onStart()}
          >
            {t('fanout.start')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{ fontSize: 12, color: 'var(--muted)' }}>
              {t('fanout.runLine', { id: run.id, base: run.base })}
            </code>
            <button
              type="button"
              data-testid="fanout-abort"
              onClick={() => void abort()}
              disabled={busy}
            >
              {t('fanout.abort')}
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
                  border: `1px solid ${selectedLaneId === lane.laneId ? 'var(--accent-soft)' : 'var(--text)'}`,
                  borderRadius: 6,
                  background: selectedLaneId === lane.laneId ? 'var(--accent-soft)' : 'transparent',
                  color: 'var(--text)',
                  cursor: lane.status === 'done' ? 'pointer' : 'default',
                  minWidth: 160,
                }}
              >
                <div style={{ fontWeight: 600 }}>{lane.model}</div>
                <div style={{ fontSize: 12, color: STATUS_COLOR[lane.status] }}>
                  {t(FANOUT_STATUS_KEY[lane.status])}
                </div>
                {lane.error && (
                  <div style={{ fontSize: 11, color: 'var(--err)' }}>{lane.error}</div>
                )}
              </button>
            ))}
          </div>

          {selectResult && selectResult.status !== 'merged' && (
            <pre style={{ color: 'var(--warn)', fontSize: 12 }}>
              {selectResult.status === 'conflict'
                ? t('fanout.mergeConflict', { files: (selectResult.conflicted ?? []).join(', ') })
                : t('fanout.mergeFailed', {
                    error: selectResult.error ?? t('fanout.unknownError'),
                  })}
            </pre>
          )}

          {selectedLane && selectedLane.status === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Suspense
                fallback={
                  <p style={{ fontSize: 13, color: 'var(--muted)' }}>{t('app.loadingDiff')}</p>
                }
              >
                <DiffView
                  key={`fanout-diff-${selectedLane.laneId}`}
                  worktreeId={selectedLane.worktreeId}
                  base={base}
                  theme={theme}
                />
              </Suspense>
              <button
                type="button"
                data-testid="fanout-use-lane"
                disabled={busy}
                onClick={() => void onUseLane(selectedLane.laneId)}
              >
                {t('fanout.useLane', { model: selectedLane.model })}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

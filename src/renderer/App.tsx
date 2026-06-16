import { useCallback, useState } from 'react';
import type { AppInfo } from '../shared/types';
import { formatVersions } from './lib/format-versions';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onPing = useCallback(async () => {
    setError(null);
    try {
      const result = await window.mango.app.ping();
      setInfo(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>MangoLove IDEA</h1>
      <p>Plan 0 spine: typed IPC round-trip + node-pty ABI probe.</p>
      <button type="button" onClick={onPing}>
        Ping main
      </button>
      {error && <pre style={{ color: 'crimson' }}>error: {error}</pre>}
      {info && (
        <pre data-testid="ping-result" style={{ marginTop: 16 }}>
          {formatVersions(info)}
        </pre>
      )}
    </main>
  );
}

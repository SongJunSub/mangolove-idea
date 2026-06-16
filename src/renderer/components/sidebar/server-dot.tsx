import type { ServerState } from '../../../shared/types';

const SERVER_COLOR: Record<ServerState, string> = {
  stopped: '#bbb',
  starting: '#d8a657',
  running: '#1f6feb',
  stopping: '#d8a657',
  crashed: '#cf222e',
};

export interface ServerDotProps {
  readonly state: ServerState;
}

/** Small colored dot showing this worktree's server state in the sidebar. */
export function ServerDot({ state }: ServerDotProps): React.JSX.Element {
  return (
    <span
      aria-label={`server ${state}`}
      title={`server ${state}`}
      style={{
        width: 8,
        height: 8,
        borderRadius: 2,
        background: SERVER_COLOR[state],
        flex: '0 0 auto',
      }}
    />
  );
}

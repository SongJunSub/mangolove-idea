import { useCallback, useEffect, useState } from 'react';
import type {
  AgentSession,
  SessionInputRequest,
  SessionResizeRequest,
} from '../../shared/types';

/** Return shape of the per-worktree session hook. */
export interface UseSession {
  readonly status: AgentSession['status'];
  readonly session: AgentSession | null;
  spawn(cols: number, rows: number, continueSession?: boolean): Promise<AgentSession>;
  kill(): Promise<void>;
  sendInput(data: string): void;
  resize(cols: number, rows: number): void;
}

/**
 * Drives the agent session for ONE worktree over window.mango.session.
 * Subscribes to onStatus/onExit (filtered by worktreeId) to keep `status` live.
 * The component (AgentTerminal) owns spawn/dispose timing; this hook is the glue.
 */
export function useSession(worktreeId: string): UseSession {
  const [session, setSession] = useState<AgentSession | null>(null);

  useEffect(() => {
    const offStatus = window.mango.session.onStatus((s) => {
      if (s.worktreeId !== worktreeId) return;
      setSession(s);
    });
    const offExit = window.mango.session.onExit((e) => {
      if (e.worktreeId !== worktreeId) return;
      setSession((prev) => (prev ? { ...prev, status: 'exited', pid: undefined } : prev));
    });
    return () => {
      offStatus();
      offExit();
    };
  }, [worktreeId]);

  const spawn = useCallback(
    (cols: number, rows: number, continueSession = false): Promise<AgentSession> =>
      window.mango.session.spawn({ worktreeId, continueSession, cols, rows }),
    [worktreeId],
  );

  const kill = useCallback(async (): Promise<void> => {
    await window.mango.session.kill(worktreeId);
  }, [worktreeId]);

  const sendInput = useCallback(
    (data: string): void => {
      const req: SessionInputRequest = { worktreeId, data };
      window.mango.session.sendInput(req);
    },
    [worktreeId],
  );

  const resize = useCallback(
    (cols: number, rows: number): void => {
      const req: SessionResizeRequest = { worktreeId, cols, rows };
      window.mango.session.resize(req);
    },
    [worktreeId],
  );

  return {
    status: session?.status ?? 'idle',
    session,
    spawn,
    kill,
    sendInput,
    resize,
  };
}

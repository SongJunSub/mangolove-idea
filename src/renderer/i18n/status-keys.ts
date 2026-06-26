import type { AgentStatus, GhBucket, ServerState } from '../../shared/types';
import type { MessageKey } from './messages';

/** Localized label key for each agent status (type-safe dynamic lookup, shared by the row + dot). */
export const AGENT_STATUS_KEY: Record<AgentStatus, MessageKey> = {
  idle: 'status.agent.idle',
  starting: 'status.agent.starting',
  running: 'status.agent.running',
  exited: 'status.agent.exited',
  error: 'status.agent.error',
};

/** Localized label key for each server state (shared by ServerControls + ServerDot). */
export const SERVER_STATE_KEY: Record<ServerState, MessageKey> = {
  stopped: 'status.server.stopped',
  starting: 'status.server.starting',
  running: 'status.server.running',
  stopping: 'status.server.stopping',
  crashed: 'status.server.crashed',
};

/** Localized label key for each CI check bucket (the per-check status glyph tooltip). */
export const GH_BUCKET_KEY: Record<GhBucket, MessageKey> = {
  pass: 'gh.bucket.pass',
  fail: 'gh.bucket.fail',
  pending: 'gh.bucket.pending',
  skipping: 'gh.bucket.skipping',
  cancel: 'gh.bucket.cancel',
};

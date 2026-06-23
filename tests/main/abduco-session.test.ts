import { describe, it, expect } from 'vitest';
import { sessionNameFor, isMangoSession } from '../../src/main/pty/abduco-session';

describe('abduco sessionNameFor', () => {
  it('is deterministic for the same worktree path', () => {
    const p = '/Users/x/repo/.worktrees/feat';
    expect(sessionNameFor(p)).toBe(sessionNameFor(p));
  });

  it('produces distinct names for distinct paths', () => {
    expect(sessionNameFor('/repo/a')).not.toBe(sessionNameFor('/repo/b'));
  });

  it('emits ONLY a safe charset (no path/shell metachars reach abduco)', () => {
    // A hostile path with spaces, dot-dot, semicolons, slashes must hash away.
    const hostile = '/repo/../etc; rm -rf ~/.worktrees/a b';
    expect(sessionNameFor(hostile)).toMatch(/^mango-[a-f0-9]{16}$/);
  });

  it('namespaces names with the mango- prefix so reap can scope to our sessions', () => {
    expect(sessionNameFor('/repo/a').startsWith('mango-')).toBe(true);
    expect(isMangoSession(sessionNameFor('/repo/a'))).toBe(true);
    expect(isMangoSession('someoneelse-session')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  classifyGhStatus,
  summarizeChecks,
  GH_MISSING_SENTINEL,
} from '../../src/main/git/gh-status-reader';
import type { GhCheckItem, GhStatus } from '../../src/shared/types';

function kind(s: GhStatus): GhStatus['kind'] {
  return s.kind;
}

describe('classifyGhStatus (pure, table-driven, no spawning)', () => {
  it('maps the gh-missing sentinel (spawn ENOENT) to gh-missing', () => {
    expect(kind(classifyGhStatus(GH_MISSING_SENTINEL, '', ''))).toBe('gh-missing');
  });

  it('maps exit 4 to not-authed', () => {
    expect(kind(classifyGhStatus(4, '', 'gh auth login required'))).toBe('not-authed');
  });

  it('maps the not-logged-in stderr to not-authed regardless of code', () => {
    expect(
      kind(classifyGhStatus(1, '', 'You are not logged into any GitHub hosts. To get started')),
    ).toBe('not-authed');
  });

  it('maps no-git-remotes / not-a-github-repo / no-github-host to no-remote', () => {
    expect(kind(classifyGhStatus(1, '', 'no git remotes found'))).toBe('no-remote');
    expect(
      kind(classifyGhStatus(1, '', 'none of the git remotes ... point to a known GitHub host')),
    ).toBe('no-remote');
    expect(kind(classifyGhStatus(1, '', 'not a github repository'))).toBe('no-remote');
  });

  it('maps the no-PR stderr (exit 1) to no-pr', () => {
    expect(kind(classifyGhStatus(1, '', 'no pull requests found for branch "feature/login"'))).toBe(
      'no-pr',
    );
  });

  it('maps rate limit / HTTP 403 to rate-limited', () => {
    expect(kind(classifyGhStatus(1, '', 'API rate limit exceeded'))).toBe('rate-limited');
    expect(kind(classifyGhStatus(1, '', 'HTTP 403: rate limit'))).toBe('rate-limited');
  });

  it('falls through to error with a trimmed friendly message', () => {
    const s = classifyGhStatus(1, '', '  fatal: something unexpected happened  \n');
    expect(s.kind).toBe('error');
    if (s.kind === 'error') expect(s.message).toBe('something unexpected happened');
  });
});

describe('summarizeChecks (pure, switches on bucket only)', () => {
  /** A full check row (name/link carried through for the expandable panel). */
  const row = (bucket: GhCheckItem['bucket'], name: string = bucket): GhCheckItem => ({
    name,
    bucket,
    link: `https://x/${name}`,
  });

  it('returns none + empty checks for zero checks', () => {
    expect(summarizeChecks([])).toEqual({
      summary: 'none',
      counts: { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 },
      checks: [],
    });
  });

  it('any fail bucket => failing (precedence over pending/pass)', () => {
    const out = summarizeChecks([row('pass'), row('fail'), row('pending')]);
    expect(out.summary).toBe('failing');
    expect(out.counts).toEqual({ pass: 1, fail: 1, pending: 1, skipping: 0, cancel: 0 });
  });

  it('a cancel bucket counts as failing-precedence', () => {
    expect(summarizeChecks([row('pass'), row('cancel')]).summary).toBe('failing');
  });

  it('pending (no fails) => pending', () => {
    expect(summarizeChecks([row('pass'), row('pending')]).summary).toBe('pending');
  });

  it('all pass/skipping => passing', () => {
    expect(summarizeChecks([row('pass'), row('skipping')]).summary).toBe('passing');
  });

  it('ignores unknown bucket values defensively', () => {
    expect(summarizeChecks([row('pass'), row('weird' as never)]).summary).toBe('passing');
  });

  it('carries the per-check rows (name/bucket/link) for the expandable panel', () => {
    const out = summarizeChecks([row('pass', 'build'), row('fail', 'lint')]);
    expect(out.checks).toEqual([
      { name: 'build', bucket: 'pass', link: 'https://x/build' },
      { name: 'lint', bucket: 'fail', link: 'https://x/lint' },
    ]);
  });
});

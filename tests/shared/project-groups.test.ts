import { describe, it, expect } from 'vitest';
import { coerceProjectGroups, coerceProjectTreeExpanded } from '../../src/shared/project-groups';

describe('coerceProjectGroups', () => {
  it('returns undefined for non-arrays and empty input (treated as unset)', () => {
    expect(coerceProjectGroups(undefined)).toBeUndefined();
    expect(coerceProjectGroups(null)).toBeUndefined();
    expect(coerceProjectGroups('nope')).toBeUndefined();
    expect(coerceProjectGroups({})).toBeUndefined();
    expect(coerceProjectGroups([])).toBeUndefined();
  });

  it('keeps well-formed groups and drops entries missing id or name', () => {
    const out = coerceProjectGroups([
      { id: 'g1', name: 'CRS', repoPaths: ['/a', '/b'] },
      { id: '', name: 'blank-id', repoPaths: [] }, // dropped
      { id: 'g3', name: '', repoPaths: [] }, // blank name dropped
      { id: 'g4', name: 'ok', repoPaths: [] }, // empty group KEPT
      42, // non-object dropped
    ]);
    expect(out).toEqual([
      { id: 'g1', name: 'CRS', repoPaths: ['/a', '/b'] },
      { id: 'g4', name: 'ok', repoPaths: [] },
    ]);
  });

  it('trims group names and drops whitespace-only ones (main enforces, not just the client)', () => {
    expect(
      coerceProjectGroups([
        { id: 'g1', name: '  CRS  ', repoPaths: [] },
        { id: 'g2', name: '   ', repoPaths: [] }, // whitespace-only -> dropped
      ]),
    ).toEqual([{ id: 'g1', name: 'CRS', repoPaths: [] }]);
  });

  it('collapses duplicate group ids to the first occurrence', () => {
    const out = coerceProjectGroups([
      { id: 'dup', name: 'first', repoPaths: ['/a'] },
      { id: 'dup', name: 'second', repoPaths: ['/b'] },
    ]);
    expect(out).toEqual([{ id: 'dup', name: 'first', repoPaths: ['/a'] }]);
  });

  it('dedupes repoPaths within a group and drops non-string paths', () => {
    const out = coerceProjectGroups([{ id: 'g', name: 'g', repoPaths: ['/a', '/a', '', 7, '/b'] }]);
    expect(out).toEqual([{ id: 'g', name: 'g', repoPaths: ['/a', '/b'] }]);
  });

  it('enforces 1-repo-1-group: a repo in two groups stays only in the FIRST', () => {
    const out = coerceProjectGroups([
      { id: 'g1', name: 'one', repoPaths: ['/shared', '/only1'] },
      { id: 'g2', name: 'two', repoPaths: ['/shared', '/only2'] },
    ]);
    expect(out).toEqual([
      { id: 'g1', name: 'one', repoPaths: ['/shared', '/only1'] },
      { id: 'g2', name: 'two', repoPaths: ['/only2'] }, // /shared removed
    ]);
  });
});

describe('coerceProjectTreeExpanded', () => {
  it('returns undefined for non-objects and all-empty input', () => {
    expect(coerceProjectTreeExpanded(null)).toBeUndefined();
    expect(coerceProjectTreeExpanded('x')).toBeUndefined();
    expect(coerceProjectTreeExpanded({})).toBeUndefined();
    expect(coerceProjectTreeExpanded({ groups: [], repos: [] })).toBeUndefined();
    expect(coerceProjectTreeExpanded({ groups: ['', 3], repos: [null] })).toBeUndefined();
  });

  it('projects deduped non-empty id/path lists', () => {
    expect(
      coerceProjectTreeExpanded({ groups: ['g1', 'g1', 'g2', ''], repos: ['/a', '/a'] }),
    ).toEqual({ groups: ['g1', 'g2'], repos: ['/a'] });
  });

  it('tolerates a missing side (only groups, or only repos)', () => {
    expect(coerceProjectTreeExpanded({ groups: ['g1'] })).toEqual({ groups: ['g1'], repos: [] });
    expect(coerceProjectTreeExpanded({ repos: ['/a'] })).toEqual({ groups: [], repos: ['/a'] });
  });
});

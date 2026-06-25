import { describe, it, expect, vi } from 'vitest';
import {
  CodeNavService,
  type CodeNavDeps,
  type RawLocation,
} from '../../src/main/codenav/code-nav-service';

const loc = (absPath: string): RawLocation => ({
  absPath,
  startLine: 1,
  startCharacter: 2,
  endLine: 1,
  endCharacter: 8,
});

function makeService(
  over: Partial<CodeNavDeps> = {},
  opts: { missing?: Set<string>; real?: Record<string, string> } = {},
) {
  const { missing = new Set(), real = {} } = opts;
  const deps: CodeNavDeps = {
    knownWorktreeIds: async () => new Set(['/repo/wt']),
    realpathSync: (p) => {
      if (missing.has(p)) throw new Error(`ENOENT ${p}`);
      return real[p] ?? p;
    },
    resolveServer: (lang) => (lang === 'java' ? '/opt/homebrew/bin/jdtls' : null),
    reasonFor: (lang) => `${lang}-ls not found`,
    query: async () => [],
    ...over,
  };
  return new CodeNavService(deps);
}

describe('CodeNavService.capabilities', () => {
  it('reports per-language availability from resolveServer (+ a reason when absent)', async () => {
    const svc = makeService(); // java present, kotlin null
    const caps = await svc.capabilities('/repo/wt');
    expect(caps.java).toEqual({ available: true });
    expect(caps.kotlin).toEqual({ available: false, reason: 'kotlin-ls not found' });
  });
});

describe('CodeNavService confinement (security boundary)', () => {
  it('DROPS every location that escapes the worktree, KEEPS in-tree, returns worktree-relative paths', async () => {
    const query = vi.fn(async () => [
      loc('/repo/wt/src/Other.java'), // in-tree -> KEEP
      loc('/usr/lib/jdk/String.java'), // absolute outside -> DROP
      loc('/repo/wt/link.java'), // symlink that realpaths outside -> DROP
      loc('/repo/wt/gone.java'), // unresolvable (realpath throws) -> DROP
    ]);
    const svc = makeService(
      { query },
      { real: { '/repo/wt/link.java': '/etc/passwd' }, missing: new Set(['/repo/wt/gone.java']) },
    );
    const res = await svc.definition({
      worktreeId: '/repo/wt',
      relPath: 'src/Main.java',
      line: 4,
      character: 6,
    });
    expect(res.locations).toEqual([
      { relPath: 'src/Other.java', startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 8 },
    ]);
    expect(query).toHaveBeenCalledWith('definition', '/repo/wt', 'java', {
      absPath: '/repo/wt/src/Main.java', // the CONFINED canonical path of the active file
      line: 4,
      character: 6,
      includeDeclaration: false,
    });
  });

  it('references passes includeDeclaration through and confines the same way', async () => {
    const query = vi.fn(async () => [loc('/repo/wt/A.java'), loc('/outside/B.java')]);
    const svc = makeService({ query });
    const res = await svc.references({
      worktreeId: '/repo/wt',
      relPath: 'A.java',
      line: 0,
      character: 0,
      includeDeclaration: true,
    });
    expect(res.locations.map((l) => l.relPath)).toEqual(['A.java']);
    expect(query).toHaveBeenCalledWith('references', '/repo/wt', 'java', {
      absPath: '/repo/wt/A.java',
      line: 0,
      character: 0,
      includeDeclaration: true,
    });
  });
});

describe('CodeNavService gating / degradation', () => {
  it('returns [] for TS/JS and unknown extensions WITHOUT querying (never hits LSP)', async () => {
    const query = vi.fn(async () => [loc('/repo/wt/x')]);
    const svc = makeService({ query });
    expect(
      (await svc.definition({ worktreeId: '/repo/wt', relPath: 'a.ts', line: 0, character: 0 }))
        .locations,
    ).toEqual([]);
    expect(
      (
        await svc.definition({
          worktreeId: '/repo/wt',
          relPath: 'README.md',
          line: 0,
          character: 0,
        })
      ).locations,
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns [] when the server is absent for that language (no query)', async () => {
    const query = vi.fn(async () => [loc('/repo/wt/A.kt')]);
    const svc = makeService({ query }); // kotlin server null
    expect(
      (await svc.definition({ worktreeId: '/repo/wt', relPath: 'A.kt', line: 0, character: 0 }))
        .locations,
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('degrades to [] when the query throws (server crash/timeout)', async () => {
    const svc = makeService({
      query: async () => {
        throw new Error('server died');
      },
    });
    expect(
      (await svc.definition({ worktreeId: '/repo/wt', relPath: 'A.java', line: 0, character: 0 }))
        .locations,
    ).toEqual([]);
  });

  it('returns [] for an unknown worktree id (defense in depth)', async () => {
    const query = vi.fn(async () => [loc('/etc/A.java')]);
    const svc = makeService({ query });
    expect(
      (await svc.definition({ worktreeId: '/etc', relPath: 'A.java', line: 0, character: 0 }))
        .locations,
    ).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { LspManager, launchArgsFor, type LspManagerDeps } from '../../src/main/lsp/lsp-manager';
import { encodeMessage, JsonRpcReader } from '../../src/main/lsp/jsonrpc-framer';
import type { IRpcProc } from '../../src/main/proc/process-runner';

/** A fake LSP child that auto-replies to requests by method, captures writes + kills. */
class FakeProc implements IRpcProc {
  pid: number | undefined = 4321;
  readonly kills: (NodeJS.Signals | undefined)[] = [];
  private readonly reader = new JsonRpcReader();
  private stdoutCb: ((b: Buffer) => void) | undefined;
  constructor(
    private readonly replies: Record<string, unknown>,
    /** Methods this fake answers with an LSP error (to simulate a failed handshake). */
    private readonly errorMethods: readonly string[] = [],
  ) {}
  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal);
  }
  write(data: Buffer): void {
    for (const msg of this.reader.append(data)) {
      const m = msg as { id?: number; method?: string };
      if (typeof m.id !== 'number' || !m.method) continue;
      const id = m.id;
      if (this.errorMethods.includes(m.method)) {
        queueMicrotask(() =>
          this.stdoutCb?.(
            encodeMessage({ jsonrpc: '2.0', id, error: { code: -32603, message: 'boom' } }),
          ),
        );
      } else if (m.method in this.replies) {
        const result = this.replies[m.method];
        queueMicrotask(() => this.stdoutCb?.(encodeMessage({ jsonrpc: '2.0', id, result })));
      }
    }
  }
  onStdout(cb: (chunk: Buffer) => void): void {
    this.stdoutCb = cb;
  }
  onStderr(): void {}
  onExit(): void {}
  onError(): void {}
}

function makeManager(replies: Record<string, unknown>, over: Partial<LspManagerDeps> = {}) {
  const procs: FakeProc[] = [];
  const spawnRpc = vi.fn((): IRpcProc => {
    const p = new FakeProc(replies);
    procs.push(p);
    return p;
  });
  const deps: LspManagerDeps = {
    spawnRpc,
    resolveServer: (lang) => (lang === 'java' ? '/opt/homebrew/bin/jdtls' : null),
    readFileText: () => 'class X {}',
    dataDir: () => '/tmp/jdtls-data',
    ...over,
  };
  return { mgr: new LspManager(deps), procs, spawnRpc };
}

const defLoc = {
  uri: 'file:///repo/wt/src/Other.java',
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
};

describe('LspManager', () => {
  it('spawns ONCE per (worktree,lang), handshakes, and resolves a definition to an absolute path', async () => {
    const { mgr, spawnRpc } = makeManager({
      initialize: { capabilities: {} },
      'textDocument/definition': [defLoc],
    });
    const q = {
      absPath: '/repo/wt/src/Main.java',
      line: 4,
      character: 6,
      includeDeclaration: false,
    };
    const r1 = await mgr.query('definition', '/repo/wt', 'java', q);
    expect(r1).toEqual([
      {
        absPath: '/repo/wt/src/Other.java',
        startLine: 1,
        startCharacter: 2,
        endLine: 1,
        endCharacter: 8,
      },
    ]);
    // a second query reuses the same server child
    await mgr.query('definition', '/repo/wt', 'java', q);
    expect(spawnRpc).toHaveBeenCalledTimes(1);
  });

  it('drops non-file (jdt://) targets and accepts the LocationLink shape', async () => {
    const { mgr } = makeManager({
      initialize: { capabilities: {} },
      'textDocument/definition': [
        { uri: 'jdt://contents/java.base/java.lang/String.class', range: defLoc.range }, // DROP
        { targetUri: 'file:///repo/wt/src/Link.java', targetRange: defLoc.range }, // LocationLink -> KEEP
      ],
    });
    const r = await mgr.query('definition', '/repo/wt', 'java', {
      absPath: '/repo/wt/src/Main.java',
      line: 0,
      character: 0,
      includeDeclaration: false,
    });
    expect(r.map((x) => x.absPath)).toEqual(['/repo/wt/src/Link.java']);
  });

  it('returns [] when the server for that language is absent (no spawn)', async () => {
    const { mgr, spawnRpc } = makeManager({});
    const r = await mgr.query('definition', '/repo/wt', 'kotlin', {
      absPath: '/repo/wt/A.kt',
      line: 0,
      character: 0,
      includeDeclaration: false,
    });
    expect(r).toEqual([]);
    expect(spawnRpc).not.toHaveBeenCalled();
  });

  it('dispose kills the EXACT child (SIGTERM), never a broad pattern', async () => {
    const { mgr, procs } = makeManager({
      initialize: { capabilities: {} },
      'textDocument/definition': [],
    });
    await mgr.query('definition', '/repo/wt', 'java', {
      absPath: '/repo/wt/A.java',
      line: 0,
      character: 0,
      includeDeclaration: false,
    });
    expect(procs).toHaveLength(1);
    mgr.dispose();
    expect(procs[0].kills).toContain('SIGTERM');
  });

  it('a FAILED initialize disposes the server so the NEXT query respawns (no permanent poison)', async () => {
    const good = { initialize: { capabilities: {} }, 'textDocument/definition': [defLoc] };
    const procs: FakeProc[] = [];
    let call = 0;
    const spawnRpc = vi.fn((): IRpcProc => {
      // 1st server FAILS 'initialize' (cold-boot failure); later servers answer everything.
      const p = call++ === 0 ? new FakeProc({}, ['initialize']) : new FakeProc(good);
      procs.push(p);
      return p;
    });
    const mgr = new LspManager({
      spawnRpc,
      resolveServer: (l) => (l === 'java' ? '/opt/homebrew/bin/jdtls' : null),
      readFileText: () => 'class X {}',
      dataDir: () => '/tmp/jdtls-data',
    });
    const q = {
      absPath: '/repo/wt/src/Main.java',
      line: 4,
      character: 6,
      includeDeclaration: false,
    };

    await expect(mgr.query('definition', '/repo/wt', 'java', q)).rejects.toThrow();
    expect(procs[0].kills).toContain('SIGTERM'); // the poisoned server was torn down
    expect(spawnRpc).toHaveBeenCalledTimes(1);

    // The NEXT query must spawn a FRESH server and succeed — not replay the cached rejection.
    const r2 = await mgr.query('definition', '/repo/wt', 'java', q);
    expect(spawnRpc).toHaveBeenCalledTimes(2);
    expect(r2).toEqual([
      {
        absPath: '/repo/wt/src/Other.java',
        startLine: 1,
        startCharacter: 2,
        endLine: 1,
        endCharacter: 8,
      },
    ]);
  });

  it('launchArgsFor: jdtls -data dir; kotlin-lsp --stdio; kotlin-language-server none', () => {
    expect(launchArgsFor('java', '/d', '/opt/homebrew/bin/jdtls')).toEqual(['-data', '/d']);
    expect(launchArgsFor('kotlin', '/d', '/opt/homebrew/bin/kotlin-lsp')).toEqual(['--stdio']);
    expect(launchArgsFor('kotlin', '/d', '/opt/homebrew/bin/kotlin-language-server')).toEqual([]);
  });
});

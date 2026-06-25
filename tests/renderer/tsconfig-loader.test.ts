import { describe, it, expect, beforeEach } from 'vitest';
import type { FileReadResult } from '../../src/shared/types';
import { loadTsconfigNav } from '../../src/renderer/lib/code-nav/tsconfig-loader';

// Virtual worktree FS behind window.mango.file.read. A relPath not present REJECTS, mirroring
// FILE_READ's behavior for a missing / out-of-scope path (the loader catches -> treats absent).
let fs: Map<string, { content: string; readOnly?: boolean }>;
let reads: string[];

function install(): void {
  Object.defineProperty(window, 'mango', {
    configurable: true,
    value: {
      file: {
        read: async (req: { worktreeId: string; relPath: string }): Promise<FileReadResult> => {
          reads.push(req.relPath);
          const f = fs.get(req.relPath);
          if (!f) throw new Error('failed to read file');
          return {
            content: f.content,
            readOnly: f.readOnly ?? false,
            size: f.content.length,
            baseToken: 't',
          };
        },
      },
    },
  });
}

beforeEach(() => {
  fs = new Map();
  reads = [];
  install();
});

describe('loadTsconfigNav', () => {
  it('returns baseDir + paths from a single root tsconfig (baseUrl ".")', async () => {
    fs.set('tsconfig.json', {
      content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '@/*': ['src/*'] } });
  });

  it('folds a non-root tsconfig baseUrl ("src") into baseDir', async () => {
    fs.set('tsconfig.json', {
      content: JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '@/*': ['*'] } } }),
    });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: 'src', paths: { '@/*': ['*'] } });
  });

  it('uses the config dir as base when paths are declared without baseUrl (TS >= 5)', async () => {
    fs.set('tsconfig.json', {
      content: JSON.stringify({ compilerOptions: { paths: { '#lib/*': ['lib/*'] } } }),
    });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '#lib/*': ['lib/*'] } });
  });

  it('follows a relative extends and inherits the parent baseUrl/paths', async () => {
    fs.set('tsconfig.json', { content: JSON.stringify({ extends: './tsconfig.base.json' }) });
    fs.set('tsconfig.base.json', {
      content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '@/*': ['src/*'] } });
    expect(reads).toContain('tsconfig.base.json');
  });

  it('child paths REPLACE (not merge) the parent paths', async () => {
    fs.set('tsconfig.json', {
      content: JSON.stringify({
        extends: './base.json',
        compilerOptions: { paths: { '@/*': ['app/*'] } },
      }),
    });
    fs.set('base.json', {
      content: JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '#x': ['x'] } },
      }),
    });
    // Child's paths win entirely; '#x' from the parent is gone. baseUrl inherited from parent.
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '@/*': ['app/*'] } });
  });

  it('strips JSONC comments + trailing commas in the tsconfig', async () => {
    fs.set('tsconfig.json', {
      content: `{
        // project config
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, },
      }`,
    });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '@/*': ['src/*'] } });
  });

  it('never reads (and ignores) an extends that escapes the worktree root', async () => {
    fs.set('tsconfig.json', {
      content: JSON.stringify({
        extends: '../../../etc/evil',
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
    });
    const nav = await loadTsconfigNav('/wt');
    expect(nav).toEqual({ baseDir: '', paths: { '@/*': ['src/*'] } }); // own options still apply
    expect(reads).toEqual(['tsconfig.json']); // the escaping extends was never read
  });

  it('ignores a bare/package extends (v1 does not resolve node_modules configs)', async () => {
    fs.set('tsconfig.json', {
      content: JSON.stringify({
        extends: '@tsconfig/node18/tsconfig.json',
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
    });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '@/*': ['src/*'] } });
    expect(reads).toEqual(['tsconfig.json']);
  });

  it('fails closed (empty nav) when there is no tsconfig', async () => {
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: {} });
  });

  it('fails closed on malformed JSON', async () => {
    fs.set('tsconfig.json', { content: '{ this is not json' });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: {} });
  });

  it('treats a readOnly (binary/too-large) tsconfig as absent', async () => {
    fs.set('tsconfig.json', { content: 'whatever', readOnly: true });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: {} });
  });

  it('terminates on an extends cycle and applies what it can', async () => {
    fs.set('tsconfig.json', {
      content: JSON.stringify({
        extends: './a.json',
        compilerOptions: { paths: { '@/*': ['src/*'] } },
      }),
    });
    fs.set('a.json', { content: JSON.stringify({ extends: './tsconfig.json' }) });
    // Must not hang; the root's own paths still apply.
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '@/*': ['src/*'] } });
  });

  it('reads each config once across a diamond extends graph (no W^depth amplification)', async () => {
    // root extends [a, b]; both a and b extend the SAME shared.json that defines the aliases.
    fs.set('tsconfig.json', { content: JSON.stringify({ extends: ['./a.json', './b.json'] }) });
    fs.set('a.json', { content: JSON.stringify({ extends: './shared.json' }) });
    fs.set('b.json', { content: JSON.stringify({ extends: './shared.json' }) });
    fs.set('shared.json', {
      content: JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    });
    expect(await loadTsconfigNav('/wt')).toEqual({ baseDir: '', paths: { '@/*': ['src/*'] } });
    // shared.json read EXACTLY once despite two inheritance paths — the shared visited set
    // prevents the diamond from re-descending (no exponential FILE_READ amplification).
    expect(reads.filter((r) => r === 'shared.json').length).toBe(1);
  });
});

import { pathToFileURL, fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { encodeMessage, JsonRpcReader } from './jsonrpc-framer';
import type { NavServerLanguage } from './lsp-detect';
import type { IRpcProc } from '../proc/process-runner';
import type { RawLocation, LspQueryInner } from '../codenav/code-nav-service';

/**
 * Spawns + speaks LSP to ONE jdtls / kotlin-language-server per (worktreeId, language),
 * over a hand-rolled Content-Length JSON-RPC framer. Lazily created on first query, killed
 * on idle-TTL or dispose. Returns ABSOLUTE-path locations (dropping non-file:// targets);
 * the CodeNavService confines them to the worktree. NEVER runs in CI/GUI-smoke here (no
 * toolchain on PATH -> the capability gate keeps this dormant); end-to-end Java/Kotlin nav
 * is a manual smoke gated on the dev installing the toolchain.
 */

const REQUEST_TIMEOUT_MS = 15000;
/**
 * `initialize` gets a MUCH longer budget than a normal request: a cold jdtls JVM + Equinox/OSGi
 * boot (and kotlin-language-server's classpath resolution) routinely exceeds 8s, and a timed-out
 * initialize used to reject-and-CACHE the handshake promise forever (poisoning every later query).
 */
const INIT_TIMEOUT_MS = 90 * 1000;
const IDLE_TTL_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 3000; // JVMs are slow; SIGTERM then SIGKILL after a grace

/** The launcher basename that identifies JetBrains' kotlin-lsp (needs an explicit stdio flag). */
const KOTLIN_LSP_BIN = 'kotlin-lsp';

/** Builds the launch argv for a language server given its resolved absolute path. */
export function launchArgsFor(
  lang: NavServerLanguage,
  dataDir: string,
  serverPath: string,
): string[] {
  // jdtls takes a per-workspace -data dir. For Kotlin there are two servers with DIFFERENT
  // launch contracts: JetBrains' kotlin-lsp speaks LSP over stdio only with `--stdio` (without
  // it, it opens a socket and our stdin/stdout pipe receives nothing), while the older
  // kotlin-language-server takes no args and reads the rootUri from the initialize handshake.
  if (lang === 'java') return ['-data', dataDir];
  return basename(serverPath) === KOTLIN_LSP_BIN ? ['--stdio'] : [];
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One live language-server child + its JSON-RPC state. */
class LspServer {
  private readonly reader = new JsonRpcReader();
  private readonly pending = new Map<number, Pending>();
  private readonly openDocs = new Set<string>();
  private nextId = 1;
  private initialized: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly proc: IRpcProc,
    private readonly rootPath: string,
    private readonly readFileText: (absPath: string) => string,
    private readonly languageId: string,
    private readonly onIdleDispose: () => void,
  ) {
    proc.onStdout((chunk) => {
      for (const msg of this.reader.append(chunk)) this.onMessage(msg);
    });
    proc.onExit(() => this.failAll(new Error('language server exited')));
    proc.onError((e) => this.failAll(e));
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { id?: number; result?: unknown; error?: unknown };
    if (typeof m.id === 'number' && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error('lsp error'));
      else p.resolve(m.result);
    }
    // Server-initiated requests/notifications (window/logMessage, etc.) are ignored.
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private send(method: string, params: unknown): void {
    this.proc.write(encodeMessage({ jsonrpc: '2.0', method, params }));
  }

  private request<T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    this.proc.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.doInitialize();
    return this.initialized;
  }

  private async doInitialize(): Promise<void> {
    const rootUri = pathToFileURL(this.rootPath).toString();
    try {
      await this.request(
        'initialize',
        {
          processId: process.pid,
          rootUri,
          capabilities: {},
          workspaceFolders: [{ uri: rootUri, name: 'worktree' }],
        },
        INIT_TIMEOUT_MS,
      );
    } catch (err) {
      // A failed/timed-out initialize must NOT poison this server forever (the rejected promise was
      // being cached, and touch() kept the idle-killer from ever respawning). Tear it down so the
      // NEXT query spawns a fresh server instead of replaying the cached rejection.
      this.onIdleDispose();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.send('initialized', {});
  }

  private ensureOpen(absPath: string): void {
    if (this.openDocs.has(absPath)) return;
    this.openDocs.add(absPath);
    let text: string;
    try {
      text = this.readFileText(absPath);
    } catch {
      return; // can't read -> skip didOpen; the query may still resolve via the index
    }
    this.send('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(absPath).toString(),
        languageId: this.languageId,
        version: 1,
        text,
      },
    });
  }

  /** Resets the idle-TTL; on expiry the manager disposes this server. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdleDispose(), IDLE_TTL_MS);
  }

  async query(
    kind: 'definition' | 'references',
    absPath: string,
    q: LspQueryInner,
  ): Promise<RawLocation[]> {
    this.touch();
    await this.ensureInitialized();
    this.ensureOpen(absPath);
    const position = { line: q.line, character: q.character };
    const textDocument = { uri: pathToFileURL(absPath).toString() };
    const result =
      kind === 'definition'
        ? await this.request<unknown>('textDocument/definition', { textDocument, position })
        : await this.request<unknown>('textDocument/references', {
            textDocument,
            position,
            context: { includeDeclaration: q.includeDeclaration },
          });
    return toRawLocations(result);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.failAll(new Error('disposed'));
    // Best-effort graceful shutdown, then EXACT-pid SIGTERM -> SIGKILL after a grace.
    try {
      this.send('shutdown', null);
      this.send('exit', null);
    } catch {
      // ignore — the kill below is the real teardown
    }
    this.proc.kill('SIGTERM');
    const pid = this.proc.pid;
    setTimeout(() => {
      // Re-kill the EXACT captured child (never a broad pattern) if still alive.
      if (pid !== undefined) {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, KILL_GRACE_MS);
  }
}

/** Converts an LSP definition/references result into absolute-path RawLocations. */
function toRawLocations(result: unknown): RawLocation[] {
  const arr = Array.isArray(result) ? result : result ? [result] : [];
  const out: RawLocation[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    // Location { uri, range } OR LocationLink { targetUri, targetRange }.
    const o = item as Record<string, unknown>;
    const uri = (o.uri ?? o.targetUri) as string | undefined;
    const range = (o.range ?? o.targetSelectionRange ?? o.targetRange) as
      | { start: { line: number; character: number }; end: { line: number; character: number } }
      | undefined;
    if (!uri || !range) continue;
    if (!uri.startsWith('file://')) continue; // drop jdt://, untitled:, decompiled, etc.
    let absPath: string;
    try {
      absPath = fileURLToPath(uri);
    } catch {
      continue;
    }
    out.push({
      absPath,
      startLine: range.start.line,
      startCharacter: range.start.character,
      endLine: range.end.line,
      endCharacter: range.end.character,
    });
  }
  return out;
}

export interface LspManagerDeps {
  /** Spawn a server child with a writable stdin + raw (Buffer) stdout (spawnArgsRpc). */
  spawnRpc(serverPath: string, args: readonly string[], cwd: string): IRpcProc;
  /** Resolve the absolute server path for a language, or null when absent. */
  resolveServer(lang: NavServerLanguage): string | null;
  /** Read a file's text for didOpen (the worktree's own file). */
  readFileText(absPath: string): string;
  /** Isolated jdtls -data dir per (worktreeId, language) under userData. */
  dataDir(worktreeId: string, lang: NavServerLanguage): string;
}

/** Owns one LspServer per (worktreeId, language); lazy-spawns, idle-kills, disposes all. */
export class LspManager {
  private readonly servers = new Map<string, LspServer>();

  constructor(private readonly deps: LspManagerDeps) {}

  private key(worktreeId: string, lang: NavServerLanguage): string {
    return `${worktreeId} ${lang}`;
  }

  /** The CodeNavService `query` seam. Returns [] on absence; rejects bubble to []-degrade. */
  async query(
    kind: 'definition' | 'references',
    worktreeId: string,
    lang: NavServerLanguage,
    q: LspQueryInner,
  ): Promise<RawLocation[]> {
    const serverPath = this.deps.resolveServer(lang);
    if (!serverPath) return [];
    const key = this.key(worktreeId, lang);
    let server = this.servers.get(key);
    if (!server) {
      const dataDir = this.deps.dataDir(worktreeId, lang);
      const proc = this.deps.spawnRpc(
        serverPath,
        launchArgsFor(lang, dataDir, serverPath),
        worktreeId,
      );
      server = new LspServer(proc, worktreeId, this.deps.readFileText, lang, () =>
        this.disposeServer(key),
      );
      this.servers.set(key, server);
    }
    // q.absPath is the CONFINED canonical path of the active file (CodeNavService already
    // realpath+isWithin-validated it) — read/open it directly, never re-join a raw relPath.
    return server.query(kind, q.absPath, q);
  }

  private disposeServer(key: string): void {
    const s = this.servers.get(key);
    if (s) {
      this.servers.delete(key);
      s.dispose();
    }
  }

  /** Kill every live server (window teardown / quit). Mirrors ServerManager.dispose(). */
  dispose(): void {
    for (const key of [...this.servers.keys()]) this.disposeServer(key);
  }
}

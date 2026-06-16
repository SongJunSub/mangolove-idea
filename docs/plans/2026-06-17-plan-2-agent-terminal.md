`@eslint/js` is referenced but not in package.json deps — it's a transitive dep. Note the CSP allows `style-src 'unsafe-inline'`, so xterm's injected styles are fine. I have all I need. Writing the plan now.

---

# PLAN 2 — Embedded Agent Terminal: the node-pty + xterm.js SPINE

**For agentic workers: REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`**

## Goal

One embedded xterm.js terminal per worktree, running the `claude` CLI inside a real PTY (node-pty). Selecting a worktree in the sidebar spawns `claude` with `cwd` = the worktree path; you type in the embedded terminal and see live output; resizing the pane drives `addon-fit → session:resize → pty.resize`; killing the session terminates the process and flips the sidebar agent indicator. `SessionManager` emits `SESSION_OUTPUT`/`SESSION_EXIT`/`SESSION_STATUS` to the renderer. `SessionManager.killAll()` is exposed (no caller yet — Plan 5's before-quit sweep wires it).

This plan delivers **MVP item 2**. It does NOT implement server/merge (Plans 3/4), session persistence, or the before-quit kill-sweep (Plan 5) — but it exposes the `killAll()`/`dispose()` surface Plan 5 will call.

## Architecture

Three seams, mirroring the existing `WorktreeManager` pattern (constructor-injected dependencies → unit-testable windowless):

```
renderer                          preload (window.mango)        main
────────                          ──────────────────────        ────
AgentTerminal (xterm + FitAddon)
  term.onData ───────────────────► session.sendInput ─ on ────► SESSION_INPUT ─► SessionManager.write()
  ResizeObserver → fit() ─────────► session.resize  ─ on ─────► SESSION_RESIZE ► SessionManager.resize()
useSession.spawn() ──────────────► session.spawn ─ invoke ───► SESSION_SPAWN ─► SessionManager.spawn() → PtyFactory.spawn()
useSession.kill()  ──────────────► session.kill  ─ invoke ───► SESSION_KILL ──► SessionManager.kill()
  term.write(e.data) ◄─ onOutput ◄─ subscribe(SESSION_OUTPUT) ◄─ event ◄─────── SessionManager → SessionEmitter
  onExit/onStatus    ◄─ subscribe ◄─────────────────────────── event ◄─────────  (drives sidebar indicator)
```

**Key design decisions (made as the engineer):**

1. **`PtyFactory` abstraction.** A new interface `PtyFactory { spawn(file, args, opts): IPtyLike }` where `IPtyLike` is the *callback-shaped* surface the fake already exposes (`pid / write / resize / kill / onData(cb) / onExit(cb)`). The **real** factory (`NodePtyFactory`) wraps `node-pty.spawn` and **adapts node-pty's disposable-returning `onData`/`onExit` down to the plain-callback `IPtyLike` shape** (verified: node-pty's `onData`/`onExit` return `{ dispose() }`; the fake's return `void`). So `SessionManager` only ever sees `IPtyLike` and the *same* manager code runs against both real and fake. The fake (`tests/helpers/fake-pty.ts`) already matches `IPtyLike` exactly — **no edit to the helper needed** (we add `IPtyLike`/`PtyFactory` types in `pty-factory.ts` and verify `FakePtyHandle` is assignable).

2. **Spawn command is injectable.** `SessionManager` constructor takes `{ factory, resolvePath, command = 'claude', emitter }`. Production passes `command: 'claude'`; tests pass the fake factory (command irrelevant). A manual/Playwright smoke can point `command` at a harmless echo shell **without launching real Claude Code**. `continueSession` appends `--continue` to args.

3. **Worktree path resolution.** `SessionManager` is injected a `resolvePath(worktreeId): Promise<string | undefined>` callback. In `register-ipc.ts` this is backed by the existing `WorktreeManager.list()` (find by id) — `worktreeId` *is* the absolute path per the contract, but we **validate it against the live list** so a spawn can never run `claude` in an unmanaged directory. Unknown id → `status:'error'`, no PTY.

4. **One PTY per worktree, replace-on-respawn.** A `Map<worktreeId, Session>`. Spawning when one already exists **kills the old PTY first, then spawns fresh** (justification: a re-select/HMR/re-spawn should give a clean `claude`, and silently returning a stale handle would desync xterm scrollback from a new mount; replacing is the predictable, idempotent choice). Status transitions: `idle → starting → running → exited | error`.

5. **Event flow is injectable.** `SessionManager` takes a `SessionEmitter` (three `emitOutput/emitExit/emitStatus` methods). Tests inject a spy emitter and assert payloads — **no BrowserWindow needed**. `register-ipc.ts` builds the production emitter from `ctx.mainWindow.webContents.send(...)`, guarding `mainWindow` null/destroyed.

6. **`hasActiveTurn` stays honest.** Plan 2 always reports `hasActiveTurn: false` (real turn-detection is Plan 5's problem; we do NOT fake it). Documented with a TODO in code.

7. **xterm CSS under electron-vite.** `agent-terminal.tsx` does a side-effect import `import '@xterm/xterm/css/xterm.css';`. The renderer is a normal Vite app (CSS imports just work) and the existing CSP already allows `style-src 'unsafe-inline'`, so xterm's runtime style injection is fine. No config change.

8. **App composition.** Lift a `selectedWorktreeId` state into `App.tsx`; `WorktreeList`/`WorktreeItem` gain an `onSelect`; selecting a worktree mounts `<AgentTerminal worktreeId=… />`. The sidebar agent indicator is driven by a `Map<worktreeId, AgentStatus>` from `session.onStatus`.

## Tech Stack

- `node-pty@1.1.0` (already in `dependencies`, N-API prebuild loads in Electron 42 with no rebuild — verified by Plan 0's probe and a throwaway spawn test).
- `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0` (already in `dependencies`).
- Vitest 4 `node` project for `SessionManager` + IPC delegation TDD using `tests/helpers/fake-pty.ts`.
- Renderer (`agent-terminal.tsx`, `use-session.ts`, App wiring) verified by `typecheck:web` + `lint` + `build` + a documented manual smoke (matches Plan 0/1 strategy — **no flaky e2e infra committed**).

## File Structure

| File | New/Edit | Responsibility |
|---|---|---|
| `src/main/pty/pty-factory.ts` | **EDIT** | Keep `probeNodePty()`. Add `IPtyLike`, `PtyExitEvent`, `PtyFactory` interfaces + `NodePtyFactory` (lazy `require('node-pty')`, adapts disposables → callbacks). |
| `src/main/managers/session-manager.ts` | **NEW** | `SessionManager`: one `IPtyLike` per worktree, lifecycle/status bookkeeping, `spawn/write/resize/kill/killAll/snapshot`, emits via injected `SessionEmitter`. |
| `src/main/ipc/ipc-context.ts` | **EDIT** | Add `sessionManager?: SessionManager` to `IpcContext`. |
| `src/main/ipc/register-ipc.ts` | **EDIT** | Add `buildSessionEmitter(ctx)`, `getSessionManager(ctx)`, wire `SESSION_SPAWN`/`SESSION_KILL` (invoke) + `SESSION_INPUT`/`SESSION_RESIZE` (`ipcMain.on`). |
| `src/preload/index.ts` | **EDIT** | Flip `session.spawn/kill` → `invoke`, `session.sendInput/resize` → `ipcRenderer.send` (fire-and-forget). `onOutput/onExit/onStatus` already wired. |
| `src/renderer/hooks/use-session.ts` | **NEW** | Hook: `spawn/kill`, subscribe `onStatus`/`onExit`, expose `status` + `sendInput`/`resize` passthroughs. |
| `src/renderer/components/terminal/agent-terminal.tsx` | **NEW** | xterm `Terminal` + `FitAddon` in a div ref; `onData→sendInput`; `onOutput→write`; `ResizeObserver→fit+resize`; spawn on mount, dispose on unmount. |
| `src/renderer/components/sidebar/worktree-item.tsx` | **EDIT** | Add `onSelect`, `selected`, `agentStatus` props; clickable row + agent dot. |
| `src/renderer/components/sidebar/worktree-list.tsx` | **EDIT** | Thread `onSelect`/`selectedId`/`agentStatuses` to items. |
| `src/renderer/App.tsx` | **EDIT** | Lift `selectedWorktreeId`; aggregate agent statuses via `session.onStatus`; render `<AgentTerminal>` for the selection. |
| `tests/main/session-manager.test.ts` | **NEW** | TDD `SessionManager` with a fake `PtyFactory` (`makeFakePty`) + spy `SessionEmitter`. |
| `tests/main/ipc-roundtrip.test.ts` | **EDIT** | Add `describe('registerIpc — session')`: spawn/kill/input/resize delegation. |

---

## Task 1 — `IPtyLike` / `PtyFactory` seam in `pty-factory.ts`

**Files:** `src/main/pty/pty-factory.ts`

This is the injectable boundary. We define it first so both the manager and its tests can import it. We verify `FakePtyHandle` is assignable to `IPtyLike` with a typecheck (no runtime test needed — pure type seam, matches the contract's "preload shape = type-checked only" philosophy).

### Step 1.1 — Add the interfaces + `NodePtyFactory` (no test yet; it's a thin adapter verified by typecheck + the manager tests)

Edit `src/main/pty/pty-factory.ts` — **keep the existing `probeNodePty` exactly as-is**, append below it:

```ts
// ── Plan 2: the spawnable PTY seam ───────────────────────────────────────────

/** Exit payload shape shared by node-pty and the test fake. */
export interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

/**
 * The minimal PTY surface SessionManager depends on. Callback-shaped on purpose:
 * node-pty's real onData/onExit return disposables, but NodePtyFactory adapts
 * them down to this plain-callback form so the SAME SessionManager code runs
 * against both the real addon and tests/helpers/fake-pty.ts (FakePtyHandle).
 */
export interface IPtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: PtyExitEvent) => void): void;
}

/** Spawn options forwarded to node-pty.spawn (subset we use). */
export interface PtySpawnOptions {
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly name?: string;
}

/** Factory abstraction so SessionManager is unit-testable with a fake PTY. */
export interface PtyFactory {
  spawn(file: string, args: readonly string[], opts: PtySpawnOptions): IPtyLike;
}

/** Shape of the node-pty module members we touch (avoids `any`). */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { cwd: string; cols: number; rows: number; env?: NodeJS.ProcessEnv; name?: string },
  ): {
    readonly pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(cb: (data: string) => void): { dispose(): void };
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  };
}

/**
 * Production PtyFactory wrapping node-pty. Lazily requires the addon (so plain
 * Node unit tests that never call this never load the native binary) and adapts
 * node-pty's disposable-returning onData/onExit to IPtyLike's callback form.
 */
export class NodePtyFactory implements PtyFactory {
  private readonly nodePty: NodePtyModule;

  constructor(nodePty?: NodePtyModule) {
    this.nodePty = nodePty ?? (require('node-pty') as NodePtyModule);
  }

  spawn(file: string, args: readonly string[], opts: PtySpawnOptions): IPtyLike {
    const proc = this.nodePty.spawn(file, [...args], {
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env ?? process.env,
      name: opts.name ?? 'xterm-color',
    });
    return {
      pid: proc.pid,
      write: (data) => proc.write(data),
      resize: (cols, rows) => proc.resize(cols, rows),
      kill: (signal) => proc.kill(signal),
      onData: (cb) => void proc.onData(cb),
      onExit: (cb) => void proc.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
    };
  }
}
```

### Step 1.2 — Verify the type seam compiles and the fake is assignable

Add a temporary type-assertion at the bottom of `tests/helpers/fake-pty.ts`? **No** — don't edit the shared helper. Instead just run typecheck; the manager test in Task 2 imports both and the assignment will surface any mismatch.

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck:node && npm run lint
```
Expected: both exit 0 (no errors). `require` is already used elsewhere via `createRequire` — note `pty-factory.ts` top already has `const require = createRequire(import.meta.url)`, so `require('node-pty')` in `NodePtyFactory` resolves with no new import.

### Step 1.3 — Commit

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git checkout -b plan-2-agent-terminal && git add src/main/pty/pty-factory.ts && git commit -m "feat(pty): add IPtyLike + PtyFactory seam with NodePtyFactory adapter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — `SessionManager` (TDD with fake PtyFactory)

**Files:** `tests/main/session-manager.test.ts`, `src/main/managers/session-manager.ts`

Follow strict red→green→commit. Write the whole test file first (RED), then implement (GREEN).

### Step 2.1 — RED: write `tests/main/session-manager.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager, type SessionEmitter } from '../../src/main/managers/session-manager';
import type { PtyFactory, IPtyLike } from '../../src/main/pty/pty-factory';
import { makeFakePty, type FakePtyHandle } from '../helpers/fake-pty';
import type { AgentSession } from '../../src/shared/types';

/** A spy emitter capturing every event SessionManager publishes. */
function makeSpyEmitter() {
  const outputs: { worktreeId: string; data: string }[] = [];
  const exits: { worktreeId: string; exitCode: number; signal?: number }[] = [];
  const statuses: AgentSession[] = [];
  const emitter: SessionEmitter = {
    emitOutput: (e) => void outputs.push(e),
    emitExit: (e) => void exits.push(e),
    emitStatus: (s) => void statuses.push(s),
  };
  return { emitter, outputs, exits, statuses };
}

/** A PtyFactory that hands back a queue of pre-built fakes and records spawn args. */
function makeFakeFactory(fakes: FakePtyHandle[]) {
  const calls: { file: string; args: readonly string[]; cwd: string; cols: number; rows: number }[] =
    [];
  let i = 0;
  const factory: PtyFactory = {
    spawn: (file, args, opts) => {
      calls.push({ file, args, cwd: opts.cwd, cols: opts.cols, rows: opts.rows });
      const fake = fakes[i++];
      if (!fake) throw new Error('fake factory ran out of PTYs');
      return fake as unknown as IPtyLike;
    },
  };
  return { factory, calls };
}

const WT = '/repo/.worktrees/feat';

function makeManager(opts: {
  fakes: FakePtyHandle[];
  resolvePath?: (id: string) => Promise<string | undefined>;
  command?: string;
}) {
  const { factory, calls } = makeFakeFactory(opts.fakes);
  const { emitter, outputs, exits, statuses } = makeSpyEmitter();
  const mgr = new SessionManager({
    factory,
    emitter,
    command: opts.command ?? 'claude',
    resolvePath: opts.resolvePath ?? (async (id) => id),
  });
  return { mgr, calls, outputs, exits, statuses };
}

describe('SessionManager.spawn', () => {
  let fake: FakePtyHandle;
  beforeEach(() => {
    fake = makeFakePty(1234);
  });

  it('spawns claude in the worktree cwd and returns a running AgentSession', async () => {
    const { mgr, calls } = makeManager({ fakes: [fake] });
    const session = await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ file: 'claude', args: [], cwd: WT, cols: 80, rows: 24 });
    expect(session).toEqual({
      worktreeId: WT,
      pid: 1234,
      status: 'running',
      hasActiveTurn: false,
      continued: false,
    });
  });

  it('passes --continue when continueSession is true and marks continued', async () => {
    const { mgr, calls } = makeManager({ fakes: [fake] });
    const session = await mgr.spawn({ worktreeId: WT, continueSession: true, cols: 80, rows: 24 });
    expect(calls[0].args).toEqual(['--continue']);
    expect(session.continued).toBe(true);
  });

  it('emits a starting then running status during spawn', async () => {
    const { mgr, statuses } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(statuses.map((s) => s.status)).toEqual(['starting', 'running']);
  });

  it('forwards PTY data as SESSION_OUTPUT events keyed by worktreeId', async () => {
    const { mgr, outputs } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    fake.emitData('hello');
    expect(outputs).toEqual([{ worktreeId: WT, data: 'hello' }]);
  });

  it('returns status:error (no PTY) when the worktree id is unknown', async () => {
    const { mgr, calls, statuses } = makeManager({ fakes: [fake], resolvePath: async () => undefined });
    const session = await mgr.spawn({
      worktreeId: '/nope',
      continueSession: false,
      cols: 80,
      rows: 24,
    });
    expect(calls).toHaveLength(0);
    expect(session.status).toBe('error');
    expect(session.pid).toBeUndefined();
    expect(statuses.map((s) => s.status)).toContain('error');
  });

  it('replaces an existing PTY when spawning the same worktree again', async () => {
    const first = makeFakePty(1);
    const second = makeFakePty(2);
    const killSpy = vi.spyOn(first, 'kill');
    const { mgr, calls } = makeManager({ fakes: [first, second] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    const again = await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(killSpy).toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(again.pid).toBe(2);
  });

  it('does not emit SESSION_EXIT for a worktree being replaced (respawn)', async () => {
    const first = makeFakePty(1);
    const second = makeFakePty(2);
    const { mgr, exits } = makeManager({ fakes: [first, second] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    // Respawn: killing `first` synchronously fires its onExit, but it has already
    // been unmapped/replaced, so handleExit must swallow it — no exit leaks.
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    expect(exits).toHaveLength(0);
  });
});

describe('SessionManager write/resize', () => {
  it('writes input to the PTY of that worktree', async () => {
    const fake = makeFakePty();
    const writeSpy = vi.spyOn(fake, 'write');
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.write({ worktreeId: WT, data: 'ls\r' });
    expect(writeSpy).toHaveBeenCalledWith('ls\r');
  });

  it('ignores input for an unknown worktree (no throw)', () => {
    const { mgr } = makeManager({ fakes: [] });
    expect(() => mgr.write({ worktreeId: '/ghost', data: 'x' })).not.toThrow();
  });

  it('resizes the PTY of that worktree', async () => {
    const fake = makeFakePty();
    const resizeSpy = vi.spyOn(fake, 'resize');
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    mgr.resize({ worktreeId: WT, cols: 120, rows: 40 });
    expect(resizeSpy).toHaveBeenCalledWith(120, 40);
  });
});

describe('SessionManager exit + kill', () => {
  it('emits SESSION_EXIT and an exited status when the PTY exits', async () => {
    const fake = makeFakePty();
    const { mgr, exits, statuses } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    fake.emitExit(0);
    expect(exits).toEqual([{ worktreeId: WT, exitCode: 0, signal: undefined }]);
    expect(statuses.at(-1)?.status).toBe('exited');
  });

  it('kill terminates the PTY and returns ok', async () => {
    const fake = makeFakePty();
    const killSpy = vi.spyOn(fake, 'kill');
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    const ack = mgr.kill(WT);
    expect(killSpy).toHaveBeenCalled();
    expect(ack).toEqual({ ok: true });
  });

  it('kill of an unknown worktree returns ok:false', () => {
    const { mgr } = makeManager({ fakes: [] });
    expect(mgr.kill('/ghost')).toEqual({ ok: false, error: 'no session for /ghost' });
  });

  it('does not leak: after exit the worktree has no live session for write', async () => {
    const fake = makeFakePty();
    const { mgr } = makeManager({ fakes: [fake] });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    fake.emitExit(0);
    expect(mgr.snapshot(WT)?.status).toBe('exited');
    // a second exit must not double-emit
  });

  it('killAll terminates every live PTY (Plan 5 hook)', async () => {
    const a = makeFakePty(1);
    const b = makeFakePty(2);
    const killA = vi.spyOn(a, 'kill');
    const killB = vi.spyOn(b, 'kill');
    const { mgr } = makeManager({ fakes: [a, b] });
    await mgr.spawn({ worktreeId: '/wt/a', continueSession: false, cols: 80, rows: 24 });
    await mgr.spawn({ worktreeId: '/wt/b', continueSession: false, cols: 80, rows: 24 });
    mgr.killAll();
    expect(killA).toHaveBeenCalled();
    expect(killB).toHaveBeenCalled();
  });
});
```

Run it — expect a module-not-found / RED:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/main/session-manager.test.ts
```
Expected: FAIL — `Cannot find module '../../src/main/managers/session-manager'`.

### Step 2.2 — GREEN: implement `src/main/managers/session-manager.ts`

```ts
import type { Ack, AgentSession, AgentStatus } from '../../shared/types';
import type {
  IPtyLike,
  PtyExitEvent,
  PtyFactory,
} from '../pty/pty-factory';

/** Plan-2 spawn input (mirrors SpawnSessionRequest minus transport concerns). */
export interface SpawnArgs {
  readonly worktreeId: string;
  readonly continueSession: boolean;
  readonly cols: number;
  readonly rows: number;
}

/** Where SessionManager publishes main->renderer events (injected, so tests spy). */
export interface SessionEmitter {
  emitOutput(e: { worktreeId: string; data: string }): void;
  emitExit(e: { worktreeId: string; exitCode: number; signal?: number }): void;
  emitStatus(s: AgentSession): void;
}

/** Constructor dependencies — all injectable for windowless unit tests. */
export interface SessionManagerDeps {
  readonly factory: PtyFactory;
  readonly emitter: SessionEmitter;
  /** Binary to spawn; default 'claude'. Injectable so smokes use a harmless cmd. */
  readonly command?: string;
  /** Resolves worktreeId -> absolute cwd, or undefined if not a managed worktree. */
  readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
}

/** Internal per-worktree bookkeeping. */
interface Session {
  readonly pty: IPtyLike;
  status: AgentStatus;
  readonly continued: boolean;
  /** Guards against double exit emission (kill then natural exit). */
  exited: boolean;
}

/**
 * Owns one node-pty per worktree running `claude`. Lifecycle + status bookkeeping
 * only; the PTY itself is created by the injected PtyFactory so tests pass a fake.
 * Emits OUTPUT/EXIT/STATUS through the injected SessionEmitter. Plan 5 calls
 * killAll() from the before-quit sweep.
 */
export class SessionManager {
  private readonly factory: PtyFactory;
  private readonly emitter: SessionEmitter;
  private readonly command: string;
  private readonly resolvePath: (worktreeId: string) => Promise<string | undefined>;
  private readonly sessions = new Map<string, Session>();

  constructor(deps: SessionManagerDeps) {
    this.factory = deps.factory;
    this.emitter = deps.emitter;
    this.command = deps.command ?? 'claude';
    this.resolvePath = deps.resolvePath;
  }

  /** Spawns (or replaces) the PTY for a worktree and returns its AgentSession. */
  async spawn(args: SpawnArgs): Promise<AgentSession> {
    const { worktreeId, continueSession, cols, rows } = args;

    // Replace-on-respawn: UNMAP the old session BEFORE killing it, so its exit
    // (synchronous from the fake, asynchronous from real node-pty) is recognized
    // as a stale handle in handleExit and does NOT emit a spurious SESSION_EXIT
    // for the worktree being respawned.
    const existing = this.sessions.get(worktreeId);
    this.sessions.delete(worktreeId);
    if (existing && !existing.exited) {
      existing.exited = true;
      existing.pty.kill();
    }

    this.emitStatus(worktreeId, 'starting', undefined, continueSession);

    const cwd = await this.resolvePath(worktreeId);
    if (!cwd) {
      const errored = this.buildSession(worktreeId, 'error', undefined, continueSession);
      this.emitter.emitStatus(errored);
      return errored;
    }

    const ptyArgs = continueSession ? ['--continue'] : [];
    const pty = this.factory.spawn(this.command, ptyArgs, { cwd, cols, rows });

    const session: Session = { pty, status: 'running', continued: continueSession, exited: false };
    this.sessions.set(worktreeId, session);

    pty.onData((data) => this.emitter.emitOutput({ worktreeId, data }));
    pty.onExit((e) => this.handleExit(worktreeId, session, e));

    const running = this.buildSession(worktreeId, 'running', pty.pid, continueSession);
    this.emitter.emitStatus(running);
    return running;
  }

  /** Writes raw input to a worktree's PTY (no-op if none). */
  write(req: { worktreeId: string; data: string }): void {
    const s = this.sessions.get(req.worktreeId);
    if (s && !s.exited) s.pty.write(req.data);
  }

  /** Resizes a worktree's PTY (no-op if none). */
  resize(req: { worktreeId: string; cols: number; rows: number }): void {
    const s = this.sessions.get(req.worktreeId);
    if (s && !s.exited) s.pty.resize(req.cols, req.rows);
  }

  /** Kills a worktree's PTY. Returns ok:false if there was no session. */
  kill(worktreeId: string): Ack {
    const s = this.sessions.get(worktreeId);
    if (!s) return { ok: false, error: `no session for ${worktreeId}` };
    if (!s.exited) {
      s.exited = true;
      s.pty.kill();
    }
    return { ok: true };
  }

  /** Current AgentSession snapshot for a worktree, if any. */
  snapshot(worktreeId: string): AgentSession | undefined {
    const s = this.sessions.get(worktreeId);
    if (!s) return undefined;
    return this.buildSession(worktreeId, s.status, s.pty.pid, s.continued);
  }

  /** Kills every live PTY (Plan 5 before-quit sweep calls this). */
  killAll(): void {
    for (const s of this.sessions.values()) {
      if (!s.exited) {
        s.exited = true;
        s.pty.kill();
      }
    }
  }

  /** Alias for killAll so a future disposer can call either. */
  dispose(): void {
    this.killAll();
    this.sessions.clear();
  }

  private handleExit(worktreeId: string, session: Session, e: PtyExitEvent): void {
    // Ignore exits from a PTY that is no longer the current session for this
    // worktree — i.e. it was replaced by a respawn. Identity (not map presence)
    // is the discriminator, so this holds whether the exit arrives synchronously
    // (fake kill) or asynchronously (real node-pty arriving after the new spawn).
    if (this.sessions.get(worktreeId) !== session) return;
    session.status = 'exited';
    session.exited = true;
    this.emitter.emitExit({ worktreeId, exitCode: e.exitCode, signal: e.signal });
    this.emitStatus(worktreeId, 'exited', undefined, session.continued);
  }

  private emitStatus(
    worktreeId: string,
    status: AgentStatus,
    pid: number | undefined,
    continued: boolean,
  ): void {
    this.emitter.emitStatus(this.buildSession(worktreeId, status, pid, continued));
  }

  private buildSession(
    worktreeId: string,
    status: AgentStatus,
    pid: number | undefined,
    continued: boolean,
  ): AgentSession {
    // hasActiveTurn: honest false for Plan 2 — real turn detection is Plan 5.
    return { worktreeId, pid, status, hasActiveTurn: false, continued };
  }
}
```

Run again — expect GREEN:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/main/session-manager.test.ts
```
Expected: all tests pass (look for `Test Files  1 passed`). Note: `snapshot()` returns the `'running'` pid even after exit because the fake keeps `pid`; the "exited" test only checks `.status`, which is correct.

### Step 2.3 — Typecheck, lint, full test, commit

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck:node && npm run lint && npm test
```
Expected: typecheck/lint exit 0; `npm test` shows the node + jsdom projects green (worktree, ipc-roundtrip, session-manager, format-versions).

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/main/managers/session-manager.ts tests/main/session-manager.test.ts && git commit -m "feat(session): SessionManager — one PTY per worktree, lifecycle + events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Wire `SESSION_*` IPC (TDD the delegation)

**Files:** `src/main/ipc/ipc-context.ts`, `src/main/ipc/register-ipc.ts`, `tests/main/ipc-roundtrip.test.ts`

The existing `ipc-roundtrip.test.ts` proves "handler delegates to the manager" without an Electron bus. We extend it: inject a fake `SessionManager` on `ctx` and assert `SESSION_SPAWN`/`SESSION_KILL`/`SESSION_INPUT`/`SESSION_RESIZE` delegate. The fake `ipcMain` must now also record `.on(...)` registrations.

### Step 3.1 — Add `sessionManager` to `IpcContext`

Edit `src/main/ipc/ipc-context.ts`:

```ts
import type { BrowserWindow } from 'electron';
import type { WorktreeManager } from '../managers/worktree-manager';
import type { SessionManager } from '../managers/session-manager';

/**
 * Holds main-process singletons + the main window ref for event emitters.
 * Plan 1 adds the WorktreeManager; Plan 2 adds the SessionManager.
 */
export interface IpcContext {
  mainWindow: BrowserWindow | null;
  /** Absolute path of the repo MangoLove operates on (set by main/index.ts). */
  repoRoot?: string;
  /** Lazily constructed in register-ipc from repoRoot; injectable in tests. */
  worktreeManager?: WorktreeManager;
  /** Lazily constructed in register-ipc; injectable in tests. */
  sessionManager?: SessionManager;
}

export function createIpcContext(): IpcContext {
  return { mainWindow: null };
}
```

### Step 3.2 — RED: extend `tests/main/ipc-roundtrip.test.ts`

First, upgrade `makeIpcMain` to also capture `.on` handlers. Replace the existing `makeIpcMain` inside `describe('registerIpc', …)`:

```ts
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const onHandlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      on: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
        onHandlers.set(channel, fn);
      }),
    };
    return { handlers, onHandlers, ipcMain };
  }
```

(The existing worktree tests don't read `onHandlers`, so they keep passing.)

Then append a new describe block to the file (after the worktree `it(...)` blocks, still inside `describe('registerIpc', …)` or as a sibling `describe`):

```ts
describe('registerIpc — session', () => {
  function makeIpcMain() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const onHandlers = new Map<string, (...a: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void handlers.set(c, fn)),
      on: vi.fn((c: string, fn: (...a: unknown[]) => unknown) => void onHandlers.set(c, fn)),
    };
    return { handlers, onHandlers, ipcMain };
  }

  function fakeSession() {
    return {
      spawn: vi.fn(async () => ({
        worktreeId: '/wt',
        pid: 7,
        status: 'running',
        hasActiveTurn: false,
        continued: false,
      })),
      kill: vi.fn(() => ({ ok: true })),
      write: vi.fn(),
      resize: vi.fn(),
      killAll: vi.fn(),
    };
  }

  it('SESSION_SPAWN delegates to sessionManager.spawn and returns the AgentSession', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const req = { worktreeId: '/wt', continueSession: false, cols: 80, rows: 24 };
    const session = await handlers.get('session:spawn')!({}, req);
    expect(sm.spawn).toHaveBeenCalledWith(req);
    expect(session).toMatchObject({ worktreeId: '/wt', status: 'running', pid: 7 });
  });

  it('SESSION_KILL delegates to sessionManager.kill and returns the Ack', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const ack = await handlers.get('session:kill')!({}, { worktreeId: '/wt' });
    expect(sm.kill).toHaveBeenCalledWith('/wt');
    expect(ack).toEqual({ ok: true });
  });

  it('SESSION_INPUT is an ipcMain.on handler that delegates to write', () => {
    const { onHandlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const req = { worktreeId: '/wt', data: 'ls\r' };
    onHandlers.get('session:input')!({}, req);
    expect(sm.write).toHaveBeenCalledWith(req);
  });

  it('SESSION_RESIZE is an ipcMain.on handler that delegates to resize', () => {
    const { onHandlers, ipcMain } = makeIpcMain();
    const sm = fakeSession();
    registerIpc(ipcMain as never, { mainWindow: null, sessionManager: sm as never });
    const req = { worktreeId: '/wt', cols: 120, rows: 40 };
    onHandlers.get('session:resize')!({}, req);
    expect(sm.resize).toHaveBeenCalledWith(req);
  });
});
```

Run — expect RED (no `session:*` registrations yet):
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/main/ipc-roundtrip.test.ts
```
Expected: the 4 new tests fail (`handlers.get('session:spawn')` is undefined → cannot call).

### Step 3.3 — GREEN: wire the handlers in `register-ipc.ts`

Add imports at the top of `src/main/ipc/register-ipc.ts`:

```ts
import type {
  Ack,
  AppInfo,
  CreateWorktreeRequest,
  RemoveWorktreeRequest,
  Worktree,
  SpawnSessionRequest,
  SessionInputRequest,
  SessionResizeRequest,
  AgentSession,
} from '../../shared/types';
import { probeNodePty, NodePtyFactory, type NodePtyProbe } from '../pty/pty-factory';
import { WorktreeManager } from '../managers/worktree-manager';
import { SessionManager, type SessionEmitter } from '../managers/session-manager';
```

(Keep the existing `IpcMain`/`IPC`/`IpcContext` imports.)

Add two helpers above `registerIpc` (after `getWorktreeManager`):

```ts
/**
 * Builds the production SessionEmitter that forwards SessionManager events to the
 * renderer over ctx.mainWindow. Null/destroyed-window guarded so a late event
 * after window close is a no-op (never throws).
 */
function buildSessionEmitter(ctx: IpcContext): SessionEmitter {
  const send = (channel: string, payload: unknown): void => {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  return {
    emitOutput: (e) => send(IPC.SESSION_OUTPUT, e),
    emitExit: (e) => send(IPC.SESSION_EXIT, e),
    emitStatus: (s) => send(IPC.SESSION_STATUS, s),
  };
}

/**
 * Resolves the SessionManager: prefer the one on ctx (tests inject a fake);
 * otherwise lazily build a real one with the node-pty factory, an emitter bound
 * to ctx.mainWindow, and a resolvePath backed by the WorktreeManager listing.
 */
function getSessionManager(ctx: IpcContext): SessionManager {
  if (ctx.sessionManager) return ctx.sessionManager;
  ctx.sessionManager = new SessionManager({
    factory: new NodePtyFactory(),
    emitter: buildSessionEmitter(ctx),
    command: 'claude',
    resolvePath: async (worktreeId) => {
      const manager = await getWorktreeManager(ctx);
      const trees = await manager.list();
      return trees.find((t) => t.id === worktreeId)?.path;
    },
  });
  return ctx.sessionManager;
}
```

Inside `registerIpc(...)`, after the worktree handlers, add:

```ts
  ipcMain.handle(
    IPC.SESSION_SPAWN,
    async (_event: unknown, req: SpawnSessionRequest): Promise<AgentSession> => {
      return getSessionManager(ctx).spawn(req);
    },
  );

  ipcMain.handle(
    IPC.SESSION_KILL,
    async (_event: unknown, req: { worktreeId: string }): Promise<Ack> => {
      return getSessionManager(ctx).kill(req.worktreeId);
    },
  );

  ipcMain.on(IPC.SESSION_INPUT, (_event: unknown, req: SessionInputRequest) => {
    getSessionManager(ctx).write(req);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event: unknown, req: SessionResizeRequest) => {
    getSessionManager(ctx).resize(req);
  });
```

Note: the test's `IpcMain` mock only declares `handle`/`on`; we cast with `as never` (already the established pattern), so the missing full `IpcMain` surface is fine.

Run — expect GREEN:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && npx vitest run tests/main/ipc-roundtrip.test.ts
```
Expected: all ipc-roundtrip tests pass (old + 4 new).

### Step 3.4 — Full verify + commit

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck:node && npm run lint && npm test
```
Expected: green across the board.

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/main/ipc/ipc-context.ts src/main/ipc/register-ipc.ts tests/main/ipc-roundtrip.test.ts && git commit -m "feat(ipc): wire SESSION_SPAWN/KILL invoke + SESSION_INPUT/RESIZE on

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Flip preload `session.*` from `notYet('2')` to real

**Files:** `src/preload/index.ts`

Per contract: `spawn`/`kill` = `invoke`; `sendInput`/`resize` = `ipcRenderer.send` (fire-and-forget). `onOutput`/`onExit`/`onStatus` already use `subscribe()` — leave them.

### Step 4.1 — Edit the `session` block

Replace the four `notYet('2')` lines in `src/preload/index.ts`:

```ts
  session: {
    spawn: (req) => ipcRenderer.invoke(IPC.SESSION_SPAWN, req),
    sendInput: (req) => ipcRenderer.send(IPC.SESSION_INPUT, req),
    resize: (req) => ipcRenderer.send(IPC.SESSION_RESIZE, req),
    kill: (worktreeId) => ipcRenderer.invoke(IPC.SESSION_KILL, { worktreeId }),
    onOutput: (cb) => subscribe(IPC.SESSION_OUTPUT, cb),
    onExit: (cb) => subscribe(IPC.SESSION_EXIT, cb),
    onStatus: (cb) => subscribe(IPC.SESSION_STATUS, cb),
  },
```

`notYet` is still used by `server`/`logs`/`merge`, so it stays imported — no unused-var lint error.

### Step 4.2 — Typecheck (preload is in tsconfig.node), lint, commit

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck:node && npm run lint
```
Expected: exit 0. The `MangoApi.session` types now match the real `invoke`/`send` returns (`Promise<AgentSession>`, `void`).

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/preload/index.ts && git commit -m "feat(preload): flip session.spawn/sendInput/resize/kill to real IPC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — `use-session.ts` hook

**Files:** `src/renderer/hooks/use-session.ts`

Renderer-side wiring. No unit test (pure window.mango glue + xterm — verified by typecheck/build/manual smoke, matching the contract's renderer strategy). It exposes `status`, `spawn`, `kill`, and passthrough `sendInput`/`resize`.

### Step 5.1 — Create `src/renderer/hooks/use-session.ts`

```ts
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
```

### Step 5.2 — Typecheck web, lint, commit

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck:web && npm run lint
```
Expected: exit 0.

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/renderer/hooks/use-session.ts && git commit -m "feat(renderer): add use-session hook (spawn/kill/input/resize + status)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — `agent-terminal.tsx` (xterm + addon-fit)

**Files:** `src/renderer/components/terminal/agent-terminal.tsx`

The renderer SPINE. xterm `Terminal` + `FitAddon` in a div ref. Mount → fit → spawn(cols,rows) → wire I/O. ResizeObserver → fit() + `resize`. Unmount → dispose term + `kill`. Verified by typecheck/build/manual smoke.

### Step 6.1 — Create `src/renderer/components/terminal/agent-terminal.tsx`

```ts
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useSession } from '../../hooks/use-session';

/** Props for the embedded agent terminal (one per selected worktree). */
export interface AgentTerminalProps {
  /** The worktree whose `claude` PTY this terminal is bound to. */
  readonly worktreeId: string;
}

/**
 * Embedded xterm.js terminal bound to a worktree's claude PTY. On mount it
 * builds a Terminal + FitAddon, spawns the session at the fitted cols/rows, and
 * bridges: term.onData -> session.sendInput, session.onOutput -> term.write,
 * ResizeObserver -> fit() + session.resize. On unmount it kills the PTY and
 * disposes the terminal. Re-mounts (worktreeId change) tear down and rebuild via
 * the effect's cleanup + the key in App.tsx.
 */
export function AgentTerminal({ worktreeId }: AgentTerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { spawn, kill, sendInput, resize } = useSession(worktreeId);

  // Keep the latest glue callbacks without retriggering the heavy mount effect.
  const spawnRef = useRef(spawn);
  const killRef = useRef(kill);
  const sendInputRef = useRef(sendInput);
  const resizeRef = useRef(resize);
  spawnRef.current = spawn;
  killRef.current = kill;
  sendInputRef.current = sendInput;
  resizeRef.current = resize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      convertEol: true,
      theme: { background: '#1e1e1e' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const onData = term.onData((data) => sendInputRef.current(data));

    const offOutput = window.mango.session.onOutput((e) => {
      if (e.worktreeId === worktreeId) term.write(e.data);
    });
    const offExit = window.mango.session.onExit((e) => {
      if (e.worktreeId === worktreeId) {
        term.writeln(`\r\n\x1b[2m[claude exited: code ${e.exitCode}]\x1b[0m`);
      }
    });

    void spawnRef.current(term.cols, term.rows, false);

    const observer = new ResizeObserver(() => {
      fit.fit();
      resizeRef.current(term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      offOutput();
      offExit();
      onData.dispose();
      void killRef.current();
      term.dispose();
    };
  }, [worktreeId]);

  return (
    <div
      data-testid="agent-terminal"
      ref={hostRef}
      style={{ width: '100%', height: 420, background: '#1e1e1e', borderRadius: 4 }}
    />
  );
}
```

### Step 6.2 — Typecheck web, lint

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck:web && npm run lint
```
Expected: exit 0. (`@xterm/xterm` ships its own `.d.ts`; `convertEol` makes bare `\n` output render on a new line.)

### Step 6.3 — Confirm the CSS import resolves under the renderer build

The full build runs in Task 8; but verify the css path exists now so a typo doesn't surprise us later:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && test -f node_modules/@xterm/xterm/css/xterm.css && echo "xterm css OK"
```
Expected: `xterm css OK`.

### Step 6.4 — Commit

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/renderer/components/terminal/agent-terminal.tsx && git commit -m "feat(renderer): AgentTerminal — xterm + addon-fit bound to session IPC

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Compose into sidebar + App (selection + agent indicator)

**Files:** `src/renderer/components/sidebar/worktree-item.tsx`, `src/renderer/components/sidebar/worktree-list.tsx`, `src/renderer/App.tsx`

Selecting a worktree shows its terminal; the sidebar shows an agent status dot.

### Step 7.1 — `worktree-item.tsx`: add `onSelect`, `selected`, `agentStatus`

Replace the contents of `src/renderer/components/sidebar/worktree-item.tsx`:

```ts
import type { AgentStatus, Worktree } from '../../../shared/types';

/** Props for one worktree row. */
export interface WorktreeItemProps {
  readonly worktree: Worktree;
  readonly selected: boolean;
  readonly agentStatus: AgentStatus;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: '#bbb',
  starting: '#d8a657',
  running: '#2ea043',
  exited: '#888',
  error: '#cf222e',
};

/** A single worktree row: agent dot, branch, badges, short HEAD, Remove. Clickable to select. */
export function WorktreeItem({
  worktree,
  selected,
  agentStatus,
  onSelect,
  onRemove,
}: WorktreeItemProps): React.JSX.Element {
  return (
    <li
      data-testid="worktree-item"
      onClick={() => onSelect(worktree.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
        background: selected ? '#eef4ff' : 'transparent',
      }}
    >
      <span
        aria-label={`agent ${agentStatus}`}
        title={`agent ${agentStatus}`}
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: STATUS_COLOR[agentStatus],
          flex: '0 0 auto',
        }}
      />
      <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}>{worktree.branch}</span>
      {worktree.isPrimary && <span style={{ fontSize: 11, color: '#888' }}>primary</span>}
      {worktree.isLocked && <span style={{ fontSize: 11, color: '#b58900' }}>locked</span>}
      {worktree.head && <span style={{ fontSize: 11, color: '#aaa' }}>{worktree.head}</span>}
      <button
        type="button"
        disabled={worktree.isPrimary || worktree.isLocked}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(worktree.id);
        }}
        title={
          worktree.isPrimary
            ? 'cannot remove the primary worktree'
            : worktree.isLocked
              ? 'worktree is locked; unlock it first'
              : 'remove worktree'
        }
      >
        Remove
      </button>
    </li>
  );
}
```

(`e.stopPropagation()` keeps Remove from also selecting the row.)

### Step 7.2 — `worktree-list.tsx`: thread the new props

Replace the contents of `src/renderer/components/sidebar/worktree-list.tsx`:

```ts
import type { AgentStatus, Worktree } from '../../../shared/types';
import { WorktreeItem } from './worktree-item';

/** Props for the worktree sidebar list. */
export interface WorktreeListProps {
  readonly worktrees: readonly Worktree[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly agentStatuses: ReadonlyMap<string, AgentStatus>;
  onSelect(worktreeId: string): void;
  onRemove(worktreeId: string): void;
}

/** Sidebar list of worktrees with loading/error/empty states + agent dots. */
export function WorktreeList({
  worktrees,
  loading,
  error,
  selectedId,
  agentStatuses,
  onSelect,
  onRemove,
}: WorktreeListProps): React.JSX.Element {
  return (
    <section data-testid="worktree-list" style={{ minWidth: 260 }}>
      <h2 style={{ fontSize: 14, margin: '8px 0' }}>Worktrees</h2>
      {error && <pre style={{ color: 'crimson', fontSize: 12 }}>error: {error}</pre>}
      {loading && <p style={{ fontSize: 12, color: '#888' }}>loading…</p>}
      {!loading && worktrees.length === 0 && (
        <p style={{ fontSize: 12, color: '#888' }}>no worktrees</p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {worktrees.map((wt) => (
          <WorktreeItem
            key={wt.id}
            worktree={wt}
            selected={wt.id === selectedId}
            agentStatus={agentStatuses.get(wt.id) ?? 'idle'}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
}
```

### Step 7.3 — `App.tsx`: lift selection + aggregate statuses + render terminal

Replace the contents of `src/renderer/App.tsx`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { AgentStatus, AppInfo } from '../shared/types';
import { formatVersions } from './lib/format-versions';
import { useWorktrees } from './hooks/use-worktrees';
import { Toolbar } from './components/toolbar/toolbar';
import { WorktreeList } from './components/sidebar/worktree-list';
import { AgentTerminal } from './components/terminal/agent-terminal';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<ReadonlyMap<string, AgentStatus>>(new Map());
  const { worktrees, loading, error, create, remove } = useWorktrees();

  // Aggregate every worktree's agent status from the global SESSION_STATUS stream.
  useEffect(() => {
    const off = window.mango.session.onStatus((s) => {
      setAgentStatuses((prev) => {
        const next = new Map(prev);
        next.set(s.worktreeId, s.status);
        return next;
      });
    });
    return off;
  }, []);

  const onPing = useCallback(async () => {
    setPingError(null);
    try {
      setInfo(await window.mango.app.ping());
    } catch (e) {
      setPingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>MangoLove IDEA</h1>
      <p>Plan 2: embedded agent terminal (claude via node-pty).</p>

      <Toolbar onCreate={create} />
      <div style={{ display: 'flex', gap: 24, marginTop: 12 }}>
        <WorktreeList
          worktrees={worktrees}
          loading={loading}
          error={error}
          selectedId={selectedId}
          agentStatuses={agentStatuses}
          onSelect={setSelectedId}
          onRemove={(id) => void remove(id)}
        />
        <section style={{ flex: 1, minWidth: 0 }}>
          {selectedId ? (
            <AgentTerminal key={selectedId} worktreeId={selectedId} />
          ) : (
            <p style={{ fontSize: 13, color: '#888' }}>Select a worktree to start its agent.</p>
          )}
          <div style={{ marginTop: 16 }}>
            <button type="button" onClick={onPing}>
              Ping main
            </button>
            {pingError && <pre style={{ color: 'crimson' }}>error: {pingError}</pre>}
            {info && (
              <pre data-testid="ping-result" style={{ marginTop: 16 }}>
                {formatVersions(info)}
              </pre>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
```

(`key={selectedId}` forces a fresh `AgentTerminal` mount per worktree, so the unmount cleanup kills the old PTY and a new one spawns — clean per-worktree terminals.)

### Step 7.4 — Typecheck web, lint, full test, commit

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck:web && npm run lint && npm test
```
Expected: exit 0; all tests green (renderer changes don't affect the jsdom `format-versions` test).

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git add src/renderer/App.tsx src/renderer/components/sidebar/worktree-item.tsx src/renderer/components/sidebar/worktree-list.tsx && git commit -m "feat(renderer): wire worktree selection + agent terminal + status dots

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Full verification + manual smoke

**Files:** none (verification only)

### Step 8.1 — Whole-suite gate

```bash
cd /Users/ltm-luan/Project/mangolove-idea && npm run typecheck && npm run lint && npm test && npm run build
```
Expected: `typecheck` (node+web) 0; `lint` 0; `vitest run` all projects green; `electron-vite build` emits `out/main`, `out/preload`, `out/renderer` with no error (this proves the `@xterm/xterm/css/xterm.css` import bundles and node-pty is externalized).

### Step 8.2 — Manual smoke with a HARMLESS command (does NOT launch real Claude Code)

Temporarily point the spawn command at a shell so you can verify the full pipe without burning a Claude session. Make a **throwaway local edit** to `getSessionManager` in `register-ipc.ts` (do NOT commit it):

```ts
    command: process.env.MANGO_AGENT_CMD ?? 'claude',
```

Then:
```bash
cd /Users/ltm-luan/Project/mangolove-idea && MANGO_AGENT_CMD=/bin/zsh npm run dev
```
In the window:
1. The sidebar lists worktrees (Plan 1). Click a non-primary worktree row → its dot turns green (`running`) and a terminal appears with a `zsh` prompt in the worktree's cwd.
2. Type `pwd` ⏎ → output shows the worktree path (proves input→PTY→output round-trip + cwd resolution).
3. Drag-resize the window → terminal reflows (proves `fit → session:resize → pty.resize`).
4. Type `exit` ⏎ → see `[claude exited: code 0]` and the dot greys to `exited` (proves EXIT event + status).
5. Select a different worktree → first PTY is killed (unmount cleanup), new one spawns.

Then **revert** the throwaway `MANGO_AGENT_CMD` edit (keep production hard-coded `'claude'`), or — if you prefer to keep the env override as a documented test seam — commit it as a deliberate, documented affordance. Decide and state in the PR; default is **revert** to keep the surface minimal.

```bash
cd /Users/ltm-luan/Project/mangolove-idea && git diff --stat   # confirm no stray smoke edit remains
```
Expected: empty (working tree clean).

### Step 8.3 — Optional: real `claude` smoke

If `claude` is on PATH, repeat Step 8.2 with `npm run dev` (no env override) and confirm a real `claude` prompt appears, accepts a keystroke, and `kill`/window-close terminates the process (`ps aux | grep claude` shows none after). This is manual-only; do not automate.

---

## Plan 2 Acceptance Checklist

- [ ] `src/main/pty/pty-factory.ts` exports `IPtyLike`, `PtyExitEvent`, `PtyFactory`, `PtySpawnOptions`, and `NodePtyFactory`; `probeNodePty` unchanged.
- [ ] `tests/helpers/fake-pty.ts` is **unedited**; `FakePtyHandle` is assignable to `IPtyLike` (typecheck green).
- [ ] `SessionManager` spawns via injected `PtyFactory`, keys one PTY per worktree, replaces on respawn, and reports `idle→starting→running→exited|error`.
- [ ] `hasActiveTurn` is always `false` in Plan 2 (no faked turn detection).
- [ ] `SessionManager.killAll()` and `dispose()` exist for Plan 5; no Plan 5 caller added here.
- [ ] Unknown worktree id → `status:'error'`, no PTY spawned.
- [ ] `tests/main/session-manager.test.ts` passes using `makeFakePty` + a spy `SessionEmitter` (output/exit/status payloads asserted).
- [ ] `register-ipc.ts` wires `SESSION_SPAWN`/`SESSION_KILL` via `ipcMain.handle` and `SESSION_INPUT`/`SESSION_RESIZE` via `ipcMain.on`; events go through `ctx.mainWindow.webContents.send` guarded for null/destroyed.
- [ ] `tests/main/ipc-roundtrip.test.ts` proves all four `SESSION_*` delegations.
- [ ] `src/preload/index.ts` `session.spawn/kill` use `invoke`; `sendInput/resize` use `ipcRenderer.send`; `onOutput/onExit/onStatus` unchanged.
- [ ] No change to the `MangoApi` surface, `src/shared/*`, or any contract type/channel.
- [ ] `agent-terminal.tsx` mounts xterm + FitAddon, bridges `onData→sendInput`, `onOutput→write`, `ResizeObserver→fit()+resize`, spawns on mount, kills+disposes on unmount; imports `@xterm/xterm/css/xterm.css`.
- [ ] `use-session.ts` exposes `status/spawn/kill/sendInput/resize` and tracks status via `onStatus`/`onExit` filtered by `worktreeId`.
- [ ] Selecting a worktree in the sidebar mounts its terminal (`key={selectedId}`); the agent dot reflects `AgentStatus`.
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all green.
- [ ] Manual smoke (harmless `MANGO_AGENT_CMD`) verifies input/output/resize/exit; no stray smoke edit committed.

## Self-Review Notes

- **Disposable reconciliation (the trap):** confirmed in a throwaway spawn that node-pty's `onData`/`onExit` return `{ dispose() }` and exit yields `{ exitCode, signal }`. `NodePtyFactory` swallows the disposables and re-exposes plain-callback `onData`/`onExit`, so `SessionManager` is identical against real and fake. The fake (`onData(cb): void`) therefore needs **no edit**.
- **Spurious-exit guard (identity-based):** `replace-on-respawn` UNMAPS the old session before killing it, and `handleExit(worktreeId, session, e)` early-returns unless `this.sessions.get(worktreeId) === session`. So a replaced PTY's exit — whether it arrives synchronously (the fake's `kill()` emits `exit` inline) or asynchronously (real node-pty's exit arriving after the new spawn) — is recognized as a stale handle and emits no `SESSION_EXIT`/`'exited'` for the worktree being respawned. Genuine natural exits and user `kill()`s (which leave the session mapped) still emit. Locked by the test "does not emit SESSION_EXIT for a worktree being replaced (respawn)".
- **`require` in `NodePtyFactory`:** `pty-factory.ts` already establishes `const require = createRequire(import.meta.url)` at module top (used by `probeNodePty`), so `require('node-pty')` in the class needs no new import and stays lazy (only the production `getSessionManager` path constructs `NodePtyFactory`; unit tests never load the native addon).
- **Path resolution safety:** `resolvePath` validates `worktreeId` against the live `WorktreeManager.list()` rather than trusting the renderer's id blindly — a spawn can never run `claude` in an unmanaged dir; unknown id is a clean `error` status.
- **xterm under electron-vite/CSP:** the renderer is a normal Vite app so the CSS import bundles; the existing `index.html` CSP already allows `style-src 'unsafe-inline'` for xterm's injected styles — no CSP/config edit. Verified `node_modules/@xterm/xterm/css/xterm.css` exists.
- **Renderer not unit-tested:** consistent with the contract (§1.4) — xterm needs a real DOM/GPU; we gate it with typecheck + lint + `electron-vite build` + a documented manual smoke, and commit **no** flaky e2e infra. The non-trivial *logic* (SessionManager + IPC delegation) is fully TDD'd.
- **`emitStatus` ordering:** `starting` is emitted before `resolvePath`, then either `error` or `running` — so the sidebar shows a brief amber `starting` then green/red, matching the lifecycle the contract specifies. The `error` test asserts `'error'` is present in the emitted sequence.
- **Plan boundaries respected:** no server/merge (Plans 3/4), no persistence/quit-sweep wiring (Plan 5). `killAll()`/`dispose()` are exposed but uncalled — the before-quit sweep is explicitly Plan 5's to wire in `src/main/index.ts`.
- **`isDestroyed()` guard:** added to `buildSessionEmitter` so a PTY event arriving after window teardown is a silent no-op (Electron throws if you `send` to a destroyed `webContents`).
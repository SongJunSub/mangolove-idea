# MangoLove IDEA — V2: Turn Detection (precise before-quit warning via output-activity)

> Status: READY TO IMPLEMENT. Date: 2026-06-19. Target: macOS.
> Stack: Electron 42 + React 19 + TypeScript 5.7 (ESM, `verbatimModuleSyntax`), node-pty 1.1.0, Vitest.

## Goal

Make the before-quit warning **precise**: fire it **only when an agent TURN is actively
running** — a turn that would be *lost* on quit — NOT merely when any `claude` session is
live.

A live-but-IDLE session is **lossless** to quit: b-lite re-spawns it via `claude --continue`
on restart and the conversation is restored. Only an **in-flight turn** (claude streaming
tokens / running a tool, mid-response) is actually lost. So the warning must key on
**"active turn"**, not "live session".

We detect an active turn with an **output-activity heuristic**, NOT by parsing the claude TUI:
a session has an active turn iff its PTY emitted output **within the last `ACTIVE_TURN_MS`
(= 1500 ms)**. During a turn claude streams tokens/tool output continuously; when idle it is
quiet. This is robust and **version-independent** — we never match spinner glyphs,
"esc to interrupt", or prompt shape (those are brittle across claude's fast-moving CLI).

This refines an EXISTING signal (`liveWorktreeIds` → `activeTurnWorktreeIds`) through the
EXISTING quit-warning flow. **No new IPC. No new manager.** `liveWorktreeIds()` stays (still
used by the SETTINGS_SET idle-guard + the kill-sweep); only the WARNING trigger and the
renderer copy change. The kill-sweep on confirmed quit STILL calls `killAll()` (kills ALL live
sessions, idle or not).

## Architecture

```
┌──────────────────────────── MAIN (SessionManager) ───────────────────────────────┐
│ Session { …, lastOutputAt: number }   ◄── NEW field                               │
│ spawn():   session.lastOutputAt = this.clock()   // counts as active until quiet  │
│ pty.onData(d => {                                                                  │
│   session.lastOutputAt = this.clock()   ◄── NEW: stamp every output byte          │
│   this.emitter.emitOutput({ worktreeId, data: d })                                │
│ })                                                                                 │
│                                                                                    │
│ hasActiveTurn(id): exists && !exited && clock() - lastOutputAt < ACTIVE_TURN_MS    │
│ activeTurnWorktreeIds(): liveWorktreeIds().filter(hasActiveTurn)   ◄── NEW         │
│ liveWorktreeIds(): UNCHANGED (idle-guard + kill-sweep still use it)                │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ activeTurnWorktreeIds()  (WARNING trigger)     │ liveWorktreeIds() (sweep, idle-guard)
        ▼                                                ▼
┌──────────────────────────── MAIN (QuitController/index.ts) ──────────────────────┐
│ deps.activeTurnWorktreeIds()  ◄── NEW dep, drives warn-vs-quit                    │
│ onBeforeQuit(): active = activeTurnWorktreeIds()                                  │
│   active.length === 0 -> sweepOnce() (orphan prevention), let quit proceed        │
│   active.length  > 0  -> preventDefault() + emitQuitWarning(active)               │
│ decide(true): confirmed; sweepOnce()  // sweep = sessionManager.killAll() (ALL)   │
│   index.ts sweep STILL calls killAll() — kills idle sessions too, unchanged       │
└────────────────────────────────────────────────────────────────────────────────────┘
        │ APP_QUIT_WARNING({ activeWorktreeIds })   (payload now = active TURNS)
        ▼
┌──────────────────────────── RENDERER (App.tsx) ──────────────────────────────────┐
│ quit-warning modal: copy updated "running agent turn(s)" (was "live session(s)") │
│ mechanics unchanged (onQuitDecision, data-testid="quit-warning")                 │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Key invariants:
- **Warning ⊆ live.** `activeTurnWorktreeIds()` is `liveWorktreeIds().filter(hasActiveTurn)`,
  so it is always a subset of the live set — never warns about an exited session.
- **Sweep is unchanged.** Confirmed quit (and the no-warning happy path) still sweeps via
  `sessionManager.killAll()` which kills EVERY live PTY, idle or busy. Only the WARNING
  *condition* changes — cleanup invariant (§7 orphan prevention) is untouched.
- **Just-spawned counts as active.** `lastOutputAt` is initialized to the spawn-time `clock()`,
  so a still-loading session (which has emitted nothing yet) is treated as an active turn until
  it goes quiet for `ACTIVE_TURN_MS`. This is the safe direction: better to warn than to
  silently kill a session mid-spin-up.
- **Additive.** No type field removed, no IPC added, no manager added. `QuitWarningEvent`
  shape is byte-identical (`activeWorktreeIds`); only its *meaning* sharpens (active turns).
- **Injected clock.** `this.clock` already exists (default `Date.now`). Reuse it for
  `lastOutputAt` and for `hasActiveTurn`'s comparison so tests drive time deterministically.

## Tech Stack

- No new dependencies. node-pty 1.1.0 PTY data stream is the only signal source.
- `ACTIVE_TURN_MS = 1500` — a module-level const in `session-manager.ts` documenting the
  gap-between-tokens tolerance. (1500 ms comfortably spans the pauses between streamed tokens /
  between a tool result and the next token, while collapsing to "idle" within ~1.5 s of the
  turn ending.)
- Vitest with the existing fake-pty (`tests/helpers/fake-pty.ts`) + an INJECTED clock for
  deterministic time. Mirror `tests/main/session-manager.test.ts` and
  `tests/main/quit-controller.test.ts` styles exactly.

**REQUIRED SUB-SKILL: superpowers:subagent-driven-development** — execute each task below as an
independent TDD unit (write failing test → run → see red → minimal COMPLETE impl → run → see
green → commit). Do not batch tasks; commit after each.

## File Structure

```
src/main/managers/session-manager.ts   MODIFIED  + ACTIVE_TURN_MS const, Session.lastOutputAt,
                                                   stamp in onData, hasActiveTurn(),
                                                   activeTurnWorktreeIds()
src/main/app/quit-controller.ts         MODIFIED  + deps.activeTurnWorktreeIds; warn keys on it
src/main/index.ts                       MODIFIED  + wire activeTurnWorktreeIds dep (sweep unchanged)
src/shared/types.ts                     MODIFIED  QuitWarningEvent doc-comment (meaning = active turns)
src/renderer/App.tsx                    MODIFIED  modal copy "running agent turn(s)"

tests/main/session-manager.test.ts      MODIFIED  + describe('SessionManager turn detection')
tests/main/quit-controller.test.ts      MODIFIED  + activeTurnWorktreeIds in deps() + 2 it()s
docs/V2-BACKLOG.md                       MODIFIED  strike-through C "실제 턴 감지 (hasActiveTurn)"
```

---

## Task 1 — SessionManager: `lastOutputAt` + `hasActiveTurn` + `activeTurnWorktreeIds` (TDD, injected clock)

### 1a. Write the failing test

Append a new `describe` block to the END of `tests/main/session-manager.test.ts` (after the
`SessionManager onIdle …` block, which currently ends at line ~247). It builds a manager with
an **injected clock** so we control time. We add a `clock` option to the local `makeManager`
helper and drive `emitData` on the fake to stamp `lastOutputAt`.

First, extend the `makeManager` helper to accept and pass a `clock`. Replace the helper's
options type + the `new SessionManager({...})` call:

**Anchor** (lines 43–59 of `tests/main/session-manager.test.ts`):

```ts
function makeManager(opts: {
  fakes: FakePtyHandle[];
  resolvePath?: (id: string) => Promise<string | undefined>;
  command?: string;
  onIdle?: () => void;
}) {
  const { factory, calls } = makeFakeFactory(opts.fakes);
  const { emitter, outputs, exits, statuses } = makeSpyEmitter();
  const mgr = new SessionManager({
    factory,
    emitter,
    command: opts.command ?? 'claude',
    resolvePath: opts.resolvePath ?? (async (id) => id),
    onIdle: opts.onIdle,
  });
  return { mgr, calls, outputs, exits, statuses };
}
```

Replace it with (adds the `clock` option, passed through):

```ts
function makeManager(opts: {
  fakes: FakePtyHandle[];
  resolvePath?: (id: string) => Promise<string | undefined>;
  command?: string;
  onIdle?: () => void;
  clock?: () => number;
}) {
  const { factory, calls } = makeFakeFactory(opts.fakes);
  const { emitter, outputs, exits, statuses } = makeSpyEmitter();
  const mgr = new SessionManager({
    factory,
    emitter,
    command: opts.command ?? 'claude',
    resolvePath: opts.resolvePath ?? (async (id) => id),
    onIdle: opts.onIdle,
    clock: opts.clock,
  });
  return { mgr, calls, outputs, exits, statuses };
}
```

Then append this new `describe` block at the very end of the file:

```ts
describe('SessionManager turn detection (output-activity heuristic, V2 C)', () => {
  // A mutable clock so the test advances "now" deterministically.
  function mutableClock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  }

  it('hasActiveTurn is true right after the session spawns (still-loading counts as active)', async () => {
    const clock = mutableClock();
    const { mgr } = makeManager({ fakes: [makeFakePty(1)], clock: clock.now });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    // lastOutputAt was initialized to spawn time; clock has not advanced.
    expect(mgr.hasActiveTurn(WT)).toBe(true);
  });

  it('hasActiveTurn is true while output keeps arriving within ACTIVE_TURN_MS', async () => {
    const clock = mutableClock();
    const fake = makeFakePty(1);
    const { mgr } = makeManager({ fakes: [fake], clock: clock.now });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    clock.advance(1499); // just under the threshold since spawn
    expect(mgr.hasActiveTurn(WT)).toBe(true);
    fake.emitData('token'); // re-stamps lastOutputAt to now (1000 + 1499)
    clock.advance(1499); // again just under the threshold since the last output
    expect(mgr.hasActiveTurn(WT)).toBe(true);
  });

  it('hasActiveTurn is false once the gap since last output reaches ACTIVE_TURN_MS', async () => {
    const clock = mutableClock();
    const { mgr } = makeManager({ fakes: [makeFakePty(1)], clock: clock.now });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    clock.advance(1500); // exactly the threshold -> NOT < ACTIVE_TURN_MS
    expect(mgr.hasActiveTurn(WT)).toBe(false);
  });

  it('hasActiveTurn is false for an exited session even if it emitted recently', async () => {
    const clock = mutableClock();
    const fake = makeFakePty(1);
    const { mgr } = makeManager({ fakes: [fake], clock: clock.now });
    await mgr.spawn({ worktreeId: WT, continueSession: false, cols: 80, rows: 24 });
    fake.emitData('mid-turn'); // recent output...
    fake.emitExit(0); // ...but the session has exited
    expect(mgr.hasActiveTurn(WT)).toBe(false);
  });

  it('hasActiveTurn is false for a worktree with no session', () => {
    const { mgr } = makeManager({ fakes: [] });
    expect(mgr.hasActiveTurn('/ghost')).toBe(false);
  });

  it('activeTurnWorktreeIds returns only the live sessions still inside ACTIVE_TURN_MS', async () => {
    const clock = mutableClock();
    const a = makeFakePty(1);
    const b = makeFakePty(2);
    const c = makeFakePty(3);
    const { mgr } = makeManager({ fakes: [a, b, c], clock: clock.now });
    await mgr.spawn({ worktreeId: '/wt/a', continueSession: false, cols: 80, rows: 24 });
    await mgr.spawn({ worktreeId: '/wt/b', continueSession: false, cols: 80, rows: 24 });
    await mgr.spawn({ worktreeId: '/wt/c', continueSession: false, cols: 80, rows: 24 });
    // Let everyone go quiet past the threshold...
    clock.advance(2000);
    // ...then only A emits again, so only A is "active".
    a.emitData('still working');
    expect(mgr.activeTurnWorktreeIds().sort()).toEqual(['/wt/a']);
    // B exits (dead): never counts. C stays idle: also excluded.
    b.emitExit(0);
    expect(mgr.activeTurnWorktreeIds().sort()).toEqual(['/wt/a']);
  });
});
```

### 1b. Run — expect RED

```
npx vitest run tests/main/session-manager.test.ts
```

Expected: the new block fails — `mgr.hasActiveTurn is not a function` /
`mgr.activeTurnWorktreeIds is not a function` (methods don't exist yet). All pre-existing tests
in the file still PASS (the `clock` option is additive and defaults to undefined → `Date.now`).

### 1c. Minimal COMPLETE implementation

In `src/main/managers/session-manager.ts`:

**(i)** Add the const at module top, after the imports (lines 1–2). Insert before the `SpawnArgs`
JSDoc (line 4):

```ts
/**
 * A turn is "active" iff the PTY emitted output within the last ACTIVE_TURN_MS.
 * Output-activity heuristic (NOT TUI-string parsing): during a turn claude streams
 * tokens/tool output continuously; when idle it is quiet. Version-independent.
 * 1500 ms tolerates the gap between streamed tokens while collapsing to "idle"
 * within ~1.5 s of the turn ending.
 */
const ACTIVE_TURN_MS = 1500;
```

**(ii)** Add the `lastOutputAt` field to the `Session` interface (anchor lines 47–54):

```ts
/** Internal per-worktree bookkeeping. */
interface Session {
  readonly pty: IPtyLike;
  status: AgentStatus;
  readonly continued: boolean;
  /** Guards against double exit emission (kill then natural exit). */
  exited: boolean;
  /**
   * Epoch ms (via injected clock) of the most recent PTY output. Initialized to
   * spawn time so a still-loading session counts as an active turn until it goes
   * quiet. Drives hasActiveTurn (output-activity heuristic, V2 C).
   */
  lastOutputAt: number;
}
```

**(iii)** Initialize `lastOutputAt` at spawn and stamp it in `onData`. Anchor (lines 111–114):

```ts
    const session: Session = { pty, status: 'running', continued: continueSession, exited: false };
    this.sessions.set(worktreeId, session);

    pty.onData((data) => this.emitter.emitOutput({ worktreeId, data }));
```

Replace with:

```ts
    const session: Session = {
      pty,
      status: 'running',
      continued: continueSession,
      exited: false,
      // Count a just-spawned (still-loading, no-output-yet) session as active until
      // it goes quiet for ACTIVE_TURN_MS — better to warn than silently kill spin-up.
      lastOutputAt: this.clock(),
    };
    this.sessions.set(worktreeId, session);

    pty.onData((data) => {
      // Stamp every output byte: this is the whole turn-detection signal.
      session.lastOutputAt = this.clock();
      this.emitter.emitOutput({ worktreeId, data });
    });
```

**(iv)** Add the two query methods. Insert immediately AFTER `liveWorktreeIds()` (its closing
`}` is at line 222), before the `recordActive` JSDoc (line 224):

```ts
  /**
   * True iff the worktree has a LIVE (non-exited) session whose last PTY output was
   * within ACTIVE_TURN_MS — i.e. a turn is in flight right now. The before-quit
   * WARNING keys on this (a running turn would be lost on quit); an idle live session
   * is lossless (b-lite re-spawns it via `claude --continue`). Output-activity
   * heuristic, NOT TUI parsing (V2 C).
   */
  hasActiveTurn(worktreeId: string): boolean {
    const s = this.sessions.get(worktreeId);
    if (!s || s.exited) return false;
    return this.clock() - s.lastOutputAt < ACTIVE_TURN_MS;
  }

  /**
   * Live worktrees that currently have an active turn (subset of liveWorktreeIds).
   * The before-quit warning fires only when this is non-empty. The kill-sweep on
   * confirmed quit STILL uses liveWorktreeIds()/killAll() (kills idle sessions too).
   */
  activeTurnWorktreeIds(): string[] {
    return this.liveWorktreeIds().filter((id) => this.hasActiveTurn(id));
  }
```

### 1d. Run — expect GREEN

```
npx vitest run tests/main/session-manager.test.ts
```

Expected: all tests pass, including the new `turn detection` block (6 new its) and every
pre-existing test (spawn/write/resize/exit/kill/onIdle).

### 1e. Typecheck (node project)

```
npm run typecheck:node
```

Expected: exits 0 (no errors).

### 1f. Commit

```
git add src/main/managers/session-manager.ts tests/main/session-manager.test.ts
git commit
```

Commit message:

```
feat(session): track lastOutputAt + hasActiveTurn for turn detection

Add an output-activity heuristic to SessionManager: stamp lastOutputAt on
every PTY output (via the injected clock) and expose hasActiveTurn(id) =
live && clock()-lastOutputAt < ACTIVE_TURN_MS (1500ms) plus
activeTurnWorktreeIds() = liveWorktreeIds().filter(hasActiveTurn).

This is the robust, version-independent signal for "a turn is in flight"
(NOT claude TUI-string parsing). Initialized to spawn time so a still-loading
session counts as active until it goes quiet. liveWorktreeIds() is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Task 2 — QuitController + index.ts: warning keys on `activeTurnWorktreeIds` (TDD; kill-sweep unchanged)

### 2a. Write the failing test

In `tests/main/quit-controller.test.ts`, the `deps()` helper currently provides only
`liveWorktreeIds`. Add `activeTurnWorktreeIds` to the base. **Anchor** (lines 4–14):

```ts
function deps(over: Partial<QuitControllerDeps> = {}) {
  const calls: string[] = [];
  const base = {
    liveWorktreeIds: () => ['/wt/a', '/wt/b'],
    emitQuitWarning: vi.fn((ids: readonly string[]) => calls.push(`warn:${ids.join(',')}`)),
    sweep: vi.fn(() => calls.push('sweep')),
    quitNow: vi.fn(() => calls.push('quitNow')),
    ...over,
  };
  return { base, calls };
}
```

Replace with (adds `activeTurnWorktreeIds`, defaulting to the same two so the EXISTING tests —
which assume the warning fires for `['/wt/a','/wt/b']` — keep passing):

```ts
function deps(over: Partial<QuitControllerDeps> = {}) {
  const calls: string[] = [];
  const base = {
    liveWorktreeIds: () => ['/wt/a', '/wt/b'],
    // The warning now keys on ACTIVE TURNS, not merely live sessions. Default to the
    // same two so the existing warn-on-quit tests are unchanged; idle-only cases
    // override this to [].
    activeTurnWorktreeIds: () => ['/wt/a', '/wt/b'],
    emitQuitWarning: vi.fn((ids: readonly string[]) => calls.push(`warn:${ids.join(',')}`)),
    sweep: vi.fn(() => calls.push('sweep')),
    quitNow: vi.fn(() => calls.push('quitNow')),
    ...over,
  };
  return { base, calls };
}
```

Then append these two new `it()`s INSIDE the existing `describe('QuitController', …)` block,
just before its closing `});` (line 70):

```ts
  it('does NOT warn when sessions are LIVE but all IDLE (no active turn): lets quit proceed, still sweeps', () => {
    // Live sessions exist (kill-sweep must still run) but none has an active turn,
    // so the warning must NOT fire — an idle session is lossless (claude --continue).
    const { base } = deps({
      liveWorktreeIds: () => ['/wt/a', '/wt/b'],
      activeTurnWorktreeIds: () => [],
    });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(base.emitQuitWarning).not.toHaveBeenCalled();
    expect(base.sweep).toHaveBeenCalledOnce(); // killAll still runs (kills idle sessions too)
  });

  it('warns with the ACTIVE-TURN worktrees (subset of live) and sweeps ALL on confirm', () => {
    // /wt/a and /wt/b are live, but only /wt/a has an active turn.
    const { base, calls } = deps({
      liveWorktreeIds: () => ['/wt/a', '/wt/b'],
      activeTurnWorktreeIds: () => ['/wt/a'],
    });
    const ctrl = new QuitController(base);
    const e = { preventDefault: vi.fn() };
    ctrl.onBeforeQuit(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(base.emitQuitWarning).toHaveBeenCalledWith(['/wt/a']); // active turns only
    expect(base.sweep).not.toHaveBeenCalled(); // not yet
    ctrl.decide(true);
    // Confirmed quit sweeps (killAll kills ALL live sessions, idle /wt/b included) then quits.
    expect(calls).toEqual(['warn:/wt/a', 'sweep', 'quitNow']);
  });
```

### 2b. Run — expect RED

```
npx vitest run tests/main/quit-controller.test.ts
```

Expected: the two new tests fail to compile/run because `QuitControllerDeps` has no
`activeTurnWorktreeIds` member and the controller still calls `liveWorktreeIds()` for the warn
decision (so `activeTurnWorktreeIds: () => []` with live sessions would still `preventDefault`).
TypeScript will also flag the unknown property in the `deps()` override objects.

### 2c. Minimal COMPLETE implementation

In `src/main/app/quit-controller.ts`:

**(i)** Add the dep to `QuitControllerDeps`. **Anchor** (lines 6–16):

```ts
/** Injected effects so QuitController is pure logic + unit-testable. */
export interface QuitControllerDeps {
  /** Worktrees with a live PTY right now (SessionManager.liveWorktreeIds). */
  liveWorktreeIds(): string[];
  /** Sends APP_QUIT_WARNING({activeWorktreeIds}) to the renderer. */
  emitQuitWarning(activeWorktreeIds: readonly string[]): void;
  /** The PTY/server kill-sweep (sessionManager.killAll + serverManager.dispose). */
  sweep(): void;
  /** Actually quit (app.quit). Re-fires before-quit; the confirmed flag lets it through. */
  quitNow(): void;
}
```

Replace with (adds `activeTurnWorktreeIds`; keeps `liveWorktreeIds` for documentation/back-compat
even though the warn decision no longer reads it):

```ts
/** Injected effects so QuitController is pure logic + unit-testable. */
export interface QuitControllerDeps {
  /**
   * Worktrees with a live PTY right now (SessionManager.liveWorktreeIds). Retained for
   * the kill-sweep / orphan reasoning; the warn-vs-quit decision uses
   * activeTurnWorktreeIds (only an in-flight turn is lost on quit).
   */
  liveWorktreeIds(): string[];
  /**
   * Worktrees with an ACTIVE TURN right now (SessionManager.activeTurnWorktreeIds): a
   * running turn would be lost on quit. The before-quit WARNING fires only when this
   * is non-empty. An idle live session is lossless (b-lite re-spawns via --continue).
   */
  activeTurnWorktreeIds(): string[];
  /** Sends APP_QUIT_WARNING({activeWorktreeIds}) to the renderer (now = active turns). */
  emitQuitWarning(activeWorktreeIds: readonly string[]): void;
  /** The PTY/server kill-sweep (sessionManager.killAll + serverManager.dispose). */
  sweep(): void;
  /** Actually quit (app.quit). Re-fires before-quit; the confirmed flag lets it through. */
  quitNow(): void;
}
```

**(ii)** Change the warn decision to read `activeTurnWorktreeIds`. **Anchor** (lines 43–51):

```ts
    const live = this.deps.liveWorktreeIds();
    if (live.length === 0) {
      this.sweepOnce(); // unconditional orphan prevention even on the happy path.
      return;
    }
    e.preventDefault();
    this.deps.emitQuitWarning(live);
```

Replace with:

```ts
    // WARN only when a TURN is in flight — an idle live session is lossless to quit
    // (b-lite re-spawns it via `claude --continue`). The kill-sweep below STILL kills
    // ALL live sessions (idle ones included) via sweep()/killAll().
    const activeTurns = this.deps.activeTurnWorktreeIds();
    if (activeTurns.length === 0) {
      this.sweepOnce(); // unconditional orphan prevention even on the happy path.
      return;
    }
    e.preventDefault();
    this.deps.emitQuitWarning(activeTurns);
```

**(iii)** Update the class JSDoc to reflect the new condition. **Anchor** (lines 18–31, the
block comment above `export class QuitController`). Replace the two lines:

```
 *  1st before-quit, sessions live, not confirmed  -> preventDefault + emit warning.
```
with
```
 *  1st before-quit, a turn is in flight, not confirmed -> preventDefault + emit warning.
```
and
```
 * When NO sessions are live we never intercept, but we STILL sweep exactly once so
 * a server child / any stray PTY can't be orphaned (binding invariant §7).
```
with
```
 * When NO turn is active we never intercept (idle live sessions are lossless), but we
 * STILL sweep exactly once — killAll() kills ALL live PTYs (idle included) so a server
 * child / any stray PTY can't be orphaned (binding invariant §7).
```

Now wire the new dep in `src/main/index.ts`. **Anchor** (lines 54–62):

```ts
const quitController = new QuitController({
  liveWorktreeIds: () => ctx.sessionManager?.liveWorktreeIds() ?? [],
  emitQuitWarning,
  sweep: () => {
    ctx.sessionManager?.killAll(); // orphan-claude prevention (binding invariant §7).
    ctx.serverManager?.dispose(); // Plan 3 server cleanup.
  },
  quitNow: () => app.quit(),
});
```

Replace with:

```ts
const quitController = new QuitController({
  liveWorktreeIds: () => ctx.sessionManager?.liveWorktreeIds() ?? [],
  // The before-quit WARNING keys on ACTIVE TURNS (a running turn would be lost on quit),
  // NOT on live sessions — an idle live session is lossless (b-lite re-spawns it via
  // `claude --continue`). The sweep below still calls killAll() (kills idle ones too).
  activeTurnWorktreeIds: () => ctx.sessionManager?.activeTurnWorktreeIds() ?? [],
  emitQuitWarning,
  sweep: () => {
    ctx.sessionManager?.killAll(); // orphan-claude prevention (binding invariant §7).
    ctx.serverManager?.dispose(); // Plan 3 server cleanup.
  },
  quitNow: () => app.quit(),
});
```

### 2d. Run — expect GREEN

```
npx vitest run tests/main/quit-controller.test.ts
```

Expected: all tests pass — the 5 pre-existing (default `activeTurnWorktreeIds` mirrors
`liveWorktreeIds` so warn-on-quit and no-live-no-warn cases are unchanged) and the 2 new
(idle-live → no warn but sweep; active-subset → warn with active ids, sweep all on confirm).

### 2e. Typecheck (node project)

```
npm run typecheck:node
```

Expected: exits 0. (`index.ts` and `quit-controller.ts` both compile; the new dep is
satisfied by `ctx.sessionManager?.activeTurnWorktreeIds()` from Task 1.)

### 2f. Commit

```
git add src/main/app/quit-controller.ts src/main/index.ts tests/main/quit-controller.test.ts
git commit
```

Commit message:

```
feat(quit): warn only when an agent turn is in flight

QuitController's before-quit warning now keys on activeTurnWorktreeIds()
instead of liveWorktreeIds(): an idle live session is lossless to quit
(b-lite re-spawns it via `claude --continue`), so warning on it is noise.
Only an in-flight turn is actually lost.

The kill-sweep on confirmed quit is UNCHANGED — sweep() still calls
sessionManager.killAll(), which kills ALL live PTYs (idle ones included),
preserving orphan-prevention (binding invariant §7). liveWorktreeIds() is
retained on the deps for the sweep/idle reasoning.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Task 3 — Renderer + shared type: quit-warning copy now means "running agent turn(s)"

This task has no unit test (no RTL in the repo — see V2-BACKLOG scrollback note); it is gated on
`typecheck:web` + `build`. The change is a minimal copy edit + a doc-comment sharpen; modal
mechanics (`data-testid="quit-warning"`, `onQuitDecision`, the two buttons) are untouched.

### 3a. Update the shared type's doc-comment (meaning, not shape)

In `src/shared/types.ts`, the `QuitWarningEvent` JSDoc currently says the warning is driven by
LIVE PTYs and that `hasActiveTurn` stays false. That is now stale. **Anchor** (lines 259–268):

```ts
/**
 * Emitted to the renderer at quit (MVP item 6) when agent sessions are live, so
 * the user can confirm before the PTYs are swept. NOTE: this is driven by LIVE
 * (running, non-exited) PTYs, not by turn detection — `hasActiveTurn` stays false
 * (b-lite declines real turn detection; warning-on-live-session is the honest MVP).
 */
export interface QuitWarningEvent {
  /** worktreeIds that currently have a running (non-exited) claude PTY. */
  readonly activeWorktreeIds: readonly string[];
}
```

Replace with (shape identical; meaning sharpened to active turns — V2 C):

```ts
/**
 * Emitted to the renderer at quit when an agent TURN is in flight, so the user can
 * confirm before the PTYs are swept. As of V2 C this is driven by TURN DETECTION
 * (output-activity heuristic: a session that emitted output within ACTIVE_TURN_MS),
 * NOT by mere liveness — an idle live session is lossless to quit (b-lite re-spawns
 * it via `claude --continue`). The kill-sweep on confirmed quit still kills ALL live
 * PTYs; only this WARNING keys on active turns.
 */
export interface QuitWarningEvent {
  /** worktreeIds that currently have an ACTIVE TURN (live PTY, output within ACTIVE_TURN_MS). */
  readonly activeWorktreeIds: readonly string[];
}
```

### 3b. Update the modal copy in `App.tsx`

**Anchor** (lines 369–374):

```tsx
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Quit MangoLove IDEA?</h2>
            <p style={{ fontSize: 13 }}>
              {quitWarning.activeWorktreeIds.length} agent session(s) are live. They will be
              terminated (their conversations are saved by claude and resume with{' '}
              <code>--continue</code> next time). Quit anyway?
            </p>
```

Replace with (copy now says "running agent turn(s)"; resume reassurance kept):

```tsx
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Quit MangoLove IDEA?</h2>
            <p style={{ fontSize: 13 }}>
              {quitWarning.activeWorktreeIds.length} running agent turn(s) are in flight and
              would be interrupted. (Conversations are saved by claude and resume with{' '}
              <code>--continue</code> next time — only the in-flight turn is lost.) Quit anyway?
            </p>
```

### 3c. Typecheck (web project) + build

```
npm run typecheck:web
npm run build
```

Expected: both exit 0. `typecheck:web` confirms the `App.tsx` JSX + the `QuitWarningEvent`
import still type-check (shape unchanged → no break); `build` confirms the renderer bundle
compiles.

### 3d. Commit

```
git add src/shared/types.ts src/renderer/App.tsx
git commit
```

Commit message:

```
feat(renderer): quit-warning copy reflects active turns, not live sessions

The APP_QUIT_WARNING payload now carries active-TURN worktrees (V2 C), so the
modal copy changes from "N agent session(s) are live" to "N running agent
turn(s) are in flight and would be interrupted", keeping the --continue resume
reassurance. Sharpen QuitWarningEvent's doc-comment to match (shape unchanged).
Modal mechanics (testid, decision buttons) untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Task 4 — Full suite + documented smoke + V2-BACKLOG strike-through

### 4a. Run the full suite + all typechecks

```
npm test
npm run typecheck
```

Expected: `npm test` (vitest run) is fully green — in particular
`tests/main/session-manager.test.ts`, `tests/main/session-manager-persistence.test.ts`,
`tests/main/quit-controller.test.ts`, and `tests/main/ipc-roundtrip.test.ts` (the
`{ killAll, liveWorktreeIds }` session mocks there are unaffected — we added a method, removed
none). `npm run typecheck` (node + web) exits 0.

### 4b. Documented manual smoke

These are the two acceptance behaviors. Run `npm run dev`, open a worktree to spawn `claude`,
then:

1. **Turn running → quit WARNS.** Send a prompt so claude is actively streaming a response
   (tokens visibly arriving). While it is mid-turn, press ⌘Q. EXPECT: the quit-warning modal
   appears reading "1 running agent turn(s) are in flight…". Click **Cancel** → app stays open,
   turn continues.
2. **Idle session → quit does NOT warn.** Let claude finish its turn and sit at the idle prompt
   for >1.5 s (no output). Press ⌘Q. EXPECT: NO modal — the app quits immediately, and the PTY
   is still swept (no orphaned `claude`: verify with `pgrep -fl claude` showing none from the
   app after quit).

(Optional precision check: with a session mid-turn, `activeTurnWorktreeIds()` is non-empty;
~1.5 s after the last token it becomes empty — the same transition the smoke exercises.)

### 4c. Strike through the V2-BACKLOG item

In `docs/V2-BACKLOG.md`, section **C** (line 32), the row currently reads:

```
| **실제 턴 감지 (`hasActiveTurn`)** | M | Plan 2 | *드러난 후보.* b-lite가 의도적으로 포기한 것. claude TUI 출력 파싱 → 종료 경고를 "라이브 세션"이 아닌 "실행 중인 턴" 기준으로 정밀화. **b-full의 전제** |
```

Replace with (strike-through + ✅ 완료 + approach correction: output-activity, NOT TUI parsing):

```
| ~~**실제 턴 감지 (`hasActiveTurn`)**~~ ✅ **완료** | M | Plan 2 | 종료 경고를 "라이브 세션"이 아닌 **"실행 중인 턴"** 기준으로 정밀화. 접근: **출력 활동 휴리스틱**(claude TUI 문자열 파싱 X — 버전 취약) — PTY가 최근 `ACTIVE_TURN_MS`(1500ms) 내 출력했으면 턴 진행 중. `SessionManager.lastOutputAt`(주입 clock 스탬프) + `hasActiveTurn`/`activeTurnWorktreeIds`. 경고 트리거만 `liveWorktreeIds`→`activeTurnWorktreeIds`로 교체(idle 라이브 세션은 `--continue`로 무손실). kill-sweep는 그대로 `killAll()`(idle 포함 전부). 신규 IPC/매니저 0. **b-full의 전제**. 계획: docs/plans/2026-06-19-v2-turn-detection.md |
```

Also update the status line near the top (line 9) to append this completion. **Anchor** (the end
of line 9, after `**임베디드 브라우저 뷰 완료**.`):

```
**임베디드 브라우저 뷰 완료**.
```

Replace with:

```
**임베디드 브라우저 뷰 완료**, **턴 감지(`hasActiveTurn`) 완료**.
```

### 4d. Commit

```
git add docs/V2-BACKLOG.md
git commit
```

Commit message:

```
docs: mark V2 C turn detection (hasActiveTurn) complete

Strike through the C-section backlog item; record the shipped approach
(output-activity heuristic, NOT claude TUI parsing) and that only the warning
trigger changed (liveWorktreeIds -> activeTurnWorktreeIds), kill-sweep
unchanged. Link the plan.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## Migration Strategy (additive)

- **No schema/IPC changes.** `QuitWarningEvent` keeps its exact shape (`activeWorktreeIds:
  readonly string[]`); only its *meaning* sharpens (live → active turn) and its doc-comment.
  No preload/contract edits, no channel added.
- **`liveWorktreeIds()` retained.** Still used by the SETTINGS_SET idle-guard
  (`register-ipc.ts:663`) and the kill-sweep (`index.ts` `sweep`). We only ADD
  `hasActiveTurn`/`activeTurnWorktreeIds`. Existing session mocks in `ipc-roundtrip.test.ts`
  (`{ killAll, liveWorktreeIds }`) keep working unchanged — no method removed.
- **`clock` already injected.** `lastOutputAt` reuses the existing `this.clock` (default
  `Date.now`), so production behavior is correct with zero new wiring; tests inject a fake clock.
- **Backward-compatible warning.** When a session is genuinely busy (which is the case the old
  live-based warning meant to catch during a turn), the new path still warns — it just ALSO
  stops warning for idle-but-live sessions, which is the intended precision gain.
- **Rollback** is a one-line revert in `quit-controller.ts`/`index.ts` (point the warn decision
  back at `liveWorktreeIds`); the SessionManager additions are inert if unused.

## Acceptance Checklist

- [ ] `ACTIVE_TURN_MS = 1500` const added to `session-manager.ts` with rationale comment.
- [ ] `Session.lastOutputAt` initialized to spawn-time `clock()`; stamped on every `onData`.
- [ ] `hasActiveTurn(id)` = exists && !exited && `clock() - lastOutputAt < ACTIVE_TURN_MS`.
- [ ] `activeTurnWorktreeIds()` = `liveWorktreeIds().filter(hasActiveTurn)`.
- [ ] SessionManager turn-detection tests pass (true right after spawn; true within window;
      false at/after threshold; false on exited; false on no-session; subset for several lives).
- [ ] `QuitControllerDeps.activeTurnWorktreeIds` added; warn decision reads it (not
      `liveWorktreeIds`).
- [ ] QuitController tests pass: idle-live → no warn but sweeps; active-subset → warn with
      active ids, sweep ALL on confirm; the 5 pre-existing tests still pass.
- [ ] `index.ts` wires `activeTurnWorktreeIds: () => ctx.sessionManager?.activeTurnWorktreeIds()
      ?? []`; `sweep` STILL calls `killAll()` (unchanged).
- [ ] `QuitWarningEvent` doc-comment sharpened (shape unchanged); App.tsx modal copy reads
      "running agent turn(s) … in flight".
- [ ] `npm test` green; `npm run typecheck` (node+web) exits 0; `npm run build` exits 0.
- [ ] Manual smoke: turn running → warns; idle session → no warn, no orphaned `claude`.
- [ ] V2-BACKLOG C item struck through + status line updated; plan linked.

## Self-Review

- **Why output-activity and not TUI parsing?** claude is a fast-moving CLI; spinner glyphs,
  "esc to interrupt", and prompt shape change across versions and break silently. PTY
  output-presence is a stable, version-independent proxy: a turn streams, idle is quiet.
- **Why count a just-spawned session as active?** A still-loading session has emitted nothing,
  so a "no output yet" rule would treat it as idle and silently kill spin-up on quit.
  Initializing `lastOutputAt` to spawn time makes the safe choice (warn) until it proves quiet.
- **Threshold edge.** `< ACTIVE_TURN_MS` (strict) means exactly 1500 ms since last output reads
  as idle; the tests pin both `1499 → active` and `1500 → idle`. 1500 ms tolerates inter-token
  gaps without lingering.
- **Accepted false-negative: a long SILENT mid-turn gap.** If a turn is genuinely running but
  claude emits nothing for > ACTIVE_TURN_MS (a slow tool call — a long bash run, a network wait),
  `hasActiveTurn` reads idle and the warning is suppressed for that worktree. TOLERATED, not a
  bug: even if the user quits in that gap, the kill-sweep kills the PTY and b-lite's
  `claude --continue` restores the conversation on next launch — only that one in-flight tool
  result is lost, and the alternative (TUI-string parsing to catch the gap) is the brittle,
  version-fragile approach this design deliberately rejects. The window is small (1.5 s) and
  quitting mid-tool-call is rare; the activity proxy is the right robustness/precision balance.
- **Sweep vs warning are deliberately decoupled.** The whole point: the WARNING shrinks to
  active turns, but cleanup must NOT — `killAll()` still kills every live PTY (idle included) so
  no `claude`/server child is orphaned (§7). The Task 2 test asserts `decide(true)` sweeps even
  when only a subset had active turns.
- **No re-entrancy regression.** The `confirmedQuit`/`sweptOnQuit` latches are untouched; we
  only swapped which list the first-pass decision reads. The "decide(true) then re-fired
  before-quit falls through" test still passes (default mock keeps the warning firing once).
- **Idle-guard unaffected.** SETTINGS_SET still reads `liveWorktreeIds().length` — turn activity
  has nothing to do with whether a settings rebuild can safely happen, so that path is left
  exactly as-is.
- **Renderer is copy-only.** Shape-identical payload means no hook/preload/contract change and no
  risk to the existing `data-testid="quit-warning"` Playwright selector.

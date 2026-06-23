# GUI smoke — Session persistence b-full (abduco detach + re-attach)

Validates that, with `sessionPersistence: full`, an in-flight agent turn SURVIVES the
app quitting/crashing and re-attaches on reopen — plus the kill-switch, quit-consent,
and loud-fallback controls.

Prereq: `abduco` installed (`brew install abduco`). macOS only.

## Safe isolation (gui-smoke-isolation pattern — never touches the real repo/config)

Throwaway Playwright/Electron driver in a scratch dir (NOT committed). Set up:

- `--user-data-dir=<temp>` so settings/session/scrollback stores are isolated.
- Seed `<temp>/settings.json` with `{ "repoRoot": "<seeded temp git repo>",
  "sessionPersistence": "full" }`.
- `MANGO_AGENT_CMD=<fake-agent>` — a harmless script that, like the Phase 0 spike
  agent, prints a startup marker then an incrementing `TICK n` every ~300 ms and
  self-exits after ~60 s (so nothing lingers). This stands in for `claude` so the
  smoke needs no real agent / tokens.
- `MANGO_HEADLESS=1` so the window never appears on screen.
- Teardown: `app.close()` ONLY; then kill EXACT `mango-<hash>` abduco masters captured
  by name (never a broad `pkill`).

## Scenario 1 — full mode wraps the agent in abduco

1. Boot the app (full mode, seeded repo). Create/select a worktree so its terminal mounts.
2. Run `abduco` (no args). EXPECT: a `mango-<16hex>` session exists for that worktree.
3. EXPECT (in xterm): the fake agent's startup marker + climbing `TICK n`.

## Scenario 2 — in-flight turn survives a HARD app kill, re-attaches on reopen (core DoD)

1. With the agent mid-"turn" (TICK climbing), capture the current TICK value `t1`.
2. Hard-kill the app process (SIGKILL the captured Electron pid — simulates a crash;
   NOT a graceful quit, NOT a broad pattern).
3. Wait ~2 s. Run `abduco`. EXPECT: the `mango-<hash>` session is STILL listed
   (master + agent survived).
4. Relaunch the app on the same `--user-data-dir` + repo. Select the same worktree.
5. EXPECT: the terminal re-attaches (main's 3-way picks `attach`) and shows `TICK n`
   with `n` MUCH greater than `t1` — proving the turn kept running while the app was
   gone (b-lite would have shown a fresh/`--continue` session that lost the turn).

## Scenario 3 — kill-switch

1. With ≥1 live `mango-` session, open Settings → click "Stop all background agents".
2. EXPECT: `abduco` lists zero `mango-` sessions; the note "All background agents
   stopped." appears.

## Scenario 4 — quit consent (2-choice)

1. With an active turn, trigger app quit (Cmd-Q / before-quit).
2. EXPECT: the quit dialog shows the b-full wording ("keep running in the background")
   with `quit-keep-running` and `quit-stop-all` buttons (NOT the b-lite "Quit anyway").
3. "Keep running & quit": app quits, `abduco` still lists the session.
4. (Fresh run) "Stop all & quit": app quits AND `abduco` lists no `mango-` session.

## Scenario 5 — loud fallback (abduco unavailable)

1. Boot full mode in an env where `resolveAbducoPath` returns null (e.g. a build with
   no bundled abduco and no dev abduco on the probe paths).
2. Open Settings, enable b-full. EXPECT: `settings-persist-warning` shows
   "abduco not found — b-full is disabled … brew install abduco", and
   `session.persistenceInfo()` reports `{requested:'full', effective:'lite',
   abducoAvailable:false}`. The agent runs as b-lite (no abduco wrap).

## Acceptance

- [ ] S1: a `mango-<hash>` session is created in full mode.
- [ ] S2: session survives a SIGKILL of the app and re-attaches with advanced TICK (DoD).
- [ ] S3: kill-switch removes all `mango-` sessions.
- [ ] S4: quit dialog offers keep/stop-all; each behaves as labeled.
- [ ] S5: abduco-missing surfaces the loud warning; effective mode = lite.
- [ ] Teardown leaves zero `mango-` sessions/processes (leak 0).

## Notes / mechanism evidence

- The detach/survival mechanism itself is independently proven by the Phase 0 spike
  (`scratchpad/_spike.mjs`): node-pty-spawned abduco master + agent survive
  SIGHUP/SIGTERM/SIGKILL of the front-end and re-attach with live output (3/3).
- The launcher arg/decision/kill logic, slug safety, loud fallback, and ps/list
  parsing are covered by unit tests (`tests/main/abduco-*.test.ts`,
  `session-manager.test.ts`, `session-persistence-info.test.ts`).

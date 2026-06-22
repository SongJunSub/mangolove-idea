# Multi-window GUI smoke (one repo per OS window)

Manual smoke proving the multi-window model. Two windows, two DIFFERENT repos,
each operating independently; closing one sweeps only its processes; quit sweeps both.

## Setup
- Two distinct local git repos, e.g. `/tmp/repoA` and `/tmp/repoB` (each `git init`).
- `MANGO_AGENT_CMD` / `MANGO_SERVER_CMD` may be set to harmless line-emitters for a
  windowless-friendly run (see existing smokes), but a real `claude`/server is fine.
- `npm run dev`.

## Steps + expected results

1. **Boot opens one window on the most-recent repo.**
   - Expect: a single window loads repoA (or the empty picker if recentRepos is empty).
   - If empty picker: click "Select repository…", choose `/tmp/repoA`. The SAME window
     reloads into repoA's worktree UI (NO app relaunch — other state untouched).

2. **Open a SECOND window on a SECOND repo.**
   - In repoA's window, click "change repo" and pick `/tmp/repoB`.
   - Expect: a window now shows repoB. repoA's window stays open and unchanged.
   - (MVP: change-repo on a window with a repo opens/focuses per openOrFocusRepo; the
     empty-gate attach path is exercised by the first-boot picker.)

3. **Same repo twice is FORBIDDEN → focus.**
   - From repoB's window, pick `/tmp/repoA` again.
   - Expect: the EXISTING repoA window is focused; NO third window opens.

4. **Independent operation — no cross-window leak.**
   - In repoA: create a worktree, spawn a session, start the server. Watch logs stream.
   - In repoB: create a DIFFERENT worktree, spawn a session, start the server.
   - Expect: repoA's terminal output / server logs / events appear ONLY in repoA's
     window; repoB's ONLY in repoB's. No event from A leaks into B (each emitter targets
     its own ctx.mainWindow).

5. **Closing one window sweeps ONLY its processes.**
   - Close repoB's window.
   - Expect: repoB's claude PTYs + server children are killed (verify with
     `ps aux | grep -E 'claude|<server-bin>'` — repoB's pids gone, repoA's still alive).
     repoA's window keeps working normally.

6. **Quit sweeps BOTH windows (no orphans).**
   - Re-open repoB (change repo → repoB), start a session in each window.
   - Quit the app (Cmd-Q). If a turn is in flight in either window, the quit-warning
     modal appears in that window; confirm.
   - Expect: after quit, `ps aux | grep -E 'claude|<server-bin>'` shows NONE of either
     window's children survive (aggregate sweep killAll+dispose over the whole registry).

## Pass criteria
- Two repos run side by side, fully isolated.
- Same-repo-twice focuses, never duplicates.
- Per-window close sweeps only that window; quit sweeps all. No orphan claude/server.

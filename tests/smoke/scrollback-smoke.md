# Scrollback replay smoke (manual)

No automated assertion is added (the behavior is timing- and PTY-bound); this documents the
exact reproduction so a human or the existing Playwright harness can confirm it.

1. `npm run dev`. Create/select a worktree; let `claude` render a recognizable screen
   (e.g. type a prompt so there is visible output). Wait > 1.5 s so the throttled persist
   fires (or just switch away, which forces the final persist).
2. Select a DIFFERENT worktree, then select the FIRST one again. EXPECT: the saved screen
   flashes instantly (instant restore), then — the moment `claude --continue` emits its first
   byte — the screen RESETS ONCE and is replaced by the live `--continue` render with **no**
   doubled/garbled lines.
3. Quit and relaunch the app, select the worktree. EXPECT: same — the persisted screen flashes,
   then resets to the live render. Confirm `~/Library/Application Support/<app>/scrollback.json`
   exists and is bounded (each value ≤ 256 KB).
4. Remove a worktree (merge+cleanup OR direct remove via IPC). EXPECT: its key is gone from
   `scrollback.json` (direct/IPC remove) or bounded by the cap (merge-runner path).

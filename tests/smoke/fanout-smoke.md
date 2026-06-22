# Multimodel Fan-out — manual GUI smoke

Proves a real 2-lane fan-out end to end: one prompt -> 2 worktrees + 2 headless
claude runs -> 2 diffs -> select one -> merge into base -> losers discarded.

## Preconditions
- A real `claude` on PATH (logged in), OR set `MANGO_AGENT_CMD` to a fake agent that
  edits a file in cwd, prints a line, and exits 0 (proves the wiring without burning tokens).
- A clean primary worktree (no uncommitted tracked changes — the winner merge gates on this).
- `git -C <repo> log --oneline -1` noted (to confirm the merge lands a new commit).

## Steps
1. Launch the app (`npm run dev`) and select the repo.
2. Click **⑃ Fan-out** in the toolbar. The Fan-out panel opens (idle: prompt + model picker + skip-permissions toggle + Start).
3. Type a small prompt, e.g. `Add a one-line note to README.md describing this lane.`
4. Tick exactly two models (e.g. opus + haiku). Leave **Skip permissions OFF**.
5. Click **Start fan-out**. Expect:
   - Two lane cards appear (opus, haiku), each transitioning `running` -> `done`.
   - `git -C <repo> worktree list` shows two new `.worktrees/fanout-<id>-<slug>` worktrees on `fanout/<id>/<slug>` branches.
6. Click the **opus** lane card (done). Its **DiffView** loads — confirm the README edit shows as a real diff vs base.
7. Click the **haiku** lane card — confirm a DIFFERENT diff (each model edited independently).
8. Toggle **Skip permissions ON** on a fresh run only to confirm the red warning copy renders; do NOT leave it on for untrusted prompts.
9. With a done lane selected, click **Use this lane (<model>)**. Expect:
   - The merge runs; the panel clears (run -> null) on `status: 'merged'`.
   - `git -C <repo> log --oneline -1` shows the winner's commit on base.
   - `git -C <repo> worktree list` shows ALL fan-out worktrees gone (winner cleaned by MergeRunner, loser removed by select()).
   - The worktree list refreshes (onMerged -> refresh()).
10. Re-run a fan-out, then click **Abort** while/after lanes run. Expect every fan-out worktree removed and the panel back to idle.

## Pass criteria
- 2 lanes -> 2 distinct diffs; select merges exactly one; the other worktrees vanish; abort tears the whole run down; the rest of the app (terminal/diff/conflict/server/PR panels) is unchanged.

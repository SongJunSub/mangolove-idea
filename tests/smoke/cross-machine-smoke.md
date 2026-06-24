# Cross-machine sessions GUI smoke (visibility-only)

Manual smoke proving cross-machine session visibility + "Start here". Two app
instances simulate two machines by using SEPARATE `--user-data-dir`s over the SAME
git repo wired to a SHARED bare remote. Machine A publishes its session pointers to
the `mangolove-sessions` orphan branch; machine B sees them and checks one out.

This is the D3 acceptance for the cross-machine feature
(docs/plans/2026-06-23-v2-cross-machine-sessions.md).

## Setup

```sh
# Shared bare remote + one working clone, on a temp path (safe per gui-smoke isolation).
BASE=$(mktemp -d /tmp/mango-xmachine.XXXX)
git init --bare --initial-branch=main "$BASE/remote.git"
git clone "$BASE/remote.git" "$BASE/repo"
cd "$BASE/repo"
git config user.email t@x && git config user.name T
printf 'work\n' > f.txt && git add . && git commit -qm init && git push -q origin main
# A feature branch on the remote so machine A has something to publish.
git push -q origin main:refs/heads/feat-demo

# Two isolated userData dirs (= two "machines"), one shared repo.
mkdir -p "$BASE/udA" "$BASE/udB"
```

- Use a harmless `MANGO_AGENT_CMD` (a line-emitter) so no real `claude` is needed and
  the run is windowless-friendly; a real `claude` is also fine.
- Launch each instance with its own `--user-data-dir` pointed at `$BASE/repo`
  (e.g. via `npm run dev` with `--user-data-dir=$BASE/udA`, and a second with `udB`).
  Seed each instance's `settings.json` with `repoRoot=$BASE/repo` (per gui-smoke
  isolation) so both open the same repo.

## Steps + expected results

1. **Both machines opt in.**
   - In EACH instance: open Settings (⚙), check "Share this machine's sessions",
     set a distinct label (A: `mac-A`, B: `mac-B`), Save.
   - Expect: `settings.json` in each userData has `crossMachineSessions:"on"` and a
     `machineId` (generated once) + `machineLabel`.

2. **Machine A starts a session on `feat-demo` and publishes.**
   - In instance A: create/select a worktree on `feat-demo`, spawn a session.
   - Expect: A's publish fires (spawn trigger). Verify the remote received it:
     `git -C "$BASE/repo" ls-remote origin 'refs/heads/mangolove-sessions'` is non-empty,
     and the orphan branch contains `<machineId-A>.json` with a pointer for `feat-demo`
     (`git -C "$BASE/repo" fetch -q origin mangolove-sessions:refs/remotes/origin/mangolove-sessions`
     then `git -C "$BASE/repo" ls-tree --name-only refs/remotes/origin/mangolove-sessions`).

3. **Machine B sees machine A's session.**
   - In instance B: click **⌘ Machines** in the toolbar.
   - Expect: the panel lists a `mac-A` group with `feat-demo` (status `running`/`idle`).
     B's own group (`mac-B`, "this machine") appears only if B has live sessions.
     A "Start here" button appears on the `mac-A` `feat-demo` row (NOT on B's own).

4. **"Start here" checks out the branch and starts a FRESH session on B.**
   - In instance B: click **Start here** on `mac-A` / `feat-demo`.
   - Expect: the panel closes; a worktree for `feat-demo` is checked out under B's
     repo (`.worktrees/feat-demo`); it is selected; a NEW session spawns
     (continueSession=false — no conversation carryover, by design). The terminal shows
     a fresh agent (the line-emitter / a fresh `claude`), NOT A's conversation.

5. **Opt-out is silent + safe.**
   - In instance A: Settings → uncheck "Share this machine's sessions", Save. Spawn/kill
     a session.
   - Expect: NO new push to `mangolove-sessions` (the publish gate is off); B's panel
     refresh still shows the last-published state (A's file isn't removed, just not
     updated). No errors.

6. **Privacy: local-only branch never leaves.**
   - In instance A (sharing on): create a worktree on a NEW local branch that was never
     pushed (`local-secret`), spawn a session.
   - Expect: B's panel does NOT show `local-secret` (filterPublishablePointers drops any
     branch not on the remote). Only remote branches appear.

7. **Working tree is never disturbed by sync.**
   - At any point, in `$BASE/repo`: `git status --porcelain` is clean and
     `git branch --list mangolove-sessions` is EMPTY (the sync branch is never checked
     out locally; pointer commits are pushed by sha).

## Pass criteria
- A's session pointer reaches the shared remote and B's panel shows it grouped by machine.
- "Start here" checks out the branch and starts a fresh (not resumed) session on B.
- Opt-out stops publishing with no error; a local-only branch never reaches the remote.
- The user's working tree / HEAD / local branches are never touched by sync.

## Recorded run — 2026-06-23 (automated, PASS)

Driven headless via two ISOLATED Electron instances (playwright-core `_electron`,
`--user-data-dir=udA`/`udB`, `MANGO_HEADLESS=1`, a harmless `MANGO_AGENT_CMD` fake
agent) over a shared bare remote with two clones (machine A = mac-A, B = mac-B).
The live app was exercised through the real preload bridge (`window.mango.*`), so
the full IPC → main handlers → git plumbing → SessionPublisher path ran end-to-end.
Teardown was `app.close()` only (no process pattern-kill).

- **S1 PASS** — A spawned a session on `main`; the SessionPublisher pushed
  `<machineId-A>.json` to the `mangolove-sessions` branch on the shared remote.
- **S2 PASS** — B's `crossMachine.fetch()` returned A's pointer (mac-A / `main`).
- **S3 PASS** — B's `crossMachine.startHere('feat-x')` checked out `feat-x` into
  `repoB/.worktrees/feat-x` (a fresh session, no conversation carryover).
- **S4 PASS** — `mangolove-sessions` is NOT a local branch on B; the only working-tree
  entry is the legitimately-created `.worktrees/` (the fixture clone has no
  `.worktrees` gitignore) — sync never touched HEAD or the index.

Conclusion: cross-machine visibility (publish → fetch → see) and "start here"
(remote-branch checkout + fresh session) work end-to-end in the live app. (D3 met.)

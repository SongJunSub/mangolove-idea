# Merge Conflict Resolution — manual Playwright smoke

Prereq: a temp repo with a guaranteed conflict (feature edits a line, main edits the
same line). Launch the app pointed at that repo (set repoRoot via the dev harness).

1. Select the feature worktree; click **Merge → main**.
2. Assert the stage line shows `conflict ⚠: merge conflict: N file(s) need resolution`
   and a **Conflicts** tab (`data-testid=tab-conflict`) appears and is auto-selected.
3. Assert `data-testid=conflict-view` is visible and lists the conflicted file
   (`data-testid=conflict-file`).
4. Assert `data-testid=conflict-continue` is DISABLED while a conflict remains.
5. Click the file; assert the Monaco editor shows `<<<<<<<` / `=======` / `>>>>>>>`.
6. Click `data-testid=conflict-ours`; assert the file leaves the list.
7. Assert `data-testid=conflict-continue` becomes ENABLED; click it.
8. Assert the pane closes, the worktree list refreshes, and (cleanup=true) the
   feature worktree/branch is gone.
9. Restart-resume check: re-run merge to a conflict, kill + relaunch the app, select
   the worktree, assert the Conflicts tab reappears (truth from MERGE_HEAD).
10. Abort check: in a fresh conflict, click `data-testid=conflict-abort`; assert the
    pane closes and `git status` in the repo shows a clean tree (no MERGE_HEAD).

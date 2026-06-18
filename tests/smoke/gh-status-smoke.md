# GH PR/CI Status Panel — manual Playwright smoke (no-PR common case)

This repo (branch `main`) has no open PR, so the smoke targets the COMMON calm state.
Document (do NOT block CI on a live network call — gate it behind the existing smoke
harness):

Manual / Playwright smoke steps:
1. Launch the app (existing Playwright harness).
2. Select the primary worktree.
3. Assert [data-testid="gh-status-line"] is present and its text starts with "PR:".
4. Assert the text is one of the calm states ("PR: none yet" | "PR: branch not pushed"
   | "PR: gh CLI not installed" | "PR: gh not signed in ...") — NOT an error chip.
5. Assert NO error toast and NO console.error were emitted (no error spam on the common path).
6. Assert a [data-testid="gh-refresh"] button is present and clickable.
7. (open-pr path, only when a real PR exists) Assert [data-testid="gh-open"] is present and
   clicking it invokes app.openExternal with the pr.url.

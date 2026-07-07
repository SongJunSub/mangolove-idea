# Editor model pool — cursor/scroll/undo preservation smoke

The pool's monaco glue (saveViewState/restoreViewState, keep-alive, dispose-on-close) needs a real
editor, so it isn't unit-tested (jsdom has no layout/view state); `modelPoolEvictions` IS unit-tested
(`tests/renderer/model-pool.test.ts`).

**Automated** (`npm run build && npm run smoke:editor`, `tests/e2e/tab-editor.smoke.mjs`): covers
tabs open, the preview (italic) tab, an edit surviving a tab switch, and — the key approach-A
contract — undo still working after a tab switch. Screenshots land in `tests/e2e/screenshots/`.

The steps below cover what the automated smoke does not yet drive (scroll position, cross-file nav
after closing a TS/JS tab, worktree-switch cleanup, quit) — run them manually via `npm run dev`.

Setup: `npm run dev`, select a worktree with several TS/JS files plus at least one non-TS/JS file
(e.g. a `.md` or `.java`).

1. **Cursor + scroll survive a tab switch.** Double-click file A (pins a tab). Scroll to the middle
   and click to place the cursor on, say, line 40 col 5. Double-click file B (second tab), move its
   cursor somewhere. Click the A tab. EXPECT: A restores at line 40 col 5 with the same scroll
   position — NOT reset to the top.

2. **Undo survives a tab switch.** In A, type a few edits (creating undo history), pause so it
   auto-saves. Switch to B and back to A. Press Cmd+Z repeatedly. EXPECT: the edits undo one by one
   (undo history intact); the file is not reloaded-from-disk fresh.

3. **Closing a tab frees its model; reopening starts clean.** Close A (× / middle-click / — ). Reopen
   A from the tree. EXPECT: it opens fresh (cursor at top, empty undo) — its pooled model was
   disposed on close. No crash.

4. **Cross-file navigation is NOT broken by closing a TS/JS tab.** Open a TS/JS file that another
   file references. Use it as a go-to-definition source (Cmd+click a symbol) — confirm nav works.
   Close that TS/JS tab, then trigger go-to-definition / find-usages again from another file into it.
   EXPECT: nav STILL resolves — closing the tab must NOT have disposed the registry-seeded model
   (borrowed, `owns=false`). A regression here manifests as go-to-def silently failing or a
   "model disposed" error in the console.

5. **Worktree switch cleans up + no double-dispose.** With tabs open in worktree W1, switch to W2
   (open a tab there), then back to W1. EXPECT: no console error (no double-dispose of the registry
   models the WorktreeModelRegistry also disposes on switch); W1's tabs still open. Cursor/undo are
   NOT expected to survive a WORKTREE switch (the registry + pool are per-worktree) — only tab
   switches within a worktree preserve them.

6. **No leak on quit.** Quit the app with several tabs open. EXPECT: clean exit, no "model was not
   disposed" warnings (the mount cleanup disposes every owned pooled model + the scratch model).

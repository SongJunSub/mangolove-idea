# Parallel per-worktree dev servers — GUI smoke (V2)

Proves TWO worktrees each run their OWN dev server CONCURRENTLY, each pane shows its
OWN logs + URL, stopping one leaves the other running, and quit/dispose kills both.

## Setup
- Use the env command seam so no real gradle/npm server is needed. Pick a harmless
  line-emitting command that prints a distinct localhost URL, e.g. a tiny node
  one-liner per worktree. Set it once before launching:
  - `export MANGO_SERVER_CMD='node -e "let p=5173+Math.floor(Math.random()*2);console.log(`Local:   http://localhost:${p}/`);setInterval(()=>console.log(`tick ${p} `+Date.now()),1000)"'`
  - (The override is global, but each worktree spawns its OWN child + its OWN log
    partition, so the printed port still demuxes per pane. For a deterministic
    two-port demo, instead run the app from `npm run dev` and set a fixed port per
    worktree via a per-worktree `.env`/script if your runner reads one.)
- Launch: `npm run dev`. Select your git repo if prompted.
- Ensure at least TWO worktrees exist (create a second via the toolbar if needed):
  call them **WT-A** (primary/main) and **WT-B** (a feature branch).

## Steps
1. Select **WT-A** → click **Run**. Expect: ServerControls shows `server: running`;
   WT-A's sidebar row shows a colored ServerDot (running). The Browser tab auto-fills
   WT-A's `http://localhost:51xx/`.
2. Select **WT-B** → click **Run**. Expect: WT-B reaches `server: running` WITHOUT
   stopping WT-A. BOTH sidebar rows now show a running ServerDot SIMULTANEOUSLY.
3. With **WT-B** selected, open **Logs** + **Browser**. Expect: the log panel shows
   ONLY WT-B's lines (its `tick` cadence + its port); the Browser URL bar holds
   WT-B's URL — NOT WT-A's. Re-select **WT-A**: its pane shows WT-A's OWN logs + URL.
   (Per-worktree partition + renderer demux: no cross-bleed.)
4. With **WT-A** selected, click **Stop**. Expect: WT-A → `server: stopped`, its dot
   greys out, BUT **WT-B's** dot stays running and its server keeps ticking
   (selecting WT-B still streams its logs). Stopping one leaves the other running.
5. Restart **WT-A** (Run again) so BOTH are running. Quit the app (Cmd-Q). Expect:
   no quit-warning fires FOR THE SERVERS (D7 — agent-turn warning is separate); the
   before-quit sweep `dispose()` kills BOTH server children. Verify no orphan node
   processes survive (`ps aux | grep -F 'http://localhost'` shows none from the app).

## Pass criteria
- Two servers run concurrently (step 2), each pane is correctly demuxed (step 3),
  independent stop (step 4), and a clean two-child quit-sweep with no orphans + no
  server quit-warning (step 5).

## Known limitation (D4)
No port injection. We rely on the dev server's own auto-increment (Vite 5173→5174,
Next) so concurrent worktrees land on distinct ports, and per-worktree log detection
picks each ACTUAL printed port. A runner that does NOT auto-increment will collide on
a fixed port — that needs a user-set per-worktree PORT (out of scope here).

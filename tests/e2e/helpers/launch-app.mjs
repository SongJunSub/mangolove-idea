// Launches the BUILT Electron app under Playwright in an ISOLATED environment for GUI smoke tests:
// a throwaway --user-data-dir, a seeded temp git repo (so the app boots straight into it via
// recentRepos), and harmless fake agent/server/verify commands so no real `claude`/server spawns.
// Teardown ALWAYS goes through electronApp.close() (never a process kill — see the repo's process
// safety rules) plus removal of the temp dirs it created.
import { _electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // project root
const MAIN_ENTRY = join(REPO, 'out', 'main', 'index.js');

/** A quiet git command in `cwd` (throws on failure). */
function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Seeds a temp git repo with `files` ({ relPath: contents }) and one commit. Returns its path.
 * The app treats this checkout as a worktree, so its files show in the tree.
 */
export function seedRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'mango-e2e-repo-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'e2e@example.com');
  git(root, 'config', 'user.name', 'E2E');
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  return root;
}

/**
 * Launches the built app pointed at a freshly seeded repo. Returns { app, window, repoRoot,
 * extraRoots, close }. `opts.extraRepos` seeds additional repos (each a { relPath: contents } map)
 * that join recentRepos AFTER the boot repo — so the project tree shows them as non-active repos
 * (for cross-repo tests). `opts.headless` (MANGO_HEADLESS=1) keeps windows hidden — they still
 * render the DOM + handle IPC, so Playwright drives them identically, but a mid-test SECOND window
 * can't steal OS focus (multi-window tests observe STATE, not focus). `close()` shuts the app down
 * cleanly and removes every temp dir. Requires `npm run build` first.
 */
export async function launchApp(files, { extraRepos = [], headless = false } = {}) {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`built main not found at ${MAIN_ENTRY} — run \`npm run build\` first`);
  }
  const repoRoot = seedRepo(files);
  const extraRoots = extraRepos.map((f) => seedRepo(f));
  const userData = mkdtempSync(join(tmpdir(), 'mango-e2e-userdata-'));

  // A fake agent that just idles — selecting a worktree mounts the agent terminal, which must not
  // spawn a real `claude`. Same for the dev-server / verify commands.
  const fakeAgent = join(userData, 'fake-agent.sh');
  writeFileSync(fakeAgent, '#!/bin/sh\nwhile true; do sleep 3600; done\n');
  chmodSync(fakeAgent, 0o755);

  // Seed settings.json so the app boots straight into the FIRST repo (recentRepos[0]); any extra
  // repos follow so they render as non-active nodes in the project tree.
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ recentRepos: [repoRoot, ...extraRoots], theme: 'dark' }, null, 2),
  );

  const app = await _electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      MANGO_AGENT_CMD: fakeAgent,
      MANGO_SERVER_CMD: fakeAgent,
      MANGO_VERIFY_CMD: 'true',
      ...(headless ? { MANGO_HEADLESS: '1' } : {}),
    },
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const close = async () => {
    await app.close().catch(() => {});
    rmSync(userData, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    for (const r of extraRoots) rmSync(r, { recursive: true, force: true });
  };
  return { app, window, repoRoot, extraRoots, close };
}

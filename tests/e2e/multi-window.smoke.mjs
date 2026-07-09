// GUI smoke for multi-window activation — drives the BUILT app under Playwright/Electron and asserts
// the two reachable paths of "open a repo in a new window" end to end, observing WINDOW STATE (never
// OS focus, which a headless CI can't assert):
//   1. CREATE — right-click a NON-active repo B in window 1 → "Open in new window" opens a SECOND
//      window whose active repo is B, while window 1 stays on repo A (no in-place switch).
//   2. FOCUS (one-repo-per-window) — doing it AGAIN, with B already open in window 2, must NOT open a
//      third window (main focuses the existing owner instead).
// Windows run hidden (headless) so the second window can't steal focus. Run after `npm run build`:
//   npm run smoke:multi-window
//
// Isolation + teardown live in helpers/launch-app.mjs (throwaway user-data-dir + two seeded repos +
// fake agent; app.close() teardown — never a process kill).
import { launchApp } from './helpers/launch-app.mjs';
import { basename } from 'node:path';

const checks = [];
const check = (name, pass) => {
  checks.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}`);
};

const hardExit = setTimeout(() => {
  console.error('❌ HARD TIMEOUT');
  process.exit(1);
}, 120000);

// Boot into repo A; repo B is a non-active node we'll open in a new window.
const { app, window, repoRoot, extraRoots, close } = await launchApp(
  { 'a-only.ts': 'export const a = 1;\n' },
  { extraRepos: [{ 'b-only.ts': 'export const b = 2;\n' }], headless: true },
);
const aName = basename(repoRoot); // window 1's active repo node id
const bName = basename(extraRoots[0]); // repo B's project-tree node id

/** The 'class' attribute of a repo node in a given window (for the ' active' flag). */
const nodeClass = (win, name) =>
  win
    .getByTestId(`repo-node-${name}`)
    .getAttribute('class')
    .then((c) => c ?? '');

try {
  // ── Boot: window 1 shows repo B as a non-active node ──
  const bNode = window.getByTestId(`repo-node-${bName}`);
  await bNode.waitFor({ timeout: 20000 });
  check(
    'window 1 boots with repo B as a non-active node',
    !(await nodeClass(window, bName)).includes('active'),
  );
  check('only one window at boot', app.windows().length === 1);

  // ── CREATE path: right-click B → "Open in new window" → a SECOND window appears ──
  const win2Promise = app.waitForEvent('window');
  await bNode.click({ button: 'right' });
  await window.getByTestId('menu-open-new-window').click();
  const win2 = await win2Promise;
  await win2.waitForLoadState('domcontentloaded');
  check('a second window opened for repo B', app.windows().length === 2);

  // ── The new window is ACTIVE on repo B (state, not OS focus) ──
  const b2 = win2.getByTestId(`repo-node-${bName}`);
  await b2.waitFor({ timeout: 20000 });
  check('the second window is active on repo B', (await nodeClass(win2, bName)).includes('active'));

  // ── Window 1 is UNCHANGED: still on A, B still non-active (no in-place switch happened) ──
  check('window 1 stayed active on repo A', (await nodeClass(window, aName)).includes('active'));
  check(
    'window 1 did NOT switch to B in place',
    !(await nodeClass(window, bName)).includes('active'),
  );

  // ── FOCUS path: opening B AGAIN (already owned by window 2) must NOT create a third window ──
  await bNode.click({ button: 'right' });
  await window.getByTestId('menu-open-new-window').click();
  await window.waitForTimeout(600); // give main a beat to (wrongly) spawn a 3rd window
  check('re-opening B focuses the existing window (no third window)', app.windows().length === 2);
} finally {
  clearTimeout(hardExit);
  await close();
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);

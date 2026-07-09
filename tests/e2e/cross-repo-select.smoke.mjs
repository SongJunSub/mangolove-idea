// GUI smoke for cross-repo worktree selection — drives the BUILT app under Playwright/Electron and
// asserts the reachable RELOAD path end to end: clicking a NON-active repo's worktree in the project
// tree switches to that repo (in-place rebind + reload) AND lands on that worktree (mount pull). The
// file tree only renders a worktree's files once one is SELECTED, so seeing repo B's file after the
// switch proves the selection survived the reload. Run after `npm run build`:  npm run smoke:cross-repo
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

// Boot into repo A; repo B (non-active) carries a DISTINCTIVE file so we can prove we landed on it.
const { window, extraRoots, close } = await launchApp(
  { 'a-only.ts': 'export const a = 1;\n' },
  { extraRepos: [{ 'b-only.ts': 'export const b = 2;\n' }] },
);
const bName = basename(extraRoots[0]); // repo B's project-tree node id

try {
  // ── Boot: the project tree shows repo B as a non-active, collapsed node ──
  const bNode = window.getByTestId(`repo-node-${bName}`);
  await bNode.waitFor({ timeout: 20000 });
  check('non-active repo B appears in the project tree', (await bNode.count()) === 1);

  // ── Expand B (chevron only — clicking the row would switch) -> lazy listFor -> its worktree ──
  const bWrap = bNode.locator('xpath=..'); // the .pt-repo-wrap holding B's header + worktrees
  await bNode.locator('.pt-chev').click();
  const bWorktree = bWrap.getByTestId('worktree-item').first();
  await bWorktree.waitFor({ timeout: 20000 });
  check('expanding repo B lazily lists its worktree', (await bWorktree.count()) === 1);

  // ── Click B's worktree -> switch to B (rebind + reload) + select it (mount pull) ──
  await bWorktree.click();
  // The file tree only renders once a worktree is selected; B's distinctive file appearing proves
  // BOTH that we switched to B AND that the clicked worktree got selected across the reload.
  await window.waitForSelector('[data-testid="tree-node-b-only.ts"]', { timeout: 30000 });
  check('after the cross-repo switch, B’s worktree is selected (its file tree shows)', true);

  // ── And A is gone: its file must NOT be in the (now B) tree ──
  const aStillThere = (await window.getByTestId('tree-node-a-only.ts').count()) > 0;
  check('the old repo A is no longer the active tree', !aStillThere);

  // ── B is now the active repo in the tree (the "here" affordance) ──
  const bActive = (await window.getByTestId(`repo-node-${bName}`).getAttribute('class')) ?? '';
  check('repo B is now flagged active in the tree', bActive.includes('active'));
} finally {
  clearTimeout(hardExit);
  await close();
}

const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);

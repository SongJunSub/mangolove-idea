// GUI smoke for the tabbed editor — drives the BUILT app under Playwright/Electron and asserts the
// behaviours that jsdom unit tests cannot: real monaco tabs, preview tabs, and (the key approach-A
// contract) cursor/undo SURVIVING a tab switch. Run after `npm run build`:  npm run smoke:editor
//
// Isolation + teardown live in helpers/launch-app.mjs (throwaway user-data-dir + seeded repo + fake
// agent; app.close() teardown — never a process kill). Screenshots are written to
// tests/e2e/screenshots/ (gitignored) as reviewable artifacts.
import { launchApp } from './helpers/launch-app.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const MARK = 'ZZUNDOMARK';

const checks = [];
const check = (name, pass) => {
  checks.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}`);
};

const hardExit = setTimeout(() => {
  console.error('❌ HARD TIMEOUT');
  process.exit(1);
}, 120000);

const { window, close } = await launchApp({
  'a.ts': 'export const a = 1;\nconst x = 10;\n',
  'b.ts': 'export const b = 2;\n',
  'c.ts': 'export const c = 3;\n',
});

const editorText = () => window.locator('.monaco-editor .view-lines').first().textContent();
const tabClass = (rel) => window.getByTestId(`editor-tab-${rel}`).getAttribute('class');

try {
  // ── Boot + open two files as pinned tabs ──
  await window.getByTestId('worktree-item').first().click();
  await window.waitForSelector('[data-testid="file-tree"]', { timeout: 20000 });
  await window.getByTestId('tree-node-a.ts').dblclick();
  await window.getByTestId('tree-node-b.ts').dblclick();
  await window.waitForSelector('[data-testid="editor-tabs"]', { timeout: 10000 });
  check(
    'two files open as tabs',
    (await window.getByTestId('editor-tab-a.ts').count()) === 1 &&
      (await window.getByTestId('editor-tab-b.ts').count()) === 1,
  );

  // ── Preview tab: single-click c.ts opens an italic (preview) tab, no accumulation ──
  await window.getByTestId('tree-node-c.ts').click();
  await window.waitForTimeout(300);
  check(
    'single-click opens a preview (italic) tab',
    (await tabClass('c.ts'))?.includes('preview') === true,
  );

  // ── Edit A, then switch away and back — the edit (model) must persist ──
  await window.getByTestId('editor-tab-a.ts').click();
  await window.waitForTimeout(400);
  await window.locator('.monaco-editor .view-line').first().click();
  await window.keyboard.press('End');
  await window.keyboard.type(' ' + MARK);
  await window.waitForTimeout(600); // let auto-save settle
  check('edit appears in the editor', (await editorText()).includes(MARK));
  await window.screenshot({ path: join(SHOTS, '1-edited.png') });

  await window.getByTestId('editor-tab-b.ts').click();
  await window.waitForTimeout(300);
  await window.getByTestId('editor-tab-a.ts').click();
  await window.waitForTimeout(400);
  check('edit survives a tab switch (model kept alive)', (await editorText()).includes(MARK));
  await window.screenshot({ path: join(SHOTS, '2-returned.png') });

  // ── The approach-A contract: undo history survives the switch ──
  await window.locator('.monaco-editor .view-line').first().click();
  await window.keyboard.press('Meta+z');
  await window.waitForTimeout(400);
  check(
    'undo works AFTER a tab switch (undo history preserved)',
    !(await editorText()).includes(MARK),
  );
  await window.screenshot({ path: join(SHOTS, '3-undone.png') });
} catch (e) {
  check(`no exception (${String(e).slice(0, 160)})`, false);
} finally {
  clearTimeout(hardExit);
  await close();
}

const failed = checks.filter((c) => !c.pass);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed — screenshots in ${SHOTS}`,
);
process.exit(failed.length === 0 ? 0 : 1);

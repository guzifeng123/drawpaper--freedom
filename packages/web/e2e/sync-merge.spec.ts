import { test, expect } from '@playwright/test';

/**
 * Wave10：v2 → v3 迁移 + 跨设备合并 e2e。
 *  - 导入 v2 .kbnote → 自动升 v3，sync 元数据落盘；
 *  - 同一份 v2 档「两台设备」各升级一次 → 结果 deep-equal、合并 0 假冲突；
 *  - v9 高版本仍被拒绝，当前文档不被污染。
 */

function v2Doc(): string {
  return JSON.stringify({
    format: 'knowledge-block-notes',
    version: 2,
    id: 'doc_v2_e2e',
    title: 'v2 旧文件',
    board: { createdAt: 1000, updatedAt: 1696000000000 },
    nodes: [
      {
        id: 'n_1',
        type: 'text',
        x: 100,
        y: 100,
        width: 260,
        height: 80,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
      },
      {
        id: 'n_2',
        type: 'todo',
        x: 400,
        y: 100,
        width: 260,
        height: 60,
        content: { format: 'tiptap-json', data: { type: 'doc', content: [] } },
        todo: { checked: true },
      },
    ],
    edges: [{ id: 'e_1', source: 'n_1', target: 'n_2', sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#86EFAC' } }],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: 15,
      mode: 'fit',
      showPageBreak: true,
      colorMode: 'color',
      header: false,
      footer: false,
      showPageNumbers: false,
      edgeLabels: true,
      pageBreaks: [],
    },
    assetRefs: [],
    links: [],
  });
}

function v9Doc(): string {
  return JSON.stringify({
    format: 'knowledge-block-notes',
    version: 9,
    id: 'doc_v9',
    title: '未来文件',
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForTimeout(800);
});

test('importing a v2 doc auto-migrates to v3 with sync metadata', async ({ page }) => {
  const res = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), v2Doc());
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.version).toBe(4);
    expect(res.migrationNotes.length).toBeGreaterThan(0);
  }
  const state = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(state.doc.id).toBe('doc_v2_e2e');
  expect(state.doc.version).toBe(4);
  // 确定性迁移戳：clientId 由 docId 派生，lamport 取自 board.updatedAt
  // @ts-expect-error 运行时存在
  expect(state.doc.sync.nodes.n_1.f.content).toEqual([1696000000000, 'seed:doc_v2_e2e']);
});

test('two devices migrating the same v2 file converge without false conflicts', async ({ page }) => {
  const check = await page.evaluate((text) => window.__drawpaper__!.v3MigrationCheck(text), v2Doc());
  expect(check.ok).toBe(true);
  expect(check.version).toBe(4);
  expect(check.migratedDeepEqual).toBe(true);
  expect(check.mergedConflictCount).toBe(0);
});

test('importing a v9 doc is rejected and leaves the current doc intact', async ({ page }) => {
  await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), v2Doc());
  const before = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(before.doc.id).toBe('doc_v2_e2e');

  const res = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), v9Doc());
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.errorKind).toBe('unsupported-version');

  const after = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(after.doc.id).toBe('doc_v2_e2e');
  expect(after.doc.version).toBe(4);
});

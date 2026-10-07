import { test, expect } from '@playwright/test';

/**
 * Wave6a：schema v2 迁移 e2e。
 *  - 导入 v1 .kbnote → 自动升到 v2，migrationNotes 非空；
 *  - 导入伪造 v9 .kbnote → 拒绝（unsupported-version），当前文档不被替换。
 */

function v1Doc(): string {
  return JSON.stringify({
    format: 'knowledge-block-notes',
    version: 1,
    id: 'doc_v1_e2e',
    title: 'v1 旧文件',
    board: { createdAt: 0, updatedAt: 0 },
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
    ],
    edges: [],
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
  // 等待异步 bootstrap（listDocs/openRecent/newDoc）落定，避免与后续 import 竞态。
  await page.waitForTimeout(800);
});

test('importing a v1 doc auto-migrates to v4 with notes', async ({ page }) => {
  const res = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), v1Doc());
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.version).toBe(4);
    expect(res.migrationNotes.length).toBeGreaterThan(0);
  }
  // 当前文档已切换为迁移后的 v1 doc
  const state = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(state.doc.id).toBe('doc_v1_e2e');
  expect(state.doc.version).toBe(4);
  expect(state.doc.links).toEqual([]);
});

test('importing a v9 doc is rejected and leaves the current doc intact', async ({ page }) => {
  // 先载入 v1 文档（迁移成功），记录其 id
  await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), v1Doc());
  const before = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(before.doc.id).toBe('doc_v1_e2e');

  // 再导入 v9 文件 → 拒绝，不替换
  const res = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), v9Doc());
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.errorKind).toBe('unsupported-version');

  // 当前文档仍是迁移后的 v1 doc，未被污染
  const after = await page.evaluate(() => window.__drawpaper__!.getState());
  expect(after.doc.id).toBe('doc_v1_e2e');
  expect(after.doc.version).toBe(3);
});

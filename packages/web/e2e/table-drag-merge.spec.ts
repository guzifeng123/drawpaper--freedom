import { test, expect } from '@playwright/test';
import type { KBNoteDoc } from '@drawpaper/core';

/**
 * Wave7 robustness（任务3）：表格单元格鼠标拖选合并/拆分 e2e。
 *
 * 直接灌一个「内容已是 2x2 表格」的文档（addNode('table') 只建空段落，
 * 不会预置表格网格），双击进入 Tiptap 编辑态，再用 mouse.move+down/up
 * 跨格拖选触发 ProseMirror CellSelection → 合并 colspan=2 → 拆分还原。
 *
 * 稳定性策略：若无头环境拖选时序不稳定导致连续失败，本测试会被移除，
 * 改为 docs/wave7/robustness.md 的人工验证清单
 * （命令层 table-ops.test.tsx 已覆盖 merge→colspan=2→split 语义）。
 */

function header(text: string) {
  return { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}
function cell(text: string) {
  return { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function buildTableFixture(): KBNoteDoc {
  const now = Date.now();
  return {
    format: 'knowledge-block-notes',
    version: 3,
    id: 'table-fixture',
    title: '表格拖选夹具',
    board: { createdAt: now, updatedAt: now },
    nodes: [
      {
        id: 'table-node-1',
        type: 'table',
        x: 0,
        y: 0,
        width: 360,
        height: 160,
        content: {
          format: 'tiptap-json',
          data: {
            type: 'doc',
            content: [
              {
                type: 'table',
                content: [
                  { type: 'tableRow', content: [header('A'), header('B')] },
                  { type: 'tableRow', content: [cell('C'), cell('D')] },
                ],
              },
            ],
          },
        },
        parentId: null,
        pinned: false,
        locked: false,
        collapsed: false,
        tags: [],
        style: {},
      },
    ],
    edges: [],
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: {
      size: 'A4',
      orientation: 'landscape',
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
    sync: { vv: {} },
  };
}

test.describe('表格拖选合并/拆分（e2e）', () => {
  test('跨格拖选 → 合并 colspan=2 → 拆分还原', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.waitForFunction(() => !!(window as unknown as { __drawpaper__?: unknown }).__drawpaper__);

    // 灌一个已是 2x2 表格的文档。
    await page.evaluate((doc: unknown) => {
      (window as unknown as { __drawpaper__: { loadFixture: (d: unknown) => void } }).__drawpaper__.loadFixture(doc);
    }, buildTableFixture());
    await page.waitForTimeout(400);

    // 双击表格节点进入编辑态。
    const tableNode = page.locator('.react-flow__node').first();
    await tableNode.dblclick();
    await page.waitForTimeout(800);

    // 工具条出现，合并按钮初始禁用。
    const mergeBtn = page.getByRole('button', { name: /合并/ });
    const splitBtn = page.getByRole('button', { name: /拆分/ });
    await expect(mergeBtn).toBeVisible();
    await expect(mergeBtn).toBeDisabled();

    // 首行两个表头单元格。
    const cells = page.locator('.ProseMirror thead th, .ProseMirror th');
    await expect(cells.nth(0)).toBeVisible();
    await expect(cells.nth(1)).toBeVisible();
    const b0 = await cells.nth(0).boundingBox();
    const b1 = await cells.nth(1).boundingBox();
    if (!b0 || !b1) throw new Error('无法获取单元格位置');

    const x0 = b0.x + b0.width / 2;
    const y0 = b0.y + b0.height / 2;
    const x1 = b1.x + b1.width / 2;
    const y1 = b1.y + b1.height / 2;

    // ProseMirror 跨格拖选：mousedown 第一格 → 移动过第二格 → mouseup。
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
    await page.mouse.move(x1, y1, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // 拖选后合并按钮应启用；不启用说明 CellSelection 未建成。
    await expect(mergeBtn).toBeEnabled({ timeout: 3000 });

    // 点合并 → 出现 colspan=2。
    await mergeBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('.ProseMirror [colspan="2"]').first()).toBeVisible({ timeout: 3000 });

    // 点拆分 → colspan=2 消失。
    await expect(splitBtn).toBeEnabled({ timeout: 3000 });
    await splitBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('.ProseMirror [colspan="2"]')).toHaveCount(0);
  });
});

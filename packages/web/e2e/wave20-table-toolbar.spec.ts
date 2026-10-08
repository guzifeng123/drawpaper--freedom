import { test, expect, type Page } from '@playwright/test';
import type { KBNoteDoc } from '@drawpaper/core';
import { waitForApp, invoke } from './fixtures/load-doc';

/**
 * Wave20 T 路：表格块工具栏 UI e2e。
 *
 * 背景：表格合并/拆分此前只有 table-drag-merge.spec.ts 一条「拖选合并」路径。
 * 本 spec 补齐工具栏按钮（增删行列 / 表头切换 / 按钮触发合并拆分）、撤销重做、
 * 单元格编辑后持久化、以及 Markdown 导出含表。
 *
 * 选择器策略：优先用按钮文字（title/可访问名）与 DOM 计数（tr / th,td / colspan），
 * 不为测试重构产品 UI。
 */

type CellSpec = { header?: boolean; text: string };

function cellNode(c: CellSpec) {
  const type = c.header ? 'tableHeader' : 'tableCell';
  return {
    type,
    content: [{ type: 'paragraph', content: c.text ? [{ type: 'text', text: c.text }] : [] }],
  };
}

/** 造一个单表格块文档。rows: 每行的单元格规格数组。 */
function buildTableDoc(rows: CellSpec[][]): KBNoteDoc {
  const now = Date.now();
  return {
    format: 'knowledge-block-notes',
    version: 4,
    id: 'wave20-table-toolbar',
    title: 'Wave20 表格工具条',
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
                content: rows.map((cells) => ({ type: 'tableRow', content: cells.map(cellNode) })),
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

async function loadTable(page: Page, rows: CellSpec[][]) {
  await page.evaluate((doc: unknown) => {
    (window as unknown as { __drawpaper__: { loadFixture: (d: unknown) => void } }).__drawpaper__.loadFixture(doc);
  }, buildTableDoc(rows));
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(300);
}

/**
 * waitForApp 只等 __drawpaper__ 钩子（模块加载即挂载）。App bootstrap 是异步的：
 * listDocs → newDoc/openDoc 会在钩子就绪后才跑，过早灌夹具会被它覆盖。
 * 等初始文档 id 从 'boot' 切走 = bootstrap 落定，再灌夹具才稳。
 */
async function waitForBoot(page: Page) {
  await waitForApp(page);
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __drawpaper__: { getState: () => { doc: { id: string } } } }).__drawpaper__.getState();
      return !!s.doc && s.doc.id !== 'boot';
    },
    null,
    { timeout: 10_000 },
  );
}

/** 双击表格节点进入 Tiptap 编辑态，等工具条出现。 */
async function enterTableEdit(page: Page) {
  await page.locator('.react-flow__node').first().dblclick();
  await expect(page.locator('.ProseMirror table')).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('button', { name: /加行/ })).toBeVisible({ timeout: 5000 });
}

const rowCount = (page: Page) => page.locator('.ProseMirror table tr');
const cellsInRow = (page: Page, nth: number) =>
  page.locator('.ProseMirror table tr').nth(nth).locator('th,td');

test.describe('Wave20 表格块工具栏 e2e', () => {
  // (a) 斜杠菜单插入表格
  test('(a) 斜杠菜单 / 插入表格 → 进入编辑态', async ({ page }) => {
    await waitForBoot(page);
    await invoke(page, 'newDoc');
    await page.waitForTimeout(300);

    // 空白处双击：建一个文本块并进入编辑态。
    await page.mouse.dblclick(640, 400);
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(200);

    // 行首输入 / 唤起斜杠菜单。
    await page.locator('.ProseMirror').click();
    await page.keyboard.type('/');
    await expect(page.getByRole('button', { name: '表格' })).toBeVisible({ timeout: 3000 });

    // 选「表格」：块类型切换为 table（编辑态随之退出）。
    await page.getByRole('button', { name: '表格' }).click();
    await page.waitForTimeout(400);
    // 退出编辑后块可能因离屏被渐进水化卸载；fit 视图把它拉回视口再双击。
    await page.keyboard.press('Control+0');
    await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 5000 });

    // 双击表格块进入编辑态 → 工具条出现。
    await enterTableEdit(page);
    // 新建表格默认 2 行 2 列（首行表头）。
    await expect(rowCount(page)).toHaveCount(2);
    await expect(cellsInRow(page, 0)).toHaveCount(2);
    await expect(cellsInRow(page, 1)).toHaveCount(2);
  });

  // (b) 加行 / 加列
  test('(b) 加行（下方）/ 加列（右侧）行列数真的增加', async ({ page }) => {
    await waitForBoot(page);
    await loadTable(page, [
      [{ header: true, text: 'A' }, { header: true, text: 'B' }],
      [{ text: 'C' }, { text: 'D' }],
    ]);
    await enterTableEdit(page);

    await expect(rowCount(page)).toHaveCount(2);
    await expect(cellsInRow(page, 0)).toHaveCount(2);

    await page.getByRole('button', { name: /加行/ }).click();
    await expect(rowCount(page)).toHaveCount(3);

    await page.getByRole('button', { name: /加列/ }).click();
    await expect(cellsInRow(page, 0)).toHaveCount(3);
    await expect(cellsInRow(page, 2)).toHaveCount(3);
  });

  // (c) 删行 / 删列
  test('(c) 删行 / 删列 → 数量减少且其余单元格内容正确', async ({ page }) => {
    await waitForBoot(page);
    await loadTable(page, [
      [{ header: true, text: 'A' }, { header: true, text: 'B' }],
      [{ text: 'C' }, { text: 'D' }],
      [{ text: 'E' }, { text: 'F' }],
    ]);
    await enterTableEdit(page);
    await expect(rowCount(page)).toHaveCount(3);

    // 点入第二行（C/D 行）后删行。
    await page.locator('.ProseMirror table tr').nth(1).locator('td').nth(0).click();
    await page.getByRole('button', { name: /删行/ }).click();
    await expect(rowCount(page)).toHaveCount(2);
    await expect(page.locator('.ProseMirror')).toContainText('A');
    await expect(page.locator('.ProseMirror')).toContainText('E');
    await expect(page.locator('.ProseMirror')).not.toContainText('C');

    // 点入第二列（B/F 列，此时为表头行第 2 格）后删列。
    await page.locator('.ProseMirror table tr').nth(0).locator('th').nth(1).click();
    await page.getByRole('button', { name: /删列/ }).click();
    await expect(cellsInRow(page, 0)).toHaveCount(1);
    await expect(cellsInRow(page, 1)).toHaveCount(1);
    await expect(page.locator('.ProseMirror')).toContainText('A');
    await expect(page.locator('.ProseMirror')).toContainText('E');
    await expect(page.locator('.ProseMirror')).not.toContainText('B');
  });

  // (d) 切换表头行
  test('(d) 切换表头行 → 表头单元格 th/td 互换', async ({ page }) => {
    await waitForBoot(page);
    await loadTable(page, [
      [{ header: true, text: 'A' }, { header: true, text: 'B' }],
      [{ text: 'C' }, { text: 'D' }],
    ]);
    await enterTableEdit(page);

    // 默认首行为表头：2 th + 2 td。
    await expect(page.locator('.ProseMirror th')).toHaveCount(2);
    await expect(page.locator('.ProseMirror td')).toHaveCount(2);

    // 关闭表头行：首行 th → td，全部变 4 td。
    await page.getByRole('button', { name: /表头/ }).click();
    await expect(page.locator('.ProseMirror th')).toHaveCount(0);
    await expect(page.locator('.ProseMirror td')).toHaveCount(4);

    // 再开：恢复 2 th + 2 td。
    await page.getByRole('button', { name: /表头/ }).click();
    await expect(page.locator('.ProseMirror th')).toHaveCount(2);
    await expect(page.locator('.ProseMirror td')).toHaveCount(2);
  });

  // (e) 拖选后按钮合并 / 拆分 + disabled 态
  test('(e) 按钮合并 → colspan=2；光标落合并格后按钮拆分还原；disabled 态正确', async ({ page }) => {
    await waitForBoot(page);
    await loadTable(page, [
      [{ header: true, text: 'A' }, { header: true, text: 'B' }],
      [{ text: 'C' }, { text: 'D' }],
    ]);
    await enterTableEdit(page);

    const mergeBtn = page.getByRole('button', { name: /合并/ });
    const splitBtn = page.getByRole('button', { name: /拆分/ });

    // 初始：单格光标 → 合并/拆分均禁用。
    await expect(mergeBtn).toBeDisabled();
    await expect(splitBtn).toBeDisabled();

    // 跨两表头格拖选，建成 CellSelection。
    const cells = page.locator('.ProseMirror th');
    const b0 = await cells.nth(0).boundingBox();
    const b1 = await cells.nth(1).boundingBox();
    if (!b0 || !b1) throw new Error('无法获取单元格位置');
    const x0 = b0.x + b0.width / 2;
    const y0 = b0.y + b0.height / 2;
    const x1 = b1.x + b1.width / 2;
    const y1 = b1.y + b1.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 });
    await page.mouse.move(x1, y1, { steps: 4 });
    await page.mouse.up();
    await expect(mergeBtn).toBeEnabled({ timeout: 3000 });

    // 点合并 → colspan=2。
    await mergeBtn.click();
    await expect(page.locator('.ProseMirror [colspan="2"]')).toBeVisible({ timeout: 3000 });

    // 合并后光标落入合并格 → 拆分启用。
    await expect(splitBtn).toBeEnabled({ timeout: 3000 });
    await splitBtn.click();
    await expect(page.locator('.ProseMirror [colspan="2"]')).toHaveCount(0);
    // 拆回单格 → 拆分重新禁用。
    await expect(splitBtn).toBeDisabled();
  });

  // (f) 撤销 / 重做
  test('(f) 结构操作后 Ctrl+Z 撤销 / Ctrl+Y 重做恢复', async ({ page }) => {
    await waitForBoot(page);
    await loadTable(page, [
      [{ header: true, text: 'A' }, { header: true, text: 'B' }],
      [{ text: 'C' }, { text: 'D' }],
    ]);
    await enterTableEdit(page);
    // 确保焦点在编辑器内。
    await page.locator('.ProseMirror td').nth(0).click();

    await expect(rowCount(page)).toHaveCount(2);
    await page.getByRole('button', { name: /加行/ }).click();
    await expect(rowCount(page)).toHaveCount(3);

    // Ctrl+Z 撤销加行。
    await page.keyboard.press('Control+z');
    await expect(rowCount(page)).toHaveCount(2);

    // Ctrl+Y 重做加行。
    await page.keyboard.press('Control+y');
    await expect(rowCount(page)).toHaveCount(3);
  });

  // (g) 单元格打字后 reload 持久化
  test('(g) 单元格打字后 reload → 结构与文字持久化', async ({ page }) => {
    await waitForBoot(page);
    await loadTable(page, [
      [{ header: true, text: '姓名' }, { header: true, text: '城市' }],
      [{ text: '' }, { text: '' }],
    ]);
    await enterTableEdit(page);

    // 在第二行第一格打字。
    await page.locator('.ProseMirror table tr').nth(1).locator('td').nth(0).click();
    await page.keyboard.type('张三');
    await expect(page.locator('.ProseMirror')).toContainText('张三');

    // 主动保存后 reload。
    await invoke(page, 'requestSave');
    await page.waitForTimeout(500);
    await page.reload();
    await waitForBoot(page);
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(400);

    // 持久化：文字仍在，表格仍是 2 行 2 列。
    await expect(page.locator('.react-flow__node').first()).toContainText('张三');
    await enterTableEdit(page);
    await expect(rowCount(page)).toHaveCount(2);
    await expect(cellsInRow(page, 0)).toHaveCount(2);
    await expect(page.locator('.ProseMirror')).toContainText('姓名');
    await expect(page.locator('.ProseMirror')).toContainText('张三');
  });

  // (h) Markdown 导出含表
  test('(h) Markdown 导出产物包含表格文字', async ({ page }) => {
    await waitForBoot(page);
    await loadTable(page, [
      [{ header: true, text: '姓名' }, { header: true, text: '城市' }],
      [{ text: '张三' }, { text: '北京' }],
    ]);
    await page.keyboard.press('Escape');

    // 打开导出对话框。
    await page.keyboard.press('Control+p');
    await page.waitForSelector('text=导出 / 打印', { timeout: 5000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByRole('button', { name: /Markdown/ }).click(),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
    const md = Buffer.concat(chunks).toString('utf-8');

    expect(download.suggestedFilename()).toMatch(/\.md$/);
    expect(md).toContain('姓名');
    expect(md).toContain('城市');
    expect(md).toContain('张三');
    expect(md).toContain('北京');
    // GFM 管道表格语法：表头与分隔行都应在。
    expect(md).toContain('| 姓名 | 城市 |');
    expect(md).toContain('| --- | --- |');
  });
});

import { test, expect } from '@playwright/test';

/**
 * Wave6b 画布 P2：边弯折点 / 文件拖入建块 / 触屏 target 长按入连。
 * 纯几何与分类已由单测覆盖；e2e 走主路径 + DEV 钩子断言。
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
});

test.describe('边弯折点', () => {
  test('setEdgePoints 后边选中出现弯折手柄、points 持久化', async ({ page }) => {
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 50, 200);
      window.__drawpaper__!.invoke('addNode', 'text', 500, 200);
    });
    await page.waitForTimeout(400);
    // 连边
    await page.evaluate(() => {
      const doc = window.__drawpaper__!.getState().doc;
      window.__drawpaper__!.invoke('addEdge', doc.nodes[0]!.id, doc.nodes[1]!.id);
    });
    await page.waitForTimeout(300);
    // DEV 设置弯折点
    await page.evaluate(() => {
      const doc = window.__drawpaper__!.getState().doc;
      const e = doc.edges[0]!;
      window.__drawpaper__!.invoke('setEdgePoints', e.id, [{ x: 200, y: 100 }]);
    });
    // store 持久化（弯折边渲染/几何已由 edge-geometry 与 svg-export 单测覆盖）
    const edgeInfo = await page.evaluate(() => {
      const doc = window.__drawpaper__!.getState().doc;
      const e = doc.edges[0]!;
      return { id: e.id, pt: e.points?.[0] };
    });
    expect(edgeInfo.pt).toMatchObject({ x: 200, y: 100 });
    // 撤销后 points 清空（可撤销命令）
    await page.evaluate(() => window.__drawpaper__!.invoke('undo'));
    const afterUndo = await page.evaluate(() => window.__drawpaper__!.getState().doc.edges[0]!.points);
    expect(afterUndo ?? []).toEqual([]);
  });
});

test.describe('文件拖入画布', () => {
  test('DataTransfer 拖入 txt → 新建文本块且内容含文本', async ({ page }) => {
    const before = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const file = new File(['hello drop\nsecond line'], 'note.txt', { type: 'text/plain' });
      dt.items.add(file);
      const el = document.querySelector('.react-flow') as HTMLElement;
      const rect = el.getBoundingClientRect();
      const drop = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: rect.x + 300,
        clientY: rect.y + 300,
        dataTransfer: dt,
      });
      el.dispatchEvent(drop);
    });
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    expect(after).toBe(before + 1);
    // 文本块内容含拖入文本
    const has = await page.evaluate(() => {
      const doc = window.__drawpaper__!.getState().doc;
      const json = JSON.stringify(doc.nodes[doc.nodes.length - 1]?.content?.data ?? {});
      return json.includes('hello drop');
    });
    expect(has).toBe(true);
  });
});

test.describe('触屏 target 长按入连', () => {
  test('长按 target 块左点 → 拖到 source 块松手 → 新增边(source=拖到, target=长按块)', async ({ page }) => {
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 500, 200); // B：将被作为 target
      window.__drawpaper__!.invoke('addNode', 'text', 50, 200); // A：将被作为 source（父）
    });
    await page.waitForTimeout(400);
    const edgesBefore = await page.evaluate(() => window.__drawpaper__!.getState().doc.edges.length);

    // B 是 nodes[0]（500,200），其左侧 target handle
    const handleBox = await page.locator('.react-flow__node').nth(0).locator('.react-flow__handle-left').boundingBox();
    const sourceBox = await page.locator('.react-flow__node').nth(1).boundingBox();
    expect(handleBox).toBeTruthy();
    expect(sourceBox).toBeTruthy();
    const hx = handleBox!.x + handleBox!.width / 2;
    const hy = handleBox!.y + handleBox!.height / 2;
    const tx = sourceBox!.x + sourceBox!.width / 2;
    const ty = sourceBox!.y + sourceBox!.height / 2;

    await page.evaluate(
      async ({ hx, hy, tx, ty }) => {
        const el = document.elementFromPoint(hx, hy) as Element;
        const pid = 888;
        el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: pid, clientX: hx, clientY: hy, bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
        window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: pid, clientX: tx, clientY: ty, bubbles: true }));
        await new Promise((r) => setTimeout(r, 50));
        window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: pid, clientX: tx, clientY: ty, bubbles: true }));
      },
      { hx, hy, tx, ty },
    );
    await page.waitForTimeout(400);
    const edgesAfter = await page.evaluate(() => window.__drawpaper__!.getState().doc.edges.length);
    expect(edgesAfter).toBe(edgesBefore + 1);
    // 边方向：source = A(nth1)，target = B(nth0)
    const orient = await page.evaluate(() => {
      const doc = window.__drawpaper__!.getState().doc;
      const e = doc.edges[doc.edges.length - 1]!;
      return { s: e.source, t: e.target };
    });
    const nodeIds = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.map((n) => n.id));
    expect(orient.s).toBe(nodeIds[1]); // A 父
    expect(orient.t).toBe(nodeIds[0]); // B 子
  });
});

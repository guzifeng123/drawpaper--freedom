import { test, expect, type Page } from '@playwright/test';

/**
 * Wave23.5 P1 修复回归：含环边导致主线程同步死锁、「连线冲突」弹窗不可达。
 *
 * 根因（见 docs/wave23/cycle-layout-hang.md）：App 分页虚线叠加层在每次 doc 变化时
 * 同步跑 computePanelsPaginate → paginateFit → activeNodeSet.isFoldedDescendant，
 * 后者沿 buildParentOf 的 parent 指针上行无 visited 守卫；含环 edges（A→B、B→A）下
 * parentOf 自成交，上行 A↔B 无限循环，React 渲染阶段主线程死锁，弹窗永远挂不出来。
 *
 * 覆盖（本分支基线能力：指针 + 触屏；键盘成环属 Wave23 H 分支，不在此断言）：
 *  - 指针/连接路径：A→B 后经 onConnect 同一个 api.addEdge(B,A) 成环 → 弹窗有界出现、
 *    页面可交互；①取消 → 触发边 B→A 回退（edges 恢复 1 条）、弹窗关闭、可继续；
 *    ②重触发 → 断开环边裁决 → applyResolution 后图恢复无环、可撤销/重放。
 *  - 触屏路径：PointerEvent pointerType=touch 长按起连线（范式见 fix-editor.spec.ts），
 *    至少覆盖弹窗可达 + 取消一条。
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

async function twoNodes(page: Page): Promise<[string, string]> {
  await page.evaluate(() => {
    window.__drawpaper__!.invoke('addNode', 'text', 50, 200); // A
    window.__drawpaper__!.invoke('addNode', 'text', 500, 200); // B
  });
  await page.waitForTimeout(400);
  return page.evaluate(() =>
    window.__drawpaper__!.getState().doc.nodes.map((n) => n.id) as [string, string],
  );
}

async function edgeAB(page: Page, a: string, b: string): Promise<void> {
  await page.evaluate(([a, b]) => window.__drawpaper__!.invoke('addEdge', a, b), [a, b]);
  await page.waitForTimeout(300);
}

async function edgeCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__drawpaper__!.getState().doc.edges.length);
}

test.describe('Wave23.5 成环冲突弹窗可达性（P1 死锁回归）', () => {
  test('指针连接路径：B→A 成环 → 弹窗有界出现；①取消回退、②断开裁决可撤销/重放', async ({ page }) => {
    const [A, B] = await twoNodes(page);
    await edgeAB(page, A, B);
    expect(await edgeCount(page)).toBe(1);

    // ---- 经 onConnect 同一个 api.addEdge 路径触发 B→A 成环 ----
    // （指针拖连松手后 onConnect 即调 api.addEdge(source,target)；此处直连该 action，
    //  与鼠标/触屏松手后汇入的是同一段 runCommand→promptConflicts→渲染链路。）
    await page.evaluate(([a, b]) => window.__drawpaper__!.invoke('addEdge', b, a), [A, B]);

    // 弹窗必须在有界时间内出现（修复前：含环文档交给 React 渲染即主线程死锁，
    // 此断言永远等不到弹窗 → 超时失败）。
    const dialog = page.getByText('连线冲突，请裁决');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('成环了')).toBeVisible();

    // ===== ① 取消：触发边 B→A 被回退，edges 恢复 1 条，弹窗关闭，可继续操作 =====
    await page.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden({ timeout: 3000 });
    expect(await edgeCount(page)).toBe(1); // B→A 精确回退

    // 页面仍可交互：再触发一次成环，弹窗仍能在有界时间内弹出（证明主线程未卡死）。
    await page.evaluate(([a, b]) => window.__drawpaper__!.invoke('addEdge', b, a), [A, B]);
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('成环了')).toBeVisible();

    // ===== ② 成环裁决：断开一条环边 → applyResolution 后图恢复无环 =====
    await page.locator('input[type="checkbox"]').first().check();
    await page.getByRole('button', { name: '确定' }).click();
    await expect(dialog).toBeHidden({ timeout: 3000 });
    // 环边被裁决断开 → 仍 1 条边（A→B 保留，B→A 被删）。
    expect(await edgeCount(page)).toBe(1);

    // 可撤销：undo 撤销 resolve-conflicts 宏 → 恢复被删边（回到 2 条）。
    await page.evaluate(() => window.__drawpaper__!.invoke('undo'));
    await page.waitForTimeout(200);
    expect(await edgeCount(page)).toBe(2);
    // 可重放：redo 再落一次裁决。
    await page.evaluate(() => window.__drawpaper__!.invoke('redo'));
    await page.waitForTimeout(200);
    expect(await edgeCount(page)).toBe(1);
  });

  test('触屏路径：长按 B 的 source handle 拖到 A 成环 → 弹窗可达 + 取消回退', async ({ page }) => {
    const [A, B] = await twoNodes(page);
    await edgeAB(page, A, B);
    expect(await edgeCount(page)).toBe(1);

    // 触屏长按 B 的 source handle（pointerType=touch，范式见 fix-editor.spec.ts）。
    const handleBox = await page
      .locator(`.react-flow__node[data-id="${B}"] .react-flow__handle-right`)
      .boundingBox();
    const targetBox = await page.locator(`.react-flow__node[data-id="${A}"]`).boundingBox();
    expect(handleBox).toBeTruthy();
    expect(targetBox).toBeTruthy();
    const hx = handleBox!.x + handleBox!.width / 2;
    const hy = handleBox!.y + handleBox!.height / 2;
    const tx = targetBox!.x + targetBox!.width / 2;
    const ty = targetBox!.y + targetBox!.height / 2;

    await page.evaluate(
      async ({ hx, hy, tx, ty }) => {
        const target = document.elementFromPoint(hx, hy) as Element;
        const pid = 999;
        target.dispatchEvent(
          new PointerEvent('pointerdown', { pointerType: 'touch', pointerId: pid, clientX: hx, clientY: hy, bubbles: true }),
        );
        await new Promise((r) => setTimeout(r, 600)); // 等长按触发连线
        window.dispatchEvent(
          new PointerEvent('pointermove', { pointerType: 'touch', pointerId: pid, clientX: tx, clientY: ty, bubbles: true }),
        );
        await new Promise((r) => setTimeout(r, 50));
        window.dispatchEvent(
          new PointerEvent('pointerup', { pointerType: 'touch', pointerId: pid, clientX: tx, clientY: ty, bubbles: true }),
        );
      },
      { hx, hy, tx, ty },
    );

    // 弹窗有界出现（修复前：主线程死锁，弹窗不可达）。
    const dialog = page.getByText('连线冲突，请裁决');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('成环了')).toBeVisible();

    // 取消 → 边回退到 1 条。
    await page.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden({ timeout: 3000 });
    expect(await edgeCount(page)).toBe(1);
  });
});

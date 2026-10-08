import { test, expect, type Page } from '@playwright/test';

/**
 * Wave23 纯键盘跨块父子连线 e2e（chromium）。
 *
 * 全程无鼠标点击：建块/选块经 DEV 钩子 invoke，连线流程纯 page.keyboard。
 * 覆盖：
 *  - 焦点 A 按 C → 弹目标选择器 → 键入 B 标题前缀 → Enter → 新边 A→B 且可一键撤销；
 *  - 取消路径：C 后 Esc 无新边、模式退回 select；
 *  - 自环候选不存在（源块自身被排除）；
 *  - 重复连接走「已存在」提示；
 *  - 成环（A→B→A）目标在候选中可见、不被静默吞掉；
 *  - 成环触发「连线冲突」裁决弹窗：以 test.fixme 挂账（基线渲染器成环死锁，见
 *    docs/wave23/keyboard-cross-connect.md §挂账）。
 */

async function edgeList(page: Page) {
  return page.evaluate(() => (window.__drawpaper__!.getState().doc.edges as { source: string; target: string }[]));
}

/** 经 DEV 钩子建一个带文字标题的块，返回 id。 */
async function makeBlock(page: Page, x: number, y: number, text: string): Promise<string> {
  return page.evaluate(
    ({ x, y, text }) => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', x, y) as string;
      h.invoke('updateContent', id, {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      });
      return id;
    },
    { x, y, text },
  );
}

test.describe('Wave23 纯键盘跨块父子连线', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow')).toBeVisible();
    await page.evaluate(() => window.__drawpaper__!.invoke('newDoc'));
    await page.waitForTimeout(300);
  });

  test('焦点 A 按 C → 键入 B 前缀 → Enter 建立 A→B，可一键撤销', async ({ page }) => {
    const A = await makeBlock(page, 0, 0, '苹果计划');
    const B = await makeBlock(page, 320, 0, '蓝莓任务');
    await page.evaluate((id) => window.__drawpaper__!.invoke('setSelection', [id]), A);
    await page.waitForTimeout(100);

    // 按 C 进入连线模式并弹出目标选择器
    await page.keyboard.press('c');
    await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeVisible();
    await expect(page.getByLabel('连线目标搜索')).toBeFocused();

    // 键入 B 标题前缀 → 候选过滤
    await page.keyboard.type('蓝莓', { delay: 30 });
    await page.waitForTimeout(150);
    await expect(page.locator('[role="option"]').filter({ hasText: '蓝莓任务' })).toBeVisible();

    // Enter 确认 → 新边 A→B
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const edges = await edgeList(page);
    expect(edges.some((e) => e.source === A && e.target === B)).toBe(true);

    // 一键撤销还原
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    const afterUndo = await edgeList(page);
    expect(afterUndo.find((e) => e.source === A && e.target === B)).toBeUndefined();

    // 选择器已关闭、模式退回 select
    await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeHidden();
  });

  test('取消路径：C 后 Esc 无新边、模式退出', async ({ page }) => {
    const A = await makeBlock(page, 0, 0, '苹果计划');
    await makeBlock(page, 320, 0, '蓝莓任务');
    await page.evaluate((id) => window.__drawpaper__!.invoke('setSelection', [id]), A);
    await page.waitForTimeout(100);

    await page.keyboard.press('c');
    await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeHidden();

    const edges = await edgeList(page);
    expect(edges).toHaveLength(0);
  });

  test('自环候选不存在（源块自身被排除）', async ({ page }) => {
    const A = await makeBlock(page, 0, 0, '苹果计划');
    await makeBlock(page, 320, 0, '蓝莓任务');
    await page.evaluate((id) => window.__drawpaper__!.invoke('setSelection', [id]), A);
    await page.waitForTimeout(100);

    await page.keyboard.press('c');
    await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeVisible();
    // 搜 A 自己的标题 → 无匹配（self 被排除）
    await page.keyboard.type('苹果', { delay: 30 });
    await page.waitForTimeout(150);
    await expect(page.locator('[role="option"]')).toHaveCount(0);
    await expect(page.getByText('无匹配块')).toBeVisible();
  });

  test('已连接的子块在候选中被排除，不产生第二条边', async ({ page }) => {
    const A = await makeBlock(page, 0, 0, '苹果计划');
    const B = await makeBlock(page, 320, 0, '蓝莓任务');
    // 先建一条 A→B（B 成为 A 的后代子块）
    await page.evaluate(({ A, B }) => window.__drawpaper__!.invoke('addEdge', A, B), { A, B });
    await page.waitForTimeout(100);

    await page.evaluate((id) => window.__drawpaper__!.invoke('setSelection', [id]), A);
    await page.waitForTimeout(100);
    await page.keyboard.press('c');
    await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeVisible();
    // B 已是 A 的子块（后代），候选过滤将其排除 → 搜不到，无法二次连线
    await page.keyboard.type('蓝莓', { delay: 30 });
    await page.waitForTimeout(150);
    await expect(page.locator('[role="option"]')).toHaveCount(0);
    await expect(page.getByText('无匹配块')).toBeVisible();
    // 仍只有一条 A→B（未产生重复边）
    const edges = await edgeList(page);
    expect(edges.filter((e) => e.source === A && e.target === B)).toHaveLength(1);
  });

  test('成环 A→B→A：从 B 可向 A 发起连线（不静默吞掉成环目标）', async ({ page }) => {
    const A = await makeBlock(page, 0, 0, '苹果计划');
    const B = await makeBlock(page, 320, 0, '蓝莓任务');
    // 已有 A→B
    await page.evaluate(({ A, B }) => window.__drawpaper__!.invoke('addEdge', A, B), { A, B });
    await page.waitForTimeout(100);

    // 焦点 B，打开选择器：A 不是 B 的后代，应作为候选出现
    // —— 即「B 想连回 A」这个成环尝试被暴露给用户，而不是被过滤静默吞掉。
    await page.evaluate((id) => window.__drawpaper__!.invoke('setSelection', [id]), B);
    await page.waitForTimeout(100);
    await page.keyboard.press('c');
    await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeVisible();
    await page.keyboard.type('苹果', { delay: 30 });
    await page.waitForTimeout(150);
    // A 在候选中
    await expect(page.locator('[role="option"]').filter({ hasText: '苹果计划' })).toBeVisible();

    // 确认走与指针拖拽完全相同的 onConnect → api.addEdge 校验链（自环/重复边 toast、
    // 多父/成环由 core analyze 检出 → pendingConflicts → 既有「连线冲突，请裁决」弹窗，
    // 撤销栈自动继承）。该裁决链路由既有指针连线 e2e 与 core 单测覆盖；此处验证键盘
    // 入口能把成环目标正确递交到同一条校验链（成环目标不被候选过滤静默吞掉）。
    // 注：实际按下确认会让既有指针路径渲染成环边（基线渲染器在成环边上的已知问题，
    // 非本路引入），故此处不断言弹窗 DOM，仅验证候选递交正确。
  });

  // 挂账：基线渲染器在「成环形状的图」上同步死锁（dev 与生产构建均复现，干净基线
  // 4836b69 同样复现），ConflictDialog 不可达。按 Wave21 D 路纪律，缺口以 test.fixme
  // 在 CI 里可见挂账，不删断言凑绿。函数体写全本应断言的步骤，待专门修复波次解除 fixme。
  // 见 docs/wave23/keyboard-cross-connect.md §挂账。
  test.fixme(
    '成环 A→B→A：触发「连线冲突」裁决弹窗（阻塞：基线渲染器成环死锁，见 docs/wave23/keyboard-cross-connect.md §挂账）',
    async ({ page }) => {
      const A = await makeBlock(page, 0, 0, '苹果计划');
      const B = await makeBlock(page, 320, 0, '蓝莓任务');
      // 已有 A→B
      await page.evaluate(({ A, B }) => window.__drawpaper__!.invoke('addEdge', A, B), { A, B });
      await page.waitForTimeout(100);

      // 焦点 B，键盘发起 B→A（成环尝试）
      await page.evaluate((id) => window.__drawpaper__!.invoke('setSelection', [id]), B);
      await page.waitForTimeout(100);
      await page.keyboard.press('c');
      await expect(page.getByRole('listbox', { name: '可连接的目标块' })).toBeVisible();
      await page.keyboard.type('苹果', { delay: 30 });
      await page.waitForTimeout(150);
      await expect(page.locator('[role="option"]').filter({ hasText: '苹果计划' })).toBeVisible();

      // 确认 → 走 onConnect → api.addEdge → core analyze 检出成环 → pendingConflicts
      // → 既有「连线冲突，请裁决」弹窗（而非静默失败）。当前基线在此步卡死主线程。
      await page.keyboard.press('Enter');
      await expect(page.getByText('连线冲突，请裁决')).toBeVisible({ timeout: 3000 });
    },
  );
});

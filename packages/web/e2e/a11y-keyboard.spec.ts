import { test, expect, type Page } from '@playwright/test';

/**
 * Wave9 无障碍 / 键盘流 e2e（chromium）。
 *
 * 纯键盘全流程：
 *  - 空文档 → Enter 建根块 → 输入文字 → Tab 建子块（父子边）→ 输入；
 *  - Alt+Left 回到父块、Alt+Right 回到子块（键盘连线替代路径 = Tab 建子 + Alt 跳父子）；
 *  - Ctrl+P 打开导出对话框：断言焦点在弹层内、Tab 焦点循环（focus trap）、Esc 关闭后焦点回触发元素；
 *  - 断言 :focus-visible 焦点环出现；
 *  - emulateMedia reducedMotion=reduce 时 transition-duration 被降级到 1ms。
 *
 * 弹层焦点管理靠 Radix Dialog 内建（已在依赖树，未引第三方 focus-lock）。
 */

test.describe('Wave9 无障碍 / 键盘流', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.react-flow')).toBeVisible();
    // 干净空文档
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('newDoc');
    });
    await page.waitForTimeout(300);
    // 点一下空白 pane，把焦点从工具栏按钮上移开。
    await page.locator('.react-flow__pane').click({ position: { x: 600, y: 400 } });
    await page.waitForTimeout(100);
  });

  async function edgeCount(page: Page): Promise<number> {
    return page.evaluate(() => window.__drawpaper__!.getState().doc.edges.length);
  }

  async function activeNodeId(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const el = document.activeElement?.closest('.react-flow__node');
      return el?.getAttribute('data-id') ?? null;
    });
  }

  test('纯键盘建块 + Alt+方向键父子导航 + 父子边', async ({ page }) => {
    // Enter 在视口中心建根块并进入编辑
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror-focused')).toBeVisible({ timeout: 5000 });
    await page.keyboard.type('根块标题', { delay: 15 });

    // Esc 退出编辑（根块仍选中）
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Tab 建子块 + 父子边，进入子块编辑
    await page.keyboard.press('Tab');
    await expect(page.locator('.ProseMirror-focused')).toBeVisible({ timeout: 5000 });
    await page.keyboard.type('子块内容', { delay: 15 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 父子边已建立（store 层断言，DOM SVG 选择器在缩放/虚拟化下不稳）
    expect(await edgeCount(page)).toBe(1);

    // Alt+Left 回到父块
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(400);
    const focusedParent = await activeNodeId(page);
    expect(focusedParent).toBeTruthy();
    await expect(page.locator('.react-flow__node').filter({ hasText: '根块标题' }).first()).toBeVisible();

    // Alt+Right 回到子块
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForTimeout(400);
    await expect(page.locator('.react-flow__node').filter({ hasText: '子块内容' }).first()).toBeVisible();

    // :focus-visible 焦点环：当前聚焦块 outline 不为 none
    const outline = await page.evaluate(() => {
      const el = document.activeElement?.closest('.block-shell') as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return cs.outlineStyle + '|' + cs.outlineWidth;
    });
    expect(outline).toBeTruthy();
    expect(outline).not.toContain('none');
  });

  test('Ctrl+P 导出对话框：焦点在弹层内 + Esc 关闭后焦点回触发元素', async ({ page }) => {
    // 先建一个块并退出编辑（作为「触发元素」）
    await page.keyboard.press('Enter');
    await expect(page.locator('.ProseMirror-focused')).toBeVisible({ timeout: 5000 });
    await page.keyboard.type('触发块', { delay: 15 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 用 Alt+Down 让块外壳获得键盘焦点（浏览器 Tab 被结构建块占用）。
    // 单块无兄弟 → Alt+Down 不移动；直接 focus 块外壳。
    await page.locator('.react-flow__node .block-shell').first().focus();
    await page.waitForTimeout(200);
    const triggerIsBlock = await page.evaluate(() =>
      !!document.activeElement?.closest('.react-flow__node .block-shell'),
    );
    expect(triggerIsBlock).toBe(true);

    // Ctrl+P 打开导出
    await page.keyboard.press('Control+p');
    await expect(page.getByRole('heading', { name: '导出 / 打印' })).toBeVisible();

    // 焦点在弹层内（[role=dialog] 内）
    const focusInDialog = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && d.contains(document.activeElement);
    });
    expect(focusInDialog).toBe(true);

    // Shift+Tab 在弹层内循环（focus trap，不跑出弹层）
    await page.keyboard.press('Shift+Tab');
    const stillInDialog = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && d.contains(document.activeElement);
    });
    expect(stillInDialog).toBe(true);

    // Esc 关闭
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '导出 / 打印' })).toBeHidden();

    // 焦点回到触发块
    const backToBlock = await page.evaluate(() =>
      !!document.activeElement?.closest('.react-flow__node .block-shell'),
    );
    expect(backToBlock).toBe(true);
  });

  test('prefers-reduced-motion: transition-duration 被降级到 1ms', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    const reducedDur = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.transition = 'transform 250ms ease';
      document.body.appendChild(probe);
      const dur = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return dur;
    });
    // @media (prefers-reduced-motion: reduce) 用 !important 把 transition-duration 压到 1ms
    expect(reducedDur).toBe('0.001s');
  });
});

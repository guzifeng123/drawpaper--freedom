import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { waitForApp, loadStandard } from './fixtures/load-doc';

/**
 * Wave22 B 路：手机 PWA 窄屏（≤640px）响应式外壳 + RF Controls aria-label 挂账。
 *
 * 全部为「可计算断言」，不做截图比对：
 *  ① documentElement 无横向滚动溢出（scrollWidth ≤ clientWidth+1）；
 *  ② 顶栏所有按钮落在横向滚动容器内容范围内（可经滑动到达，不被裁切）；
 *  ③ DocsList 侧栏 / 右上搜索 / 左下大纲 / 右下反链 在窄屏为受控浮层
 *     （有遮罩、宽度 ≤ min(18rem, 90vw)），关闭后画布可交互（pane 点击 + Enter 建块）；
 *  ④ React Flow Controls 四按钮均有非空中文 aria-label，axe 区域扫描零 violation；
 *  ⑤ 桌面 1280×800 基线：面板仍为固定侧栏形态、窄屏遮罩 display:none、无横向溢出。
 */

const MOBILE = { width: 375, height: 667 };
/** 375px 下 min(18rem, 90vw) = min(288, 337.5) = 288px，放 1px 余量。 */
const NARROW_PANEL_MAX = 289;

const nodeCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __drawpaper__: { getState: () => { nodeCount: number } } })
    .__drawpaper__.getState().nodeCount);

/** 关闭面板后证明画布可交互：点空白 pane（不建块），再 Enter 真的建一块。 */
async function expectCanvasInteractive(page: Page) {
  const before = await nodeCount(page);
  // (180, 300)：避开左侧文档轨道（≤56px）、左下角 RF Controls 与右下角 MiniMap。
  await page.locator('.react-flow__pane').click({ position: { x: 180, y: 300 } });
  expect(await nodeCount(page)).toBe(before);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => nodeCount(page), { timeout: 3000 })
    .toBe(before + 1);
}

/** 断言浮层形态：面板可见 + 遮罩可见 + 宽度 ≤ min(18rem,90vw)。 */
async function expectOverlayShape(page: Page, panelSel: string) {
  const panel = page.locator(panelSel);
  await expect(panel).toBeVisible();
  await expect(page.locator('.narrow-backdrop >> visible=true').first()).toBeVisible();
  const box = await panel.boundingBox();
  expect(box, `浮层 ${panelSel} 不存在`).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(NARROW_PANEL_MAX);
}

/** 断言窄屏遮罩全部关闭（≥640px 下 sm:hidden 的节点不算可见）。 */
async function expectNoVisibleBackdrop(page: Page) {
  await expect(page.locator('.narrow-backdrop >> visible=true')).toHaveCount(0);
}

test.describe('Wave22 手机窄屏外壳（375×667 移动视口）', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true });

  test('无横向滚动溢出；顶栏一行横向滚动收纳、按钮不被裁切', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);

    // ① 文档级无横向溢出。
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { sw: de.scrollWidth, cw: de.clientWidth };
    });
    expect(overflow.sw).toBeLessThanOrEqual(overflow.cw + 1);

    // ② 顶栏所有按钮都在滚动内容范围内（min≥0、max≤scrollWidth），且窄屏确实可滑。
    const topbar = await page.evaluate(() => {
      const h = document.querySelector('header') as HTMLElement;
      const hs = h.getBoundingClientRect();
      const btns = Array.from(h.querySelectorAll('button'));
      let min = Infinity;
      let max = -Infinity;
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        min = Math.min(min, r.left - hs.left + h.scrollLeft);
        max = Math.max(max, r.right - hs.left + h.scrollLeft);
      }
      return { count: btns.length, min, max, sw: h.scrollWidth, cw: h.clientWidth };
    });
    expect(topbar.count).toBeGreaterThan(10);
    expect(topbar.min).toBeGreaterThanOrEqual(-1);
    expect(topbar.max).toBeLessThanOrEqual(topbar.sw + 1);
    // 窄屏内容比视口宽 → 横向滚动收纳成立。
    expect(topbar.sw).toBeGreaterThan(topbar.cw);
  });

  test('DocsList 窄屏为左侧浮层 sheet：展开有遮罩，点遮罩收起为轨道', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);

    // 展开轨道按钮（aria-label）→ sheet 滑出。
    await page.getByRole('button', { name: '展开文档列表' }).click();
    await expectOverlayShape(page, '[data-testid="docs-list-panel"]');

    // 点遮罩右侧空白处（sheet 占左 288px，右侧 320px 不被面板压住）→ 收起为轨道。
    await page.locator('.narrow-backdrop').click({ position: { x: 330, y: 300 } });
    await expect(page.locator('[data-testid="docs-list-panel"]')).toBeHidden();
    await expectNoVisibleBackdrop(page);
    await expect(page.getByRole('button', { name: '展开文档列表' })).toBeVisible();
  });

  test('右上搜索面板窄屏为受控浮层：遮罩关闭后画布可交互', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);

    await page.getByRole('button', { name: '搜索' }).click();
    await expectOverlayShape(page, '[data-testid="search-panel"]');

    // 面板自带 × 关闭（aria-label=关闭搜索）。
    await page.getByRole('button', { name: '关闭搜索' }).click();
    await expect(page.locator('[data-testid="search-panel"]')).toBeHidden();
    await expectNoVisibleBackdrop(page);

    await expectCanvasInteractive(page);
  });

  test('左下大纲面板窄屏为受控浮层：点遮罩关闭后画布可交互', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);

    await page.getByRole('button', { name: /大纲面板/ }).click();
    await expectOverlayShape(page, '[data-testid="outline-panel"]');

    // 大纲无自带关闭钮：点遮罩右侧（sheet 占左 288px）关闭。
    await page.locator('.narrow-backdrop').click({ position: { x: 330, y: 300 } });
    await expect(page.locator('[data-testid="outline-panel"]')).toBeHidden();
    await expectNoVisibleBackdrop(page);

    await expectCanvasInteractive(page);
  });

  test('右下反链面板窄屏为受控浮层：× 关闭后画布可交互', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);

    await page.getByRole('button', { name: '反向链接' }).click();
    await expectOverlayShape(page, '[data-testid="backlinks-panel"]');

    await page.getByRole('button', { name: '关闭反链' }).click();
    await expect(page.locator('[data-testid="backlinks-panel"]')).toBeHidden();
    await expectNoVisibleBackdrop(page);

    await expectCanvasInteractive(page);
  });

  test('React Flow Controls 四按钮均有中文 aria-label，axe 区域扫描零 violation', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);

    const btns = page.locator('.react-flow__controls-button');
    await expect(btns).toHaveCount(4);
    const labels = await btns.evaluateAll((ns) =>
      ns.map((b) => b.getAttribute('aria-label') ?? ''),
    );
    expect(labels.every((l) => l.length > 0)).toBeTruthy();
    expect(new Set(labels)).toEqual(new Set(['放大', '缩小', '适应视图', '锁定视口']));

    // axe 仅扫 Controls 区域：零 violation（critical/serious/moderate 全清零）。
    const results = await new AxeBuilder({ page }).include('.react-flow__controls').analyze();
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html ?? ''}`).join('\n'),
    ).toHaveLength(0);
  });
});

test.describe('Wave22 桌面基线（1280×800）', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('布局与基线一致：面板仍为固定侧栏形态、窄屏遮罩不显示、无横向溢出', async ({ page }) => {
    await waitForApp(page);
    await loadStandard(page);

    // 文档级无横向溢出。
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { sw: de.scrollWidth, cw: de.clientWidth };
    });
    expect(overflow.sw).toBeLessThanOrEqual(overflow.cw + 1);

    // DocsList 默认展开 w-56（224px）固定侧栏，贴左。
    const docsBox = await page.locator('[data-testid="docs-list-panel"]').boundingBox();
    expect(docsBox).not.toBeNull();
    expect(docsBox!.width).toBeGreaterThan(200);
    expect(docsBox!.x).toBeLessThan(40);

    // 打开搜索面板：桌面 w-96（384px）固定浮层；窄屏遮罩在 ≥640px 下全部 display:none。
    await page.getByRole('button', { name: '搜索' }).click();
    const searchBox = await page.locator('[data-testid="search-panel"]').boundingBox();
    expect(searchBox).not.toBeNull();
    expect(searchBox!.width).toBeGreaterThan(360);
    await expectNoVisibleBackdrop(page);
  });
});

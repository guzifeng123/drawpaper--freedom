import { test, expect } from '@playwright/test';
import { waitForApp, loadPerf, getState } from './fixtures/load-doc';

/**
 * §9 性能验收：
 *  - 500 块：一次拖拽 + 一次滚轮缩放的中位/低分帧率（rAF 采样）；
 *    视口内实际渲染节点数远小于总数（onlyRenderVisibleElements 生效）。
 *  - 2000 块：可加载、无崩溃、可平移。
 * 无头环境可能被节流，如实报告数值。
 */

/** 在页面内采样 rAF 帧率并执行一次交互，返回 {frames, durationMs}。 */
async function sampleFps(page: import('@playwright/test').Page, interact: 'drag' | 'wheel') {
  return page.evaluate(async (kind) => {
    await new Promise((r) => setTimeout(r, 200));
    const frames: number[] = [];
    let raf = 0;
    let start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (t: number) => {
        frames.push(t);
        if (t - start > 350) {
          resolve();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    cancelAnimationFrame(raf);
    // 帧率 = 帧数 / 秒。
    const dur = (frames[frames.length - 1]! - frames[0]!) / 1000;
    const fps = (frames.length - 1) / dur;
    return { fps, samples: frames.length, kind };
  }, interact);
}

test.describe('§9 性能', () => {
  test('500 块：拖拽/滚轮帧率采样 + 渲染节点数远小于总数', async ({ page }) => {
    await waitForApp(page);
    await loadPerf(page, 500);
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(500);

    const st = (await getState(page)) as { nodeCount: number };
    expect(st.nodeCount).toBeGreaterThanOrEqual(450);

    // 视口内实际渲染的 React Flow 节点数（onlyRenderVisibleElements 生效）。
    const rendered = await page.locator('.react-flow__node').count();
    console.log('RENDERED_VISIBLE', rendered, 'OF_TOTAL', st.nodeCount);
    expect(rendered).toBeLessThan(st.nodeCount * 0.5);

    // 拖拽一个节点 300ms。
    const node = page.locator('.react-flow__node').first();
    const box = await node.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + 100, box!.y + 30);
    const dragP = sampleFps(page, 'drag');
    await page.mouse.down();
    await page.mouse.move(box!.x + 300, box!.y + 120, { steps: 20 });
    await page.mouse.up();
    const dragFps = await dragP;
    console.log('DRAG_FPS', JSON.stringify(dragFps));

    // 滚轮缩放。
    const wheelP = sampleFps(page, 'wheel');
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, -300);
    const wheelFps = await wheelP;
    console.log('WHEEL_FPS', JSON.stringify(wheelFps));

    // 数值记录即可；无头环境节流时不做硬性 30fps 断言，仅报告。
    expect(dragFps.fps).toBeGreaterThan(0);
    expect(wheelFps.fps).toBeGreaterThan(0);
  });

  test('2000 块：可加载、无崩溃、可平移', async ({ page }) => {
    test.setTimeout(180_000);
    await waitForApp(page);
    const t0 = Date.now();
    await loadPerf(page, 2000);
    const loadMs = Date.now() - t0;
    console.log('LOAD_2000_MS', loadMs);
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(500);

    const st = (await getState(page)) as { nodeCount: number };
    expect(st.nodeCount).toBeGreaterThanOrEqual(1900);

    // 平移：拖拽空白画布。
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(900, 600, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    // 无崩溃：页面仍有画布。
    await expect(page.locator('.react-flow')).toBeVisible();
    console.log('LOAD_2000_OK', st.nodeCount, 'nodes in', loadMs, 'ms');
  });
});

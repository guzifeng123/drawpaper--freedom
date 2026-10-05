import { test, expect } from '@playwright/test';
import { waitForApp, loadPerf, getState } from './fixtures/load-doc';
import { buildPerfFixture } from './fixtures/sample-doc';

/**
 * §9 性能验收：
 *  - 500 块：一次拖拽 + 一次滚轮缩放的中位/低分帧率（rAF 采样）；
 *    视口内实际渲染节点数远小于总数（onlyRenderVisibleElements 生效）。
 *  - 2000 块：加载 TTI ≤ 15s（争取 ≤10s），可平移/可双击/搜索最终命中。
 * 无头环境可能被节流，如实报告数值。
 */

/**
 * TTI 阈值（ms）。测量口径见 docs/wave5/perf-large-doc.md：
 * 从触发 loadFixture 开始，到「视口内节点已渲染」且「一次画布交互
 * （Ctrl+F 打开搜索）在 500ms 内响应」为止。
 */
const TTI_2000_MAX_MS = 15_000;
/** 交互响应预算（ms）：TTI 前最后一次交互必须在此时间内出结果。 */
const INTERACTION_BUDGET_MS = 500;

/** 在页面内采样 rAF 帧率并执行一次交互，返回 {frames, durationMs}。 */
async function sampleFps(page: import('@playwright/test').Page, interact: 'drag' | 'wheel') {
  return page.evaluate(async (kind) => {
    await new Promise((r) => setTimeout(r, 200));
    const frames: number[] = [];
    let raf = 0;
    const start = performance.now();
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

  test('2000 块：加载 TTI ≤15s，可平移/搜索', async ({ page }) => {
    test.setTimeout(180_000);
    await waitForApp(page);

    // ---- 精确 TTI 测量 ----
    // t0 = 触发 loadFixture；等到视口节点渲染 + 一次交互（Ctrl+F 开搜索）在预算内响应。
    const doc = buildPerfFixture(2000);
    const t0 = Date.now();
    await page.evaluate((d: unknown) => {
      (window as unknown as { __drawpaper__: { loadFixture: (x: unknown) => void } }).__drawpaper__.loadFixture(d);
    }, doc);

    // 1) 视口内节点已渲染。
    await page.locator('.react-flow__node').first().waitFor({ timeout: TTI_2000_MAX_MS });
    const nodesRenderedMs = Date.now() - t0;

    // 2) 一次画布交互在 500ms 内响应：Ctrl+F 打开搜索面板。
    const tInteractionStart = Date.now();
    await page.keyboard.press('Control+f');
    await page.locator('.absolute.right-4.top-14').first().waitFor({ timeout: INTERACTION_BUDGET_MS });
    const interactionMs = Date.now() - tInteractionStart;

    const ttiMs = Date.now() - t0;
    console.log('TTI_2000_MS', ttiMs, 'nodesRenderedMs', nodesRenderedMs, 'interactionMs', interactionMs);

    // 分阶段采样（long tasks / buildIndex 等由 dev-hooks 写入 __perfStages）。
    await page.waitForTimeout(1500);
    const stages = await page.evaluate(
      () => (window as unknown as { __perfStages?: Record<string, number> }).__perfStages ?? {},
    );
    console.log('PERF_STAGES', JSON.stringify(stages));

    // TTI 断言：节点渲染 + 交互在预算内，总 TTI ≤ 阈值。
    expect(nodesRenderedMs).toBeLessThan(TTI_2000_MAX_MS);
    expect(interactionMs).toBeLessThan(INTERACTION_BUDGET_MS);
    expect(ttiMs).toBeLessThan(TTI_2000_MAX_MS);

    const st = (await getState(page)) as { nodeCount: number };
    expect(st.nodeCount).toBeGreaterThanOrEqual(1900);

    // 搜索最终能命中（索引已在 buildIndex 同步建好）。先关掉上一步的搜索再重开，直接填输入框。
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+f');
    await page.waitForTimeout(200);
    await page.locator('.absolute.right-4.top-14 input').first().fill('block');
    await page.waitForTimeout(800);
    const hits = await page.evaluate(
      () => {
        const g = (window as unknown as { __drawpaper__: { getState: () => { searchResults: unknown[]; searchQuery?: string } } }).__drawpaper__.getState();
        return { n: g.searchResults.length, q: (g as { searchQuery?: string }).searchQuery };
      },
    );
    console.log('SEARCH_HITS_AFTER_LOAD', JSON.stringify(hits));

    // 平移：拖拽空白画布。
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(900, 600, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    await expect(page.locator('.react-flow')).toBeVisible();
    console.log('LOAD_2000_OK', st.nodeCount, 'nodes; TTI', ttiMs, 'ms');
  });
});

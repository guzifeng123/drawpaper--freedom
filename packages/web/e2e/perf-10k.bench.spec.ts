import { test, expect } from '@playwright/test';
import { waitForApp, getState } from './fixtures/load-doc';
import { buildPerfFixtureWide } from './fixtures/sample-doc';

/**
 * Wave7 robustness（任务4）：10000 块文档性能基准。
 *
 * 默认随门禁 SKIP：仅当 RUN_BENCH=1 时运行。避免拖慢全量 e2e。
 * 测量口径（与 §9 performance.spec.ts 2000 块一致）：
 *  - TTI：loadFixture → 视口节点渲染 + 一次交互（Ctrl+F）在预算内响应；
 *  - 最长 long task（dev-hook PerformanceObserver 采样，__perfStages.longTasks）；
 *  - buildIndex / afterRaf2 / switchDocSync 分阶段；
 *  - DOM 实际挂载的 .react-flow__node 数（onlyRenderVisibleElements 是否生效）。
 *
 * 采样输出打印到 stdout，人工记录进 docs/wave7/perf-10k.md。
 */

const TTI_10K_BUDGET_MS = 15_000;
const INTERACTION_BUDGET_MS = 1500;

// 默认跳过：benchmark 不随门禁跑。
const runBench = !!process.env.RUN_BENCH;

test.describe('§9b 10000 块性能基准（默认 skip）', () => {
  test.skip(!runBench, '需 RUN_BENCH=1 才跑（benchmark 不随门禁运行）');

  test('10000 块 TTI / long task / DOM 节点数采样', async ({ page }) => {
    test.setTimeout(120_000);
    await waitForApp(page);

    const doc = buildPerfFixtureWide(10000);
    const t0 = Date.now();
    await page.evaluate((d: unknown) => {
      (window as unknown as { __drawpaper__: { loadFixture: (x: unknown) => void } }).__drawpaper__.loadFixture(d);
    }, doc);

    // 1) 视口内节点已渲染。
    await page.locator('.react-flow__node').first().waitFor({ timeout: 60_000 });
    const nodesRenderedMs = Date.now() - t0;

    // 2) 一次交互（Ctrl+F 开搜索）响应时间。
    const tInteractionStart = Date.now();
    await page.keyboard.press('Control+f');
    await page.locator('.absolute.right-4.top-14').first().waitFor({ timeout: INTERACTION_BUDGET_MS });
    const interactionMs = Date.now() - tInteractionStart;

    const ttiMs = Date.now() - t0;

    // 等 idle 采样落定（longTasks / buildIndex）。
    await page.waitForTimeout(3000);
    const stages = await page.evaluate(
      () => (window as unknown as { __perfStages?: Record<string, number | number[]> }).__perfStages ?? {},
    );

    const renderedDomNodes = await page.locator('.react-flow__node').count();
    const st = (await getState(page)) as { nodeCount: number };

    console.log('BENCH_10K_RESULT', JSON.stringify({
      ttiMs,
      nodesRenderedMs,
      interactionMs,
      nodeCount: st.nodeCount,
      renderedDomNodes,
      stages,
    }));

    // 软断言：节点数对得上；DOM 挂载数应远小于总数（虚拟渲染生效）。
    expect(st.nodeCount).toBeGreaterThanOrEqual(9900);
    expect(renderedDomNodes).toBeLessThan(st.nodeCount * 0.5);

    // TTI 预算仅作记录性软阈值（headless 节流），不在 CI 硬卡。
    console.log('BENCH_10K_TTI_MS', ttiMs, 'budget', TTI_10K_BUDGET_MS);
  });
});

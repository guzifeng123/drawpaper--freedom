import { test, expect, type Page } from '@playwright/test';
import { waitForApp, getState } from './fixtures/load-doc';
import { buildPerfFixtureWide } from './fixtures/sample-doc';

/**
 * Wave8 性能固化：大规模文档渐进水化的硬阈值用例。
 *
 * 两级用例：
 *
 * 1) 完整 10000 块 benchmark —— 默认 SKIP，仅当 RUN_BENCH=1 运行（手动采样/本机验收）。
 *    带硬阈值：本机 3 次采样 TTI 中位 ~8.4s（8427/8707/8408），最长 long task ~3.9s。
 *    阈值 TTI ≤ 12s、最长 long task ≤ 6s（本机中位留 ~40% 余量；headless 节流波动）。
 *
 * 2) CI 默认跑的降级规模用例（2000 块）—— 门禁全量 e2e 必跑，防渐进水化逻辑回归。
 *    选 2000 块的依据：(a) 与 §9 performance.spec 同夹具，量级足够触发
 *    「首 commit 挂载全部节点」路径（onlyRenderVisibleElements 首帧前不裁剪）；
 *    (b) 本机 TTI 中位 ~2.4s、最长 long task ~0.9s，给 CI runner ~3x 慢机余量后
 *    定 TTI ≤ 8s、最长 long task ≤ 3s，既卡得住回归又不会因 runner 方差 flaky。
 *
 * 测量口径：TTI = loadFixture → 视口节点渲染 + 一次交互（Ctrl+F）在预算内响应；
 * 最长 long task 取 dev-hook PerformanceObserver 采样（__perfStages.longTasks）。
 */

const INTERACTION_BUDGET_MS = 1500;

// RUN_BENCH=1 完整 10k 硬阈值。
const TTI_10K_BUDGET_MS = 12_000;
const LONGTASK_10K_BUDGET_MS = 6_000;

// CI 默认降级规模（2000 块）硬阈值。
const TTI_2K_CI_BUDGET_MS = 8_000;
const LONGTASK_2K_CI_BUDGET_MS = 3_000;

const runBench = !!process.env.RUN_BENCH;

/** 灌 n 块大树夹具，测 TTI 与分阶段 long task。 */
async function measureLoad(page: Page, n: number) {
  await waitForApp(page);
  const doc = buildPerfFixtureWide(n);
  const t0 = Date.now();
  await page.evaluate((d: unknown) => {
    (window as unknown as { __drawpaper__: { loadFixture: (x: unknown) => void } }).__drawpaper__.loadFixture(d);
  }, doc);

  await page.locator('.react-flow__node').first().waitFor({ timeout: 60_000 });
  const nodesRenderedMs = Date.now() - t0;

  const tInteractionStart = Date.now();
  await page.keyboard.press('Control+f');
  await page.locator('.absolute.right-4.top-14').first().waitFor({ timeout: INTERACTION_BUDGET_MS });
  const interactionMs = Date.now() - tInteractionStart;
  const ttiMs = Date.now() - t0;

  await page.waitForTimeout(3000);
  const stages = (await page.evaluate(
    () => (window as unknown as { __perfStages?: Record<string, number | number[]> }).__perfStages ?? {},
  )) as Record<string, number | number[]>;

  const renderedDomNodes = await page.locator('.react-flow__node').count();
  const st = (await getState(page)) as { nodeCount: number };
  const longTasks = Array.isArray(stages.longTasks) ? (stages.longTasks as number[]) : [];
  const longestLongTask = longTasks.length ? Math.max(...longTasks) : 0;

  return { ttiMs, nodesRenderedMs, interactionMs, nodeCount: st.nodeCount, renderedDomNodes, stages, longTasks, longestLongTask };
}

test.describe('§9b 10000 块性能基准（RUN_BENCH=1 才跑）', () => {
  test.skip(!runBench, '需 RUN_BENCH=1 才跑（完整 10k benchmark 不随门禁运行）');

  test('10000 块 TTI / long task 硬阈值', async ({ page }) => {
    test.setTimeout(120_000);
    const r = await measureLoad(page, 10000);
    console.log('BENCH_10K_RESULT', JSON.stringify(r));

    expect(r.nodeCount).toBeGreaterThanOrEqual(9900);
    expect(r.renderedDomNodes).toBeLessThan(r.nodeCount * 0.5);
    // 硬阈值（本机中位留 ~40% 余量）。
    expect(r.ttiMs).toBeLessThan(TTI_10K_BUDGET_MS);
    expect(r.longestLongTask).toBeLessThan(LONGTASK_10K_BUDGET_MS);
  });
});

test.describe('§9c 渐进水化回归（2000 块，CI 默认跑）', () => {
  test('2000 块 TTI 与最长 long task 硬阈值', async ({ page }) => {
    test.setTimeout(60_000);
    const r = await measureLoad(page, 2000);
    console.log('BENCH_2K_RESULT', JSON.stringify(r));

    expect(r.nodeCount).toBeGreaterThanOrEqual(1900);
    expect(r.renderedDomNodes).toBeLessThan(r.nodeCount * 0.5);
    // 硬阈值：本机 TTI 中位 ~2.4s、最长 long task ~0.9s，CI 慢机留余量。
    expect(r.ttiMs).toBeLessThan(TTI_2K_CI_BUDGET_MS);
    expect(r.longestLongTask).toBeLessThan(LONGTASK_2K_CI_BUDGET_MS);
  });
});

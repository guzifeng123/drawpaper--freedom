import { test, expect, type Page } from '@playwright/test';
import { waitForApp } from './fixtures/load-doc';
import { buildPerfFixture } from './fixtures/sample-doc';

type ColdReport = {
  marks: Record<string, number>;
  measures: Record<string, number>;
  navigation: { domContentLoaded: number | null };
  fcp: number | null;
  all: Record<string, number>;
};

/**
 * Wave24 路 3：冷启动分段埋点门禁。
 *
 * 不追求压测绝对值（本机/CI 抖动大），断言两件事：
 *  1. 分段埋点齐全——关键段一个都不能少（防后续重构把埋点删掉/改名）；
 *  2. 关键段有界——阈值按本机 dev 实测分布（taskset -c 0,1）取 P90 × ~2.5 CI 余量，
 *     不是拍脑袋的宽松值：本机空文档 tti 中位 ~880ms、render→commit ~150ms、
 *     domContentLoaded ~600ms；CI 共享 2 核按既有 §9 标定慢 ~2x，再留 2.5x 余量。
 *
 * 时间字典：单点段 = performance.mark；成对段（idb-open / sync-restore / asset-reconcile）
 * = performance.measure。断言取 marks ∪ measures。
 * 采集口径与完整 before/after 表见 docs/wave24/web-coldstart.md。
 */

// ── 阈值（本机 taskset 标定后 × CI 余量）──────────────────────
/** 空文档冷启动 TTI 上限（本机 dev 中位 880ms；CI 慢机余量后 5s 仍远低于 §9 的 8s 2k 阈值）。 */
const TTI_EMPTY_MAX_MS = 5_000;
/** render→首次 commit 上限（本机中位 150ms）。 */
const RENDER_TO_COMMIT_MAX_MS = 2_000;
/** canvas-frame→tti 上限（空文档本机中位 ~90ms）。 */
const FRAME_TO_TTI_MAX_MS = 2_000;

/** 冷启动必须齐备的时间点（mark 单点 + measure 成对段）。 */
const REQUIRED_MARKS = [
  'boot', // main.tsx 模块求值
  'store', // editor-store 单例
  'bootstrap', // bootstrap() 开始
  'idb-open', // 首次 IDB 列表读出（measure）
  'doc-open', // 最近文档载入
  'render-start', // ReactDOM.render
  'react-commit', // App 首 effect
  'canvas-frame', // 首画布首帧
  'tti', // 连续可交互窗口
];

async function coldReport(page: Page): Promise<ColdReport> {
  await page.waitForFunction(
    () => {
      const g = window as unknown as {
        __coldStart?: { report?: () => { marks?: Record<string, number> } };
      };
      const r = g.__coldStart?.report?.();
      return !!r && typeof r.marks?.tti === 'number';
    },
    null,
    { timeout: 20_000 },
  );
  return page.evaluate(() => {
    const g = window as unknown as { __coldStart: { report: () => ColdReport } };
    const r = g.__coldStart.report();
    return { ...r, all: { ...r.measures, ...r.marks } };
  });
}

test.describe('Wave24 冷启动分段埋点', () => {
  test('空文档冷启动：关键段齐全且有界', async ({ page }) => {
    // 清掉历史 e2e 灌进去的文档，保证每次都是「空 IDB 冷启动」。
    await page.goto('/');
    await page.evaluate(() => {
      indexedDB.deleteDatabase('drawpaper-db');
    });
    await page.goto('/');
    await waitForApp(page);

    const report = await coldReport(page);

    // 1) 埋点齐全（mark ∪ measure）。
    for (const k of REQUIRED_MARKS) {
      expect(report.all, `缺少时间点: ${k}`).toHaveProperty(k);
    }
    console.log('COLD_MARKS', JSON.stringify(report.marks));
    console.log('COLD_MEASURES', JSON.stringify(report.measures));
    console.log('COLD_NAV', JSON.stringify(report.navigation), 'fcp', report.fcp);

    // 2) 有界断言。
    const tti = report.marks.tti!;
    expect(tti).toBeLessThan(TTI_EMPTY_MAX_MS);

    const renderToCommit = report.marks['react-commit']! - report.marks['render-start']!;
    expect(renderToCommit).toBeLessThan(RENDER_TO_COMMIT_MAX_MS);

    const frameToTti = tti - report.marks['canvas-frame']!;
    expect(frameToTti).toBeLessThan(FRAME_TO_TTI_MAX_MS);

    // 导航侧：domContentLoaded 必须有值。
    expect(report.navigation.domContentLoaded).toBeGreaterThanOrEqual(0);
    // FCP 必须有值。
    expect(report.fcp).not.toBeNull();

    console.log(
      'COLD_BOUNDS',
      JSON.stringify({ tti, renderToCommit, frameToTti, fcp: report.fcp }),
    );
  });

  test('2000 块冷启动：分段存在且 TTI 不劣于 §9 预算', async ({ page }) => {
    // 复用 §9 的灌数路径：先 boot，再经 DEV 钩子灌 2000 块，随后 reload 走真实
    // bootstrap（listDocs → openDoc）测冷启动分段。
    await waitForApp(page);

    const doc = buildPerfFixture(2000);
    await page.evaluate((d) => {
      (window as unknown as { __drawpaper__: { loadFixture: (x: unknown) => void } }).__drawpaper__.loadFixture(d);
    }, doc);
    // 等自动保存落 IDB（500ms 防抖 + 写盘）。
    await page.waitForTimeout(1500);

    // reload：真实冷启动打开 2k 文档。
    await page.goto('/');
    const report = await coldReport(page);

    for (const k of REQUIRED_MARKS) {
      expect(report.all, `缺少时间点: ${k}`).toHaveProperty(k);
    }
    console.log('COLD_HEAVY_MARKS', JSON.stringify(report.marks));
    console.log('COLD_HEAVY_MEASURES', JSON.stringify(report.measures));

    // 2k 块 TTI 沿用 §9 硬预算（8s），不放宽。
    expect(report.marks.tti!).toBeLessThan(8_000);
    // doc-open 必须发生（bootstrap 真的打开了重文档）：doc-open 时间戳晚于 idb-open-start。
    expect(report.marks['doc-open']!).toBeGreaterThan(report.marks['idb-open-start']!);
  });
});

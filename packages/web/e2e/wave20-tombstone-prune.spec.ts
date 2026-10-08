import { test, expect, type Page } from '@playwright/test';

/**
 * Wave20 R 路：同步墓碑水位裁剪（pruneTombstones）web 传输层接线 e2e。
 *
 * 真实造 1000+ 删除太重，故经 dev-hook `syncSeedTombstoneDoc` 注入合成墓碑
 * （lamport 全部 ≤ 合并后 vv，即全部安全），走真实 FSA fake 通道跑一轮同步，
 * 断言：
 *  - SyncRunResult 统计字段可观测（prunedTombstones / retainedTombstones / watermark）；
 *  - 推送出去的 .kbnote 墓碑数被压到阈值（1000）以内。
 *
 * 硬门（5 场景的正确性）由 vitest 集成测 orchestrator.prune.test.ts 覆盖；
 * 本 spec 只在真实 FSA 通道上做「阈值生效 + 统计可观测」的冒烟。
 */

const waitBoot = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
};

test.describe('Wave20 R 路 墓碑水位裁剪（FSA fake 通道）', () => {
  test('一轮同步后阈值生效：1050 安全墓碑 → 推送文档压到 1000，统计可观测', async ({ page }) => {
    await waitBoot(page);

    // 注入内存 fake 目录并启动 FSA 通道。
    await page.evaluate(() => window.__drawpaper__!.syncUseFakeFolder());

    // 注入 1050 条合成节点墓碑（全部安全），本地库多一份「远超阈值」的文档。
    const seeded = await page.evaluate(() => window.__drawpaper__!.syncSeedTombstoneDoc(1050));
    expect(seeded.tombstones).toBe(1050);

    // 跑一轮同步：该文档本地独有 → push 路径，stampForPersist 前裁剪。
    const inspect = (await page.evaluate(async () =>
      window.__drawpaper__!.syncRunNow(),
    )) as {
      channel: string;
      lastRun: {
        prunedTombstones: number;
        prunedEdgeTombstones: number;
        retainedTombstones: number;
        tombstoneWatermark: number;
      } | null;
    };

    // SyncRunResult 统计字段可观测且阈值生效。
    expect(inspect.channel).toBe('folder');
    expect(inspect.lastRun, 'lastRun 应存在').toBeTruthy();
    expect(inspect.lastRun!.prunedTombstones).toBe(50); // 1050 - 1000
    expect(inspect.lastRun!.prunedEdgeTombstones).toBe(0);
    expect(inspect.lastRun!.retainedTombstones).toBe(1000);
    expect(inspect.lastRun!.tombstoneWatermark).toBe(1050);

    // 推送到 fake 目录的文档墓碑数应被压到 1000。
    const count = await page.evaluate(() => {
      const dump = window.__drawpaper__!.syncFakeDump();
      const text = dump['seed-tomb-doc.kbnote'];
      if (!text) return null;
      const doc = JSON.parse(text);
      const nodes = doc.sync?.nodes ?? {};
      return Object.keys(nodes).filter((k) => nodes[k]?.t).length;
    });
    expect(count, '远端推送文档墓碑数应 ≤1000').toBe(1000);
  });
});

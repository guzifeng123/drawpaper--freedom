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

/**
 * 轮询 syncInspect() 直到同步空闲且 lastRun 反映「含裁剪的那一轮」。
 * 背景：syncUseFakeFolder() 启动控制器即跑首轮同步；safeRun 在 this.running=true
 * 时对 manual syncRunNow() 直接 return（不排队、不 await 在飞 run）。高负载下
 * 在飞 run（1050 墓碑序列化+裁剪 CPU 不轻）尚未落 lastRun，立即取 inspect 会拿到
 * busy=true / lastRun=null。故必须有界轮询，而不是同步后立刻读。
 *
 * @param wantPruned 期望的 prunedTombstones；null = 只等「空闲 + lastRun 非空」。
 */
const waitIdle = async (page: Page, wantPruned: number | null) => {
  await page.waitForFunction(
    (want) => {
      const h = window.__drawpaper__;
      if (!h) return false;
      const ins = h.syncInspect() as {
        busy: boolean;
        lastRun: { prunedTombstones: number } | null;
      };
      if (ins.busy) return false;
      if (!ins.lastRun) return false;
      if (want !== null && ins.lastRun.prunedTombstones !== want) return false;
      return true;
    },
    wantPruned,
    { timeout: 20000, polling: 200 },
  );
};

test.describe('Wave20 R 路 墓碑水位裁剪（FSA fake 通道）', () => {
  test('一轮同步后阈值生效：1050 安全墓碑 → 推送文档压到 1000，统计可观测', async ({ page }) => {
    await waitBoot(page);

    // 注入内存 fake 目录并启动 FSA 通道（会触发首轮同步）。
    await page.evaluate(() => window.__drawpaper__!.syncUseFakeFolder());

    // 先等「启动首轮」收敛到空闲，避免在飞 run 与后续 seed/手动跑竞争锁。
    await waitIdle(page, null);

    // 注入 1050 条合成节点墓碑（全部安全），本地库多一份「远超阈值」的文档。
    const seeded = await page.evaluate(() => window.__drawpaper__!.syncSeedTombstoneDoc(1050));
    expect(seeded.tombstones).toBe(1050);

    // 该文档本地独有 → push 路径，stampForPersist 前裁剪。
    // safeRun 在忙时对 syncRunNow() 直接 return：故有界重试——每轮发起一次手动同步，
    // 再等空闲且 lastRun.prunedTombstones===50；若被在飞 run 抢锁则下一轮重试。
    type Inspect = {
      channel: string;
      lastRun: {
        prunedTombstones: number;
        prunedEdgeTombstones: number;
        retainedTombstones: number;
        tombstoneWatermark: number;
      } | null;
    };
    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt += 1) {
      await page.evaluate(() => window.__drawpaper__!.syncRunNow());
      try {
        await waitIdle(page, 50);
        done = true;
      } catch {
        /* 超时未拿到含裁剪的 lastRun → 重试发起 */
      }
    }
    expect(done, '20s 内未观察到含裁剪的同步结果').toBe(true);

    const inspect = (await page.evaluate(() => window.__drawpaper__!.syncInspect())) as Inspect;

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

import { test, expect, type Page } from '@playwright/test';

/**
 * Wave10 阶段 B ② FSA 同步文件夹通道 e2e（内存 fake directory handle）。
 *
 * Playwright 无法真实操作 showDirectoryPicker，故经 dev-hook 注入 FakeDirectoryHandle，
 * 走真实导出 / 轮询检测 / 合并 / conflicted 副本代码路径。
 *
 * 覆盖：
 *  - 文档变更自动导出 .kbnote 到 fake 目录；
 *  - 外部写入（模拟 Syncthing/对端落盘）被轮询检测并拉取；
 *  - 并发冲突时生成《文档名》.conflicted-<时间>.kbnote 副本。
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

const dump = (page: Page) => page.evaluate(() => window.__drawpaper__!.syncFakeDump());

test.describe('Wave10 FSA 同步文件夹通道（fake directory handle）', () => {
  test('② 自动导出、外部写入检测、conflicted 副本生成', async ({ page }) => {
    await waitBoot(page);

    // 注入内存 fake 目录并启动 FSA 通道。
    await page.evaluate(() => window.__drawpaper__!.syncUseFakeFolder());

    // 本地建块 + 落盘 → 自动导出（初始 run + 2s 防抖）。
    const nodeId = await page.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 100, 100) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '本地初稿' }] });
      h.invoke('requestSave');
      return id;
    });
    await page.waitForTimeout(2500);

    const docId = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);
    // (a) fake 目录里应出现 <docId>.kbnote，且内容含本块。
    let d = await dump(page);
    expect(d[`${docId}.kbnote`], '应自动导出 .kbnote').toBeTruthy();
    expect(d[`${docId}.kbnote`]).toContain('本地初稿');

    // (b) 外部写入一个全新文档（模拟对端落盘）→ 轮询拉取进资料库。
    const remoteDoc = {
      format: 'knowledge-block-notes',
      version: 3,
      id: 'remote-doc-1',
      title: '对端文档',
      board: { createdAt: 1000, updatedAt: 2000 },
      nodes: [
        { id: 'rn1', type: 'text', x: 0, y: 0, width: 200, height: 80, content: { format: 'tiptap-json', data: { type: 'doc', content: [{ type: 'paragraph', text: '对端带来的块' }] } }, parentId: null, tags: [] },
      ],
      edges: [],
      tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color', header: false, footer: false, showPageNumbers: false, edgeLabels: true, pageBreaks: [] },
      assetRefs: [],
      links: [],
      sync: { vv: { d_remote: 5 }, nodes: { rn1: { f: { content: [5, 'd_remote'] } } } },
    };
    await page.evaluate((text) => window.__drawpaper__!.syncFakeWrite('remote-doc-1.kbnote', text), JSON.stringify(remoteDoc));
    // 轮询间隔 5s + 余量。
    await page.waitForTimeout(6500);
    // 拉取后打开对端文档，应看到其块。
    await page.evaluate(() => window.__drawpaper__!.invoke('openDoc', 'remote-doc-1'));
    await expect.poll(
      () => page.evaluate(() => window.__drawpaper__!.getState().nodeCount),
      { timeout: 5000 },
    ).toBe(1);

    // (c) 制造并发冲突：回到本地文档，把外部 docX.kbnote 改写成「另一客户端」在同一字段
    //     上的并发写（不同 clientId + 更高 lamport），同时本地再改一次 → 双方都改 → conflicted 副本。
    await page.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId);
    await page.waitForTimeout(500);

    // 解析已导出的 docX.kbnote，把 content 戳改成对端 d_other 在更高 lamport 的并发写。
    await page.evaluate(
      ({ docId, nodeId }) => {
        const dump = (window.__drawpaper__!.syncFakeDump() as Record<string, string>);
        const local = JSON.parse(dump[`${docId}.kbnote`]!) as {
          nodes: Array<{ id: string; content: unknown }>;
          sync: { vv: Record<string, number>; nodes: Record<string, { f?: Record<string, [number, string]> }> };
        };
        // 对端版本：内容改为「对端改稿」，content 戳换成 d_other @ 999（与本端并发）。
        const node = local.nodes.find((n) => n.id === nodeId)!;
        (node.content as { data: unknown }).data = { type: 'doc', content: [{ type: 'paragraph', text: '对端改稿' }] };
        local.sync.nodes[nodeId] = { f: { content: [999, 'd_other'] } };
        local.sync.vv['d_other'] = 999;
        window.__drawpaper__!.syncFakeWrite(`${docId}.kbnote`, JSON.stringify(local));
      },
      { docId, nodeId },
    );

    // 本地再改一次（在 base 之上并发改同一字段）。
    await page.evaluate((nid) => {
      window.__drawpaper__!.invoke('updateContent', nid, { type: 'doc', content: [{ type: 'paragraph', text: '本地二次改' }] });
      window.__drawpaper__!.invoke('requestSave');
    }, nodeId);
    await page.evaluate(() => window.__drawpaper__!.syncRunNow());

    d = await dump(page);
    const conflicted = Object.keys(d).filter((k) => k.includes('conflicted-'));
    expect(conflicted.length, '应生成 conflicted 副本').toBeGreaterThan(0);
  });
});

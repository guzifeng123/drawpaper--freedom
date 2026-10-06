import { test, expect, type Page } from '@playwright/test';

/**
 * Wave14 D · 任务二：同浏览器协作元数据随文档持久化。
 *
 * 场景：A、B 两标签协作 → A reload 文档（协作元数据从独立 IndexedDB 恢复，不把既有实体
 * 重新按 lamport=0 播种）→ A/B 继续各自编辑 → 收敛无伪冲突、无 lamport 回退导致的覆盖；
 * 并验 tags 并发并集。
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

const docIdOf = (page: Page) =>
  page.evaluate(() => window.__drawpaper__!.getState().doc.id);

const nodeCount = (page: Page) =>
  page.evaluate(() => window.__drawpaper__!.getState().nodeCount);

const openSameDoc = async (pageA: Page, pageB: Page) => {
  const id = await docIdOf(pageA);
  await pageB.evaluate((docId) => {
    void window.__drawpaper__!.invoke('openDoc', docId);
  }, id);
  await pageB.waitForFunction((docId) => window.__drawpaper__!.getState().doc.id === docId, id);
  await pageB.waitForTimeout(600);
};

const waitPeerSeen = async (page: Page, minCount: number) => {
  await page.waitForFunction(
    (n) => (window.__drawpaper__!.collab().peerCount ?? 0) >= n,
    minCount,
    { timeout: 8000 },
  );
};

const nodeX = (page: Page, id: string) =>
  page.evaluate((nid) => {
    const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === nid);
    return n ? Math.round(n.x) : null;
  }, id);

const nodeTags = (page: Page, id: string) =>
  page.evaluate((nid) => {
    const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === nid);
    return n ? [...n.tags] : null;
  }, id);

test.describe('Wave14 协作元数据持久化（reload 恢复）', () => {
  test('A reload 后继续编辑不被 lamport 回退覆盖；tags 并发并集', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await waitBoot(pageA);
    await waitBoot(pageB);
    await openSameDoc(pageA, pageB);
    await waitPeerSeen(pageB, 1);

    // A 建一个块。
    const nodeId = await pageA.evaluate(() => window.__drawpaper__!.invoke('addNode', 'text', 100, 100) as string);
    await expect.poll(() => nodeCount(pageB), { timeout: 5000 }).toBe(1);

    // B 把块移到 x=300（抬高该字段时钟水位）。A 应看到。
    await pageB.evaluate((nid) => window.__drawpaper__!.invoke('moveNode', nid, 300, 100), nodeId);
    await expect.poll(() => nodeX(pageA, nodeId), { timeout: 5000 }).toBe(300);

    // ---- tags 并发并集：A 打 tagA，B 打 tagB（基于同一基线）----
    await pageA.evaluate((nid) => window.__drawpaper__!.invoke('addTagToNode', nid, 'tagA'), nodeId);
    await pageB.evaluate((nid) => window.__drawpaper__!.invoke('addTagToNode', nid, 'tagB'), nodeId);
    await pageA.waitForTimeout(800);
    await pageB.waitForTimeout(800);
    const tagsA = await nodeTags(pageA, nodeId);
    const tagsB = await nodeTags(pageB, nodeId);
    expect([...(tagsA ?? [])].sort()).toEqual(['tagA', 'tagB']);
    expect([...(tagsB ?? [])].sort()).toEqual(['tagA', 'tagB']);

    // ---- A reload：协作元数据恢复 ----
    await pageA.reload();
    await waitBoot(pageA);
    // reload 后 bootstrap 自动打开最近文档 = 同一篇。
    await expect.poll(() => docIdOf(pageA), { timeout: 8000 }).toBe(await docIdOf(pageB));
    // A 与 B 重新对齐。
    await waitPeerSeen(pageA, 1);
    await waitPeerSeen(pageB, 1);
    // 块还在，tags 并集仍在（元数据恢复后不回退）。
    await expect.poll(() => nodeX(pageA, nodeId), { timeout: 5000 }).toBe(300);
    await expect.poll(() => nodeTags(pageA, nodeId), { timeout: 5000 }).toEqual(['tagA', 'tagB']);

    // ---- A reload 后继续移动块到 x=800：不能因 lamport 回退被 B 旧水位盖掉 ----
    await pageA.evaluate((nid) => window.__drawpaper__!.invoke('moveNode', nid, 800, 100), nodeId);
    await expect.poll(() => nodeX(pageB, nodeId), { timeout: 5000 }).toBe(800);

    // 无伪冲突横幅。
    const conflictsAfter = await pageA.evaluate(() => window.__drawpaper__!.collabConflicts().length);
    expect(conflictsAfter).toBe(0);
    await context.close();
  });
});

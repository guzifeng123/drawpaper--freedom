import { test, expect } from '@playwright/test';

/**
 * Wave16 F：资产内容 hash 化去重 + 孤儿资产 GC。
 *
 * 覆盖：
 *  ①内容寻址：写入后 assetRef = 64-hex SHA-256；相同内容再写一次 → 同 ref、只存一份
 *     （listAssets 不增长）；跨文档相同内容共享 ref。
 *  ②v3→v4 往返：legacy nanoid blob + v3 档 → reconcile 后 ref 变 hash、字节可读、
 *     导出再导入不丢资产。
 *  ③GC：无人引用的孤儿 blob 经「扫描未使用资产」移入保留区；确认后物理清空。
 */

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const waitBoot = async (page: import('@playwright/test').Page) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
};

async function dropFile(
  page: import('@playwright/test').Page,
  name: string,
  mime: string,
  b64: string,
): Promise<void> {
  await page.evaluate(
    ({ name, mime, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      const pane = document.querySelector('.react-flow__pane') as HTMLElement;
      pane.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 600, clientY: 400 }),
      );
    },
    { name, mime, b64 },
  );
}

/** 拖入图片并等图片块落库，返回 image.src（即 assetRef）。 */
async function dropImageGetRef(page: import('@playwright/test').Page): Promise<string> {
  await dropFile(page, 'drop.png', 'image/png', PNG_B64);
  await page.waitForFunction(() => {
    const nodes = window.__drawpaper__!.getState().doc.nodes;
    return nodes.some((n) => n.type === 'image' && !!n.image?.src);
  });
  return page.evaluate(() => {
    const img = window.__drawpaper__!.getState().doc.nodes.find((n) => n.type === 'image')!;
    return img.image!.src;
  });
}

const HEX64 = /^[0-9a-f]{64}$/;

test.describe('Wave16 资产内容寻址去重', () => {
  test('① 写入 ref=64-hex；相同内容再写一次共享 ref、只存一份', async ({ page }) => {
    await waitBoot(page);

    const r1 = await dropImageGetRef(page);
    expect(r1).toMatch(HEX64);

    // 第二次拖入完全相同的字节 → 必须得到同一个 ref。
    const r2 = await dropImageGetRef(page);
    expect(r2).toBe(r1);

    // 主资产区只存一份 blob。
    const assets = await page.evaluate(() => window.__drawpaper__!.opfsListAssets());
    expect(assets).toEqual([r1]);
  });

  test('② v3→v4 往返：legacy nanoid blob 经 reconcile 变 hash，字节可读、不丢', async ({ page }) => {
    await waitBoot(page);

    // 播种一个「旧 nanoid 名」的 blob。
    const legacyRef = 'V1StGXR8_Z5jdHi6B-myT';
    await page.evaluate(
      async ({ ref, b64 }) => window.__drawpaper__!.opfsSeedAsset(ref, b64),
      { ref: legacyRef, b64: PNG_B64 },
    );

    // 构造一份 v3 文档：image.src 指向该 nanoid，assetRefs 登记它。
    const v3Doc = {
      format: 'knowledge-block-notes',
      version: 3,
      id: 'doc_legacy_v3',
      title: 'legacy',
      board: { createdAt: 1000, updatedAt: 2000 },
      nodes: [
        {
          id: 'n_1', type: 'image', x: 0, y: 0, width: 200, height: 120,
          content: { format: 'tiptap-json', data: { type: 'doc' } },
          image: { src: legacyRef },
        },
      ],
      edges: [], tags: [],
      layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
      viewport: { x: 0, y: 0, zoom: 1 },
      page: { size: 'A4', orientation: 'portrait', marginMm: 15, mode: 'fit', showPageBreak: true, colorMode: 'color' },
      assetRefs: [legacyRef],
      links: [],
      sync: { vv: { cA: 1 } },
    };
    await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), JSON.stringify(v3Doc));
    // 先落 IndexedDB（reconcile 扫的是 db.docs），再跑 reconcile。
    await page.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
    await page.waitForTimeout(1200);

    // 跑 reconcile（启动时已自动跑一次；这里显式再跑一次以观测摘要）。
    const summary = await page.evaluate(() => window.__drawpaper__!.opfsReconcile());
    console.log('RECONCILE_SUMMARY', JSON.stringify(summary));

    // reconcile 改写的是 db.docs；重新打开文档以载入改写后的 assetRefs。
    await page.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), 'doc_legacy_v3');

    // 文档 assetRefs 已从 nanoid 映射成内容 hash。
    const state = await page.evaluate(() => window.__drawpaper__!.getState());
    const refs = state.doc.assetRefs as string[];
    expect(refs).toHaveLength(1);
    const newRef = refs[0]!;
    expect(newRef).toMatch(HEX64);

    // blob 仍可读（hash 名下有字节）。
    const has = await page.evaluate((ref) => window.__drawpaper__!.opfsHasAsset(ref), newRef);
    expect(has).toBe(true);

    // 导出 v4 → 再导入不丢资产。
    const exported = await page.evaluate(() => window.__drawpaper__!.exportCurrent());
    const reimported = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), exported);
    expect(reimported.ok).toBe(true);
    if (reimported.ok) expect(reimported.version).toBe(4);
    const afterState = await page.evaluate(() => window.__drawpaper__!.getState());
    expect(afterState.doc.assetRefs).toEqual(refs);
  });

  test('③ GC：孤儿 blob 移入保留区；确认后物理清空', async ({ page }) => {
    await waitBoot(page);

    // 写一个被文档引用的资产。
    const r1 = await dropImageGetRef(page);
    await page.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
    await page.waitForTimeout(800);

    // 播种一个「孤儿」blob（没有任何文档引用它）。
    const orphanRef = 'orphan_' + 'a'.repeat(50);
    await page.evaluate(
      async ({ ref, b64 }) => window.__drawpaper__!.opfsSeedAsset(ref, b64),
      { ref: orphanRef, b64: PNG_B64 },
    );

    // 扫描未使用资产 → 孤儿应进保留区；被引用的 r1 不动。
    const result = await page.evaluate(() => window.__drawpaper__!.assetGcManual());
    console.log('GC_MANUAL', JSON.stringify(result));
    const trashList = await page.evaluate(() => window.__drawpaper__!.trashListAssets());
    expect(trashList).toContain(orphanRef);

    // 主资产区：r1 仍在，孤儿已移走。
    const mainAssets = await page.evaluate(() => window.__drawpaper__!.opfsListAssets());
    expect(mainAssets).toContain(r1);
    expect(mainAssets).not.toContain(orphanRef);

    // 确认物理清空保留区。
    const purged = await page.evaluate(() => window.__drawpaper__!.assetGcPurge());
    expect(purged).toBeGreaterThan(0);
    const trashAfter = await page.evaluate(() => window.__drawpaper__!.trashListAssets());
    expect(trashAfter).toEqual([]);
  });
});

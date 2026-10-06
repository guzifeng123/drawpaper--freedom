import { test, expect } from '@playwright/test';
import { waitForApp, invoke } from './fixtures/load-doc';

/**
 * Wave11 阶段 C 补缺 e2e ①：附件/图片块 OPFS 上传与恢复（chromium）。
 *
 * 证明「图片字节落在 OPFS、文档 JSON 只存 assetRef 引用」二者存储隔离：
 *  1) 注入真实大图（800x600 canvas→PNG）走真实 drop 管线（压缩→OPFS）；
 *  2) 断言图片块 image.src 是 assetRef（非 data: URL），且 OPFS 真有该 blob；
 *  3) 清掉 IndexedDB 的 docs/snapshots/trash 三张表（**不动 OPFS**）；
 *  4) 刷新后 OPFS blob 仍在；重新导入之前导出的文档 JSON（仍引用同一 assetRef），
 *     图片从幸存的 OPFS blob 恢复渲染（naturalWidth>0）。
 *
 * 与 p21-image-opfs.spec.ts 的区别：后者只验证「普通 reload 持久化」；
 * 本用例额外注入「IndexedDB 被清空」这一故障，证明 OPFS 附件独立于 IndexedDB 存活。
 */

test.describe('Wave11 补缺 ①：图片块 OPFS 上传与 IndexedDB 隔离恢复', () => {
  test('大图落 OPFS（非 dataURL）→ 清 IDB 保留 OPFS → 刷新后图片恢复渲染', async ({ page }) => {
    await waitForApp(page);
    expect(await page.evaluate(() => window.__drawpaper__!.opfsAvailable())).toBe(true);

    // 显式建一个干净的新文档并等 boot 稳定（避免全套件下 boot 异步 loadDoc 覆盖刚建的块）。
    await invoke(page, 'newDoc');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const h = window.__drawpaper__!;
      const id = h.invoke('addNode', 'text', 120, 200) as string;
      h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: 'OPFS-恢复标记' }] });
    });
    // 确定性断言：文本标记块已入 store（再 drop 图片）。
    await expect
      .poll(
        () => page.evaluate(() => JSON.stringify(window.__drawpaper__!.getState().doc.nodes).includes('OPFS-恢复标记')),
        { timeout: 5000 },
      )
      .toBe(true);

    // ---- 注入真实大图（800x600 渐变 PNG），走真实 drop→压缩→OPFS 管线 ----
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 600;
      const ctx = canvas.getContext('2d')!;
      const grad = ctx.createLinearGradient(0, 0, 800, 600);
      grad.addColorStop(0, '#ff3300');
      grad.addColorStop(1, '#0033ff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 800, 600);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('canvas.toBlob 失败');
      const file = new File([blob], 'large-gradient.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const pane = document.querySelector('.react-flow__pane') as HTMLElement;
      pane.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
          clientX: 520,
          clientY: 360,
        }),
      );
    });

    // 等图片块出现并解码成功。
    await page.waitForFunction(
      () => {
        const nodes = window.__drawpaper__!.getState().doc.nodes;
        return nodes.some((n) => n.type === 'image' && !!n.image?.src);
      },
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
        return !!img && img.naturalWidth > 0;
      },
      null,
      { timeout: 10_000 },
    );

    // ---- 断言：src 是 assetRef（非 dataURL），OPFS 真有 blob ----
    const before = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      const img = nodes.find((n) => n.type === 'image')!;
      return { src: img.image!.src, assetRefs: window.__drawpaper__!.listAssetRefs() };
    });
    console.log('BEFORE_CLEAR src=', before.src, 'assetRefs=', before.assetRefs);
    expect(before.src.startsWith('data:')).toBe(false);
    expect(before.src.startsWith('blob:')).toBe(false);
    expect(before.assetRefs).toContain(before.src);
    expect(await page.evaluate((ref) => window.__drawpaper__!.opfsHasAsset(ref), before.src)).toBe(true);

    // ---- 捕获整份文档 JSON 前，先确定性断言：文本标记块 + 图片块都在 store 里 ----
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const json = JSON.stringify(window.__drawpaper__!.getState().doc.nodes);
            return json.includes('OPFS-恢复标记') && window.__drawpaper__!.getState().doc.nodes.some((n) => n.type === 'image');
          }),
        { timeout: 8000 },
      )
      .toBe(true);
    const docJson = await page.evaluate(() => window.__drawpaper__!.exportCurrent());

    // 强制落盘到 IndexedDB。
    await invoke(page, 'requestSave');
    await page.waitForTimeout(800);

    // ---- 清 IndexedDB（docs/snapshots/trash），**不动 OPFS** ----
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('drawpaper-db');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['docs', 'snapshots', 'trash'], 'readwrite');
          tx.objectStore('docs').clear();
          tx.objectStore('snapshots').clear();
          tx.objectStore('trash').clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    });

    // ---- 刷新：App 从空 IndexedDB 冷启动 ----
    await page.reload();
    await waitForApp(page);
    await page.waitForTimeout(300);

    // OPFS blob  survives IDB 清空 + 刷新。
    expect(
      await page.evaluate((ref) => window.__drawpaper__!.opfsHasAsset(ref), before.src),
    ).toBe(true);
    console.log('OPFS_BLOB_SURVIVED_IDB_CLEAR ref=', before.src);

    // 重新导入之前捕获的文档 JSON（仍引用同一 assetRef）。
    const res = await page.evaluate((text) => window.__drawpaper__!.importKbnoteText(text), docJson);
    expect(res.ok).toBe(true);
    // fit 相机让节点进入视口（onlyRenderVisibleElements 卸载屏外节点）。
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(400);

    // 图片从幸存的 OPFS blob 恢复渲染。
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
        return !!img && img.naturalWidth > 0;
      },
      null,
      { timeout: 10_000 },
    );
    // 文本标记也回来了（store 层断言，不依赖视口裁剪）。
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            JSON.stringify(window.__drawpaper__!.getState().doc.nodes).includes('OPFS-恢复标记'),
          ),
        { timeout: 5000 },
      )
      .toBe(true);

    const after = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      const img = nodes.find((n) => n.type === 'image')!;
      return img.image!.src;
    });
    expect(after).toBe(before.src);
    console.log('RESTORED_IMG src=', after);
  });
});

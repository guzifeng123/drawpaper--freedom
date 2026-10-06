import { test, expect, type Page } from '@playwright/test';
import { waitForApp, invoke } from './fixtures/load-doc';
import fs from 'node:fs';

/**
 * P2.1 图片统一压缩 → OPFS 落盘 → JSON 仅存 assetRef 引用（e2e）。
 *
 *  端口由 playwright.config 读 E2E_PORT（本任务固定 4182）。
 *  a) 拖入 DataTransfer(File) → 图片块出现；dev-hook 断言 OPFS 有该 asset、
 *     文档 JSON 里 image.src 是 assetRef 而非 dataURL；
 *  b) reload 后图片仍渲染（OPFS 跨会话持久化，objectURL 重新解析）；
 *  c) 斜杠菜单「图片」→ 文件选择器 → 走同一管线摄入第二张；
 *  d) exportCurrent 序列化含 assetRefs、buildSvgPagesDev 输出 SVG 内嵌 data:image。
 */

// 1x1 红点 PNG（合法最小 PNG，canvas 可解码）。
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function dropPng(page: Page): Promise<void> {
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const pane = document.querySelector('.react-flow__pane') as HTMLElement;
    pane.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: 500,
        clientY: 400,
      }),
    );
  }, PNG_B64);
}

test.describe('P2.1 图片 → OPFS assetRef 统一管线', () => {
  test('a 拖入落 OPFS；b reload 持久化；c 斜杠第二入口；d 导出内嵌', async ({ page }) => {
    await waitForApp(page);
    expect(await page.evaluate(() => window.__drawpaper__!.opfsAvailable())).toBe(true);

    // ---- (a) 拖入 ----
    await dropPng(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.some((n) => n.type === 'image' && !!n.image?.src);
    });

    const first = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      const img = nodes.find((n) => n.type === 'image')!;
      return { src: img.image!.src, assetRefs: window.__drawpaper__!.listAssetRefs() };
    });
    console.log('FIRST_IMAGE_SRC', first.src, 'ASSET_REFS', first.assetRefs);
    // JSON 里是 assetRef，不是 dataURL
    expect(first.src.startsWith('data:')).toBe(false);
    expect(first.assetRefs).toContain(first.src);
    // Blob 真的落在 OPFS
    expect(await page.evaluate((ref) => window.__drawpaper__!.opfsHasAsset(ref), first.src)).toBe(true);
    // 画布 <img> 渲染出图（objectURL 解析成功）
    await page.waitForFunction(() => {
      const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
      return !!img && img.naturalWidth > 0;
    });

    // 强制落盘后 reload
    await invoke(page, 'requestSave');
    await page.waitForTimeout(800);

    // ---- (b) reload 后 OPFS 持久化 ----
    await page.reload();
    await waitForApp(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.some((n) => n.type === 'image' && !!n.image?.src);
    });
    await page.waitForFunction(() => {
      const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
      return !!img && img.naturalWidth > 0;
    });
    const afterReload = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.filter((n) => n.type === 'image').map((n) => n.image!.src);
    });
    console.log('AFTER_RELOAD_SRCS', afterReload);
    expect(afterReload.some((s: string) => s === first.src)).toBe(true);

    // ---- (c) 斜杠菜单「图片」第二入口（文件选择器）----
    await page.keyboard.press('Control+0');
    await page.waitForTimeout(300);
    // 进入图片块编辑（双击节点），唤起斜杠菜单。
    await page.dblclick('.react-flow__node');
    await page.waitForTimeout(200);
    await page.keyboard.type('/');
    // 菜单项「图片」→ 触发隐藏 file input → filechooser（斜杠菜单 portal 在 body 下的 w-56 浮层里）
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.locator('div.w-56 button', { hasText: '图片' }).click(),
    ]);
    await chooser.setFiles({
      name: 'slash.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_B64, 'base64'),
    });
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.filter((n) => n.type === 'image').length >= 2;
    });
    await page.keyboard.press('Escape');
    const assetRefs2 = await page.evaluate(() => window.__drawpaper__!.listAssetRefs());
    console.log('AFTER_SLASH_ASSET_REFS', assetRefs2);
    expect(assetRefs2.length).toBeGreaterThanOrEqual(2);
    // 全部 image.src 都不是 dataURL
    const allSrc = await page.evaluate(() =>
      window.__drawpaper__!.getState().doc.nodes.filter((n) => n.type === 'image').map((n) => n.image!.src),
    );
    console.log('ALL_IMAGE_SRCS', allSrc);
    for (const s of allSrc) expect(s.startsWith('data:')).toBe(false);

    // ---- (d) 导出 / 序列化 ----
    const serialized = await page.evaluate(() => window.__drawpaper__!.exportCurrent());
    console.log('SERIALIZED_HAS_REFS', assetRefs2.every((r: string) => serialized.includes(r)));
    // 序列化文本里含 assetRef 登记、且 image 块 src 引用
    expect(assetRefs2.every((r: string) => serialized.includes(r))).toBe(true);

    const svgs = await page.evaluate(() => window.__drawpaper__!.buildSvgPagesDev());
    console.log('SVG_PAGE_COUNT', svgs.length, 'SVG_HAS_DATA_IMAGE', svgs.some((s) => s.includes('data:image')));
    fs.mkdirSync('test-results', { recursive: true });
    for (const [i, s] of svgs.entries()) {
      fs.writeFileSync(`test-results/p21-debug-${i}.svg`, s);
      console.log(`SVG[${i}] len=${s.length} hasImageTag=${s.includes('<image')}`, s.slice(0, 600));
    }
    expect(svgs.length).toBeGreaterThanOrEqual(1);
    expect(svgs.some((s) => s.includes('<image') && s.includes('data:image'))).toBe(true);
  });
});

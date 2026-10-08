import { test, expect, type Browser, type Page } from '@playwright/test';
import { waitForApp, invoke } from './fixtures/load-doc';

/**
 * Wave20 S 路：OPFS 不可用（非安全上下文/旧浏览器/隐私模式）下端到端降级验证。
 *
 * 契约：
 *  - 图片（拖入 / 斜杠 / 粘贴）：降级为 data: URL 内联，文档 JSON 不存 OPFS assetRef；
 *  - 非图片附件（.pdf 等）：toast 提示，不建坏块、不落盘；
 *  - reload 后内联图片仍在（IDB 持久化）；
 *  - 导出 SVG 内嵌 data:image；
 *  - OPFS 正常上下文不回退（p21 主路径仍绿）。
 *
 * 两种 OPFS 不可用模拟（context.addInitScript，页面脚本前覆写）：
 *  - 模式 A：navigator.storage 整体不存在（旧浏览器/非安全上下文）；
 *  - 模式 B：navigator.storage.getDirectory 存在但调用抛 NotAllowedError（隐私模式）。
 */

// 1x1 红点 PNG（合法最小 PNG，canvas 可解码）。
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 最小合法 PDF（伪造 .pdf 附件字节）。 */
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc3, 0xb4, 0xc3, 0xa1,
]);

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

async function dropPdf(page: Page): Promise<void> {
  await page.evaluate((bytesArr) => {
    const bytes = Uint8Array.from(bytesArr);
    const file = new File([bytes], 'report.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const pane = document.querySelector('.react-flow__pane') as HTMLElement;
    pane.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: 600,
        clientY: 500,
      }),
    );
  }, Array.from(PDF_BYTES));
}

async function newDegradedContext(browser: Browser, mode: 'no-storage' | 'throws') {
  const ctx = await browser.newContext();
  await ctx.addInitScript((m) => {
    if (m === 'no-storage') {
      // 故意覆写 navigator.storage = undefined 模拟旧浏览器/非安全上下文。
      Object.defineProperty(navigator, 'storage', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    } else {
      // getDirectory 存在但调用抛 NotAllowedError（隐私模式）。
      // 用 Object.defineProperty 强覆写实例属性，shadow 掉原型上的原生方法。
      const s = (navigator as unknown as { storage?: Record<string, unknown> }).storage;
      if (s) {
        Object.defineProperty(s, 'getDirectory', {
          value: () => Promise.reject(new DOMException('Access to OPFS is not allowed', 'NotAllowedError')),
          configurable: true,
          writable: true,
        });
      }
    }
  }, mode);
  return ctx;
}

test.describe('Wave20 OPFS 降级 — 模式 A（navigator.storage 不存在）', () => {
  test('a/b 拖入图片内联 data:，无 OPFS assetRef 泄漏', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await newDegradedContext(browser, 'no-storage');
    const page = await ctx.newPage();
    await waitForApp(page);

    expect(await page.evaluate(() => window.__drawpaper__!.opfsAvailable())).toBe(false);

    // 拖入第一张图片 → 内联 data: URL。
    await dropPng(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.some((n) => n.type === 'image' && !!n.image?.src);
    });

    const afterFirst = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      const imgs = nodes.filter((n) => n.type === 'image').map((n) => n.image!.src);
      return { imgs, assetRefs: window.__drawpaper__!.listAssetRefs() };
    });
    console.log('DEGRADED_A_FIRST_SRCS', afterFirst.imgs, 'ASSET_REFS', afterFirst.assetRefs);
    expect(afterFirst.imgs.length).toBeGreaterThanOrEqual(1);
    for (const s of afterFirst.imgs) expect(s.startsWith('data:')).toBe(true);
    expect(afterFirst.assetRefs.length).toBe(0);

    // 画布 <img> 渲染出图。
    await page.waitForFunction(() => {
      const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
      return !!img && img.naturalWidth > 0;
    });

    // 拖入第二张 → 同样内联。
    await dropPng(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.filter((n) => n.type === 'image').length >= 2;
    });
    const afterDrop = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.filter((n) => n.type === 'image').map((n) => n.image!.src);
    });
    console.log('DEGRADED_A_AFTER_DROP_SRCS', afterDrop);
    expect(afterDrop.length).toBeGreaterThanOrEqual(2);
    for (const s of afterDrop) expect(s.startsWith('data:')).toBe(true);

    await ctx.close();
  });

  test('c reload 持久化 + d SVG 导出内嵌 + e 附件 toast 不建块', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await newDegradedContext(browser, 'no-storage');
    const page = await ctx.newPage();
    await waitForApp(page);

    expect(await page.evaluate(() => window.__drawpaper__!.opfsAvailable())).toBe(false);

    // 先建两张内联图。
    await dropPng(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.filter((n) => n.type === 'image').length >= 1 && nodes.every((n) => !n.image || n.image.src.startsWith('data:'));
    });
    await dropPng(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.filter((n) => n.type === 'image').length >= 2;
    });

    // ---- (c) reload 后内联图片仍在（IDB 持久化）----
    await invoke(page, 'requestSave');
    await page.waitForTimeout(2000);
    await page.reload();
    await waitForApp(page);
    await page.keyboard.press('Control+0');
    await page.waitForFunction(
      () => window.__drawpaper__!.getState().doc.nodes.filter((n) => n.type === 'image').length >= 2,
      null,
      { timeout: 15_000 },
    );
    await page.waitForFunction(() => {
      const imgs = document.querySelectorAll('.react-flow__node img');
      return imgs.length >= 1 && Array.from(imgs).some((i) => (i as HTMLImageElement).naturalWidth > 0);
    }, null, { timeout: 15_000 });
    const afterReload = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.filter((n) => n.type === 'image').map((n) => n.image!.src);
    });
    console.log('DEGRADED_A_RELOAD_SRCS', afterReload.length);
    expect(afterReload.length).toBeGreaterThanOrEqual(2);
    for (const s of afterReload) expect(s.startsWith('data:')).toBe(true);

    // ---- (d) 导出 SVG 内嵌 data:image ----
    const svgs = await page.evaluate(() => window.__drawpaper__!.buildSvgPagesDev());
    console.log('DEGRADED_A_SVG_PAGES', svgs.length, 'hasDataImage', svgs.some((s) => s.includes('data:image')));
    expect(svgs.length).toBeGreaterThanOrEqual(1);
    expect(svgs.some((s) => s.includes('<image') && s.includes('data:image'))).toBe(true);

    // ---- (e) 拖入非图片附件（.pdf）→ toast 且不建坏块 ----
    const nodesBefore = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    await dropPdf(page);
    await expect(
      page.locator('div[role="status"]', { hasText: /附件本地存储|OPFS/ }),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      (before) => window.__drawpaper__!.getState().doc.nodes.length === before,
      nodesBefore,
      { timeout: 15_000 },
    );
    const nodesAfter = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    expect(nodesAfter).toBe(nodesBefore);
    const badAttachment = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.some((n) => n.type === 'attachment' && !n.attachment?.assetRef);
    });
    expect(badAttachment).toBe(false);

    await ctx.close();
  });
});

test.describe('Wave20 OPFS 降级 — 模式 B（getDirectory 抛 NotAllowedError）', () => {
  test('拖入图片内联 + 附件 toast 不建块', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctx = await newDegradedContext(browser, 'throws');
    const page = await ctx.newPage();
    await waitForApp(page);

    // 注意：模式 B 下 getDirectory 函数存在 → isOpfsAvailable() 返回 true（能力检测只看函数存在），
    // 但实际调用会抛错。putAsset 内部 try/catch 会兜住并降级。
    const avail = await page.evaluate(() => window.__drawpaper__!.opfsAvailable());
    console.log('DEGRADED_B_opfsAvailable', avail);

    // 拖入图片 → 运行时 getDirectory 抛错 → putImageAsset 返回空 → 管线降级 dataURL。
    await dropPng(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.some((n) => n.type === 'image' && !!n.image?.src);
    }, null, { timeout: 30_000 });
    const imgs = await page.evaluate(() =>
      window.__drawpaper__!.getState().doc.nodes.filter((n) => n.type === 'image').map((n) => n.image!.src),
    );
    console.log('DEGRADED_B_DROP_SRCS', imgs);
    // 必须有图片块且全部是 data: 内联（不允许空数组空过）。
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    for (const s of imgs) expect(s.startsWith('data:')).toBe(true);

    // 附件拖入 → toast（getDirectory 运行时抛错 → putImageAsset 兜底返回 data: URL
    // → CanvasEditor 识别 data: 前缀 → toast 且不建块）。
    const nodesBefore = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    await dropPdf(page);
    await expect(
      page.locator('div[role="status"]', { hasText: /附件本地存储|OPFS/ }),
    ).toBeVisible({ timeout: 15_000 });
    // 轮询确认 node count 不变（不依赖固定 sleep）。
    await page.waitForFunction(
      (before) => window.__drawpaper__!.getState().doc.nodes.length === before,
      nodesBefore,
      { timeout: 15_000 },
    );
    const nodesAfter = await page.evaluate(() => window.__drawpaper__!.getState().doc.nodes.length);
    expect(nodesAfter).toBe(nodesBefore);

    await ctx.close();
  });
});

test.describe('Wave20 OPFS 降级 — (f) 正常上下文不回退', () => {
  test('不注入覆写：opfsAvailable=true，拖入图片走 OPFS assetRef', async ({ page }) => {
    await waitForApp(page);
    expect(await page.evaluate(() => window.__drawpaper__!.opfsAvailable())).toBe(true);

    await dropPng(page);
    await page.waitForFunction(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      return nodes.some((n) => n.type === 'image' && !!n.image?.src);
    });
    const src = await page.evaluate(() => {
      const nodes = window.__drawpaper__!.getState().doc.nodes;
      const img = nodes.find((n) => n.type === 'image')!;
      return img.image!.src;
    });
    // OPFS 正常：src 是 64-hex assetRef，不是 data:。
    expect(src.startsWith('data:')).toBe(false);
    expect(src).toMatch(/^[0-9a-f]{64}$/);
  });
});

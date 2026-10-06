import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * Wave14·同步资产推送：修复跨设备同步「资产只拉不推」。
 *
 * 背景：orchestrator 旧 push 段只 channel.pushDoc，从不 pushAsset；pull 段(4c)却会把远端
 * 资产拉回本地 OPFS。结果是：本端新建的图片/附件，文档能同步过去，二进制却永远留在本机，
 * 对端拉到文档后图片裂图。本波在 push 段(4d)补资产上传：收集本轮收敛文档的 assetRefs，
 * 与远端已有资产清单比对去重，从 OPFS 读字节经 channel.pushAsset 上传（E2EE 时通道层包信封）。
 *
 * 覆盖：
 *  ①FSA：设备 A 新增图片块+附件块 → 同步推送 → fake 目录出现 assets/<ref>；
 *         设备 B 把该文档+资产放进自己的 fake 目录后拉取合并 → 图片真实渲染、资产落 B 的 OPFS。
 *  ②WebDAV route mock：资产双向收敛（A 推 B 拉渲染；B 新增资产 A 再拉落 OPFS）。
 *  ③E2EE 开启时：资产 PUT body 为密文信封，服务器侧 grep 不到 PNG 签名/固定 fixture 字节，
 *     manifest/文档标题同样不可见。
 *  ④重复同步不重复传：第二次同步资产上传计数为 0（去重断言）。
 *
 * 注意：拖入图片后需等 flush（落 IndexedDB，含 assetRefs 登记）再同步；FSA 通道另有 2s 防抖
 * 自动推送，故 FSA 用例额外等自动推送落盘后再断言目录转储。
 */

// 1x1 红点 PNG（合法最小 PNG，canvas 可解码）。
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 一个任意字节串（当作附件 pdf；附件管线不解析内容，只落 OPFS）。
const PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2Jq';
// PNG 文件签名（8 字节）。E2EE 用例断言服务器侧任何 body 都不含它。
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const waitBoot = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.react-flow')).toBeVisible();
  await page.waitForFunction(() => {
    const h = window.__drawpaper__;
    return h && !!h.getState().doc.id;
  });
  await page.waitForTimeout(300);
};

const nodeCount = (page: Page) => page.evaluate(() => window.__drawpaper__!.getState().nodeCount);

async function dropFile(page: Page, name: string, mime: string, b64: string): Promise<void> {
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

/** 等图片块落库并返回其 assetRef；随后 requestSave 并等 flush 落 IndexedDB。 */
async function dropImageSave(page: Page): Promise<string> {
  await dropFile(page, 'drop.png', 'image/png', PNG_B64);
  await page.waitForFunction(() => {
    const nodes = window.__drawpaper__!.getState().doc.nodes;
    return nodes.some((n) => n.type === 'image' && !!n.image?.src);
  });
  const ref = await page.evaluate(() => {
    const img = window.__drawpaper__!.getState().doc.nodes.find((n) => n.type === 'image')!;
    return img.image!.src;
  });
  await page.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
  await page.waitForTimeout(1200); // 等 flush 把 assetRefs 写进 IndexedDB
  return ref;
}

/** Node 侧共享 WebDAV 服务器（二进制安全：body 以 base64 存，便于 grep 密文字节）。 */
function createMockServer() {
  const filesB64 = new Map<string, string>();
  const putLog: string[] = [];

  const multistatus = (paths: string[]): string => {
    const responses = paths
      .map((p) => `  <d:response><d:href>${p}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>`)
      .join('\n');
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">\n${responses}\n</d:multistatus>`;
  };

  async function handler(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const path = decodeURIComponent(url.pathname.replace(/^\/dav\/?/, ''));
    const method = req.method();
    if (method === 'PROPFIND') {
      const names = [...filesB64.keys()].map((k) => `/dav/${k}`);
      await route.fulfill({ status: 207, contentType: 'application/xml; charset=utf-8', body: multistatus(names) });
      return;
    }
    if (method === 'GET') {
      const b64 = filesB64.get(path);
      if (b64 == null) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      await route.fulfill({ status: 200, body: Buffer.from(b64, 'base64') });
      return;
    }
    if (method === 'PUT') {
      const buf = req.postDataBuffer() ?? Buffer.alloc(0);
      filesB64.set(path, buf.toString('base64'));
      putLog.push(`${method} ${path} len=${buf.length}`);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 200, body: '' });
  }

  return { filesB64, putLog, handler };
}

/** 判定一段 body（base64）是否为合法 E2EE 信封（而非明文/原始二进制）。 */
function looksLikeEnvelopeB64(b64: string): boolean {
  try {
    const text = Buffer.from(b64, 'base64').toString('utf-8');
    const o = JSON.parse(text);
    return (
      o &&
      o.v === 1 &&
      o.kdf === 'PBKDF2-SHA-256' &&
      o.enc === 'A256GCM' &&
      typeof o.it === 'number' &&
      typeof o.salt === 'string' &&
      typeof o.nonce === 'string' &&
      typeof o.ct === 'string' &&
      !('format' in o) &&
      !('title' in o)
    );
  } catch {
    return false;
  }
}

interface LastRun {
  push: number;
  merged: number;
  assetsPushed: number;
  assetsFailed: number;
}
const inspectLastRun = (p: Page) =>
  p.evaluate(() => (window.__drawpaper__!.syncRunNow() as Promise<{ lastRun?: LastRun }>)).then((r) => r.lastRun);

test.describe('Wave14 同步资产推送（资产只拉不推修复）', () => {
  test('① FSA：A 推图片+附件资产到共享目录；B 拉取后图片渲染、资产落 B OPFS', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await waitBoot(pageA);

    // A：注入 fake 目录通道，拖入图片块 + 附件块；等自动推送落盘。
    await pageA.evaluate(() => window.__drawpaper__!.syncUseFakeFolder());
    const r1 = await dropImageSave(pageA);
    await dropFile(pageA, 'note.pdf', 'application/pdf', PDF_B64);
    await pageA.evaluate(() => window.__drawpaper__!.invoke('requestSave'));
    await pageA.waitForTimeout(3000); // FSA 2s 防抖自动推送 + 同步
    const docId = await pageA.evaluate(() => window.__drawpaper__!.getState().doc.id);

    const dumpA = await pageA.evaluate(() => window.__drawpaper__!.syncFakeDump());
    console.log('FSA_A_DUMP_KEYS', Object.keys(dumpA).join(','));
    expect(dumpA[`${docId}.kbnote`], '文档应推到共享目录').toBeTruthy();
    expect(Object.keys(dumpA)).toContain(`assets/${r1}`);

    // 把 A 的文档 + 资产字节搬到 B 的 fake 目录（模拟 Syncthing 把磁盘同步给另一台设备）。
    const docText = await pageA.evaluate(() => window.__drawpaper__!.exportCurrent());
    const b64r1 = await pageA.evaluate((ref) => window.__drawpaper__!.opfsReadAssetB64(ref), r1);
    expect(b64r1, 'A 的 OPFS 应有该图片字节').toBeTruthy();

    await waitBoot(pageB);
    await pageB.evaluate(() => window.__drawpaper__!.syncUseFakeFolder());
    await pageB.waitForTimeout(1500); // 等 startFolder 的初始同步收尾，避免手动 sync 被 running 挡掉
    await pageB.evaluate(
      ({ docId, docText, r1, b64r1 }) => {
        window.__drawpaper__!.syncFakeWrite(`${docId}.kbnote`, docText);
        window.__drawpaper__!.syncFakeWriteBytes(`assets/${r1}`, b64r1!);
      },
      { docId, docText, r1, b64r1 },
    );
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());

    // B 打开拉来的文档：节点在、图片真实渲染、资产落 B 的 OPFS。
    await pageB.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId);
    await expect.poll(() => nodeCount(pageB), { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => await pageB.evaluate((ref) => window.__drawpaper__!.opfsHasAsset(ref), r1), {
      timeout: 5000,
    }).toBe(true);
    await pageB.waitForFunction(() => {
      const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
      return !!img && img.naturalWidth > 0;
    });

    await ctxA.close();
    await ctxB.close();
  });

  test('② WebDAV route mock：资产双向收敛（A 推 B 拉渲染；B 加资产 A 拉）', async ({ browser }) => {
    const server = createMockServer();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.route('**/dav/**', (r) => server.handler(r));
    await ctxB.route('**/dav/**', (r) => server.handler(r));
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await waitBoot(pageA);
    await waitBoot(pageB);

    // A 拖图片 → r1；明文 WebDAV 推。
    const r1 = await dropImageSave(pageA);
    const docId = await pageA.evaluate(() => window.__drawpaper__!.getState().doc.id);
    await pageA.evaluate(() => window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass'));
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());
    expect(server.filesB64.has(`${docId}.kbnote`), 'A 文档应推到 WebDAV').toBe(true);
    expect(server.filesB64.has(`assets/${r1}`), 'A 应把图片资产推到 WebDAV').toBe(true);

    // B 拉 → 打开 → 图片渲染、资产落 B OPFS。
    await pageB.evaluate(() => window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass'));
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());
    await pageB.evaluate((id) => window.__drawpaper__!.invoke('openDoc', id), docId);
    await expect.poll(() => nodeCount(pageB), { timeout: 8000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => await pageB.evaluate((ref) => window.__drawpaper__!.opfsHasAsset(ref), r1), {
      timeout: 5000,
    }).toBe(true);
    await pageB.waitForFunction(() => {
      const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
      return !!img && img.naturalWidth > 0;
    });

    // B 再加一张图 r2 → 推（B 端独有资产反向推回服务器）。
    const r2 = await dropImageSave(pageB);
    await pageB.evaluate(() => window.__drawpaper__!.syncRunNow());
    expect(server.filesB64.has(`assets/${r2}`), 'B 新增资产应反向推到 WebDAV').toBe(true);

    // A 再拉 → r2 落 A 的 OPFS。
    await pageA.evaluate(() => window.__drawpaper__!.syncRunNow());
    await expect.poll(async () => await pageA.evaluate((ref) => window.__drawpaper__!.opfsHasAsset(ref), r2), {
      timeout: 8000,
    }).toBe(true);

    await ctxA.close();
    await ctxB.close();
  });

  test('③ E2EE：资产 PUT body 为密文信封，服务器 grep 不到 PNG 签名/标题', async ({ page }) => {
    const server = createMockServer();
    await page.route('**/dav/**', (r) => server.handler(r));
    await waitBoot(page);

    const r1 = await dropImageSave(page);
    const docId = await page.evaluate(() => window.__drawpaper__!.getState().doc.id);
    await page.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass', 'e2ee-asset-pass');
    });
    await page.evaluate(() => window.__drawpaper__!.syncRunNow());

    // 文档 + 资产都在服务器上。
    expect(server.filesB64.has(`${docId}.kbnote`), '加密文档应已上传').toBe(true);
    expect(server.filesB64.has(`assets/${r1}`), '加密资产应已上传').toBe(true);

    // 逐文件断言：全部是信封；任何 body 字节里都 grep 不到 PNG 签名。
    for (const [path, b64] of server.filesB64.entries()) {
      const raw = Buffer.from(b64, 'base64');
      expect(raw.indexOf(PNG_SIG), `${path} 泄露了 PNG 签名字节`).toBe(-1);
      if (path.endsWith('.kbnote') || path.startsWith('assets/')) {
        expect(looksLikeEnvelopeB64(b64), `${path} 不是 E2EE 信封`).toBe(true);
      }
    }
    for (const entry of server.putLog) {
      expect(entry).not.toContain('drop.png');
    }
    console.log('E2EE_SERVER_FILES', [...server.filesB64.keys()].join(','));
    await page.close();
  });

  test('④ 重复同步不重复传：第二次同步资产上传计数为 0（WebDAV 无自动推送，计数确定）', async ({ page }) => {
    const server = createMockServer();
    await page.route('**/dav/**', (r) => server.handler(r));
    await waitBoot(page);
    await page.evaluate(() => window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass'));

    const r1 = await dropImageSave(page);
    const run1 = await inspectLastRun(page);
    console.log('DEDUP_RUN1', JSON.stringify(run1));
    expect(server.filesB64.has(`assets/${r1}`), '资产应已推到服务器').toBe(true);
    expect(run1?.assetsPushed, '本轮应推 1 个资产').toBe(1);

    // 第二次同步（无任何新增资产）：远端已有该资产，推送计数必须为 0（去重生效）。
    const run2 = await inspectLastRun(page);
    console.log('DEDUP_RUN2', JSON.stringify(run2));
    expect(run2?.assetsPushed, '第二次同步不应重复上传已存在的资产').toBe(0);
    await page.close();
  });
});

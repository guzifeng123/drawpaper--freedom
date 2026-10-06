import { test, expect, type Page } from '@playwright/test';

/**
 * Wave11 阶段 C 补缺 e2e ②：WebDAV 401 认证失败 / 断网错误路径（chromium）。
 *
 *  - route 全量返回 401 → 点立即同步 → toast「认证失败，请检查用户名/密码」，
 *    且本地文档仍可编辑、数据不丢；
 *  - route abort 模拟断网 → toast「无法连接服务器」，且本地数据不丢。
 *
 * 零外网：dav.mock 主机仅在 page.route 白名单内，真实网络请求被 route 拦截/拒绝。
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

/** 建一个带标记文本的本地块，返回 nodeId。 */
async function seedLocalDoc(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = window.__drawpaper__!;
    const id = h.invoke('addNode', 'text', 100, 100) as string;
    h.invoke('updateContent', id, { type: 'doc', content: [{ type: 'paragraph', text: '本地未同步标记' }] });
    h.invoke('requestSave');
    return id;
  });
}

const nodeCount = (page: Page) => page.evaluate(() => window.__drawpaper__!.getState().nodeCount);

test.describe('Wave11 补缺 ②：WebDAV 401 / 断网错误路径', () => {
  test('① WebDAV 全量 401 → 认证失败 toast，本地仍可编辑', async ({ page }) => {
    // route：所有 dav 请求一律 401。
    await page.route('**/dav/**', (route) => route.fulfill({ status: 401, body: '' }));

    await waitBoot(page);
    const nodeId = await seedLocalDoc(page);
    expect(await nodeCount(page)).toBe(1);

    // 启动 WebDAV 通道并立即同步（会失败于 401）。
    await page.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'wrong-pass');
    });
    await page.evaluate(() => window.__drawpaper__!.syncRunNow());

    // toast：认证失败。
    await expect(page.getByRole('status').filter({ hasText: '认证失败，请检查用户名/密码' })).toBeVisible();
    console.log('GOT_401_TOOK');

    // 本地数据不丢：标记块仍在。
    const markerStillThere = await page.evaluate((nid) => {
      const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === nid);
      return JSON.stringify(n?.content?.data ?? '').includes('本地未同步标记');
    }, nodeId);
    expect(markerStillThere).toBe(true);

    // 本地仍可编辑：再加一块成功。
    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 400, 100);
      window.__drawpaper__!.invoke('requestSave');
    });
    expect(await nodeCount(page)).toBe(2);

    // 清理通道。
    await page.evaluate(() => window.__drawpaper__!.syncStop());
  });

  test('② route abort 模拟断网 → 无法连接 toast，本地数据不丢', async ({ page }) => {
    // route：直接 abort（网络层失败，无响应）。
    await page.route('**/dav/**', (route) => route.abort('failed'));

    await waitBoot(page);
    const nodeId = await seedLocalDoc(page);
    expect(await nodeCount(page)).toBe(1);

    await page.evaluate(() => {
      window.__drawpaper__!.syncStartWebdav('http://dav.mock/dav', 'user', 'pass');
    });
    await page.evaluate(() => window.__drawpaper__!.syncRunNow());

    // toast：无法连接服务器。
    await expect(page.getByRole('status').filter({ hasText: '无法连接服务器' })).toBeVisible();
    console.log('GOT_OFFLINE_TOOK');

    // 本地数据不丢 + 仍可编辑。
    const markerStillThere = await page.evaluate((nid) => {
      const n = window.__drawpaper__!.getState().doc.nodes.find((x) => x.id === nid);
      return JSON.stringify(n?.content?.data ?? '').includes('本地未同步标记');
    }, nodeId);
    expect(markerStillThere).toBe(true);

    await page.evaluate(() => {
      window.__drawpaper__!.invoke('addNode', 'text', 400, 100);
      window.__drawpaper__!.invoke('requestSave');
    });
    expect(await nodeCount(page)).toBe(2);

    await page.evaluate(() => window.__drawpaper__!.syncStop());
  });
});

import type { Page, BrowserContext } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Wave8 离线回归共享辅助：
 *  - bootOnlineWithSW()：联网首访生产预览，等 SW 安装 + precache 落盘，再 reload 拿到受控页面；
 *  - 所有操作走真实 UI（生产无 __drawpaper__ 钩子）。
 */

// 1x1 红点 PNG（合法最小 PNG，canvas 可解码）。
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 联网启动：首访 → 等 SW active → 等 precache 缓存写满 → reload 拿到 controller。 */
export async function bootOnlineWithSW(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.react-flow').waitFor({ timeout: 15_000 });

  // SW 注册并激活（registerSW.js 在 load 事件后 register('/sw.js')）。
  await page.waitForFunction(
    async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.ready;
      return !!reg.active;
    },
    null,
    { timeout: 20_000 },
  );

  // workbox precache 落盘：precache cache 达到构建产物量级（基线 78+ 条）。
  await page.waitForFunction(
    async () => {
      for (const k of await caches.keys()) {
        const c = await caches.open(k);
        if ((await c.keys()).length >= 70) return true;
      }
      return false;
    },
    null,
    { timeout: 30_000 },
  );

  // 首访页面尚未被 SW 控制（active 时 clientsClaim 一般已接管，这里再 reload 兜底）。
  await page.reload();
  await page.locator('.react-flow').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10_000 });
}

/** 断网：context 级离线，并 reload 验证外壳从 SW 缓存恢复。 */
export async function goOfflineAndReload(ctx: BrowserContext, page: Page): Promise<void> {
  await ctx.setOffline(true);
  await page.reload();
  // 离线导航由 workbox NavigationRoute 回退到 precache 的 index.html。
  await page.locator('.react-flow').waitFor({ timeout: 20_000 });
}

/** 双击空白画布新建文本块并进入编辑态。 */
export async function newTextBlock(page: Page, x: number, y: number): Promise<void> {
  await page.locator('.react-flow__pane').dblclick({ position: { x, y } });
  await page.locator('.ProseMirror-focused').waitFor({ timeout: 5_000 });
}

/** 在当前已聚焦的块编辑器里打开斜杠菜单并选择一项（label 见 slash-menu.tsx）。 */
export async function pickSlashItem(page: Page, label: string): Promise<void> {
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.waitForTimeout(250);
  await page.locator('div.w-56 button', { hasText: label }).click();
}

/** 拖入 PNG 到画布（真实 ingest → OPFS 管线，等价于用户拖文件）。 */
export async function dropPng(page: Page, b64: string, x = 600, y = 300): Promise<void> {
  await page.evaluate(
    ({ b64, x, y }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'offline-drop.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const pane = document.querySelector('.react-flow__pane') as HTMLElement;
      pane.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    },
    { b64, x, y },
  );
}

/** 打开导出对话框（Ctrl+P）。 */
export async function openExportDialog(page: Page): Promise<void> {
  // 先退出任何编辑态，快捷键才生效。
  await page.locator('.react-flow__pane').click({ position: { x: 900, y: 600 } });
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+p');
  await page.getByRole('heading', { name: '导出 / 打印' }).waitFor({ timeout: 5_000 });
}

export interface RequestAudit {
  /** 全部请求 URL（按序）。 */
  urls: string[];
  /** 失败请求：url -> errorText。 */
  failures: Map<string, string>;
  /** 外网 http(s) 请求（排除同源 localhost、blob:/data:）。 */
  external: string[];
  attach(): void;
  /** 断言：无失败请求、无外网请求。 */
  assertClean(baseUrl: string): void;
}

/** 安装全请求审计：记录 request / requestfailed，供离线阶段断言零外网零失败。 */
export function attachRequestAudit(page: Page): RequestAudit {
  const urls: string[] = [];
  const failures = new Map<string, string>();
  const external: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  page.on('requestfailed', (r) => {
    failures.set(r.url(), r.failure()?.errorText ?? 'unknown');
  });
  return {
    urls,
    failures,
    external,
    attach() {
      /* listeners 已在构造时挂上 */
    },
    assertClean(baseUrl: string) {
      // 外网定义：http(s) 且 host 不是 preview 同源。blob:/data: 是页面内生成，不计。
      const ext = urls.filter((u) => /^https?:\/\//.test(u) && !u.startsWith(baseUrl + '/') && !u.startsWith(baseUrl));
      external.push(...ext);
      expect([...failures.entries()], `失败请求：${[...failures].map(([u, f]) => u + '(' + f + ')').join('; ')}`).toHaveLength(0);
      expect(ext, `外网请求：${ext.join('; ')}`).toHaveLength(0);
    },
  };
}

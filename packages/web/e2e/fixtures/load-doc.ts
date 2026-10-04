import type { Page } from '@playwright/test';
import { buildStandardFixture, buildPerfFixture } from './sample-doc';
import type { KBNoteDoc } from '@drawpaper/core';

/**
 * e2e 数据灌入辅助：等待应用 boot，再经 DEV 钩子批量灌文档。
 * 钩子仅在 dev server 下存在（import.meta.env.DEV 守卫）。
 */

export async function waitForApp(page: Page): Promise<void> {
  await page.goto('/');
  // 等待画布根与 DEV 钩子就绪。
  await page.waitForFunction(() => !!(window as unknown as { __drawpaper__?: unknown }).__drawpaper__, null, {
    timeout: 15_000,
  });
}

export async function loadStandard(page: Page) {
  const fx = buildStandardFixture();
  await page.evaluate((doc: KBNoteDoc) => {
    (window as unknown as { __drawpaper__: { loadFixture: (d: KBNoteDoc) => void } }).__drawpaper__.loadFixture(doc);
  }, fx.doc);
  await page.waitForTimeout(200);
  // fit 相机让节点进入视口（否则 onlyRenderVisibleElements 卸载屏外节点）。
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(400);
  return fx;
}

export async function loadPerf(page: Page, n: number): Promise<void> {
  const doc = buildPerfFixture(n);
  await page.evaluate((d: KBNoteDoc) => {
    (window as unknown as { __drawpaper__: { loadFixture: (doc: KBNoteDoc) => void } }).__drawpaper__.loadFixture(d);
  }, doc);
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(400);
}

export async function getState(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __drawpaper__: { getState: () => unknown } }).__drawpaper__.getState(),
  );
}

export async function invoke(page: Page, action: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ({ action, args }) =>
      (window as unknown as { __drawpaper__: { invoke: (a: string, ...x: unknown[]) => unknown } }).__drawpaper__.invoke(
        action,
        ...(args as unknown[]),
      ),
    { action, args },
  );
}

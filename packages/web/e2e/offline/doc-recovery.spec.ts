import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  bootOnlineWithSW,
  goOfflineAndReload,
  newTextBlock,
  dropPng,
  TINY_PNG_B64,
} from './helpers';

/**
 * 用例 1：断网首屏与文档恢复。
 *  联网时通过真实 UI 建好「文本块 + OPFS 图片」文档并等待自动保存落盘；
 *  断网 reload 后：应用外壳正常渲染；文档从 IndexedDB/OPFS 恢复，
 *  文本与图片可见、且仍可编辑。
 */

const OUT = path.resolve(process.cwd(), 'test-results/offline');
const MARKER = '离线恢复标记-X7';

test.describe('离线：首屏外壳 + 文档/OPFS 图片恢复', () => {
  test('断网 reload 后外壳渲染、IDB 文档与 OPFS 图片可见可编辑', async ({ page, context }) => {
    fs.mkdirSync(OUT, { recursive: true });

    // ---- 联网：建文档 ----
    await bootOnlineWithSW(page);

    await newTextBlock(page, 300, 250);
    await page.keyboard.type(MARKER, { delay: 10 });
    // 退出编辑态。
    await page.locator('.react-flow__pane').click({ position: { x: 800, y: 500 } });
    await page.getByText(MARKER).waitFor();

    // 拖入图片 → OPFS。
    await dropPng(page, TINY_PNG_B64, 650, 300);
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.react-flow__node img') as HTMLImageElement | null;
        return !!img && img.naturalWidth > 0;
      },
      null,
      { timeout: 10_000 },
    );
    console.log('ONLINE_DOC_READY: 文本块 + OPFS 图片已建');

    // 等 500ms 防抖自动保存落 IndexedDB + OPFS 写盘完成。
    await page.waitForTimeout(1500);

    // ---- 断网 reload ----
    await goOfflineAndReload(context, page);
    console.log('OFFLINE: 外壳（.react-flow）已从 SW 缓存恢复渲染');

    // 文档恢复：文本可见。
    await expect(page.getByText(MARKER).first()).toBeVisible({ timeout: 10_000 });
    console.log('OFFLINE: IndexedDB 文档文本已恢复');

    // 图片恢复：OPFS blob 重新解析，naturalWidth>0。
    await page.waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('.react-flow__node img')] as HTMLImageElement[];
        return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0);
      },
      null,
      { timeout: 10_000 },
    );
    console.log('OFFLINE: OPFS 图片已恢复（blob 重新解析成功）');

    // 断网下仍可编辑：双击文本块进编辑态、追加输入。
    await page.locator('.react-flow__node', { hasText: MARKER }).dblclick();
    await page.locator('.ProseMirror-focused').waitFor({ timeout: 5_000 });
    await page.keyboard.type('-断网追加');
    await expect(page.getByText(`${MARKER}-断网追加`).first()).toBeVisible();
    console.log('OFFLINE: 断网下文本块可编辑');

    await page.screenshot({ path: path.join(OUT, 'doc-recovery-offline.png'), fullPage: false });
  });
});

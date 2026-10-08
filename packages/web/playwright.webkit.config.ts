import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// 本机 playwright 浏览器（webkit-2359）装在 /home/user/ms-playwright；
// CI runner 上该路径不存在，保持默认缓存路径。仅当本机路径真实存在时覆盖。
const LOCAL_BROWSERS_PATH = '/home/user/ms-playwright';
if (existsSync(LOCAL_BROWSERS_PATH)) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = LOCAL_BROWSERS_PATH;
}

/**
 * Wave21 WebKit/Safari 兼容降级专用配置（独立于默认 chromium 套件）。
 *
 *  - project 固定 webkit；testMatch 只匹配本波新增的 webkit 兼容 spec，
 *    绝不让默认 chromium 全量套件改跑 webkit；
 *  - 本配置**不被 .github/workflows/web-ci.yml 默认调用**（CI 只装 chromium），
 *    仅在具备 WebKit 系统依赖（libgtk-4 / gstreamer-codecparsers / libavif 等）
 *    的本机/真机验证环境手动跑；
 *  - webServer 走 `pnpm dev`（e2e 依赖 window.__drawpaper__ DEV 钩子）。
 *
 * 前置：packages/web 先 build；WebKit 需系统库（缺库时 minibrowser 127 退出）。
 */
const WEBKIT_PORT = Number(process.env['WEBKIT_PORT'] ?? 4190);

export default defineConfig({
  testDir: './e2e',
  testMatch: 'wave21-webkit-compat.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEBKIT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${WEBKIT_PORT} --strictPort`,
    url: `http://localhost:${WEBKIT_PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});

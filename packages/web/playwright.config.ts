import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// 本机 playwright 浏览器（chromium 1243）实际装在 /home/user/ms-playwright。
// shell 可能全局导出 PLAYWRIGHT_BROWSERS_PATH=/opt/vm/preinstall/...
// （该路径缺 chromium_headless_shell），干净环境下浏览器会找不到。
// 但 CI runner 上 /home/user/ms-playwright 不存在，必须走默认缓存路径，
// 所以仅当本机路径真实存在时才覆盖（本地行为不变，CI 用 ~/.cache/ms-playwright）。
const LOCAL_BROWSERS_PATH = '/home/user/ms-playwright';
if (existsSync(LOCAL_BROWSERS_PATH)) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = LOCAL_BROWSERS_PATH;
}

/**
 * Playwright e2e 配置：chromium，webServer 自动起 preview（build 后）或 dev。
 * 本机浏览器缓存目录 /home/user/ms-playwright。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // DEV server：e2e 依赖 window.__drawpaper__ 测试钩子（仅 import.meta.env.DEV 暴露，
    // 生产构建不挂载）。生产产物的零外网/无钩子由 build 后 grep 单独核验。
    command: 'pnpm dev --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});

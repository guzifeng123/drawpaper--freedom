import { defineConfig, devices } from '@playwright/test';

// 本机 playwright 浏览器装在 /home/user/ms-playwright（默认 /opt 路径不可写）。
if (!process.env['PLAYWRIGHT_BROWSERS_PATH']) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = '/home/user/ms-playwright';
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
    command: 'pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});

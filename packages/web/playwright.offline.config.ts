import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// 本机 playwright 浏览器（chromium 1243）实际装在 /home/user/ms-playwright；
// CI runner 上该路径不存在，保持默认缓存路径。仅当本机路径真实存在时覆盖。
const LOCAL_BROWSERS_PATH = '/home/user/ms-playwright';
if (existsSync(LOCAL_BROWSERS_PATH)) {
  process.env['PLAYWRIGHT_BROWSERS_PATH'] = LOCAL_BROWSERS_PATH;
}

/**
 * Wave8 PWA「真实离线回归」专用配置：
 *  - 跑**生产预览**（vite preview 服务 dist），只有生产构建才注册 Service Worker；
 *    现有 playwright.config.ts 的 webServer 是 `pnpm dev`（无 SW、有 __drawpaper__ 钩子），
 *    不能复用于离线断言。
 *  - 端口固定 4188（可用 OFFLINE_PORT 覆盖），与 dev 类 e2e 的 E2E_PORT=4187 隔离，
 *    也不与其他并行 worktree 冲突。
 *  - 生产构建无 __drawpaper__ DEV 钩子，所有操作走真实 UI（双击画布建块、斜杠菜单、
 *    Ctrl+P 导出对话框、拖入图片）。
 *
 * 前置：先 `pnpm build` 产出 dist（webServer.command 会自动 build）。
 */
const OFFLINE_PORT = Number(process.env['OFFLINE_PORT'] ?? 4188);

export default defineConfig({
  testDir: './e2e/offline',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  // 离线用例共享浏览器存储语义：每个 test 独立 context（全新 IDB/OPFS/SW 注册），
  // 但同一 context 内多步骤串行。workers=1 避免 4188 端口上并发 preview 竞争（单 server）。
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${OFFLINE_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // 生产构建预览：先 build（产出 sw.js / precache manifest），再起 preview。
    // reuseExistingServer:true —— 本地手动起好的 preview 会被复用，避免每次重 build。
    command: `pnpm build && pnpm exec vite preview --port ${OFFLINE_PORT} --strictPort`,
    url: `http://localhost:${OFFLINE_PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});

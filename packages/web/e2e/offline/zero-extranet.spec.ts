import { test, expect } from '@playwright/test';
import { bootOnlineWithSW, goOfflineAndReload, attachRequestAudit } from './helpers';

/**
 * 用例 5：生产构建运行时零外网。
 *  审计从首访（含在线启动）到断网操作全程的所有 http(s) 请求：
 *   - 除同源 localhost（preview / SW precache）外，不得有任何外网请求；
 *   - AI endpoint 默认未配置，不得发起 openai/anthropic/chat/completions 类请求；
 *   - 断网后无任何 failed request（同源资源全部 precache 命中）。
 */

test.describe('离线：运行时零外网断言', () => {
  test('全程无外网请求、断网零失败', async ({ page, context }) => {
    // 监听先于一切导航挂上，覆盖在线启动阶段。
    const audit = attachRequestAudit(page);

    await bootOnlineWithSW(page);

    // 在线阶段也用一下搜索/导出入口，确保没有隐藏的外联。
    await page.keyboard.press('Control+f');
    const searchBox = page.getByPlaceholder(/搜索块内文字/);
    if (await searchBox.count()) {
      await searchBox.fill('x');
      await page.waitForTimeout(300);
    }
    await page.keyboard.press('Escape');

    // 断网后再操作一轮。
    await goOfflineAndReload(context, page);
    await page.keyboard.press('Control+f');
    if (await searchBox.count()) {
      await searchBox.fill('离线');
      await page.waitForTimeout(300);
    }
    await page.keyboard.press('Escape');

    const base = page.url().replace(/\/$/, '');
    const allHttp = audit.urls.filter((u) => /^https?:\/\//.test(u));
    const external = allHttp.filter((u) => !u.startsWith(base));
    const aiCalls = allHttp.filter((u) =>
      /(openai|anthropic|\/chat\/completions|\/v1\/messages|api\.openai|api\.anthropic)/.test(u),
    );
    console.log('TOTAL_HTTP_REQUESTS', allHttp.length);
    console.log('EXTERNAL_REQUESTS', external);
    console.log('AI_ENDPOINT_CALLS', aiCalls);
    console.log('FAILED_REQUESTS', [...audit.failures.entries()]);

    expect(external, `存在外网请求：${external.join('; ')}`).toHaveLength(0);
    expect(aiCalls, 'AI endpoint 默认未配置，不应发起请求').toHaveLength(0);
    expect([...audit.failures.entries()], `断网下有失败请求：${[...audit.failures].map(([u, f]) => u + '(' + f + ')')}`).toHaveLength(0);
  });
});

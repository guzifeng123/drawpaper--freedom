// Wave25.5 WebKit 导航取证（一次性，结果写 GITHUB_STEP_SUMMARY）。
//
// 判读逻辑：
//  - context.request.get() 走 node 侧网络（不经 WebKit 引擎）；
//  - page.goto() 走 WebKit 引擎网络栈。
// 若 node 侧 200 而引擎 commit 挂起 → 锁定 WebKit 引擎代理层拦截（CI runner 带
//    http_proxy/https_proxy，WebKitGTK 可能把 127.0.0.1 也走代理）。
// 同时 goto https://example.com 对照：引擎能否访问外网（区分是本地代理还是全无网）。
import { webkit } from '@playwright/test';
import fs from 'node:fs';

const SUMMARY = process.env.GITHUB_STEP_SUMMARY || '/tmp/webkit-nav-summary.md';
const BASE = process.env.WEBKIT_BASE || 'http://127.0.0.1:4190';
const out = (s) => fs.appendFileSync(SUMMARY, s + '\n');

out('## WebKit nav forensics');
out('');
out(`- base: ${BASE}`);
out(`- proxy env: http_proxy=${process.env.http_proxy || '(unset)'} https_proxy=${process.env.https_proxy || '(unset)'} no_proxy=${process.env.no_proxy || '(unset)'}`);
out('');

const browser = await webkit.launch({ headless: true });
const ctx = await browser.newContext();

// 1) node 侧网络（不经引擎）
try {
  const resp = await ctx.request.get(`${BASE}/`, { timeout: 10_000 });
  out(`### context.request.get('/')  (node 侧)`);
  out(`- status: ${resp.status()} ${resp.statusText()}`);
  const body = await resp.text();
  out(`- body head: \`\`\`html\n${body.slice(0, 400)}\n\`\`\``);
} catch (e) {
  out(`### context.request.get('/')  FAILED`);
  out(`- ${e?.message}`);
}
out('');

// 2) 引擎侧导航
const page = await ctx.newPage();
const events = [];
page.on('console', (m) => events.push(`[console ${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => events.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => events.push(`[requestfailed] ${r.url()} | ${r.failure()?.errorText}`));
page.on('request', (r) => events.push(`[request] ${r.url()}`));

out(`### page.goto('${BASE}/', waitUntil=commit)`);
try {
  await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 10_000 });
  out('- commit: OK');
} catch (e) {
  out(`- commit: THREW — ${e?.message}`);
}
await page.waitForTimeout(8_000);

let state = {};
try {
  state = await page.evaluate(() => ({
    readyState: document.readyState,
    title: document.title,
    html: document.documentElement?.outerHTML?.slice(0, 600) ?? '(no documentElement)',
    nav: performance.getEntriesByType('navigation').map((n) => ({
      type: n.type,
      domContentLoaded: n.domContentLoadedEventEnd,
      load: n.loadEventEnd,
    })),
  }));
} catch (e) {
  state = { evalError: e.message };
}
out(`- after 8s: readyState=${state.readyState ?? '?'} title=${state.title ?? '?'}`);
out(`- nav: \`\`\`json\n${JSON.stringify(state.nav || state.evalError, null, 2)}\n\`\`\``);
out(`- html: \`\`\`html\n${state.html}\n\`\`\``);
out('');

// 3) 外网对照
out(`### page.goto('https://example.com/', waitUntil=commit)  (外网对照)`);
try {
  await page.goto('https://example.com/', { waitUntil: 'commit', timeout: 10_000 });
  out('- external commit: OK');
} catch (e) {
  out(`- external commit: THREW — ${e?.message}`);
}
out('');

out('### collected events');
out(`\`\`\`\n${events.join('\n') || '(none)'}\n\`\`\``);

await browser.close();
out('');
out('Forensics done.');

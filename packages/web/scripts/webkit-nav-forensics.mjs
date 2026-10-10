/* eslint-disable no-undef -- page.evaluate / waitForFunction 回调跑在浏览器上下文
   （document/performance），本文件其余部分跑在 Node；一次性取证脚本，不接运行时代码。 */

// Wave25.5 WebKit 导航取证（一次性；结果用 ::warning annotation 输出，匿名可读）。
//
// 判读矩阵：每个 URL 都做
//   (a) ctx.request.get() —— node 侧网络，不经 WebKit 引擎；
//   (b) page.goto(url, {waitUntil:'commit', timeout:10s}) —— WebKit 引擎网络栈。
// 等 8s 后 dump readyState / outerHTML 500 字 / 收集到的 requestfailed·console·pageerror。
// 若 (a)=200 而 (b) 挂 → 引擎代理/网络栈拦截；dev 挂而 preview 通 → Vite dev 注入
// （/@vite/client、HMR ws）与 WebKit 的交互；连 example.com 都挂 → 引擎全无网。
import { webkit } from '@playwright/test';

const TARGETS = [
  { name: 'dev-127', url: 'http://127.0.0.1:4190/' },
  { name: 'dev-localhost', url: 'http://localhost:4190/' },
  { name: 'preview-127', url: 'http://127.0.0.1:4191/' },
  { name: 'external', url: 'https://example.com/' },
];

/** 发一条 ::warning annotation（标题/正文编码；每条 <1500 字符）。 */
function ann(title, body) {
  const t = String(title).replace(/%/g, '%25').replace(/:/g, '%3A').replace(/\r?\n/g, ' ').slice(0, 200);
  const b = String(body).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 1400);
  process.stdout.write(`::warning title=${t}::${b}\n`);
}

async function probe(browser, target) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const events = [];
  page.on('console', (m) => events.push(`[console ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => events.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => events.push(`[requestfailed] ${r.url()} | ${r.failure()?.errorText}`));

  // (a) node 侧
  let nodeStatus = 'ERR';
  try {
    const resp = await ctx.request.get(target.url, { timeout: 10_000 });
    nodeStatus = String(resp.status());
  } catch (e) {
    nodeStatus = `THROW ${e?.message?.slice(0, 120)}`;
  }

  // (b) 引擎侧
  let commit = 'OK';
  try {
    await page.goto(target.url, { waitUntil: 'commit', timeout: 10_000 });
  } catch (e) {
    commit = `THROW ${e?.message?.slice(0, 120)}`;
  }
  await page.waitForTimeout(8_000);

  let state = {};
  try {
    state = await page.evaluate(() => ({
      readyState: document.readyState,
      title: document.title,
      html: document.documentElement?.outerHTML?.slice(0, 500) ?? '(no documentElement)',
    }));
  } catch (e) {
    state = { evalErr: e.message };
  }

  ann(
    `probe ${target.name}`,
    `url=${target.url}\nnode.request.status=${nodeStatus}\nengine.commit=${commit}\nreadyState=${state.readyState ?? '?'}\ntitle=${state.title ?? '?'}\nhtml=${state.html ?? state.evalErr ?? '?'}\nevents=${events.slice(0, 12).join(' ;; ') || '(none)'}`,
  );
  await ctx.close();
}

(async () => {
  try {
    ann(
      'proxy-env',
      `http_proxy=${process.env.http_proxy || '(unset)'} https_proxy=${process.env.https_proxy || '(unset)'} no_proxy=${process.env.no_proxy || '(unset)'} HTTP_PROXY=${process.env.HTTP_PROXY || '(unset)'}`,
    );
    const browser = await webkit.launch({ headless: true });
    for (const t of TARGETS) {
      try {
        await probe(browser, t);
      } catch (e) {
        ann(`probe ${t.name} FATAL`, String(e?.message || e));
      }
    }
    await browser.close();
    ann('forensics-done', 'all probes finished');
  } catch (e) {
    ann('forensics-crash', String(e?.message || e));
  }
  process.exit(0);
})();

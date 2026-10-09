/**
 * Wave24 路 3：冷启动分段量化采集脚本（Playwright，非 CI 门禁；门禁见 e2e/wave24-coldstart.spec.ts）。
 *
 * 用法：
 *   node scripts/measure-coldstart.mjs --base http://127.0.0.1:4731 --scenario empty --runs 7 --out before-dev-empty.json
 *   node scripts/measure-coldstart.mjs --base http://127.0.0.1:4731 --scenario heavy --runs 7 --out before-dev-heavy.json
 *
 * 采集方式：
 *  - 同一 browser context 内重复导航（IDB 跨导航保留 = 真实「重开应用」）；
 *  - heavy 场景先经裸 indexedDB 把 2000 块样例写入 docs 表（复刻 buildPerfFixture 的
 *    mindmap-right 双叉树），随后每次导航走真实 bootstrap：listDocs → openDoc 最近文档；
 *  - 每次导航等到 window.__coldStart.report().marks.tti 出现即收报告；
 *  - 输出每次原始报告 + 各段 median/P90。
 *
 * CPU 对齐：脚本整体由外层 `taskset -c 0,1 node ...` 拉起，chromium 子进程继承亲和性。
 */
import { chromium } from '@playwright/test';
/* eslint-disable no-undef -- page.evaluate 回调跑在浏览器上下文（window/indexedDB），
   本文件其余部分跑在 Node；这是一次性采集脚本，不接运行时代码。 */

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const BASE = opt('--base', 'http://127.0.0.1:4731');
const SCENARIO = opt('--scenario', 'empty');
const RUNS = Number(opt('--runs', '7'));
const OUT = opt('--out', '');
const SLOWMO = Number(opt('--slowmo', '0'));

// ── 复刻 e2e/fixtures/sample-doc.ts buildPerfFixture ──────────────────────
function buildHeavyDoc(totalNodes) {
  const now = Date.now();
  let counter = 100000;
  const nid = (p) => `${p}_${counter++}_${now.toString(36)}`;
  const tip = (text) => ({
    format: 'tiptap-json',
    data: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  });
  const nodes = [];
  const edges = [];
  const childrenOf = new Map();
  let ySlot = 0;
  const RANK_X = 340;
  const SLOT_Y = 96;
  const rootId = nid('root');
  nodes.push({ id: rootId, type: 'heading', x: 0, y: 0, width: 240, height: 72, content: tip('root'), parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {} });
  let created = 1;
  const addSubtree = (parentId, depth) => {
    if (created >= totalNodes) return;
    const id = nid('n');
    created += 1;
    nodes.push({ id, type: 'text', x: depth * RANK_X, y: 0, width: 240, height: 72, content: tip(`block ${id}`), parentId: null, pinned: false, locked: false, collapsed: false, tags: [], style: {} });
    edges.push({ id: `e_${parentId}_${id}`, source: parentId, target: id, sourceHandle: 'right', targetHandle: 'left', label: '', directed: true, style: { color: '#60A5FA' } });
    const arr = childrenOf.get(parentId) ?? [];
    arr.push(id);
    childrenOf.set(parentId, arr);
    for (let k = 0; k < 2 && created < totalNodes; k++) addSubtree(id, depth + 1);
  };
  for (let k = 0; k < 3; k++) addSubtree(rootId, 1);
  const assignY = (id) => {
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) {
      const n = nodes.find((x) => x.id === id);
      n.y = ySlot * SLOT_Y;
      ySlot += 1;
      return;
    }
    for (const c of kids) assignY(c);
    const childYs = kids.map((k) => nodes.find((x) => x.id === k).y);
    const n = nodes.find((x) => x.id === id);
    n.y = (Math.min(...childYs) + Math.max(...childYs)) / 2 - n.height / 2;
  };
  assignY(rootId);
  return {
    format: 'knowledge-block-notes',
    version: 4,
    id: 'perf-heavy-2000',
    title: '性能样例-2000',
    board: { createdAt: now - 60_000, updatedAt: now },
    nodes,
    edges,
    tags: [],
    layout: { mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 },
    viewport: { x: 0, y: 0, zoom: 1 },
    page: { size: 'A4', orientation: 'landscape', marginMm: 15, mode: 'tiles', showPageBreak: true, colorMode: 'color', header: true, footer: true, showPageNumbers: true, edgeLabels: true, pageBreaks: [] },
    assetRefs: [],
    links: [],
    sync: { vv: {} },
  };
}

async function seedHeavy(context) {
  const page = await context.newPage();
  await page.goto(BASE);
  // 等应用把 Dexie DB 建起来（__coldStart 在模块 import 即挂）。
  await page.waitForFunction(() => !!window.__coldStart, { timeout: 15_000 });
  await page.waitForTimeout(800);
  const doc = buildHeavyDoc(2000);
  await page.evaluate(async (d) => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('drawpaper-db');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('docs', 'readwrite');
        tx.objectStore('docs').put(d);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, doc);
  await page.close();
  console.error(`[seed] heavy doc (${doc.nodes.length} nodes) written to IDB`);
}

function pct(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[idx];
}
function agg(runs, keyFn) {
  const vals = runs.map(keyFn).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return { n: 0, median: null, p90: null };
  const s = [...vals].sort((a, b) => a - b);
  return { n: vals.length, median: pct(s, 0.5), p90: pct(s, 0.9), min: s[0], max: s[s.length - 1] };
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'], slowMo: SLOWMO });
  const context = await browser.newContext();

  if (SCENARIO === 'heavy') await seedHeavy(context);

  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    // 等 tti mark 出现（轮询）。
    let report = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      report = await page.evaluate(() => window.__coldStart?.report?.() ?? null);
      if (report && report.marks && typeof report.marks.tti === 'number') break;
      await page.waitForTimeout(150);
    }
    if (!report || typeof report.marks?.tti !== 'number') {
      throw new Error(`run ${i}: no tti mark. report=${JSON.stringify(report)}`);
    }
    runs.push(report);
    console.error(`[run ${i + 1}/${RUNS}] tti=${report.marks.tti}ms fcp=${report.fcp} nodes-ish`);
    await page.close();
  }

  // 聚合段：mark 时间戳（相对 timeOrigin）+ measure 时长。
  const markKeys = new Set();
  const measureKeys = new Set();
  for (const r of runs) {
    for (const k of Object.keys(r.marks)) markKeys.add(k);
    for (const k of Object.keys(r.measures)) measureKeys.add(k);
  }
  const table = {};
  for (const k of markKeys) table[`mark:${k}`] = agg(runs, (r) => r.marks[k]);
  for (const k of measureKeys) table[`measure:${k}`] = agg(runs, (r) => r.measures[k]);
  table['derived:render_to_commit'] = agg(runs, (r) => (r.marks['react-commit'] ?? 0) - (r.marks['render-start'] ?? 0));
  table['derived:commit_to_frame'] = agg(runs, (r) => (r.marks['canvas-frame'] ?? 0) - (r.marks['react-commit'] ?? 0));
  table['derived:frame_to_tti'] = agg(runs, (r) => (r.marks['tti'] ?? 0) - (r.marks['canvas-frame'] ?? 0));
  table['nav:domContentLoaded'] = agg(runs, (r) => r.navigation.domContentLoaded);
  table['nav:responseEnd'] = agg(runs, (r) => r.navigation.responseEnd);
  table['nav:transferSize'] = agg(runs, (r) => r.navigation.transferSize);
  table['paint:fcp'] = agg(runs, (r) => r.fcp);
  table['env:swControlled'] = { n: runs.length, yes: runs.filter((r) => r.swControlled).length };

  const out = { base: BASE, scenario: SCENARIO, runs: RUNS, table, raw: runs };
  console.log(JSON.stringify(out, null, 2));
  if (OUT) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.error(`[out] ${OUT}`);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

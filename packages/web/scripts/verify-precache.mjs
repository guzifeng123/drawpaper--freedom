/**
 * Wave5c PWA 离线核查脚本：
 * 解析 dist/sw.js 的 precache 清单，断言构建产物里所有 JS/CSS/字体文件都被预缓存，
 * 确保懒加载 chunk（pdf-lib / html-to-image / katex / highlight）与 KaTeX 字体离线可用。
 * 用法：pnpm build 后 node scripts/verify-precache.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const swPath = join(dist, 'sw.js');

if (!existsSync(swPath)) {
  console.error('✗ dist/sw.js 不存在，请先 pnpm build');
  process.exit(1);
}

const sw = readFileSync(swPath, 'utf8');
// workbox precache manifest：每个条目形如 {"url":"assets/xxx.js","revision":"..."}
const urls = new Set();
const re = /url:"([^"]+)"/g;
let m;
while ((m = re.exec(sw)) !== null) urls.add(m[1]);

// 收集 dist 下需要离线缓存的资源
const assetsDir = join(dist, 'assets');
const onDisk = [];
for (const f of readdirSync(assetsDir)) {
  const ext = extname(f);
  if (['.js', '.css', '.woff2', '.woff', '.ttf'].includes(ext)) {
    onDisk.push('assets/' + f);
  }
}
// 根目录文件
for (const f of readdirSync(dist)) {
  // workbox runtime 本身由 sw.js 直接加载，不进 precache；index.html / registerSW 正常纳入。
  if (f.startsWith('workbox-')) continue;
  if (['.html', '.js'].includes(extname(f)) && f !== 'sw.js') onDisk.push(f);
}

const missing = onDisk.filter((u) => !urls.has(u));
console.log(`precache 清单：${urls.size} 条`);
console.log(`dist 待缓存资源：${onDisk.length} 个（js/css/字体/html）`);

// 关键懒 chunk 必须在清单里
const mustContain = [
  'pdf-lib', 'html-to-image', 'katex', 'highlight', 'index-', 'tiptap-', 'xyflow-', 'react-vendor-',
];
const missingKey = mustContain.filter((k) => ![...urls].some((u) => u.includes(k)));

if (missing.length > 0 || missingKey.length > 0) {
  console.error('✗ precache 不完整：');
  if (missing.length) console.error('  未缓存文件：', missing);
  if (missingKey.length) console.error('  缺关键 chunk：', missingKey);
  process.exit(1);
}
console.log('✓ 全部构建产物（含懒加载 chunk + KaTeX 字体）均在 precache 清单中');

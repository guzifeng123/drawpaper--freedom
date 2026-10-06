import { createDoc, createEdge } from '@drawpaper/core';
import type { KBNoteDoc, BlockNode, Edge } from '@drawpaper/core';

/**
 * Wave13：桌面端首次运行欢迎文档。
 *
 * 触发条件（纯函数 shouldCreateWelcomeDoc 可单测）：
 *  ① 检测到 Tauri 宿主（window.__TAURI__ 存在）；
 *  ② localStorage 无 `drawpaper:welcome-doc-v1` 标记。
 * 两个条件同时满足才创建，并立即写入标记（即便用户随后删掉文档，也不重建）。
 * 浏览器/PWA/e2e 环境无 __TAURI__ → 永不创建（有断言）。
 *
 * 文档走普通 newDoc/loadDoc 流程：可自由删除、不影响任何计数/空状态逻辑——
 * 因为 e2e 跑在浏览器宿主，根本不会创建它。
 */

export const WELCOME_DOC_FLAG = 'drawpaper:welcome-doc-v1';
export const WELCOME_DOC_ID = 'doc_welcome_v1';

/** 纯函数：是否应当创建欢迎文档。 */
export function shouldCreateWelcomeDoc(opts: {
  isTauri: boolean;
  flagSet: boolean;
}): boolean {
  return opts.isTauri && !opts.flagSet;
}

/** duck-type 检测 Tauri 宿主（与 tauri-host 同源，避免循环 import）。 */
export function detectTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/** 读 localStorage 标记（隐私模式可能抛错，兜底 false）。 */
export function readWelcomeFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(WELCOME_DOC_FLAG) === '1';
  } catch {
    return false;
  }
}

/** 写入「已创建」标记（失败静默——最多下次启动再建一次，不阻塞）。 */
export function writeWelcomeFlag(): void {
  try {
    localStorage.setItem(WELCOME_DOC_FLAG, '1');
  } catch {
    /* 隐私模式 / 存储满：忽略 */
  }
}

/** 纯文本 → 合法 tiptap 段落 doc。 */
function paragraphData(text: string): unknown {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function makeBlock(id: string, type: BlockNode['type'], x: number, y: number, text: string): BlockNode {
  return {
    id,
    type,
    x,
    y,
    width: 320,
    height: type === 'heading' ? 48 : 72,
    content: { format: 'tiptap-json', data: paragraphData(text) },
    parentId: null,
    pinned: false,
    locked: false,
    collapsed: false,
    tags: [],
    style: {},
  };
}

/**
 * 构造欢迎文档（确定性 id，内容六项见 agent-hint）。
 * 根块为「快速上手」标题，下挂六条 bullet。
 */
export function buildWelcomeDoc(): KBNoteDoc {
  const doc = createDoc('欢迎使用 drawpaper');
  doc.id = WELCOME_DOC_ID;

  const root = makeBlock('n_welcome_root', 'heading', 0, 0, '快速上手（可自由删除本页）');

  const items: { id: string; text: string }[] = [
    {
      id: 'n_welcome_save',
      text:
        '数据保存位置：浏览器版存在 IndexedDB / OPFS；桌面端存为原生 .kbnote，数据目录在 ' +
        '%APPDATA%\\com.drawpaper.app，日志 logs\\drawpaper.log。',
    },
    {
      id: 'n_welcome_open',
      text: '双击任意 .kbnote 文件即可直接打开本应用编辑（已关联文件类型）。',
    },
    {
      id: 'n_welcome_keys',
      text:
        '常用快捷键：双击空白建块、Tab 建子块、Alt+方向键在块间导航、' +
        'Ctrl+F 搜索、Ctrl+Shift+S 另存为、Ctrl+P 打印 / 另存 PDF。',
    },
    {
      id: 'n_welcome_sync',
      text: '同步文件夹 / WebDAV / 端到端加密（E2EE）：在「设置 → 同步」里配置。',
    },
    {
      id: 'n_welcome_smartscreen',
      text:
        'Windows SmartScreen 提示「未发布的未知应用」：本安装包未做代码签名，' +
        '点「更多信息 → 仍要运行」即可，来源可信时放心安装。',
    },
    {
      id: 'n_welcome_update',
      text: '检查更新：在顶部菜单「帮助 → 检查更新」打开 Releases 页面（仅点击时联网一次）。',
    },
  ];

  const nodes: BlockNode[] = [root];
  const edges: Edge[] = [];
  items.forEach((item, i) => {
    const child = makeBlock(item.id, 'bullet', 360, i * 110 - 250, item.text);
    child.parentId = root.id;
    nodes.push(child);
    edges.push(createEdge(root.id, child.id));
  });

  doc.nodes = nodes;
  doc.edges = edges;
  doc.viewport = { x: 120, y: 260, zoom: 0.9 };
  return doc;
}

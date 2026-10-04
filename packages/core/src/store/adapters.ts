import type { KBNoteDoc } from '../model/index.js';

/**
 * 平台适配器接口（core 只定义类型，由 web / Tauri 各端实现）。
 * 这是「core 零 DOM、三端复用」的接缝：core 不直接碰 IndexedDB / 窗口 / 打印。
 */

/**
 * 跨端 Blob 抽象（core 不引用 DOM 类型，故 duck-type 一个最小形状；
 * web 侧浏览器原生 Blob、Tauri 侧 Rust 侧都可满足此结构）。
 */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number): BlobLike;
}

// ============ StorageAdapter：本地文档与 Blob 存储 ============

/** 文档元信息（列表用）。 */
export interface DocMeta {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
}

export interface StorageAdapter {
  /** 保存/覆盖整份文档（自动保存防抖 500ms 由调用方控制）。 */
  saveDoc(doc: KBNoteDoc): Promise<void>;
  /** 按 id 加载文档；不存在返回 null。 */
  loadDoc(id: string): Promise<KBNoteDoc | null>;
  /** 列出全部文档元信息（按 updatedAt 倒序）。 */
  listDocs(): Promise<DocMeta[]>;
  /** 删除文档及其索引（附件 Blob 由调用方单独清理）。 */
  deleteDoc(id: string): Promise<void>;

  /** 读取附件 Blob（OPFS）。 */
  getAsset(assetRef: string): Promise<BlobLike | null>;
  /** 写入附件 Blob，返回引用 id。 */
  putAsset(blob: BlobLike): Promise<{ assetRef: string }>;
  /** 删除附件 Blob。 */
  deleteAsset(assetRef: string): Promise<void>;
}

// ============ HostAdapter：平台外壳能力（文件选择/打印/分享）============

/** showOpenFilePicker 等 File System Access API 的最小形状（web 不支持时降级）。 */
export interface OpenFileResult {
  /** 文件名（含 .kbnote）。 */
  name: string;
  text: string;
}

export interface HostAdapter {
  /** 弹出系统打开文件框，读取 .kbnote 文本。不支持时 resolve 为 null（web 降级为 <input type=file>）。 */
  showOpenFilePicker(): Promise<OpenFileResult | null>;
  /** 弹出保存文件框，把文本落盘为 .kbnote。不支持时触发下载。 */
  showSaveFilePicker(filename: string, text: string): Promise<void>;
  /** 触发系统打印（另存为 PDF）。 */
  print(): void;
  /** 分享（Web Share / Tauri 分享）。 */
  share?(payload: { title: string; text?: string; file?: BlobLike }): Promise<void>;
}

// ============ AIProvider（P1，接口先行，零后端）============

/** OpenAI 兼容 chat.completions 请求形状（用户自配 endpoint + key）。 */
export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIChatRequest {
  endpoint: string;
  apiKey: string;
  model: string;
  messages: AIChatMessage[];
  /** 要求模型输出 JSON。 */
  responseFormat?: 'json';
  temperature?: number;
}

export interface AIChatResponse {
  content: string;
}

export interface AIProvider {
  chat(req: AIChatRequest): Promise<AIChatResponse>;
}

/** AI 给出的「建议」：新增父子边 / 建议根 / 分组 / 拆块。Schema 校验后才进入 diff。 */
export interface AISuggestion {
  type: 'add-edge' | 'set-root' | 'group' | 'split-block' | 'summarize';
  /** 建议涉及的节点 id（已知的）。 */
  nodeIds?: string[];
  /** 建议新增的边（source→target）。 */
  proposedEdges?: Array<{ source: string; target: string; label?: string }>;
  /** 自然语言说明（UI 展示用）。 */
  reason: string;
}

/** AI diff：一组待用户逐条勾选的建议。 */
export interface AIDiff {
  suggestions: AISuggestion[];
}

/**
 * 把用户确认（勾选）的建议应用回文档，返回新文档。
 * 未勾选的建议丢弃；非法建议在应用前再次校验。
 * 【TODO wave1-c / P1】
 */
export function applyAIDiff(
  _doc: KBNoteDoc,
  _diff: AIDiff,
  _accepted: ReadonlySet<number>,
): KBNoteDoc {
  throw new Error('not implemented: P1 (applyAIDiff)');
}

// ============ CollabAdapter（P3 预留，空接口）============
/**
 * Yjs/CRDT 协作预留。本期不实现、不安装 yjs。
 * 仅固定接口形态：未来把文档层拆成独立记录后接入。
 */
export interface CollabAdapter {
  readonly docId: string;
  /** 连接/断开（未来）。 */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

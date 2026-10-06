// @drawpaper/core 顶层 barrel。
export * from './model/index.js';
export * from './links/index.js';
export * from './graph/index.js';
export * from './layout/index.js';
export * from './paginate/index.js';
// 大规模文档渐进水化：可见区间判定 / buffer / 分批计划 / 占位摘要（纯函数零 DOM）。
export * from './hydration/index.js';
export * from './serialize/index.js';
export * from './store/index.js';
// 同浏览器多标签实时协作协议（Wave9 阶段 A：纯类型 + 纯函数 + 单测，传输层在 web）。
export * from './collab/index.js';
// 跨设备同步合并内核（Wave10 阶段 A：快照级 LWW 合并 / schema v3 元数据 / manifest 差异）。
export * from './sync/index.js';
// AI 纯逻辑（与 store/adapters 的 AIProvider 接口配合；类型名刻意与 adapters 的
// 宽松 AISuggestion 区分：这里是校验过的判别联合 AiSuggestion）。
export * from './ai/index.js';
// 跨文档全局知识图谱总览（聚合/折叠展开/采样/轻量布局/搜索，纯函数零 DOM）。
export * from './overview/index.js';

// sync 模块 barrel：跨设备同步合并内核（Wave10 阶段 A，契约冻结版）。
// 纯 TS、零 DOM/React/宿主 API；阶段 B（WebDAV/FSA 传输通道）按此导出实现。
export * from './types.js';
export * from './migrate.js';
export * from './clock-floor.js';
export * from './merge.js';
export * from './manifest.js';
export * from './prune.js';

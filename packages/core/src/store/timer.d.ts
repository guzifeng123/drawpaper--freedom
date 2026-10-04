/**
 * core 零 DOM、tsconfig lib 仅 ES2022、types 为空——因此全局 `setTimeout/clearTimeout`
 * 没有类型。二者在 Node（vitest）与浏览器运行时都天然存在，这里补一份最小 ambient 声明，
 * 供 store 的自动保存防抖使用。只声明核心两参形式，handle 不透明（视为 number）。
 */
declare function setTimeout(handler: () => void, ms: number): number;
declare function clearTimeout(handle: number | undefined): void;

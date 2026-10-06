# Wave14 · D 路：触屏长按空白菜单 + 同浏览器协作状态持久化

本路（D）在 drawpaper--freedom monorepo 完成两项 web/core 增强，与 A/B/C/E 路并行，
文件隔离见文末红线。范围严格收敛。

## 任务一（#6）：触屏长按空白处上下文菜单

### 共享实现方式
- 新增 `packages/web/src/editor/canvas/PaneContextMenu.tsx`：一个**受控**弹出菜单，
  菜单项 = 新建文本块 / 粘贴 / 适应屏幕；分页预览模式额外「在此插入分页符」。
  菜单项按钮 `h-11`（≥44px 触控热区），outside-pointerdown / Esc 关闭。
- 鼠标右键（原生 `contextmenu`，capture）与触屏长按（自包含 pointer 手势）**都只是在屏幕坐标
  调 `openPaneMenuAt(clientX, clientY)`**，共用这一个菜单组件与同一组动作回调。
  不存在第二套菜单渲染逻辑。

### 触屏长按消费
- 在画布 wrap 上挂原生 `pointerdown/pointermove/pointerup/pointercancel`（capture）：
  仅 `pointerType === 'touch'` 起 500ms 定时器；移动 >8px 取消（退化为 RF 原生平移）；
  静止到点且命中目标为**空白 pane** → `navigator.vibrate(15)`（与 ConnectHandle 同时序/同反馈）
  + 弹菜单。
- **target 判定**（与原右键 `onCtx` 完全一致）：命中 `.react-flow__node` /
  `.react-flow__edgelabel-renderer` / `.react-flow__edge` / `[data-testid^="edge-bend"]`
  任一即不弹空白菜单（块长按归 ConnectHandle 连线，边浮层有自己的交互）。
- 长按后手指抬起无位移 → 不触发平移（RF 仅在 touchmove 时 pan）；菜单由 pointerup 不会被关掉，
  下次任意 pointerdown 才关。

### 鼠标路径
- 右键菜单的触发条件（preventDefault + target 排除）保持原样；区别是右键不再弹
  `window.confirm`，而是与触屏共用这个真菜单（菜单项即原 confirm 的两个动作 + 粘贴/适应屏幕）。
  无既有鼠标 e2e 依赖 confirm 对话框（基线右键无 spec）。

## 任务二（#8）：协作状态持久化 + 寄存器并集（严格收敛）

### CollabState 持久化落点与格式
- **独立 IndexedDB 数据库** `drawpaper-collab-persist-v1`（见 `web/src/collab/collab-persist.ts`），
  表 `meta`，主键 = `docId`。**刻意不动** `storage/db.ts` 的 docs 表、不动 `src/sync/**`。
- 只序列化协作**元数据**（`packages/core/src/collab/persist.ts` 的
  `serializeCollabMeta` / `hydrateCollabMeta`）：`vv` / `nodeMeta` / `edgeMeta` /
  `docFields` / `pageFields` / `regMeta` / `appliedOpIds` / `log` / 本端 `clockValue`。
  **doc 本体不落这里**——doc 仍由文档主存储通道（Dexie docs / .kbnote）负责。
- **与 sync v3 如何隔离**：这是同浏览器 collab 运行时水位，物理上是独立 IndexedDB 库，
  不写进 .kbnote、不进 sync 目录、不碰 `doc.sync.vv`。跨设备 `mergeSnapshots` 永远看不到这些字段，
  不污染同步契约。
- **旧文档兼容**：无该元数据行 / 结构损坏 / 版本不符 → `hydrateCollabMeta` 返回 `null`，
  `CollabManager` 回退 `createCollabState(doc)` 的 lamport=0 播种（现状行为不变）。
- `CollabManager.setupSession` 启动时 `await loadCollabMeta` → 命中则重建时钟水位 + 覆盖
  字段时钟/寄存器墓碑/vv；本地 op / 远端 op / snapshot 对齐 / compact 后防抖 400ms 落盘，
  换文档与卸载前 flush。

### 寄存器并集语义（tags / edge.points / page.pageBreaks）
- 新增 CollabOp：`reg-add` / `reg-remove`（`core/collab/ops.ts`）。`doc-diff.ts` 对这三个数组
  **不再整体 LWW 覆盖**，而是按元素身份差量成 reg-add（并集）/ reg-remove（墓碑）。
- 元素身份 key：tags=`t:<tagId>`，pageBreaks=`b:<id>`，points=`p:<round(x)>,<round(y)>`。
- 合并引擎（`core/collab/merge.ts`）：`reg-add` 把元素并入 doc 数组（同 key 去重），
  被墓碑压住的旧 add 不复活；`reg-remove` 按 key 删除元素并写 `regMeta.removes` 墓碑。
- **删除以墓碑为准**：`removes[key]` 记录删除定位；只有更晚 lamport 的重新 add 才可复活
  （LWW-remove / OR-set），早于墓碑的旧 add 不复活——防止「并集导致删不掉」。
- `applySnapshot` 换基线时按基线当前数组播种 adds；`compactCollabState` 按 watermark 裁剪
  过期 remove 墓碑。

### reload 双标签 e2e 证据
- `packages/web/e2e/collab-persist.spec.ts`：A/B 协作 → B 抬高块坐标水位 → A/B 并发打不同 tag
  （并集 [tagA, tagB]）→ A `page.reload()` 后元数据恢复 → A 继续移动块到 x=800 → B 侧看到
  x=800（证明无 lamport 回退覆盖），冲突横幅为 0。

## 明确不做（遗留）
- **周期性 compactCollabState 自动调度**：现有 `COMPACT_INTERVAL_MS` 定时器保持原样，
  本路不引入新的自动 compact 调度策略。
- **远端 op 进入本地 undo 栈**：保持 undo/redo 仅本地手势，远端合并走 `applyRemoteDoc`，
  不进 undo 栈。

## 红线自检
- 仅碰 `packages/core/src/collab/**`（含其测试）、`packages/web/src/editor/**`、
  `packages/web/src/collab/**`、`packages/web/e2e/**`（触屏/协作相关）、
  `packages/web/src/wiring/dev-hooks.ts`（仅白名单加两个 e2e action）、`docs/wave14/**`、`CHANGELOG.md`。
- 未碰 `packages/core/src/sync/**`、`packages/web/src/sync/**`、`apps/**`、
  `packages/web/src/export/**`、`.github/**`；未改任何版本号字段；未建/推 tag。

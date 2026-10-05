# Wave6b · 画布 P2：边弯折点 / 文件拖入建块 / 触屏 target 长按入连

> 分支 `feat/p2-canvas-advanced`（基于 develop ddefa21，schema v2 Edge.points 已落地）。

---

## 1. 边手动弯折点

### 数据模型
- 复用 schema v2 `Edge.points?: Array<{x,y}>`（世界坐标、按 source→target 顺序、≤64、缺省/空=贝塞尔）。
- 持久化走可撤销命令：core store 新增 `setEdgePoints(id, points)`（`runCommand`，undo 还原旧 points，空数组=恢复贝塞尔）。editor-api/mock/create-editor-api 同步追加。

### 几何算法（`editor/edges/edge-geometry.ts`，纯函数、单测 8 例）
- `buildEdgePath(source, target, points?)`：
  - 无 points/空 → 三次贝塞尔（端点切向随 source/targetHandle 朝向，与 RF getBezierPath 视觉一致）。
  - 有 points → source 经贝塞尔平滑入第一个弯折点 → 中间逐点折线 → 末点经贝塞尔平滑入 target；箭头仍在 target。
- `edgeRectIntersections(source, target, points, rect)`：折线各段与页矩形求交（用于跨页续接，纯几何）。
- 单测：无 points 贝塞尔、空数组等价、多点 path、忽略非有限点、中点、直线穿矩形两交点、折线绕矩形 0 交点、弯折进入矩形。

### 交互（`ParentEdge.tsx`）
- 选中边时：中点出现拖拽手柄（无 points 时拖出第一个弯折点）；已有弯折点逐点显示为蓝色圆点手柄。
- 拖动：pointerdown 捕获→实时预览 path→松手 `api.setEdgePoints` commit（可撤销）。
- 双击锚点 = 删除该点；锚点激活态按 Delete/Backspace = 清空全部弯折点恢复贝塞尔（与「选中边本体 Delete=删边」区分）。

### 导出同步
- `svg-export.ts` 与 `PrintSheets.tsx` 均改用 `buildEdgePath`；世界坐标弯折点按 source 节点世界→页本地偏移换算后渲染。
- 单测断言：svg 含页本地弯折坐标（世界点 (200,200) 经 delta (60,60) → path 含 "260 260"）。
- 跨页续接（已补完）：core `paginate/edge-crossing.ts` 逐段把 source 锚点→points→target 锚点折线归属到页；同页段 edgeId 压入整段绘制，跨页段成对 marker，token=`cont:<edgeId>:<seg>`（按段编号），peerPageIndex 互指相邻页；`finalizePages` 保留含 marker 的中间页（无 points 边零回归）。

## 2. 桌面端文件拖入画布（`editor/canvas/drop-classify.ts` + CanvasEditor）
- pane `dragover/drop`：阻止默认导航；拖入整画布 ring 高亮。
- 分类纯函数（单测 5 例）：`.txt/.md/.markdown`→文本块（读文本按行成 Tiptap doc 段落）；图片（image/* 或图片扩展名）→图片块（readAsDataURL→addImageBlock）；其他已知类型→附件块（`putImageAsset` OPFS，不可用 toast「当前浏览器不支持附件本地存储」不建坏块）；无扩展名→unsupported 不建块。
- 多文件按 `dropOffset(i)` 错位排列。
- e2e：DataTransfer 拖入 txt → 节点数 +1 且文本含内容。

## 3. 触屏 target 长按入连（`ConnectHandle.tsx`）
- 复用 Wave5b source 长按状态机，对称扩展 target 点（左/上）：长按 500ms（vibrate、蓝色虚线跟随）→ 以本节点为预定 target → 手指拖到某 source 块松手 → `addEdge(source=拖到节点, target=长按节点)`；拖到空白=取消（不建块）。
- BlockShell 左/上 handle 由裸 RF `<Handle>` 换为 `TargetHandles`（≥44px 热区由 editor-theme 保证）。鼠标行为不变。
- e2e：长按 B 左点 → 拖到 A 松手 → 边数 +1 且方向 source=A、target=B。

## 4. 测试清单
- 单测新增：edge-geometry 8 + drop-classify 5 + svg-export 弯折断言（共 web 178→191）；core 140（+setEdgePoints 可撤销）。
- e2e 新增 `e2e/canvas-advanced.spec.ts` 3 例：弯折点持久化+undo、txt 拖入建块、target 长按入连。

## 5. CSS 变量
- 沿用既有 `--editor-grid`；弯折手柄用 shadcn/tailwind 蓝色，未新增硬编码色。

## 6. 遗留
- 中间跨页页沿用既有「成对圆圈」续接样式，未重绘跨页连线线段（与无弯折跨页边一致）。
- 图片拖入走 dataURL 内联，OPFS 资产压缩管线对图片的接入留后续。
- 弯折点框选多锚点、Ctrl 多选删点未做。

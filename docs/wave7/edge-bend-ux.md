# P2.1 边手动弯折点交互打磨

> 分支：`feat/p21-edge-bend-ux` ｜ Wave7 打磨项
> 目标：让用户可以手动弯折父子边，增删锚点随块移动，并与分页 / 导出 / 打印保持一致。

## 1. 交互总览

| 操作 | 行为 | 撤销 |
| --- | --- | --- |
| 双击边路径（非锚点的路径区域） | 在光标世界坐标处插入一个弯折点，走 `setEdgePoints` | 可撤销 |
| 选中边后拖动中点手柄 | 从贝塞尔边拖出第一个弯折点（既有交互保留） | 可撤销 |
| 拖动已有锚点 | 改位该弯折点 | 松手后落库，可撤销 |
| 选中单个锚点后按 Delete / Backspace | **只删除该锚点**（不再清空全部弯折） | 可撤销 |
| 边被选中但未选中锚点时按 Delete | 删除整条边（RF 原生，既有行为不回退） | 可撤销 |
| 多选边（Ctrl/⌘ 点选）后点浮动工具条「清除弯折」 | 对每条选中边 `setEdgePoints([])`，合并为一次可撤销宏 | 一次 undo 恢复全部 |
| 右键锚点 | 弹出小菜单：「删除此弯折点」/「取消」 | 可撤销 |
| `points` 为空数组 | 边自动恢复为贝塞尔曲线 | — |

## 2. 数据模型

- `Edge.points?: { x: number; y: number }[]`（schema v2，≤64 个有限坐标）。
- 空数组 / `undefined` = 贝塞尔曲线；非空 = 平滑入 + 折线出。
- core `store.setEdgePoints(edgeId, points)`：可撤销命令，空数组 = 恢复贝塞尔。
- core `store.clearEdgesPoints(edgeIds)`：宏命令，对每条边依次 `setEdgePoints([])`，合并为一个撤销单元。

## 3. 弯折点随块移动规则（确定性）

弯折点存储在**世界坐标**下，不绑定到端点局部。拖动连接的源/目标块时：

- **只动 source 块**：该边所有弯折点按 source 节点位移平移 `(dx, dy)`。
- **只动 target 块**：该边所有弯折点按 target 节点位移平移 `(dx, dy)`。
- **两端都动**（一次拖动只动一个端点，正常使用不会同时动两端；若通过批量命令同时移动两端）：弯折点按 **source 位移**平移一次；target 位移不再重复叠加。规则：以 source 为基准，避免双重平移导致弯折点漂移。

实现位置：`packages/core/src/store/store.ts` 的 `moveNode`——遍历该节点的出/入边，对 `edge.points` 逐点加 `(dx, dy)`。

## 4. 导出与分页一致性

弯折点是世界坐标点，与块/边共享同一坐标系：

- **SVG 导出**（`svg-export.ts`）与 **PrintSheets** 共用 `buildEdgePath`。世界坐标弯折点按 source 节点偏移换算到页本地坐标，再生成 `<path>`。
- **分页续接**（`paginate/edge-crossing.ts`）：`planBentEdgeSegments` 把折线逐段穿页，箭头 marker 按段配对，续接页保留完整。
- **矢量 PDF**：走 PrintSheets 同一路径，弯折坐标与屏幕一致。

回归断言（`e2e/p21-edge-bend.spec.ts`）：
- 移动 source 块后导出 SVG，弯折路径仍包含正确的弯折坐标（与移动后的世界坐标一致）。
- 分页 marker 成对性不破坏（既有 edge-crossing 单测 + e2e 覆盖）。

## 5. 热区与触屏

- 锚点命中区域 **24×24px**（外层 `h-6 w-6` flex 居中），视觉圆点 14px。
- 中点手柄同样 24px 热区。
- 不影响 Wave5/6 已有的触屏长按起连线与粗指针工具：锚点容器 `pointer-events-none`，单个手柄 `pointer-events-auto`；右键/长按 `onHandlePointerDown` 对 `button===2` 直接 return，不阻止默认 contextmenu。

## 6. 纯函数与单测

`packages/web/src/editor/edges/edge-geometry.ts` 新增：

- `distToSegment(p, a, b)`：点到线段距离。
- `insertBendPoint(points, clickWorld, s, t)`：在路径上找最近点，插入弯折点，返回新数组。
- `removeBendPoint(points, index)`：删第 index 个弯折点。
- `translateBendPoints(points, dx, dy)`：批量平移。

单测：edge-geometry 8 → 17 例；core store 10 → 14 例（source 平移 / target 不动 / 两端同移不重复 / clearEdgesPoints 宏一次 undo）。

## 7. E2E

`e2e/p21-edge-bend.spec.ts`（E2E_PORT=4183）：

1. 双击边路径 → points 长度 +1。
2. 选中锚点 Delete → 只少一个点。
3. 多选两条边 → 一键清空 → 两条都恢复贝塞尔 → undo 一次恢复。
4. 右键锚点 → 菜单删除此弯折点。
5. 移动 source 块后导出 SVG → 仍含正确弯折路径。

## 8. 已知设计取舍

- 右键菜单用模块级单例（`bend-menu.ts`）存储，避免 ReactFlow 边组件重挂载导致本地 state 丢失。
- 双击加点挂在 wrap div 的原生 `dblclick` capture 监听（RF 的 `onEdgeDoubleClick` prop 实测不触发）。
- 边色板浮层 / 锚点浮层上的右键不触发「在此新建块」（`onCtx` 跳过 `.react-flow__edgelabel-renderer`）。

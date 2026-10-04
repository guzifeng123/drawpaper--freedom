# Wave3-H：大纲双向联动 / 标签筛选 / 模板·快照·回收站 / 深色模式（P1）

> 所有者：Wave3-H。分支 `feat/p1-panels-outline-tags`。
> 范围：`packages/web/src/panels/`、`packages/web/src/index.css`、`packages/web/index.html`（防闪烁内联脚本）、
> `packages/web/src/wiring/create-panels-api.ts`（仅为接口自洽的最小桩，见 §6）。
> 未动：editor / export / storage / host / store / ai / core / App.tsx / tailwind.config.ts（`darkMode:'class'` develop 已开）。

## 1. 组件清单（`src/panels/`）

| 文件 | 说明 |
|---|---|
| `panels-api.ts` | PanelsApi 结构型接口扩展（见 §2） |
| `create-mock-panels-api.ts` | 内存假实现：标签表、筛选态、快照、回收站、活动文件名、reparent/addChild 等全部可交互改写 |
| `OutlinePanel.tsx` | 左侧大纲（§4.7）：core `buildMainTree` 渲染可折叠树；游离块入「未分组」；选中高亮滚动可见；悬停/点击 → `flyToNode`；折叠 chevron ↔ 节点 `collapsed`；指针拖拽手柄改缩进 = reparent；行尾「+」/根级按钮内联建块；顶部过滤框 |
| `lib/outline-dnd.ts` | 拖拽落点纯函数：`canReparent` / `resolveReparentTarget` / `positionFromPointerRatio` / `isInSubtree` |
| `TagFilterBar.tsx` | 标签筛选条（§4.8）：chip 切换、任一/全部语义切换、清除 |
| `TagManagerDialog.tsx` | 全局标签管理：新建（名 + 8 色板 + 自定义 hex）、双击改名、行内迷你色板改色、删除确认 |
| `lib/tag-filter.ts` | `nodeMatchesFilter` 纯逻辑 + 8 色板 `TAG_SWATCHES` |
| `TemplatesDialog.tsx` | 6 份模板卡片（读书笔记/会议纪要/课程大纲/头脑风暴/知识体系/项目拆解） |
| `lib/templates.ts` | 模板静态元数据（id/名/简介/图标） |
| `SnapshotsDialog.tsx` | 快照列表（label/时间/文档标题）、手动拍快照、恢复确认、删除单条 |
| `TrashDialog.tsx` | 回收站列表、恢复、彻底删除确认、清空确认 |
| `TopToolbar.tsx` | 新增：活动文件状态文案、文档菜单（从模板新建/打开本地/另存为/快照历史/回收站）、主题三态切换、聚焦分支按钮、标签管理入口；`bg-white` → `bg-card` 暗色适配 |
| `lib/theme.ts` | 主题 zustand store：light/dark/system、localStorage 持久化、`.dark` class 切换、system 跟随 `matchMedia` |
| `lib/toast.tsx` | `bg-white` → `bg-card`（暗色适配） |

## 2. PanelsApi 新增签名（§2 完整冻结，组件只依赖此接口）

```ts
// 标签表
tags: Tag[];
createTag(name, color): void;
renameTag(id, name): void;
changeTagColor(id, color): void;
deleteTag(id): void;            // 同时从所有节点摘除

// 标签筛选
tagFilter: TagFilterState;     // { tagIds: string[]; blockTypes: BlockType[]; colors: string[]; match: 'any'|'all' }
setTagFilter(patch: Partial<TagFilterState>): void;
clearTagFilter(): void;

// 大纲
toggleCollapseNode(id): void;
reparentNode(nodeId, newParentId: string|null, index): void;  // newParentId=null=根级
addChildBlock(parentId: string|null, text): string;
addSiblingBlock(afterNodeId, text): string;

// 聚焦分支
focusNodeId: string|null;
setFocusNode(id: string|null): void;

// 活动本地文件
activeFile: { name: string|null };
openLocalFile(): void;         // File System Access；不支持浏览器降级上传导入
saveAsLocalFile(): void;

// 模板 / 快照 / 回收站
createDocFromTemplate(templateId): void;
snapshots: SnapshotInfo[];     // { id, at, label, docTitle }
takeSnapshot(label?): void;
restoreSnapshot(id): void;      // 实现方须自动留「恢复前」快照支持反悔
deleteSnapshot(id): void;
trash: TrashItem[];             // { id, title, deletedAt, kind: 'doc'|'snapshot' }
restoreFromTrash(id): void;
purgeFromTrash(id): void;
emptyTrash(): void;
```

## 3. 需要编辑器 agent / 总装配合的接线清单

### 3.1 画布视觉消费（editor 目录，不归 H）
- **标签筛选下发**：`api.tagFilter` 变化后，画布按 `lib/tag-filter.ts` 的 `nodeMatchesFilter` 语义
  （空筛选=全显；三维度 AND；标签内 any/all）：**非匹配节点 opacity ≈ 0.35、其连线隐藏**；匹配节点正常。
- **聚焦分支**：`api.focusNodeId` 非空时，画布只渲染该子树（`core.enumerateSubtree`），其余淡化/隐藏；
  `setFocusNode(null)` 恢复。工具栏「聚焦此分支」在恰好选中 1 块时出现，「聚焦中」徽章可取消。
- **大纲联动**：`selectedNodeIds` 变化 → 大纲高亮（已实现）；大纲 `flyToNode` 复用既有 lastFocus 飞块。
- **右键菜单**：建议加「聚焦此分支」条目调 `api.setFocusNode(nodeId)`（工具栏入口已给）。

### 3.2 需要编辑器替换为 CSS 变量的颜色清单（index.css 已定义 light/dark 双值）

| 变量 | 浅色值（现硬编码） | 用途 |
|---|---|---|
| `--canvas-bg` | `hsl(210 40% 98%)`（#f8fafc） | 画布底色（`.react-flow` 已切变量） |
| `--canvas-grid-dot` | 点阵灰 | React Flow `backgroundColor` 点阵 |
| `--node-bg` | `#fff` | 块白底 BlockShell |
| `--node-border` | slate-200 | 块边框 |
| `--node-text` / `--node-muted` | slate-900 / slate-500 | 块正文 / 次要文字 |
| `--note-yellow` | yellow-100 | 便签默认色 |
| `--edge-color` | `#94A3B8` | 连线默认色 |
| `--edge-label-bg` | `#fff` | 边标签气泡底 |
| `--selection-ring` | slate-900 | 选中框环色 |

使用方式：`background: hsl(var(--node-bg))`。深色值已在 `.dark` 同步给出（同色相 slate、低饱和低明度）。

### 3.3 存储 agent / Wave4 接线桩（wiring/create-panels-api.ts）
本分支为保证 `tsc` 自洽，在适配层补了最小桩：`tags` 直读 `doc.tags`、`toggleCollapseNode` 直接已有
`store.toggleCollapse`，其余（reparentNode / 标签 CRUD / setTagFilter / 快照 / 回收站 / 模板 /
活动文件 / setFocusNode / addChild*）为 no-op 或空 getter。**真实 store 动作落地后，请在此替换为
store action 调用**；组件与 mock 已按 §2 签名就绪。

## 4. 深色模式实现

- `tailwind.config.ts`：`darkMode:'class'` develop 已开，未改。
- `index.css`：`:root` 补 12 个画布/节点/边视觉变量；`.dark` 全套 shadcn 变量（同 slate 色相、低饱和）+
  画布变量暗色值；`.react-flow` 底色切 `hsl(var(--canvas-bg))`。
- `index.html`：`<head>` 加 9 行内联脚本，React 挂载前同步读 `localStorage['drawpaper-theme']`
  决定 `<html>` 是否加 `.dark` —— **首屏无闪烁**（key 与 `lib/theme.ts` 一致）。
- `lib/theme.ts`：三态切换持久化；system 模式监听 `prefers-color-scheme`；模块首次 import 幂等 apply。
- panels 自身：TopToolbar / DocsListPanel / SearchPanel / Toaster 硬编码 `bg-white` 全部切 `bg-card` 变量。

## 5. 测试清单（vitest + testing-library，jsdom）

| 文件 | 覆盖 |
|---|---|
| `lib/outline-dnd.test.ts` | 自拖/后代落点非法；child/before/after 解析；根级 newParent=null；指针三带 |
| `lib/tag-filter.test.ts` | 空筛选全过；any/all；类型；颜色大小写；多维度 AND |
| `lib/theme.test.ts` | class 切换 + localStorage 持久化；system resolved；首屏恢复（fake matchMedia） |
| `OutlinePanel.test.tsx` | 树渲染 + 未分组分区；点击→flyToNode；chevron→toggleCollapseNode；过滤；根级内联建块 |
| `TagFilterBar.test.tsx` | 空态不渲染；chip→setTagFilter；清除；任一/全部切换 |
| `TagManagerDialog.test.tsx` | 列表渲染；新建→createTag；删除确认→deleteTag；色板→changeTagColor |
| `TemplatesDialog.test.tsx` | 6 卡片；点击→createDocFromTemplate(id) |
| `SnapshotsDialog.test.tsx` | 列表；拍快照带 label；恢复确认→restoreSnapshot；删除单条 |
| `TrashDialog.test.tsx` | 空态；恢复；彻底删除确认；清空确认→emptyTrash |

所有新组件 `React.memo`；空态（无文档/无节点/无标签/无快照/回收站空）均已覆盖。

## 6. 越界改动说明（显式列出）

1. `packages/web/index.html`：仅新增主题防闪烁内联脚本（§4），无其它改动。
2. `packages/web/src/wiring/create-panels-api.ts`：+45 行最小桩（§3.3），只为本分支 `tsc --noEmit` 自洽；
   无业务逻辑，Wave4 总装时由存储 agent 动作替换。
3. `tailwind.config.ts`：**未改**（`darkMode:['class']` develop 已具备）。

## 7. 遗留 / 已知缺口

- 大纲拖拽为指针事件自研（非 HTML5 DnD）， guide line 三态（上 before / 下 after / 中 child）；
  index 落点在同层重排序未接 store 的顺序语义（store reparentNode 先接线父子关系，同层顺序后续补）。
- 大纲悬停即 `flyToNode` 会随鼠标扫过连续触发相机移动；总装时可在 lastFocus 侧做 150ms 节流。
- 标签颜色筛选（`filter.colors`）UI 未做色板按钮（P1 只接了 API 与纯函数），块类型筛选同；TagFilterBar 当前暴露标签 chip。
- 右键菜单「聚焦此分支」入口在工具栏已给，画布右键条目待 editor agent 加。
- 未新增任何依赖。

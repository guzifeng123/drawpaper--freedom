# Wave 9 · 无障碍与键盘流打磨

> 分支 `feat/a11y-keyboard`（基于 develop 4d8009f）。与协作任务时间独立。
> 原则：改动温和，不破坏现有视觉、深色模式与 60fps；不引新依赖；core 零 DOM/React。

## 1. 语义角色选择理由

| 位置 | 选择 | 理由 |
|---|---|---|
| 画布容器 | `role="application"` + `aria-label="画布"` | 整个画布是一个自包含的交互 widget（无限平移/缩放/块编辑），application 角色告诉屏幕阅读器「这里面的方向键不滚动页面，由应用自己处理」。不嵌套在 document 角色里。 |
| 块节点外壳 | `role="article"` + `aria-label="<块类型>：<前 60 字摘要>"` | **没有用 tree/treeitem**。块在 RF 里是自由绝对定位的（横/纵思维导图、组织树、放射四种布局），RF 不托管 tree 语义（aria-level / aria-expanded / aria-posinset 都没有真实来源）。伪 tree 会让 SR 用户听到与视觉不符的「层级位置」。article 是中性语义：它是画布上一个有边界、有标题的「文章」。父子关系不通过 tree 角色表达，而通过 Alt+方向键导航 + 块工具条「父子关系」菜单暴露。 |
| 块内编辑态 | Tiptap ProseMirror 原生 contenteditable | 编辑中块外壳 `tabIndex=-1`，键盘焦点交给 ProseMirror，避免双层 Tab 停点。 |
| 工具条图标按钮 | `aria-label`（中文）+ `aria-pressed`（工具模式开关） | 原来只有 `title`，SR 读不出图标含义。 |
| 缩放控件 | `aria-label`（缩小/放大/适应屏幕/实际大小） | 纯符号按钮（− / + / % / 1:1）。 |
| 粗指针工具组（触屏） | `aria-label` + `aria-pressed` | 同工具条。 |

## 2. 快捷键清单（完整）

> 规划文档（融合规划方案 §4.6）已约定的不重复列；本波新增/补全的用 **★** 标出。

| 键 | 作用 | 备注 |
|---|---|---|
| `Enter` | 选中块 = 新建同级块；**无选中 = 在视口中心建根块并进编辑** | ★ 无选中分支为本波新增（纯键盘建块入口） |
| `Tab` | 选中块 = 新建子块并连父子边 | 规划文档约定 |
| `Shift+Tab` | 选中块 = 升级（移出父级） | 规划文档约定 |
| `Esc` | 编辑中 → 退出编辑仍选中；选中 → 清空选择；**弹层打开时交给 Radix 关弹层** | ★ 弹层打开时全局 Esc 不拦截 |
| `F2` | 选中块 = 进入编辑 | |
| `Delete` / `Backspace` | 删除选中块 / 边 | |
| `Alt+ArrowRight` | **跳到第一个子块** | ★ 块间焦点导航 |
| `Alt+ArrowLeft` | **跳到父块** | ★ |
| `Alt+ArrowUp` | **上一个兄弟块**（同父，按 y 排序） | ★ 首尾到头/尾不动 |
| `Alt+ArrowDown` | **下一个兄弟块** | ★ 无选中时落到最上块 |
| `方向键`（无 Alt） | 微移选中块 1px；Shift+方向键 10px | 规划文档约定 |
| `Ctrl/Cmd+S` / `Z` / `Shift+Z` / `Y` / `D` / `G` / `F` / `P` / `A` / `0` / `1` | 保存 / 撤销 / 重做 / 重做 / 复制 / 成组 / 搜索 / 导出 / 全选 / 适应屏幕 / 实际大小 | 规划文档约定 |
| `V` / `C` | 选择工具 / 连线工具 | |
| `空格按住` | 平移 | |
| 中文输入法 composition 期间 | 屏蔽 Tab/Enter/方向键/空格 | 规划文档约定 |

**连线的键盘替代路径**（不拖 Handle）：
1. 选中块后按 `Tab` → 建子块并自动连父子边（规划文档原有）；
2. 块工具条（选中后出现在块上方）的「父子关系」按钮（Waypoints 图标）→ 下拉菜单列出「跳到父块 / 跳到第一个子块 / 新建子块并连线」，键盘可达（Radix Dropdown）；
3. `Alt+方向键` 在父子树间跳。

## 3. prefers-reduced-motion 收口方式

统一在 `packages/web/src/index.css` 末尾：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
  .react-flow__node { transition: none !important; }
}
```

- 一键整理的 250ms 节点 transform 过渡（`.react-flow__node`）被压到 1ms；
- Radix Dialog 的 zoom/fade 动画（tailwind `animate-zoom-in-95` 等）同样被压到 1ms；
- CanvasEditor 里 `rf.setCenter(..., { duration })` 这种 JS 相机动画，也读 `matchMedia('(prefers-reduced-motion: reduce)')` 把 duration 设 0。
- **不在组件里逐个内联** transition 时长。

## 4. 焦点环（:focus-visible）

`index.css` 统一：

```css
:focus { outline: none; }
:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
.block-shell:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }
.block-shell.is-editing:focus-visible { outline: none; } /* Tiptap 自有焦点态 */
```

- 鼠标点击不出现持久环（浏览器默认 `:focus` 在鼠标点击也显示，统一收口到 `:focus-visible`）；
- 键盘 Tab / Alt+方向键落到块上时出现 ring 色 outline，深色模式跟随 `--ring` 变量。

## 5. 弹层焦点管理

- **Radix Dialog（ExportDialog / BlockDeleteConfirmDialog / Templates / Snapshots / Trash / TagManager / ConflictDialog）**：Radix 内建 focus trap（Tab/Shift+Tab 循环）、Esc 关闭、关闭后还焦点到触发元素。**未引 react-focus-lock 等第三方焦点库**（Radix 已是 shadcn/ui 既有依赖）。
- **ExportDialog 额外兜底**：打开时记录 `document.activeElement`，关闭后下一帧 `.focus()` 还回去——因为触发元素是画布内 `.block-shell` div 时 Radix 偶尔还到 body（e2e 实测发现）。
- **全局 Esc 拦截**：useKeyboardShortcuts 检测到 `[role=dialog][data-state=open]` 或 Radix popper 浮层存在时，Esc 直接 return，交给 Radix 自己关，避免 `preventDefault` 吃掉关闭。

## 6. 离屏 Skeleton 与键盘导航的交互

- `Alt+方向键` 目标块若离屏（Wave8 轻量 Skeleton）：
  1. `api.setSelection([id])` → 选中保护集（水合调度器永不回收）；
  2. `applyHydrationDelta([id], [])` 立即强制升级（不等视口邻近调度）；
  3. `flyToNode(id)` → CanvasEditor `lastFocus` effect 里 `rf.setCenter` 把块拉进视口；
  4. 两帧后 `document.querySelector('.react-flow__node[data-id=…] .block-shell').focus()`。
- 焦点查询不在每帧跑 O(N)：只在 Alt+方向键按下时查一次单个 id。

## 7. 测试

- **单测**：`packages/web/src/editor/lib/focus-nav.test.ts`（7 例，纯函数：父/子/兄弟/边界）。
- **e2e**：`packages/web/e2e/a11y-keyboard.spec.ts`（3 例，chromium）：
  1. 纯键盘建块（Enter→输入→Tab→子块→输入）+ Alt+Left/Right 父子跳转 + `:focus-visible` outline；
  2. Ctrl+P 导出对话框：焦点在弹层内、Shift+Tab 不逃出、Esc 关闭后焦点回块；
  3. `emulateMedia({reducedMotion:'reduce'})` 下 transition-duration 计算值为 0.001s。

## 8. 屏幕阅读器人工复测项（headless 覆盖不到）

headless Playwright 能断言 DOM/焦点/计算样式，但不能真读屏。下列项需人工在 NVDA / VoiceOver 下过一遍：

- [ ] VoiceOver（macOS Safari）：Tab 从工具栏进入画布，块外壳是否按视觉顺序朗读「块：根块标题」？
- [ ] NVDA（Windows Chrome）：`Alt+方向键` 跳转时，焦点是否正确移动且朗读块内容？
- [ ] 导出对话框打开时，是否朗读「导出 / 打印，对话框」？Tab 是否在按钮间循环？
- [ ] 深色模式下 `:focus-visible` outline 对比度（--ring 在深色下是否够亮）？
- [ ] 屏幕阅读器用户不打开鼠标，能否从空白画布纯键盘建出一棵带父子边的树？
- [ ] 放大到 200% + reduced-motion，Alt+方向键飞块是否即时（无相机动画拖尾）？
- [ ] Tiptap 编辑中块，Esc 退出后焦点是否回到块外壳而非 body？

## 9. 遗留

- RF 自带的 Controls（左下角 zoom buttons）未加 aria-label（RF 内部按钮，样式在 `index.css` 覆盖；功能上用户可用右下角自建缩放控件 + Ctrl+0/1）。后续可加 `aria-label` 经一个 `useEffect` 注入。
- 连线的「选一个已存在块作为父/子」还不能纯键盘完成（connect mode 是指针拖拽）；当前键盘替代只覆盖父子树内的 Tab 建子 + Alt 跳转。跨位置连到任意已有块留给后续。

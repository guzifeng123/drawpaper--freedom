# Wave22 · B 路 手机 PWA 窄屏（≤640px）响应式外壳

纯 web 表现层工作：让既有桌面 UI 在 375–390px 手机窄屏上不溢出、不被裁切、
浮层面板不永久压住画布。不重写任何交互逻辑、不引新依赖、core 零改动。

## 断点选择

- **640px（Tailwind `sm` 分界）**：窄屏覆写全部写在 `@media (max-width: 639px)`
  （`index.css` 收口）与组件 `max-sm:` 前缀里。选 640 而非 768/1024 的理由：
  375–390px（iPhone SE/13/14、主流安卓小屏）是真实手机竖屏；≥640 已属
  平板/桌面，既有布局在该区间一直可用，**≥1024px 视觉零变化**是硬验收线，
  640 分界把覆写面压到最小。
- 全仓此前除 `@media print` 与 `prefers-reduced-motion` 外无任何响应式断点，
  本路是第一组；没有既有断点需要兼容/对齐。

## 各表面窄屏行为

### 顶栏（TopToolbar）

- 一行不换行、改为**横向滚动收纳**：`index.css` 的 `.topbar-shell` 窄屏
  `overflow-x: auto`（隐藏滚动条、保留触摸惯性），所有直接子项 `flex-shrink: 0`，
  按钮不被压缩。桌面 ≥640px 类不生效，视觉零变化。
- 文档标题保留 truncate：窄屏 `max-w` 从 200px 收到 `38vw`，长标题截断省略，
  双击重命名交互不变。

### 三类浮层面板（受控浮层化）

窄屏统一改为「打开 = 浮层 sheet + 半透明遮罩（`.narrow-backdrop`），关闭 = 画布完整可用」：

| 面板 | 桌面形态（≥640px 不变） | 窄屏（≤639px） |
| --- | --- | --- |
| DocsList 侧栏 | 展开 w-56(224px) 常驻左侧 | **默认收起为 40px 轨道**（初始值按 `innerWidth<640` 取一次，状态语义不变）；点轨道展开为左侧 sheet，宽 `min(18rem,90vw)`，遮罩点击收起 |
| 右上搜索面板 | `absolute right-4 top-14 w-96` | 宽 `min(18rem,90vw)`、贴左右各 8px；遮罩点击关闭，自带 × 不变 |
| 左下大纲面板 | `absolute left-60 top-16 w-64` | 贴左 8px、顶 56px、宽 `min(18rem,90vw)`，遮罩点击走既有 `ui-store.setOutlineOpen(false)` 关闭 |
| 右下反链面板 | `absolute right-4 top-14 w-72 h-[70vh]` | 贴右 8px、高 `calc(100dvh-4.5rem)`、宽 `min(18rem,90vw)`；自带 × 与遮罩均可关 |

- 面板打开/关闭状态机**完全沿用既有 `ui-store`**（searchOpen / outlineOpen /
  backlinksOpen），DocsList 的 collapsed 是组件内 useState，仅初始值按视口取，
  不新增任何全局态、不改状态语义。
- 遮罩 `sm:hidden`：≥640px 不渲染显示（节点仍在 DOM 但 `display:none`），
  桌面面板仍是常驻/浮动侧栏形态，无遮罩模式。

### 底部胶囊工具条 与 RF Controls

- 一键整理 ghost 预览胶囊条：窄屏 `bottom` 叠加 `env(safe-area-inset-bottom)`，
  并允许 92vw 内换行，不被 Home 指示条遮挡。
- React Flow 缩放控件（`bottom-left`）：窄屏左偏移到 `4.5rem` 让出左侧文档轨道
  （轨道 left-4 16px + w-10 40px），bottom/right 叠加 `safe-area-inset-*`；
  MiniMap 同步落安全区。RF 内联 style 定位，覆写带 `!important`，仅窄屏生效。

### a11y 挂账（docs/wave9 §9 收口）

- React Flow Controls 四按钮（`.react-flow__controls-button`：zoomin / zoomout /
  fitview / interactive）在 `CanvasEditor` 挂载后经 `useEffect`+`MutationObserver`
  按 class 覆写中文 `aria-label`：**放大 / 缩小 / 适应视图 / 锁定视口**。
  仅 childList 变化触发、不监听属性，不干扰交互锁定态的 title 切换。

## 手动走查项（真机/移动模拟）

1. Chrome DevTools 设备工具栏切 iPhone 13（375×667）：
   - 顶栏可左右滑动，全部按钮可达，无横向滚动条残留，页面无横向滚动（双指缩小无白边）。
   - 打开搜索/大纲/反链：出现半透明遮罩、面板 ≤288px 宽；点遮罩或 × 后面板消失，
     画布可点选块、Enter 建块。
   - 左侧 40px 轨道：点开展开文档列表 sheet；点遮罩收回轨道。
2. iOS Safari（PWA 到主屏幕）：底部胶囊条不被 Home 指示条压；RF Controls 不被
   文档轨道遮挡；横屏旋转后布局仍无溢出。
3. 桌面 1280×800：与基线比对——顶栏、侧栏、搜索/反链面板位置与宽度无任何变化；
   打开面板**无**遮罩出现。
4. 读屏（NVDA/VoiceOver）聚焦画布：RF 缩放四按钮依次播报「放大/缩小/适应视图/
   锁定视口」。

## 验收（e2e `wave22-narrow-shell.spec.ts`）

375×667 移动视口（`isMobile+hasTouch`）可计算断言：documentElement 无横向溢出；
顶栏按钮全部落在滚动内容范围内；逐个打开 DocsList/搜索/大纲/反链为浮层
（遮罩可见、宽 ≤289px）且关闭后 pane 点击 + Enter 建块成立；RF Controls 四按钮
aria-label 集合 = 中文四词、axe `.react-flow__controls` 区域零 violation。
1280×800 桌面视口：DocsList 仍为 224px 固定侧栏、搜索面板仍 384px、所有遮罩
`display:none`、无横向溢出。

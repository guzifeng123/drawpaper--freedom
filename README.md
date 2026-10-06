# drawpaper · 知识块连线笔记

本地优先（local-first）的「无限画布 + 富文本知识块 + 父子连线 + 一键整理成树 + A4 分页导出」Web PWA 笔记工具。纯本地、无账号、无服务器：数据存浏览器 IndexedDB / OPFS，可通过 File System Access 直接读写本地 `.kbnote` 文件。

## 功能一览

**画布与编辑**
- 无限画布：平移/缩放、点阵网格、MiniMap、框选、右键菜单、对齐参考线、网格磁吸、双击空白建块
- 块内 Tiptap 富文本：斜杠菜单、Markdown 行首快捷语法、粘贴网址成链/图片插图、8 色标签
- 块类型：文本/标题、待办、无序列表、图片、便签、分组容器；P1 增补**表格、代码（语法高亮）、公式（KaTeX 本地渲染）、网页书签、附件、日期提醒**
- 父子连线：Handle 拖拽、松手到空白自动建子块、自环/重复边拦截、多父/成环弹窗裁决（选主父/选断边，均可撤销）；边标签自由编辑，6 色淡色板（5 淡色 + 中性灰，常量集中可整体替换）
- 快速建块：Tab 子块 / Enter 兄弟 / Shift+Tab 升级（中文输入法 composition 期间自动屏蔽）
- 多选、复制粘贴、缩放、pinned 固定、折叠子树、悬停高亮整条逻辑链、边反转/批量改色、聚焦分支
- PWA 触屏：粗指针设备显示显式工具按钮（选择/连线/平移），热区 ≥44px，双指平移缩放，长按连接点 500ms 进入连线态

**一键整理（d3-hierarchy，无 dagre/力导向）**
- 横向思维导图、纵向思维导图、组织结构树、放射树；ghost 预览 → 250ms 动画落位 → 可撤销
- pinned/手动移动过的块绕行保留、仅整理选中分支、折叠后自动收紧、增量整理

**文档管理**
- 多文档列表（新建/重命名/复制/删除）、自动快照与历史（每文档保留 20 条）、回收站（恢复/彻底删除）、6 份模板（读书笔记/会议纪要/课程大纲/头脑风暴/知识体系/项目拆解）、定时备份开关
- 500ms 防抖自动保存 + 保存状态提示；OPFS 大 Blob 与图片压缩；File System Access 活动文件直写（不支持时降级上传/下载）
- 大纲面板双向联动（拖拽改父子、内联建块、未分组分区）、标签/类型/颜色筛选、MiniSearch 全文搜索飞块高亮
- 深色模式（light/dark/跟随系统，首屏无闪烁）

**导出**
- A4 纵/横，页边距 10/15/20mm，页眉/页脚/页码，分页虚线 WYSIWYG 预览（分页原点可拖、手动分页符可插入/拖动/删除）
- fit / tiles / flow 三模式：块零切割、跨页成对续接标记、孤块标黄、折叠子树不导出
- 矢量打印 PDF（文字可选中）、高清 PNG（scale≈3）、pdf-lib 直接下载多页 PDF、SVG、Markdown/文本大纲；支持导出选中分支/选中区域
- 默认文件名 `{标题}_{YYYYMMDD}_{纵向|横向}.pdf`

**AI 辅助（P1，默认关闭）**
- 用户自带 OpenAI 兼容 endpoint/key/model（仅存本机 localStorage）；一键整理建议、长文拆块、自动分组、摘要润色、孤立断点检测
- 输出经 zod schema 校验 → diff 预览逐条勾选 → 合入后再走规则布局；非法建议自动丢弃、失败静默回退纯规则、文档不被污染

**跨端外壳**
- `apps/desktop-tauri`：Tauri 2 桌面外壳（菜单/打开保存/打印/最近文件/.kbnote 关联），目标 Windows WebView2 出包
- `apps/mobile-capacitor`：Capacitor 平板外壳配置与 HostAdapter 参考实现
- P3 协作（Yjs/CRDT）、跨画布双链、知识图谱总览仅预留接口（`CollabAdapter` 等），未实现

## 技术栈

- **monorepo**：pnpm workspaces（`packages/*` + `apps/*`）
- **core**（`@drawpaper/core`）：纯 TypeScript，零 DOM / 零 React。model / graph / layout / paginate / serialize / store / ai，平台能力经适配器接口注入
- **web**（`@drawpaper/web`）：React 18 + TypeScript + Vite + Tailwind + shadcn/ui + @xyflow/react + Tiptap + Dexie + MiniSearch + pdf-lib + html-to-image + KaTeX + highlight.js + vite-plugin-pwa
- **状态**：zustand（vanilla）+ immer + 自研 Command 命令栈（含宏命令与输入合并）
- **测试**：Vitest（core/web 单测 295+）+ Playwright（画布交互与导出回归 e2e 27）

## 快速开始

```bash
pnpm install        # 安装依赖（已配置 npmmirror 镜像）
pnpm dev            # 启动 web（Vite，默认 http://localhost:5173）
pnpm build          # 构建 packages 下全部包（core ESM/.d.ts → web PWA）
pnpm test           # 全部 Vitest 单测
pnpm typecheck      # 全包 tsc --noEmit
pnpm lint           # ESLint（core 中访问 DOM 全局会报错）
pnpm e2e            # Playwright（在 packages/web 下，自动起 dev server）
```

首次跑 e2e 若提示缺浏览器：`pnpm --filter @drawpaper/web exec playwright install chromium`。

桌面外壳见 `apps/desktop-tauri/README.md`（Linux 下 cargo check 需 GTK/webkit2gtk 开发库，Windows 出包无需）。

## 键盘快捷键

| 键 | 作用 |
|---|---|
| `Enter` | 选中块 = 新建同级块；无选中 = 在视口中心建根块并进编辑 |
| `Tab` / `Shift+Tab` | 选中块 = 新建子块并连父子边 / 升级（移出父级） |
| `Esc` | 退出编辑 → 取消选中；弹层打开时关弹层 |
| `F2` | 选中块 = 进入编辑 |
| `Alt+→` / `Alt+←` | 跳到第一个子块 / 跳到父块 |
| `Alt+↑` / `Alt+↓` | 上一个 / 下一个兄弟块（同父） |
| `方向键` / `Shift+方向键` | 微移选中块 1px / 10px |
| `Delete` / `Backspace` | 删除选中块 / 边 |
| `Ctrl/Cmd+S` / `Z` / `Shift+Z` / `Y` | 保存 / 撤销 / 重做 / 重做 |
| `Ctrl/Cmd+D` / `G` / `A` | 复制 / 成组 / 全选 |
| `Ctrl/Cmd+F` / `P` | 全文搜索 / 导出打印 |
| `Ctrl/Cmd+0` / `1` | 适应屏幕 / 实际大小 |
| `V` / `C` / 空格按住 | 选择工具 / 连线工具 / 平移 |

无障碍细节（:focus-visible、reduced-motion、ARIA 语义、屏幕阅读器人工复测清单）见 `docs/wave9/a11y-keyboard.md`。

## 状态 / 获取安装包

- **Web PWA**：浏览器直接打开部署地址即可，可「添加到主屏幕」离线使用。
- **Windows 桌面**：GitHub Release 的预发布页提供 NSIS 安装包（Win10/11 x64 与 ARM64）。
  打 tag `v*` 触发 `.github/workflows/release-windows.yml` 自动构建；tag 含 `-`（如 `v0.1.0-rc.1`）标记为 prerelease。
- **Android 平板**：每次 push 到 feat/develop 会由 `android-debug.yml` 产出一个 unsigned debug APK（workflow artifact，14 天内下载）。侧载到平板即可测试；未签名、不上架。
- **CI**：`.github/workflows/web-ci.yml` 在每次 push/PR 跑 build/typecheck/lint/单测/e2e/PWA precache 守门。

**本期明确不做**：iOS（需 Apple Developer 账号 + 签名证书 + macOS runner）、Yjs/CRDT 实时协作（仅预留 `CollabAdapter` 接口）、手绘墨迹块（需手写笔硬件预研）、自动更新（无签名私钥与更新服务器，见 `docs/p2-tauri-ci.md` §3）。

## 目录

```
packages/
  core/    @drawpaper/core   纯逻辑包（DOM-free）：模型/图分析/布局/分页/序列化/状态内核/AI 纯逻辑
  web/     @drawpaper/web    React PWA：画布编辑器、面板、导出、存储与宿主适配、AI Provider
apps/
  desktop-tauri/       Tauri 2 桌面外壳（Rust）
  mobile-capacitor/    Capacitor 平板外壳
docs/
  ARCHITECTURE.md      分层、模块契约表、所有权划分
  wave1/ wave2/ wave3/ 各波次实现与验收记录（含最终 API 签名、验收矩阵、已知限制）
```

## 硬约束

- core 禁止任何浏览器全局（window/document/IndexedDB/fetch…）与 react/@tiptap/vite 依赖；平台能力一律经 `HostAdapter` / `StorageAdapter` / `AIProvider` 注入。
- 运行时除可选字体 CDN 与用户自配 AI endpoint 外**零网络请求**，无外部统计/埋点；KaTeX/highlight.js 资源全部本地打包。
- 连线只有父子一种语义（Edge 无 relation 字段，schema version=1）；布局仅 d3-hierarchy 树系（横向/纵向/组织树/放射），不引入 dagre / d3-force / elkjs。
- 性能口径：500 块拖拽/缩放 60fps（视口虚拟化，仅渲染可见节点）；2000 块文档加载到可交互约 6s（e2e 断言 ≤15s）。

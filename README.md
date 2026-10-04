# drawpaper · 知识块连线笔记

本地优先（local-first）的「无限画布 + 富文本知识块 + 父子连线 + 一键整理成思维导图 + 导出 A4 横/纵 PDF」Web PWA 笔记工具。纯本地、无账号、无服务器。

> 当前为 **Wave 0 脚手架**：冻结了 core/web 类型与 API 契约，业务逻辑占位待后续并行实现。

## 技术栈

- **monorepo**：pnpm workspaces（`packages/*`）
- **core**（`@drawpaper/core`）：纯 TS，零 DOM / 零 React / 零 Vite。model / graph / layout / paginate / serialize / store 契约。
- **web**（`@drawpaper/web`）：React 18 + TypeScript + Vite + Tailwind v3.4 + shadcn/ui + @xyflow/react + Tiptap v2 + vite-plugin-pwa。
- **状态**：zustand + immer + 自研 Command 命令栈。
- **布局**：d3-hierarchy（仅 3 种树：mindmap-right / mindmap-down / org-tree）。**不引入** dagre / d3-force / elkjs。
- **存储**：Dexie/IndexedDB + OPFS + File System Access（StorageAdapter 注入）。
- **测试**：Vitest（core 纯函数）+ Playwright（web e2e）。

## 快速开始

```bash
pnpm install        # 安装依赖（已配置 npmmirror 镜像）
pnpm dev            # 启动 web（Vite，默认 http://localhost:5173）
pnpm build         # 依次构建 core → web（产出 ESM + d.ts + PWA）
pnpm test          # 跑全部 vitest 单测
pnpm lint          # ESLint（core 中访问 DOM 全局会报错）
pnpm typecheck     # 全包 tsc --noEmit
pnpm e2e           # Playwright 冒烟（需先 pnpm build；自动起 preview）
```

首次跑 e2e 若提示缺浏览器：`pnpm --filter @drawpaper/web exec playwright install chromium`。

## 目录

```
packages/
  core/    @drawpaper/core  纯逻辑契约包（DOM-free）
  web/     @drawpaper/web   React PWA 外壳
docs/
  ARCHITECTURE.md           分层、模块契约表、所有权划分（后续 agent 必读）
```

## 硬约束

- core 禁止任何浏览器全局（window/document/IndexedDB/fetch…）与 react/@tiptap/vite 依赖；平台能力一律经 `HostAdapter` / `StorageAdapter` 注入。
- 运行时除可选字体 CDN 与用户自配 AI endpoint 外**零网络请求**，不接外部统计/埋点。
- 连线只有父子一种语义（Edge 无 relation 字段）；P0 布局仅 3 种树。详见 `docs/ARCHITECTURE.md`。

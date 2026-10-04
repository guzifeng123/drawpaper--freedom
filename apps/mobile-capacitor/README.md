# drawpaper · 平板壳（Capacitor，PWA 先行）

本目录是 drawpaper 的 iPad / Android 平板外壳。**前端完全复用 `packages/web`**，
这里只放 Capacitor 配置和一个参考 HostAdapter 映射。

> 选型依据：规划文档 §4.12 / §12 — **先 PWA 上线**（iPad/Android 浏览器
> 「添加到主屏幕」即可安装、离线可用），需要上架应用商店再用 Capacitor
> 套壳。本目录不产出 APK/IPA，仅留脚手架。

## 目录

```
apps/mobile-capacitor/
├─ package.json            # 独立 package.json，不进根 pnpm workspace
├─ capacitor.config.ts     # appId/appName/webDir/plugins
├─ README.md               # 本文件
└─ src/
   └─ host-mobile.ts       # 参考实现（不进构建）：Filesystem/Share 插件映射
```

## PWA 先行策略（当前默认）

iPad / Android 用户：

1. 用 Safari / Chrome 打开 drawpaper 的 PWA 地址；
2. 分享 → 「添加到主屏幕」；
3. 启动后全屏、离线可用（vite-plugin-pwa 已在 packages/web 配置）。

触屏手势（长按连线 / 双指缩放 / 44px 热区）是 Wave3 P1 范围，不在本期。
规划 §4.6 已列清单：

- 单指拖块移动；长按连接点再拖为连线
- 双指平移 + 捏合缩放；双击编辑；长按空白出菜单
- 连接热区 ≥ 44px；显式工具按钮（选择/连线/平移）兜底手势歧义
- 手写笔取压感/倾斜（P2 后期）
- 外接键盘快捷键复用桌面端

## 出包步骤（仅在上架时执行）

```bash
# 1. 仓库根：构建前端到 packages/web/dist
cd <repo-root>
pnpm install
pnpm -r --filter "./packages/*" build

# 2. 本目录装 Capacitor CLI（独立装，不污染根 workspace）
cd apps/mobile-capacitor
pnpm install --ignore-workspace

# 3. 添加平台（首次）
npx cap add android        # 需要 Android Studio + JDK 17
npx cap add ios            # 需要 macOS + Xcode

# 4. 同步 web 产物 + 插件到原生工程
npx cap sync

# 5. 打开 IDE 出包
npx cap open android       # Android Studio → Build APK / Bundle
npx cap open ios           # Xcode → Archive
```

`webDir` 在 `capacitor.config.ts` 中指向 `../../packages/web/dist`。
如果希望原生工程自包含（CI 打包时不依赖 monorepo 路径），可改成本地复制：

```bash
pnpm copy:web              # 把 ../../packages/web/dist 复制到本目录 dist/
```

然后把 `capacitor.config.ts` 的 `webDir` 改成 `'./dist'`。

## HostAdapter 差异点

见 `src/host-mobile.ts`。三端对照（完整版见 `docs/p2-shells.md`）：

| 能力 | Web PWA | Tauri 桌面 | Capacitor 平板 |
|---|---|---|---|
| 打开 .kbnote | `<input type=file>` / FS Access | 原生对话框 `open_kbnote` | `<input type=file>`（Files app）|
| 保存 .kbnote | 下载 / FS Access | 原生对话框 `save_kbnote` | Filesystem 写 Documents/ 后 share |
| 打印 | `window.print()` | `window.print()`（WebView2）| 走分享 sheet 导出 PDF |
| 分享 | `navigator.share` | no-op（桌面无系统分享面板）| `@capacitor/share` |

## 隐私

与桌面/PWA 一致：零外网（除可选字体 CDN 与用户自配 AI endpoint）。
Filesystem 插件默认写 app-private 目录，不申请全存储权限。

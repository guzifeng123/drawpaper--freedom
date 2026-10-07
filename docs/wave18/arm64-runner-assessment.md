# Wave18 P3：GitHub hosted Windows ARM64 runner 现状评估

> 查询日期：**2026-10-08**（Asia/Shanghai）。结论先行：`windows-11-arm` 标准 hosted runner
> 对**公开仓库已 GA、免费**，本仓库（`guzifeng123/drawpaper--freedom`，未认证探测仓库页 /
> raw /actions 均 200，判为公开仓库）**技术上已可升级为 arm64 实跑冒烟**；但本次 Wave18
> 按任务约束**不新增任何 arm64 实跑 job**，维持「arm64 仅交叉构建、不执行」现状，升级留待独立波次。

## 1. 联网调研结论（带来源）

| 事项 | 现状（2026-10-08 查询） | 来源 |
| --- | --- | --- |
| 公开可用性 | Windows arm64 hosted runner 2025-04-14 进入 public preview；**2025-08-07 起公开仓库 GA**（Linux + Windows 标准 arm64 runner） | https://github.blog/changelog/2025-04-14-windows-arm64-hosted-runners-now-available-in-public-preview/ ；https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/ |
| 申请门槛 | 公开仓库**无需申请、免费**（标准 runner 分钟数不消耗）；GA 公告原文："These runners are only available in public repositories and will not work in private repositories" | 同上 2025-08-07 公告 |
| 私有仓库 | 标准 `windows-11-arm` **不可用于私有仓库**；私有仓库要用 arm64 只能开**付费 arm64 larger runner**（`windows_2_core_arm` 约 $0.010/分钟，与 x64 标准 Windows 同价） | https://github.blog/changelog/2025-08-07-... ；https://docs.github.com/en/billing/reference/actions-runner-pricing |
| 标签名 | **`windows-11-arm`**（另有 `windows-11-vs2026-arm` 精确标签；`windows-11-arm` 于 2026-09-21 起逐步滚动到 VS2026 镜像） | https://docs.github.com/en/actions/how-tos/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners ；https://github.blog/changelog/2026-08-20-windows-11-arm64-vs2026-image-generally-available/ |
| 规格 | 标准 runner **4 vCPU / 16 GB RAM / 14 GB SSD**，Arm 管理镜像 | 2025-08-07 公告（"standard runners are 4vCPU"）；GitHub docs runner 表 |
| 镜像软件（2026-01 镜像构建） | Node 22.21.1 已缓存（另含 20/24）、Rust 1.92 + rustup、VS Enterprise 2022 ARM + Windows SDK 10.0.26100、**NSIS 3.10**、PowerShell 7.4、Edge/Chrome 均在列 | https://raw.githubusercontent.com/actions/partner-runner-images/main/images/arm-windows-11-image.md |
| 镜像缺失项（Omitted） | **WiX Toolset 不在 arm 镜像**；Docker / MSYS2 / PostgreSQL 等也省略 | 同上镜像清单 |

## 2. 本仓库现状

- `release-windows` matrix 里 arm64 行（`aarch64-pc-windows-msvc`）跑在 **`windows-latest`（x64）runner 上做交叉构建**：`tauri build --target aarch64-pc-windows-msvc --bundles nsis,msi`，产出 arm64 NSIS/MSI 安装包后上传 artifact。
- 所有「冒烟」步骤均 `if: matrix.arch == 'x64'` 显式跳过 arm64：arm64 exe **从不被安装、从不被执行**——没有冷启动、没有欢迎文档、没有 diag 金丝雀、没有本次新增的 native-autosave selftest、没有卸载冒烟。即 arm64 产物只验证「能编出来 + 能被 artifact 收走」，不验证「能装能跑」。
- 资源新鲜度：交叉构建每波次在 x64 runner 上现拉 `aarch64-pc-windows-msvc` target（`rustup target add`），工具链随 workflow 步骤即时安装，无本地缓存假设；镜像侧 arm 镜像月度滚动（最近一次重大变更是 2026-09 的 VS2026 切换）。

## 3. 升级为 arm64 实跑冒烟：前置条件与建议工作量

**结论：技术上可行、成本低，但按本次任务约束不在本分支落地。** 前置条件盘点：

1. **runner 标签切换**：arm64 job 的 `runs-on` 从 `windows-latest` 改为 `windows-11-arm`。公开仓库免费、无需申请（已核实 2025-08-07 GA）。
2. **工具链差异**：
   - Rust：arm 镜像自带 Rust 1.92/rustup，`rustup target add aarch64-pc-windows-msvc` 后原生（非交叉）构建；构建时间预计与 x64 相当或略慢（4 vCPU 同规格）。
   - NSIS：镜像自带 NSIS 3.10 ✓。
   - **WiX/MSI 冒烟需额外处理**：arm 镜像**省略了 WiX Toolset**——arm64 MSI 产物要么在 arm runner 上补装 WiX，要么 arm64 继续只跑 NSIS 冒烟（MSI 仍不执行，与现状一致）。
3. **WebView2 Runtime**：arm 镜像自带 Edge（Chromium）；WebView2 Evergreen ARM64 Runtime 是否预装需在首次实跑时确认（本仓库 x64 冒烟同样依赖 runner 预装，缺省走 embedBootstrapper 验证步骤兜底）。
4. **可迁移的冒烟面**（按风险排序）：
   - 最易迁移、收益最高：本次 P1 的 `--native-autosave-selftest`（纯 headless CLI、不弹窗、无 WebView 交互）——arm64 上可直接复用，把 `if: matrix.arch == 'x64'` 放开即可。
   - 次易：`--diag-export` 金丝雀（同为 headless CLI）。
   - 较重：GUI 启动/欢迎文档/文件关联冒烟（依赖窗口标题轮询与 EBWebView leveldb 断言，arm runner 桌面会话未经验证）。
   - P4 两个 SendKeys 原生菜单自动化：在 x64 上尚是 best-effort（见 ci-hardening.md），arm 上更不建议现在上。
5. **建议工作量**：一个独立波次，约 0.5～1 天——切换 label + 放开 headless CLI 冒烟条件（半小时内可改完）+ 一次实跑调试（镜像 WebView2/工具链差异）+ 观察 2~3 个分支跑稳定后再放开 GUI 冒烟。

## 4. 本分支决策

- **不加任何 arm64 实跑 job**（任务红线）。matrix 维持 `runs-on: windows-latest` 双架构交叉构建；冒烟维持 `matrix.arch == 'x64'` 门控。
- 理由：① 本波次范围是 EXE 收尾加固（P1/P2），arm64 实跑是独立议题；② VS2026 镜像 2026-09 刚完成滚动，arm 镜像生产稳定性观察期尚短；③ GUI 类冒烟在 arm runner 桌面会话上零经验，贸然放开会引入新 flaky 面。
- 后续触发条件：当需要对 arm64 真机用户负责（例如首批 ARM Windows 用户反馈）时，按 §3 清单立项迁移。

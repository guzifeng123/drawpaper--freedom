# drawpaper Windows 用户指南

> 适用版本：Windows 10 / 11（x64 与 ARM64）。
> 安装包由 `.github/workflows/release-windows.yml` 自动构建并发布到 GitHub Releases。
> 本指南面向**最终用户**，只讲「怎么装、数据在哪、出问题怎么办」，不讲构建。

## 0. 选哪个安装包

每个架构有**两种格式**，装出来的是同一个 drawpaper，只是安装器不同：

| 格式 | 文件名 | 适合谁 | 安装范围 |
|---|---|---|---|
| **NSIS（推荐）** | `drawpaper_*_x64-setup.exe` / `drawpaper_*_arm64-setup.exe` | 绝大多数个人用户 | 向导可选「仅当前用户」（默认，不弹 UAC）或「为所有用户」 |
| **WiX MSI** | `drawpaper_*_x64_en-US.msi` / `drawpaper_*_arm64_en-US.msi` | 企业批量部署 / 组策略 / SCCM / Intune | 固定**按机器安装**到 `C:\Program Files\drawpaper`（需要管理员） |

个人用户直接下 NSIS `*-setup.exe` 即可。MSI 主要给要批量分发 / 静默部署（`msiexec /i xxx.msi /qn`）的 IT 管理员用；MSI 安装界面只有英文，NSIS 有中 / 英双语选择。

## 1. 下载与安装

1. 打开仓库 Releases 页（`https://github.com/guzifeng123/drawpaper--freedom/releases`），选最新一条预发布（prerelease）。
2. 按机型下载（个人用户选 NSIS，企业批量部署才选 MSI，见 §0）：
   - 普通 Intel / AMD 笔记本、台式机 → `drawpaper_*_x64-setup.exe`
   - Copilot+ PC、Surface Pro X 等 ARM 设备 → `drawpaper_*_arm64-setup.exe`
   - （可选）企业静默部署 → 同名 `*_x64_en-US.msi` / `*_arm64_en-US.msi`，管理员 `msiexec /i xxx.msi /qn`
   - 同时下载 `SHA256SUMS.txt`，在 PowerShell 里校验（NSIS 与 MSI 四个包的校验和都在里面）：
     ```powershell
     Get-FileHash .\drawpaper_*_x64-setup.exe -Algorithm SHA256
     # 与 SHA256SUMS.txt 里对应那一行的哈希比对，一致再装
     ```
3. NSIS 双击 `*-setup.exe` 安装；MSI 双击 `.msi` 或命令行 `msiexec /i xxx.msi`。

### 1.1 SmartScreen 蓝色弹窗（「Windows 已保护你的电脑」）

因为安装包**没有购买代码签名证书**（Authenticode 签名每年要付费，本项目目前没有），Microsoft SmartScreen 不认识这个发布者，会拦一道：

- 点击弹窗左侧的 **「更多信息」**，会出现 **「仍要运行」** 按钮，点它即可继续。
- 这是未签名免费开源 Windows 软件的常态，不是病毒；安装包本身在 Releases 页公开、可 anyone 审。
- 装一次之后，SmartScreen 通常不会再拦同一个文件。

### 1.2 安装模式（installMode: both）

Wave13 起安装器配置为 `both`：安装向导里**默认按当前用户安装**（不需要管理员权限，不弹 UAC），装到 `%LOCALAPPDATA%\Programs\drawpaper`，只对当前 Windows 账号生效。

高级选项里可勾选「为所有用户安装」：这一步会弹 UAC，装到 `%ProgramFiles%\drawpaper`，所有本机账号共用一份。两者选其一即可；之后想换模式，先卸载再重装。

两种模式都**不会**改系统环境变量、不动 `PATH`。

### 1.3 卸载

- 方式一：Windows 设置 → 应用 → 已安装的应用 → drawpaper → 卸载。
- 方式二：开始菜单 → 右键 drawpaper → 卸载。
- NSIS 静默卸载器是安装目录下的 `unins000.exe`。
- MSI 版卸载走系统「应用」面板，或管理员命令行 `msiexec /x drawpaper_*_x64_en-US.msi /qn`。MSI 固定装在 `C:\Program Files\drawpaper`。

## 2. 数据目录与卸载后保留策略

drawpaper 是本地优先应用，**所有文档、最近文件列表、自动快照、同步配置、AI endpoint 都存在本机**，不注册账号、不上传云端。

Tauri 2 按 identifier `com.drawpaper.app` 决定目录名，Windows 上对应位置：

| 用途 | 路径（资源管理器地址栏直接粘贴） |
|---|---|
| 配置 / 最近文件 / 自动保存元数据 | `%APPDATA%\com.drawpaper.app\` |
| 文档时间戳备份（`backups\*.kbnote`） | `%APPDATA%\com.drawpaper.app\backups\` |
| 日志（`drawpaper.log`） | `%APPDATA%\com.drawpaper.app\logs\` |
| 程序本体（currentUser 模式） | `%LOCALAPPDATA%\Programs\drawpaper\` |
| 程序本体（整机模式） | `%ProgramFiles%\drawpaper\` |

**卸载会删程序本体目录，但保留 `%APPDATA%\com.drawpaper.app\` 下的用户数据**（最近文件、备份、配置）。这样误装/重装不会丢文档；如果你要彻底清干净，卸载后手动删掉上面那个 `Roaming\com.drawpaper.app` 目录即可。

文档本体本身（`.kbnote` 文件）由你通过「另存为」或同步通道放在任意目录，drawpaper 不会动你没绑定的文件。

## 3. `.kbnote` 文件关联

安装包会把 `.kbnote` 扩展名注册给 drawpaper：

- currentUser 模式写到 `HKCU\Software\Classes\.kbnote`
- 整机模式写到 `HKLM\Software\Classes\.kbnote`
- 双击任何 `.kbnote` 文件应直接用 drawpaper 打开。

### 3.1 双击没反应 / 弹「打开方式」怎么办

1. 右键任意 `.kbnote` 文件 → **打开方式 → 选择另一个应用**。
2. 选 drawpaper（如果列表里没有，点「更多应用 → 在此电脑上查找另一个应用」，手动选 `drawpaper.exe`，通常在 `%LOCALAPPDATA%\Programs\drawpaper\drawpaper.exe`）。
3. 勾选 **「始终使用此应用打开 .kbnote 文件」**。
4. 如果还是被浏览器 / 记事本抢回去，到 Windows 设置 → 应用 → 默认应用，搜 `.kbnote`，把它指到 drawpaper。

## 4. WebView2 运行时

drawpaper 的窗口用 Microsoft Edge WebView2 渲染：

- **Win11**：系统自带 WebView2 运行时，装完即跑。
- **Win10 或精简过的系统**：第一次启动 drawpaper 会自动下载 WebView2 Evergreen Runtime（约 100MB）。
- **完全离线 / 内网隔离机器**：提前在能上网的机器上下载「WebView2 Standalone Installer (x64)」（Microsoft 官网，搜 *Evergreen Bootstrapper* / *Standalone*），拷到内网装好，再装 drawpaper 即可。
- WebView2 崩了会表现为白屏 / 窗口卡死；关掉 drawpaper 重开即可，文档有 500ms 防抖自动保存兜底。

## 5. 检查更新

**当前（RC 阶段）未启用自动更新**：没有代码签名私钥、也没有更新服务器，所以不会弹「有新版本」。

手动检查：

1. 打开 `https://github.com/guzifeng123/drawpaper--freedom/releases/latest`。
2. 看页面顶部的版本号是不是比你菜单「帮助 → 关于」里的新。
3. 新版下载新的 `*-setup.exe`，直接双击覆盖安装即可（用户数据不动）。

## 6. 同步（文件夹 / WebDAV / 端到端加密）

drawpaper 官方不提供任何云服务，同步通道完全由你自己选，配置在 app 内「同步」菜单：

- **同步文件夹（推荐）**：选一个本地目录（Syncthing / iCloud Drive / OneDrive / Dropbox 同步的那个文件夹都行），文档自动导出为 `<docId>.kbnote`，图片附件进 `assets/` 子目录。多台机器放同一个文件夹即同步。
- **WebDAV**：自填 base URL / 用户名 / 应用密码（Nextcloud、坚果云、群晖、威联通等）。凭据只存本机，不发往任何第三方。
- **端到端加密（仅 WebDAV）**：在 WebDAV 设置里开 E2EE，口令经 PBKDF2 派生 AES-256-GCM 密钥，服务器端看不到正文。口令默认只在内存里，关掉 app 就要重新输。
- **冲突**：自动合并失败时会保留 `《文档名》.conflicted-《时间》.kbnote` 副本，并在同步设置里提供「冲突副本中心」让你挑以哪边为准。

详细配置步骤见 [`sync.md`](./sync.md)。

## 7. 日志与反馈

- 日志文件位置：`%APPDATA%\com.drawpaper.app\logs\drawpaper.log`（按启动追加，由 tauri-plugin-log 写入）。
- 出 bug（崩溃、白屏、同步报错、快捷键失灵）时：
  1. 先把 app 关掉再重开一次，看是否复现。
  2. 复现后把 `%APPDATA%\com.drawpaper.app\logs\drawpaper.log` 最近几百行截出来（里面不含文档正文，只有启动 / 错误栈）。
  3. 到仓库 Issues 页提一条：附上 Windows 版本（Win10/11、x64/ARM64）、drawpaper 版本号（菜单「帮助 → 关于」）、复现步骤、日志尾部。
- 反馈时**不要**把 `%APPDATA%\com.drawpaper.app\` 下的备份 `.kbnote` 直接贴出来——那是你的私有文档。

## 8. 边界与已知限制

- 本 RC 版本**不自动更新**、**不做代码签名**、**不收集任何遥测**。
- 同步是文件夹级 / WebDAV 级，**不是实时云端多人协作**；同一台机器同一个浏览器开多个标签页是实时的（`BroadcastChannel`，零外网）。
- ARM64 包在 x64 Windows 上跑不起来（反之亦然），别下错架构。
- 卸载保留 `%APPDATA%\com.drawpaper.app\`；要彻底清理请手动删。
- CI 冒烟只覆盖「当前用户」静默安装路径；「为所有用户安装」（整机 / UAC / `C:\Program Files\drawpaper`）路径目前需人工在 Windows 桌面验证，注册表 HKLM 与公共快捷方式双探测已在冒烟里预留但不做硬门。

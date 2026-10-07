# Wave 18/19 — WiX MSI 双语 culture 双包（en-US + zh-CN）：**已启用（rc.10 重启后通过）**

> 状态：本波最终**成功**。`bundle.windows.wix.language = ["en-US", "zh-CN"]` 后，x64 / arm64
> 各产 en-US + zh-CN 两个 MSI，加上 NSIS×2 共 **6 个 Windows 安装包**；x64 zh-CN 静默装 /
> ProductVersion 断言 / 静默卸**全绿**。
>
> 这段文档最初在 Wave 18 N 路写的是「不做」（盲猜根因、匿名日志不可读、止损回退）。
> Wave 19 A 路在新分支 `fix/msi-zhcn-smoke` 上用「诊断打到 check-run annotations」的手法拿到
> 了真实根因，推翻了旧结论。下面以 Wave19 A 的实测证据为准。
> 基线：`fea7e73`（rc.10）。分支：`fix/msi-zhcn-smoke`。

## 1. 配置键（Tauri 2 / WiX v3）

`apps/desktop-tauri/src-tauri/tauri/tauri.conf.json` → `bundle.windows.wix`：

```json
"wix": {
  "version": "0.1.0.10",
  "language": ["en-US", "zh-CN"]
}
```

- `wix.language` 的 schema 是 `WixLanguage = string | string[] | map`（数组即每种 culture 一个
  MSI，语言键直接成为文件名后缀）。见 <https://schema.tauri.app/config/2> 与
  <https://v2.tauri.app/distribute/windows-installer/>。
- `wix.version: "0.1.0.10"`（数字 ProductVersion 覆盖）与 app `0.1.0-rc.10` **全程零改动**；
  NSIS 配置一行未动。
- **不需要自定义 fragment / `.wxl`**：WixUIExtension v3.14 自带 zh-CN（ProductLanguage 2052）
  本地化，开箱构建即过。Wave18 的「疑似缺语言包」假设被证伪。

## 2. 实测产物（run #130，commit 624e79c）

`List MSI artifacts` 步骤打印的完整文件名 + 大小：

| 文件名 | 大小（bytes） |
|---|---|
| `drawpaper_0.1.0-rc.10_x64_en-US.msi` | 6,496,256 |
| `drawpaper_0.1.0-rc.10_x64_zh-CN.msi` | 6,496,256 |
| `drawpaper_0.1.0-rc.10_arm64_en-US.msi` | 6,373,376 |
| `drawpaper_0.1.0-rc.10_arm64_zh-CN.msi` | 6,373,376 |

加 NSIS：`drawpaper_0.1.0-rc.10_x64-setup.exe`、`drawpaper_0.1.0-rc.10_arm64-setup.exe`，
共 **6 包**，`SHA256SUMS.txt` = 6 行（publish job 硬断言 `-eq 6`）。

MSI 属性（COM 读 Property 表实测）：

- en-US：ProductCode `{F9A50531-062B-4520-BAEF-3CAA7332DE60}`，ProductLanguage **1033**
- zh-CN：ProductCode `{60E19AB2-707F-4B38-82B2-97C89D522DD1}`，ProductLanguage **2052**
- 两者 **UpgradeCode 相同** `{6CB9B379-977E-564A-AE1B-603E96D8C8F2}`

> 即：Tauri 给每种 culture 生成**不同的 ProductCode**（Wave18 假设的「同 ProductCode 冲突」
> 被证伪），但共享 UpgradeCode。同机二选一部署，不能并存。

## 3. 真正的根因（Wave18 失败、Wave19 通过的差别）

Wave18 N 路两次红叉（runs #110 / #113），加 settle + 1618-retry 仍败——**那不是根因**。

Wave19 A 第 1 轮（run #127）把 msiexec 退出码、ProductCode、install log 尾部、Uninstall
注册表项轮询全部打到 `::error` / `::notice`（check-run annotations，匿名 GitHub API 可读），
拿到决定性证据：

- zh-CN `msiexec /i` **exitcode = 0（安装成功）**；
- 但断言步骤硬编码检查 `C:\Program Files\drawpaper` —— **目录不存在**，于是失败。

第 2 轮（run #130）把断言从「硬编码 Program Files」改成**广域搜盘**（Program Files /
Program Files (x86) / `%LOCALAPPDATA%\Programs` 下找 `drawpaper.exe`），立刻定位：

> zh-CN MSI 实际装到了 **per-user** 路径 `C:\Users\runneradmin\AppData\Local\Programs\drawpaper\drawpaper.exe`，
> ProductVersion = `0.1.0-rc.10`，卸载后 `dir-removed=True`（干净）。

即：**安装/卸载一直是好的**，Wave18 的断言路径写错了（WiX 模板在该 CI 上下文里走 per-user
InstallScope，不落 Program Files）。改成与 en-US 轮一致的多候选发现后，zh-CN 装 / 版本 / 卸
真过。

## 4. 静默部署说明（企业）

两种 culture 的 MSI 二选一部署（同 ProductCode 族，同机不并存）：

```powershell
# en-US（英文向导，ProductLanguage 1033）
msiexec /i drawpaper_<ver>_x64_en-US.msi /qn /norestart /lv* install.log
msiexec /x drawpaper_<ver>_x64_en-US.msi /qn /norestart

# zh-CN（中文向导，ProductLanguage 2052）
msiexec /i drawpaper_<ver>_x64_zh-CN.msi /qn /norestart /lv* install.log
msiexec /x drawpaper_<ver>_x64_zh-CN.msi /qn /norestart
# 退出码 0 或 3010（需要重启）都算成功
```

## 5. NSIS 不受影响

`bundle.windows.nsis` 一行未动；NSIS 7 步冒烟（静默装 / .kbnote 注册表 / 快捷方式 / 启动标题 /
全局快捷键 / 二次启动吸收 / 卸载）与既有全部冒烟零回退。NSIS 仍按 `installMode: both` +
`displayLanguageSelector` 自带中/英向导语言选择，与 MSI 的 culture 双包是两套独立机制。

## 6. 分支与红线自检

- 只推 `fix/msi-zhcn-smoke`（白名单自加一行）；未碰 develop / main / tag。
- 版本红线零改动：app `0.1.0-rc.10`、`wix.version` `0.1.0.10`。
- 改动面：`tauri.conf.json` 的 `bundle.windows.wix` 段、`release-windows.yml`（白名单 + MSI
  选包 pin / zh-CN 探针步骤 / List MSI / SHA256SUMS=6 / release body）、本文件、
  `apps/desktop-tauri/README.md` MSI 语言相关句、`CHANGELOG.md` 未发布段。
- 未改任何 Rust / Cargo / packages / NSIS 步骤 / ci/*.ps1。

# Wave 18 — WiX MSI 双语 culture 双包（en-US + zh-CN）：**结论「不做」（已回退）**

> 状态：本波尝试给 WiX MSI 加 zh-CN 中文 UI culture。**构建侧成功**，但 x64 zh-CN 安装/卸载
> 冒烟两次失败，且匿名 CI 日志正文不可读、无法在止损窗口内定位根因。按止损指令**回退到
> rc.9 的英文 MSI 单文化矩阵**（NSIS×2 + MSI en-US×2 = 4 包）。分支上仅保留 push 白名单探针，
> `wix.language` 已撤除，未合入任何出包改动。
> 基线：`0ef0ff5`（rc.9）。分支：`feat/msi-bilingual`。

## 1. 做了什么（已回退的尝试）

`bundle.windows.wix` 增加 `"language": ["en-US", "zh-CN"]`（schema 已核实：
`WixLanguage = string | string[] | map`，数组即每种 culture 一个包，语言键即文件名后缀，
见 <https://v2.tauri.app/distribute/windows-installer/>）。`wix.version: "0.1.0.9"` 与 app
`0.1.0-rc.9` 全程零改动；NSIS 一行未动。

配套在 `release-windows.yml`：把 en-US 轮选包 pin 到 `*_x64_en-US.msi`、新增 x64 zh-CN
静默装/卸冒烟、上传前打印 MSI 名+大小、`SHA256SUMS` 行数断言改 6。

## 2. 实测证据（CI 权威门）

| 项 | 结果 |
|---|---|
| `Tauri build (NSIS + MSI, x64)` | ✅ 绿 —— **双语 MSI 成功产出，无需自定义 fragment / .wxl**（WixUIExtension 内置 zh-CN 本地化开箱可用，构建未报任何语言包缺失） |
| arm64 build job | ✅ 绿；上传 `msi-arm64` artifact = **11.6 MB**（约 = 2 × ~5.8 MB，对应 en-US + zh-CN 两个 arm64 MSI） |
| en-US MSI 整轮冒烟（装→注册表→快捷方式→启动标题→卸净） | ✅ 全绿，与 rc.9 基线一致 |
| NSIS 冒烟 | ✅ 未受影响（`*-setup.exe`×2 正常） |
| **新增 `Smoke (x64 MSI zh-CN): silent install + uninstall`** | ❌ **两次失败** |
| web-ci（feat/** 自动触发） | ✅ 绿 |

失败 run：
- `#110` run id `37657688949`（commit `0c9a8be`，首版双语）：x64 zh-CN 冒烟红叉，其后上传步骤全部跳过。
- `#113` run id `37660508380`（commit `09555b5`，加「安装前排空 msiexec + 1618 繁忙单次重试」）：
  **仍在同一步骤红叉**。说明不是瞬时 1618 busy。

x64 job 总时长从 `#110` 的 12m32s 增至 `#113` 的 17m46s——zh-CN 的 `msiexec /i` 实际跑起来了
（不是「找不到 `*_x64_zh-CN.msi`」那种秒败），但既未通过安装退出码断言，也未通过卸载目录清理断言。

## 3. 为什么停手（不硬凑）

- **不是**「WiX 3.14 内置 zh-CN 语言包缺失 / 必须自定义 fragment 才能生成中文 MSI」——
  构建步骤两次都绿，zh-CN MSI 确实产出。
- 但 zh-CN MSI 在 x64 runner 上**静默装/卸冒烟不通过**（en-US 同包同流程全绿）。二者仅 UI culture
  与 ProductLanguage 不同，疑似同 ProductCode 顺序装-卸交互 / 或该 culture 包在英文系统上的安装行为
  差异。
- 仓库匿名 `api.github.com` 限流、job 日志正文匿名不可见，**止损窗口内拿不到 msiexec 退出码与
  install log tail**，无法在不再烧 CI 周期的前提下确认根因。
- 按「严禁硬凑、严禁假绿」原则，**不**把一个冒烟未通过的 zh-CN MSI 当成可用产物发布。

## 4. 回退内容（现状 = rc.9 英文矩阵）

- `tauri.conf.json`：撤掉 `wix.language`，恢复 `wix = { "version": "0.1.0.9" }`。
- `release-windows.yml`：撤掉 zh-CN 冒烟步骤、en-US 选包 pin、List MSI 步骤、SHA256SUMS=6 断言、
  release body 双语清单；**仅保留** push 白名单 `- 'feat/msi-bilingual'`（分支触发器）。
- `apps/desktop-tauri/README.md`、`CHANGELOG.md`：恢复基线（英文 MSI 矩阵，4 包）。
- 产物回到：NSIS×2 + MSI en-US×2 = **4 个 Windows 安装包**，`SHA256SUMS.txt` 4 行。

## 5. 后续（若重启此波）

需要一次**有日志权限**的环境复现：直接看 zh-CN 那次 `msiexec /i` 的真实退出码（1603? 1638?）
与 install log tail，再决定是否需要：拆 ProductCode（每 culture 独立 GUID）、或 zh-CN 自定义
`.wxl` fragment。当前证据不足以支撑直接发 zh-CN 包。

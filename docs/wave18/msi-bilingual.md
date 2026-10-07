# Wave 18 — WiX MSI 双语 culture 双包（en-US + zh-CN）

> 范围：仅 Windows 安装包出包配置（`bundle.windows.wix`）与 `release-windows.yml` 冒烟 / 收集断言。
> 不改任何 Rust / Cargo / packages / NSIS 配置 / 版本字段。
> 基线：`0ef0ff5`（rc.9）。分支：`feat/msi-bilingual`。

## 1. 目标

rc.9 基线的 WiX MSI 只产 en-US 单文化包（安装向导 / 错误提示全英文）。企业批量部署里有中文
系统用户，希望安装界面随系统语言。本波给 WiX MSI 加上 **en-US + zh-CN 两种 UI culture**，
x64 与 arm64 各出两个 MSI（共 4 个 MSI），NSIS 行为完全不动。

## 2. 配置键（唯一出包改动）

`apps/desktop-tauri/src-tauri/tauri.conf.json` → `bundle.windows.wix`：

```jsonc
"wix": {
  "version": "0.1.0.9",          // 既有数字 ProductVersion 覆盖，原样保留不动
  "language": ["en-US", "zh-CN"] // 新增：数组 = 每种 culture 出一个独立 MSI
}
```

- 键名 / 形态已对 Tauri 2 config schema（`https://schema.tauri.app/config/2`）核实：
  `WixConfig.properties.language`，`anyOf: string | string[] | map`，默认 `"en-US"`。
  传数组即「每种 culture 一个包」，无需自定义 WiX fragment / .wxl 模板——WixUIExtension
  v3.14 自带 zh-CN 本地化（已编译进扩展，开箱可用）。
- `wix.version: "0.1.0.9"` 是 MSI ProductVersion 数字覆盖（rc.9 基线值），**本波零改动**；
  两种 culture 共用同一个 ProductVersion。
- NSIS 段（`installMode` / `displayLanguageSelector` / `languages` / 两张位图）一行未动。

## 3. 产物矩阵（一次 release-windows 构建）

| 架构 | NSIS（不变） | WiX MSI（本波 ×2 culture） |
|---|---|---|
| x64 | `drawpaper_<ver>_x64-setup.exe` | `drawpaper_<wixver>_x64_en-US.msi` + `..._x64_zh-CN.msi` |
| arm64 | `drawpaper_<ver>_arm64-setup.exe` | `drawpaper_<wixver>_arm64_en-US.msi` + `..._arm64_zh-CN.msi` |

共 **6 个安装包**：NSIS×2（不变）+ MSI×4（x64/arm64 × en-US/zh-CN）。
`SHA256SUMS.txt` 同步变为 6 行，publish job 对行数硬断言 `-eq 6`。

### 3.1 实测文件名与大小（CI 产物证据，待回填）

> 来源：release-windows 双架构 run 的 `List MSI artifacts to upload` 步骤输出（每文件
> 全名 + 字节数）与 publish job 的 `SHA256SUMS.txt` cat。

| 文件 | 大小 |
|---|---|
| （待回填：`<run URL>`） | |

## 4. 企业 msiexec 静默部署（两种 culture）

两种 culture 的 MSI **ProductCode / UpgradeCode 相同**，仅 UI 文化不同，同一台机器上**不能
并存**——企业按目标机 UI 偏好二选一部署即可：

```powershell
# 英文界面包（默认，与 rc.9 之前一致）
msiexec /i drawpaper_0.1.0.9_x64_en-US.msi /qn /norestart /lv* install.log   # 0 或 3010 都算成功
msiexec /x drawpaper_0.1.0.9_x64_en-US.msi /qn /norestart                    # 卸载

# 中文界面包（新增）
msiexec /i drawpaper_0.1.0.9_x64_zh-CN.msi /qn /norestart /lv* install.log
msiexec /x drawpaper_0.1.0.9_x64_zh-CN.msi /qn /norestart
```

- 仍是 per-machine 装到 `C:\Program Files\drawpaper`，需要管理员；`/qn` 全程无界面，
  culture 只影响本来就看不见的向导文案——静默部署下两种包行为等价，区别在交互安装时。
- 从 en-US 包升级 / 换 zh-CN 包：ProductCode 相同，直接新包覆盖安装即可（同产品码
  升级路径），用户数据不动。

## 5. NSIS 不受影响

- `bundle.windows.nsis` 配置（`installMode: "both"`、`displayLanguageSelector: true`、
  `languages: [SimpChinese, English]`、两张 bmp 位图）**一行未动**。
- NSIS 的中英双语向导是它自己的语言选择器体系，与 WiX `wix.language` 完全独立——
  NSIS 本来就支持中 / 英，本波只解决 MSI 侧的单文化问题。
- CI 里 NSIS 7 步冒烟一个字没改，产物仍是 `*-setup.exe`×2 + `.sig`（若配了签名）。

## 6. CI 改动清单（release-windows.yml，只增不删）

1. push 分支白名单新增 `- 'feat/msi-bilingual'`。
2. 既有 en-US 轮 MSI 选包从裸 `*.msi | Select -First 1` 精化为 `*_x64_en-US.msi`
   （install 步与 uninstall 步各一处；双文化后同目录有两个 MSI，裸选第一个会歧义）。
3. 新增 `Smoke (x64 MSI zh-CN): silent install + uninstall of zh-CN culture`：
   前置断言 en-US 轮已卸载干净 → `*_x64_zh-CN.msi` 静默装 → 断言
   `C:\Program Files\drawpaper\drawpaper.exe`（+ ProductVersion 打印）→ 静默卸 →
   60s 有界等待目录移除。与 en-US 轮严格串行。
4. `Upload MSI installer artifact` 前新增 `List MSI artifacts to upload (name + size
   evidence)`：打印 bundle/msi 下每个 MSI 全名 + 字节数（匿名日志正文不可见，证据全靠
   Write-Host）。上传 glob `bundle/msi/*.msi` 天然收两种 culture，无需改 glob。
5. publish job：`SHA256SUMS.txt` 行数断言从 `-ge 4` 写死为 `-eq 6`（NSIS×2 + MSI×4），
   注释列明构成；release body 的 MSI 清单补 zh-CN 两条、校验和描述改「六个安装包」。
6. arm64 MSI 维持**只构建不执行**（无 ARM runner）。

## 7. 红线自检

- `wix.version` / app `version` 零改动（diff 里 tauri.conf 只多 `language` 一个键）。
- 不切 tag、不动 develop/main；只推 `feat/msi-bilingual`。
- 未新增 WiX license / fragment / 自定义模板（基线 en-US 就没配 license，zh-CN 用扩展内置
  本地化，实测零自定义成本）。

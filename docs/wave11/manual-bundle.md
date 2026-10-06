# Wave 11 阶段 B：手动备份包通道 + 引导式同步面板 + 冲突副本处理

> 契约冻结点。core 合并语义（`mergeSnapshots`）零改动；`.kbpack` 是 store-only ZIP，
> 全程手写、零新依赖（不引 jszip/fflate/yauzl）。手动通道一次性搬运、不常驻、零网络。

## 1. 目标与范围

- **手动备份包通道**：把全部文档 + 附件导出成单个 `.kbpack` 文件，拷到另一台设备导入合并。
  补「无 FSA / 无 WebDAV 服务器」浏览器的降级路径。
- **引导式三通道面板**：把原两通道（同步文件夹 / WebDAV）扩成三卡片引导；首次打开出可跳过引导弹层。
- **冲突副本处理 UI**：聚合三来源的 `*.conflicted-*.kbnote`，逐项给三个确定性动作。
- **零新依赖**：CRC32 + ZIP 本地文件头 / 中央目录 / EOCD 全部手写。
- 保留现有单个 / 多个 `.kbnote` 导入（TopToolbar 文件选择）行为不变。

## 2. `.kbpack` 二进制结构（手写 store-only ZIP）

`.kbpack` 就是一个标准 **ZIP**（`application/octet-stream`，扩展名自定义），
压缩方式 `method=0`（store，不压缩——图片/附件本身已压缩）。可用系统 `unzip` 解开交叉验证。

包内布局：

```
manifest.json              清单：全部文档条目 + 每文档 vv / 墓碑 / 资产清单
docs/<docId>.kbnote        文档本体（UTF-8 JSON，与 FSA/WebDAV 通道同格式，v3）
assets/<assetRef>          文档引用的二进制资产（原样字节）
```

### 2.1 ZIP 物理布局

```
[本地文件头 30B][文件名 UTF-8][文件数据]   × N
[中央目录头 46B][文件名 UTF-8]            × N
[EOCD 22B]
```

- **本地文件头**：签名 `0x04034b50`，method=0，GP 位标志 `0x0800`（文件名 UTF-8），
  CRC32 / 压缩大小 / 原大小（store 下二者相等）。
- **中央目录头**：签名 `0x02014b50`，记录每文件 CRC、大小、本地头偏移。
- **EOCD**：签名 `0x06054b50`，记录条目总数、中央目录大小/偏移。
- 文件名一律 UTF-8 编码（含中文文件名也能被系统 `unzip` 正确解码）。
- DOS 时间/日期字段固定为 1980-01-01 00:00（真实 mtime 记在 `manifest.json`）。

### 2.2 CRC32

标准 IEEE 802.3 反射多项式 `0xEDB88320`，init/final XOR `0xFFFFFFFF`。
已知向量单测锁定：`CRC32("123456789") = 0xCBF43926`、`CRC32("a") = 0xE8B7BE43`。

### 2.3 manifest.json 形状

```json
{
  "format": "kbpack-manifest",
  "version": 1,
  "createdAt": 1700000000000,
  "deviceId": "<deviceClientId>",
  "docs": {
    "<docId>": {
      "file": "docs/<docId>.kbnote",
      "title": "...",
      "version": 3,
      "vv": { "<clientId>": <lamport> },
      "tombstones": { "nodes": [...], "edges": [...] },
      "assets": ["<assetRef>"],
      "modifiedAt": 1700000000000
    }
  }
}
```

逐文档带 vv / 墓碑，是为了导入时能走与在线通道同一套 `mergeSnapshots` 合并语义。

## 3. 导出 / 导入语义

- **导出全部为单个备份包**（`kbpack-transfer.exportAllToKbpackBlob`）：
  读 `db.docs` 全量 → `stampForPersist` → 构建 manifest → 打包（文档 + 并集资产）→ Blob 下载。
- **导入备份包并合并**（`importKbpackBundle`）：
  1. `unpackZip` 逐条 CRC 校验，解析 `manifest.json`；
  2. `planKbpackImport` 纯决策：本端没有该 docId → `new`（直接收）；本端已有 → `merge`；
  3. 逐文档 `mergeSnapshots(本端, 包内)`——**绝不整包覆盖**；
  4. 资产按 manifest 把 `assets/<ref>` 经 `writeAssetToRef` 回填 OPFS（仅补本端缺失）。
- 解析失败（非 ZIP / CRC 坏 / 缺 manifest）时**本端零改动**（先解后写）。

## 4. 引导式同步面板

三通道卡片（互斥）：

1. **同步文件夹（FSA）**——选本地文件夹自动双向同步。`isFsaDirectorySupported()` 为 false 时置灰。
2. **WebDAV**——连自有服务器；阶段 A 的端到端加密开关 / 口令 / 解锁 / 换口令控件与 testid
   （`e2ee-toggle` / `e2ee-pass` / `e2ee-confirm` / `e2ee-remember` / `e2ee-unlock-row` /
   `e2ee-change-row` 等）原样保留，行为不变。
3. **手动备份包**——导出全部 / 导入合并两个按钮（`bundle-export` / `bundle-import`）。
   无 FSA 浏览器下自动加 `border-primary` 高亮 + `manual-recommend`「推荐」徽标。

首次打开同步设置出三步引导弹层（`onboard-step-1/2/3`），可点「跳过」（`onboard-skip`）；
跳过状态记 `localStorage['drawpaper-sync:onboarded']='1'`，不再弹出。

## 5. 冲突副本三动作语义

冲突副本统一登记在 `drawpaper-sync` Dexie 库的 `conflictCopies` 表
（在线通道写远端 `《标题》.conflicted-<时间>.kbnote` 时同步登记；手动通道导入冲突直接登记）。
面板（`open-conflict-panel` → `conflict-row`）逐项三动作：

| 动作 | testid | 语义 |
|---|---|---|
| 打开为新文档预览 | `conflict-preview` | 副本解析后换**新 docId** 载入浏览（标题 `[副本预览] …`），不覆盖原文档 |
| 以此副本为准 | `conflict-adopt` | `resolveCopyAsWinner`：副本正文/标题/节点/边/页面全量胜出；vv 取并集、资产取并集、墓碑并集传播（不复活已删节点），落库 |
| 丢弃 | `conflict-discard` | 删本地登记；在线通道连着时一并删通道侧副本文件 |

## 6. e2e 证据（`e2e/sync-manual-bundle.spec.ts`，E2E_PORT=4198）

1. **导出 kbpack → 清空库 → 导入合并还原**：多文档 + 一个 OPFS 资产；删资产后导入，
   `opfsHasAsset` 回到 true，两文档内容各自还原。
2. **冲突三动作**：seed 一条冲突副本 → 预览开出 `[副本预览]` 新文档 → 采纳后原文档内容变为副本内容、列表清空 → 再 seed 一条点丢弃后列表清空（`conflict-list-empty`）。
3. **无 FSA 高亮**：`setFsaSupported(false)` 删 `window.showDirectoryPicker` → 面板出现 `manual-recommend` 徽标、`channel-manual` 带 `border-primary`。
4. **单文件导入仍可用**：走真实 `importKbnoteText`（parse + 迁移 + loadDoc）。

## 7. 门禁

- `pnpm -r build` / `pnpm typecheck` / `pnpm lint`（0 error）。
- 单测：core 273 不变；web 285 → **297**（新增 12：CRC32 向量、ZIP 往返含中文文件名/多文件/空包、bad-crc/not-zip、manifest 决策、副本胜）。
- `E2E_PORT=4198 npx playwright test`：75 passed +1 skipped 基线 → **+4 新增**（不回退）。
- `OFFLINE_PORT=4206 npx playwright test --config playwright.offline.config.ts`：4 passed 不变。
- `node scripts/verify-precache.mjs`：通过。
- 零新依赖；手动打包/导入全程零网络；未配通道零请求。

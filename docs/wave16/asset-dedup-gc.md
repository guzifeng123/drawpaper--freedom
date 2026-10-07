# Wave16 F：资产内容 hash 化去重 + 孤儿资产 GC

> 状态：随 `feat/asset-dedup-gc` 交付（两阶段：阶段一迁移+去重，阶段二 GC+保留区）。

## 1. 目标

- 相同内容的图片 / 附件只存一份 blob（content-addressed storage），跨文档共享同一引用。
- 删除文档后无人引用的孤儿 blob 不直接物理删除，先移入「保留区」，由用户在设置里确认后才清。
- 全程幂等、可重入；老档（v3 nanoid ref）透明迁移不丢资产。

## 2. 引用方案（content-addressed）

- 写入时按字节算 SHA-256，文件名即 `hex(sha256)`（64 位小写 hex）。
- hash 在 **web 侧**用 Web Crypto `crypto.subtle.digest('SHA-256', bytes)` 计算并封装在
  `storage/opfs.ts`；core 只把 hash 当不透明字符串（`isContentHashRef(ref)` 判形状）。
- `putAsset(blob)` 改为内容寻址：先读字节 → 算 hash → 同名已存在则跳过写入（幂等）。
- 跨设备同步拉取仍 `writeAssetToRef(ref, bytes)` 同名落盘；ref 现在天然是 hash，
  远端 `assets/<hash>` 目录去重由 `listRemoteAssets` 清单 + `pushMissingAssets` 的全局 Set 完成。
- E2EE：资产字节在通道层包 AES-GCM 信封，资产名（远端文件名）仍是 hash。

## 3. schema v3 → v4

- `CURRENT_DOC_VERSION = 4`。
- core 纯迁移步 `migrateV3ToV4`（注册进 `MIGRATION_REGISTRY[3]`）：
  assetRefs 去空、去重、稳定顺序，版本抬到 4。**幂等**（重复跑结果不变、不丢 ref）。
- 字节级「旧 nanoid → 内容 hash」重命名在 **web 侧启动时** `storage/asset-reconcile.ts`：
  遍历活动 + 回收站文档，对「非 64-hex」的 ref 读 blob → 算 hash → 落到 `<hash>` →
  改写 `assetRefs` → 回写 IndexedDB；最后清理已无引用的旧 nanoid blob。重复运行跳过已迁移项。

## 4. 引用计数与不可达集合（core 纯函数）

`packages/core/src/sync/asset-gc.ts`：

- `computeAssetGcPlan({ docs, trashDocs, conflictCopyRefs, knownAssets, vv })`
  - `reachable` = ⋃(docs.assetRefs) ∪ ⋃(trashDocs.assetRefs) ∪ conflictCopyRefs。
  - `reclaimable` = knownAssets − reachable（孤儿，进保留区候选）。
  - `refcount` = 每个 ref 被活动文档引用的文档数（回收站/冲突副本只保活、不计数）。
  - `watermark` = `safeTombstoneWatermark(vv)`；>0 时 `mayPhysicallyPurge=false`（落后副本可能重引用）。
- `orphanRefsAfterPurge(purgedDoc, remainingDocs, remainingTrashDocs, conflictCopyRefs)`
  —— 物理清除一份回收站文档时，只把「refcount 归零」的 ref 移进保留区。

保守策略：仍被冲突副本引用、或在安全水位内可能被落后副本重引用的资产，一律不物理删。
自动动作只「移进保留区」（可恢复）；物理清除必须用户手动确认。

## 5. Web 侧保留区与 GC 编排

- OPFS 主资产目录 `drawpaper-assets/`；保留区 `drawpaper-assets/.trash/assets/<ref>` + `.meta.json` 边车
  （记录原 ref / movedAt / sourceDocId）。
- `storage/asset-gc-web.ts`：
  - `orphansAfterPurge` / `moveOrphansToTrash`：purgeTrash / emptyTrash 触发，孤儿移入保留区。
  - `runManualAssetCleanup`：计算全部不可达资产并移入保留区，返回可回收体积。
  - `confirmEmptyRetention`：用户确认后物理清空保留区。
- 设置（回收站对话框）新增「未使用资产」区：显示保留区占用（人类可读），
  「扫描未使用资产」把孤儿移入保留区，「清空保留区」二次确认后物理删除。

## 6. 安全 / 边界

- core 零 DOM / React / SubtleCrypto；hash 计算只在 web 侧。
- 不动 `apps/**`、`.github/workflows/**`、版本号；CHANGELOG 只加 Unreleased 段。
- 不引入 zip / webdav 库；.kbpack 仍手写 store-only ZIP。

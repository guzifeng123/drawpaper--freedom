# Wave14·B 路：同步资产推送（修复「资产只拉不推」）

## 缺陷回顾

跨设备同步一轮由 `packages/web/src/sync/orchestrator.ts` 编排。旧实现里：

- **push 段（4a）** 只对 `bundle.pushDocIds` 调 `channel.pushDoc`，把 `.kbnote` 文档本体传走；
- **pull 段（4c）** 却会遍历合并后文档的 `assetRefs`，对本地缺失的资产调 `channel.pullAsset` 从远端拉回 OPFS。

全仓非测试代码此前**零 `channel.pushAsset` 调用点**。后果：一台设备新建的图片块/附件块，
文档元数据（`.kbnote`，含 `assetRefs`）能同步到对端，但二进制字节永远留在本机 OPFS。
对端拉到文档后 `image.src=<ref>` 在本地找不到字节 → 裂图、附件打不开。即「资产只拉不推」。

手动备份包通道（`kbpack-transfer.ts`）早已正确处理资产（manifest `missingAssets` 计算 + 打包），
在线两通道漏了这一半。

## 本波修复

在 orchestrator 新增 **4d 资产推送**，紧跟文档 push/pull/merge 之后：

1. **收集本地待传 ref**：取本轮收敛的文档集合 `pushDocIds ∪ pullIds`，逐篇从本地库读出
   `assetRefs`，并入一个全局 `Set`（跨文档同 ref 自动去重）。
   - `pushDocIds`：本端领先/独有的文档——其引用的资产必须随文档一起上去；
   - `pullIds`：对端领先/合并后的文档——合并结果的 `assetRefs` 是两端并集，因此对端带来的
     文档若引用了「本端才有」的资产（如 B 本地后加的图），也会在这一步被反向推回远端，
     实现资产双向收敛。
2. **比对远端已有清单**：`channel.listRemoteAssets()` 返回远端 `assets/<ref>` 里已有 ref 集合。
   - FSA：递归列目录后过滤 `assets/` 前缀；
   - WebDAV：`PROPFIND assets/`（`WebDavClient.list('assets')`，目录不存在返回 `[]`）。
3. **缺失集 = 本地 refs − 远端 refs**，逐个从本地 OPFS 读字节（动态 `import('@/storage/opfs')`，
   与 4c 同款写法），调 `channel.pushAsset(ref, bytes)`。

**容错与观测**：单个资产 OPFS 读不到或通道上传失败，只记 `result.assetsFailed += 1` 并 `continue`，
不阻断文档同步（与 4c 容错风格一致）；成功计数 `result.assetsPushed` 进 toast 与
`syncController.inspect().lastRun`（e2e 去重断言用）。pull 段行为保持不变。

**E2EE 接通**：WebDAV 通道 `pushAsset` 在开启口令时本就把字节包成自描述信封
（`encryptBundle` → JSON body），本波只负责把 orchestrator 接到这条路径上。服务器侧
资产 PUT body 是密文信封，grep 不到 PNG 签名/固定 fixture 字节（见 e2e ③）。

## 去重算法要点

- 全局 `Set<string>` 去重：同一 ref 被多篇文档引用只传一次；
- 远端已有 ref 不重传：第二轮同步 `lastRun.assetsPushed === 0`（e2e ④ 断言）；
- 引用与字节解耦：只传「文档引用了、且远端没有」的 ref，不传本端 OPFS 里孤儿 ref。

## 本波明确不做（留待后续波次）

- **孤儿资产 GC**：文档删除后无人引用的资产 ref，本波**保守保留**在远端 `assets/` 与本地 OPFS，
  不做垃圾回收。删除文档只推进文档侧水位，不回删资产文件。GC 需跨轮对账远端清单与全量文档
  assetRefs 并集，涉及误删风险，单开波次评审。
- **assetRef 内容 hash 化迁移**：本波保持 nanoid ref 方案；内容寻址 dedup 另开波次。
- **周期 compact**：不做。

## E2EE 附带打磨（wave11 遗留）

- **冲突副本文件名不泄露标题**：开启 E2EE 时，远端 conflicted 副本文件名由
  `《标题》.conflicted-<时间>.kbnote` 改为 `<docId>.conflicted-<时间>.kbnote`（docId 派生名），
  文档标题保留在信封密文内；未加密通道（FSA / 明文 WebDAV）维持可读命名。冲突副本中心
  （`conflict-copies.ts` / `ConflictCopiesDialog`）仍从本地登记行的 `title` 字段取展示名，
  三通道登记与展示不回退。
- **PBKDF2 派生密钥会话内缓存**：crypto 模块以 `(passphrase|saltB64|iterations)` 为键内存缓存
  CryptoKey，同口令同 salt 不重复跑 310k 派生；仅内存、刷新即失效，单测覆盖命中与隔离。

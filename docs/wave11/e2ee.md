# Wave 11 阶段 A：WebDAV 可选端到端加密（E2EE）

> 契约冻结点。core 合并语义（`mergeSnapshots` / `planBundle` / orchestrator）零改动；
> 加密只在 WebDAV 通道边界做（PUT 前包信封、GET 后解信封）。默认关闭、用户主动开启。

## 1. 目标与范围

- 给 WebDAV 同步通道加**可选**端到端加密：开启后 WebDAV 服务器只能看到自描述加密信封，
  无法读取文档标题、块文本、清单内容。
- **FSA 同步文件夹通道不加密**（本地文件夹即用户自己的磁盘，见 §6）。
- **零新依赖**：只用浏览器 / Node 22 原生的 `globalThis.crypto.subtle`。
- 未开启时，Wave10 明文路径逐字节行为不变（单测 + e2e ④ 回归）。

## 2. 信封格式（外层 JSON 明文）

每条上传物（`.kbnote`、conflicted 副本、资产）都是一段 UTF-8 JSON：

```json
{
  "v": 1,
  "kdf": "PBKDF2-SHA-256",
  "enc": "A256GCM",
  "it": 310000,
  "salt": "<base64url, 16 字节>",
  "nonce": "<base64url, 12 字节>",
  "ct": "<base64url, AES-GCM 密文 ‖ 16B 认证标签>"
}
```

- `v`：格式版本。本端最高识别 1；未来版本号更高 → 直接报错，**不静默解析**。
- `kdf` / `enc`：算法标识，仅本端校验，不保密。
- `it`：PBKDF2 迭代次数，随包存放，解密自描述；当前冻结 **310 000**（OWASP 2023 对 SHA-256 的建议下限）。
- `salt`：每条随机 16 字节；`nonce`：每条随机 12 字节（GCM 推荐长度）。
- `ct`：AES-256-GCM 输出（密文后接认证标签）。
- 外层**只**有上述字段：没有 `format`/`version`/`id`/`title`/`blocks`，服务器 grep 不到任何业务内容。

派生密钥：`PBKDF2-HMAC-SHA256(passphrase, salt, it)` → AES-GCM-256 密钥（不可导出）。

## 3. crypto.ts 完整签名（阶段 B 对接用）

文件：`packages/web/src/sync/crypto.ts`（纯函数 / 纯异步，不碰 DOM / localStorage / 网络）。

```ts
export const ENVELOPE_VERSION = 1;
export const KDF_ID = 'PBKDF2-SHA-256';
export const CIPHER_ID = 'A256GCM';
export const PBKDF2_ITERATIONS = 310_000;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const KEY_BITS = 256;

export interface Envelope { v: number; kdf: typeof KDF_ID; enc: typeof CIPHER_ID;
  it: number; salt: string; nonce: string; ct: string; }

export type E2eeErrorKind = 'bad-envelope' | 'unsupported-version' | 'auth' | 'aborted';
export class E2eeError extends Error { kind: E2eeErrorKind; }

// 编码辅助（纯）
export function bytesToBase64Url(bytes: Uint8Array): string;
export function base64UrlToBytes(s: string): Uint8Array;
export function utf8Encode(s: string): Uint8Array;
export function utf8Decode(b: Uint8Array): string;

// 信封 parse / serialize（纯）
export function serializeEnvelope(env: Envelope): Uint8Array;
export function parseEnvelope(envBytes: Uint8Array): Envelope;   // 非法/高版本抛 E2eeError

// 高层（纯异步）
export interface EncryptOptions { salt?: Uint8Array; nonce?: Uint8Array; iterations?: number; }
export function encryptBundle(plaintext: Uint8Array, passphrase: string, opts?: EncryptOptions): Promise<Uint8Array>;
export function decryptBundle(envelopeBytes: Uint8Array, passphrase: string): Promise<Uint8Array>;
// 口令错 / 密文被篡改 → reject E2eeError('auth')
```

## 4. WebDAV 通道接入点

`WebDavSyncChannel` 构造新增可选第二参：`{ passphrase?: string }`。

| 方法 | 明文（未传 passphrase） | 加密（传了 passphrase） |
|---|---|---|
| `pullDoc` | `getBytes` → UTF-8 字符串（同 Wave10） | 解信封 → UTF-8 字符串 |
| `pushDoc` | `putText`（application/json） | `encryptBundle` → `putBytes`（信封 JSON） |
| `pullAsset` | `getBytes` 原样 | 解信封 → 原二进制 |
| `pushAsset` | `putBytes` 原样 | `encryptBundle` → `putBytes` |
| `writeConfcted` | `putText` | `encryptBundle` → `putBytes` |

- orchestrator 不感知加密：它拿到的永远是明文 KBNote 文本。
- 资产同样加密为信封（取舍见 §7）。

## 5. 口令生命周期

- **持久化（localStorage `drawpaper-sync:config`）**：仅存 `e2ee.enabled` 与 `e2ee.rememberSession` 两个布尔。
  **口令本身绝不写 localStorage。**
- **内存保存**：`SyncController.e2eePass`，页面刷新即失。
- **记住本次会话（默认关）**：勾选后口令镜像到 `sessionStorage`（`drawpaper-sync:e2ee-pass`），
  仅本标签页存活期有效；关闭标签页即失。
- **刷新后**：若配置开启加密而内存/会话都没有口令 → **不建通道、零网络请求**，
  设置面板 WebDAV 区显示解锁框（`data-testid="e2ee-unlock-row"`），输入后 `unlockWebdav()` 才上线。
- **错误口令**：GCM 认证失败 → `E2eeError('auth')`。本轮在「拉远端清单」阶段即失败，
  **尚未写本地、也未推远端**；通道被拆掉、进入锁定态、明确 toast。本地库与远端文件均不被破坏。
- **换口令**：`changeWebdavPassphrase(new)` → 清本地 base → 重建通道（新口令）→ 下一轮把全部本地文档
  以新口令信封全量重推。旧口令信封本端已无法解，视为全新起点；各端本地库内容完好，
  其它设备需用新口令解锁。

## 6. 威胁模型与边界

- **服务器端不可见**：文档标题、正文块、清单、资产二进制全部在信封内；WebDAV 管理员/被入侵服务器
  只能看到文件名与密文。
- **服务器端可见（明确接受）**：
  - 文件名（`<docId>.kbnote`、`assets/<随机hash>`）——随机串，不含语义；
  - 文件大小、修改时间、访问模式；
  - **conflicted 副本的文件名**仍带文档标题（`标题.conflicted-<时间>.kbnote`）。这是罕见的合并冲突产物，
    标题以明文文件名形式暴露；阶段 A 接受此边界（避免改 orchestrator 命名约定）。
- **传输层**：E2EE 与传输无关——即使 http 明文传输，密文本身仍不可读；但 Basic Auth 凭据仍裸奔，
  故 http 警告保留。
- **FSA 文件夹不加密的原因**：同步文件夹就是用户自己选的本地磁盘目录（或自己的 Syncthing 盘），
  等同于本地文件；再套一层信封只增加复杂度与迁移成本，不增加信任边界。
- **不防御**：恶意客户端（口令在内存中）、浏览器扩展、服务器侧侧信道流量分析。

## 7. 资产加密取舍

资产是**不可变二进制、文件名为随机 hash**。阶段 A 决定**资产也包成信封**：

- 优点：开启 E2EE 后服务器对图像/附件也零可见内容，威胁模型一致；实现与文档同一条 `encryptBundle` 路径。
- 成本：每个资产传输付一次 PBKDF2（310k，~数十 ms）。因资产不可变、每设备只拉一次，个人笔记规模下可忽略；
  未来若需优化，可在 `E2eeSession` 内缓存一次派生密钥、复用同一 salt 仅换 nonce。
- Wave10 orchestrator 当前只 pull 资产、尚未 push 资产；通道接口已预留加密路径。

## 8. 设置面板新增字段（阶段 B 对接）

WebDAV 区内新增（`data-testid` 供自动化）：

| 控件 | testid | 说明 |
|---|---|---|
| 端到端加密开关 | `e2ee-toggle` | 默认关；开启后显示口令区 |
| 加密口令 | `e2ee-pass` | ≥8 位 |
| 确认口令 | `e2ee-confirm` | 两次一致校验 |
| 记住本次会话 | `e2ee-remember` | Checkbox，默认关 |
| 口令错误提示 | `e2ee-error` | 长度/不一致 |
| 刷新解锁框 | `e2ee-unlock-row` / `e2ee-unlock-pass` / `e2ee-unlock` | 配置已开但未解锁时 |
| 已启用状态行 | `e2ee-active-row` / `e2ee-change-pass` | 解锁后展示 |
| 换口令区 | `e2ee-change-row` / `e2ee-new-pass` / `e2ee-new-confirm` / `e2ee-change-confirm` | 全量重推 |

面板文案（实际落地）：

- 开关副文案：「开启后服务器只看到加密信封，无法读取文档标题与内容」
- 解锁框：「端到端加密已开启：请输入口令解锁同步（不会把口令发给服务器）」
- 换口令说明：「更换口令后，本端会把全部文档以新口令重新加密推送一份；旧设备需用新口令解锁。」
- 已启用行：「端到端加密已启用（AES-256-GCM）」

## 9. e2e 证据（`packages/web/e2e/sync-e2ee.spec.ts`，route mock WebDAV）

1. **① 密文 grep**：开启加密后把 mock 服务器每个 `.kbnote` body 逐个 `JSON.parse` 断言
   `{v:1,kdf,enc,it,salt,nonce,ct}` 形状，并断言不含块文本 `E2EE-SECRET-BLOCK-42`、标题 `E2EE-SECRET-TITLE-42`、
   以及 `"title"`/`"blocks"` 键。
2. **② 同口令双向收敛**：A 推 → B 拉见「来自A加密」→ B 改「来自B加密」→ A 拉收敛；服务器上全部 `.kbnote` 均为信封。
3. **③ 错误口令**：B 用错误口令同步后 `syncInspect()` 为 `{e2eeLocked:true, hasChannel:false}`，
   B 本地块仍在、远端文件数与内容不变（仍是 A 的信封，未被覆盖）。
4. **④ 关加密恢复明文**：A 加密推送后关加密重连 → 同一文件被明文信封覆盖 → B 明文同步收敛。

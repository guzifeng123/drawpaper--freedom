//! Wave17 J2 — 冷启动外部文件打开事件的可靠投递队列。
//!
//! # 背景
//!
//! 进程未运行时双击 `.kbnote`（文件关联），Windows 把文件路径作为 `argv[1]` 传给首个
//! 实例。rc.8 的做法是在 `tauri::Builder::setup` 回调里读盘后**一次性 fire-and-forget**
//! `app:open-file` 事件。但 setup 回调运行时 webview 尚未加载、前端 React 也未挂载，
//! 前端对 `app:open-file` 的监听（`packages/web/src/host/desktop-bridge.ts` 里
//! `useEffect(() => initDesktopBridge(), [])` → `window.__TAURI__.event.listen(...)`
//! 的 Promise resolve 之后）要晚 1~2 秒才注册。Tauri 2 的 `emit` 对「无监听者」不做
//! 缓冲/重放，所以这一发必然丢失——日志和 recents 证明 Rust 收到了 argv[1]，但画布
//! 实际加载的是欢迎文档。详见 `docs/wave17/coldstart-race.md`。
//!
//! # 修复
//!
//! 本模块只承载**纯逻辑**（不依赖 tauri），lib.rs 用 `Mutex<StartupQueueInner>` 包一层
//! 放进 managed state：
//!
//!   * `open_external_path` 读盘后把富载荷 `{path,name,text}` 入队，并立即 emit 一次
//!     （热启动 / 菜单「打开最近」场景监听已就绪，这一发就够了）。
//!   * setup 里 spawn 一个有界重发泵：每 ~400ms 调 [`StartupQueueInner::retry_tick`]
//!     取出所有未确认载荷再 emit 一次，attempts+1；超过 `MAX_ATTEMPTS` 仍未确认则放弃。
//!     冷启动时第一发丢了，泵在前端监听就绪后的某个 tick 重发 → 命中。
//!   * **隐式 ack（零 web 改动）**：前端成功 `routeOpenFile` 后本来就会调用
//!     `bind_native_file(path)`。lib.rs 在该命令里追加 [`StartupQueueInner::ack`]，
//!     把同 path 的载荷摘掉 → 泵停止重发。前端 ack 是 < 100ms 的 IPC 往返，远小于
//!     400ms 重发间隔，因此收敛到恰好一次投递，不会重复加载。
//!
//! 热启动（单实例第二实例回调）与冷启动共用同一个队列/泵/ack 通道，不另起一套逻辑。

use std::collections::VecDeque;
use std::path::PathBuf;

/// 重发泵最大尝试次数（含首次立即 emit）。400ms × 12 ≈ 4.8s 后放弃。
pub const MAX_ATTEMPTS: u32 = 12;

/// 一次待投递的「外部打开 .kbnote」富载荷。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedOpen {
    /// 单调递增序号，便于日志对齐重发次数。
    pub seq: u64,
    /// 绝对路径（字符串，与前端 payload.path 一致）。
    pub path: String,
    /// 文件名（含 .kbnote 后缀）。
    pub name: String,
    /// Rust 已读好的全文文本（前端直接 parseKBNote，webview 无任意路径读权限）。
    pub text: String,
    /// 已经 emit 了几次（含首次立即 emit）。
    pub attempts: u32,
}

/// 投递队列的纯逻辑内核。非线程安全；lib.rs 用 `Mutex<StartupQueueInner>` 包一层。
///
/// 语义：
///   * `enqueue` —— 入队（同 path 已 pending 则去重，不重复入队）。
///   * `retry_tick` —— 泵每个 tick 调用：返回本 tick 要重发的载荷克隆，attempts+1；
///     超过 `max_attempts` 的载荷被丢弃。
///   * `ack` —— 前端消费后调用（经 `bind_native_file`）：摘掉所有同 path 载荷。
///   * `peek` / `pending_paths` —— 只读观察，不消费。
#[derive(Debug, Default)]
pub struct StartupQueueInner {
    pending: VecDeque<QueuedOpen>,
    next_seq: u64,
}

/// 从进程 argv 里挑出文件关联路径。
///
/// `argv[0]` 是 exe；Windows 文件关联双击把被打开的 `.kbnote` 路径作为 `argv[1]` 传入。
/// 非 `.kbnote` 扩展（例如单实例插件转发的无文件启动）一律忽略。
pub fn classify_argv(argv: &[String]) -> Option<PathBuf> {
    let p = argv.get(1)?;
    let pb = PathBuf::from(p);
    if pb.extension().and_then(|e| e.to_str()) == Some("kbnote") {
        Some(pb)
    } else {
        None
    }
}

impl StartupQueueInner {
    pub fn new() -> Self {
        Self::default()
    }

    /// 入队一个待投递载荷。若队列里已有**同 path** 的 pending 载荷（热启动双击同一文件、
    /// 或泵还没 ack 时又来一发），不重复入队，直接返回已有载荷的 seq。
    /// 返回本次（或已有）载荷的 seq。
    pub fn enqueue(&mut self, path: String, name: String, text: String) -> u64 {
        if let Some(existing) = self.pending.iter().find(|q| q.path == path) {
            return existing.seq;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.pending.push_back(QueuedOpen {
            seq,
            path,
            name,
            text,
            attempts: 0,
        });
        seq
    }

    /// 前端消费确认：摘掉所有 path 相同的 pending 载荷。返回是否摘掉了至少一个。
    pub fn ack(&mut self, path: &str) -> bool {
        let before = self.pending.len();
        self.pending.retain(|q| q.path != path);
        self.pending.len() != before
    }

    /// 队首载荷（只读，不消费）。空队列返回 None。
    pub fn peek(&self) -> Option<&QueuedOpen> {
        self.pending.front()
    }

    /// 当前所有 pending 路径（快照，most-recent 在后）。
    pub fn pending_paths(&self) -> Vec<String> {
        self.pending.iter().map(|q| q.path.clone()).collect()
    }

    /// 泵每个 tick 调用：返回 `(to_emit, dropped)`。
    ///
    ///   * `to_emit` —— 本 tick 要 emit 的载荷克隆（每个 pending 的 attempts 已 +1）。
    ///   * `dropped` —— attempts 超过 `max_attempts`、本次被放弃投递的载荷（lib.rs 负责
    ///     记日志）。
    ///
    /// 未 ack 的载荷不会被本函数移除 —— 重发语义就是「未确认就一直重发」。
    pub fn retry_tick(&mut self, max_attempts: u32) -> (Vec<QueuedOpen>, Vec<QueuedOpen>) {
        let mut to_emit = Vec::new();
        let mut dropped = Vec::new();
        let mut i = 0;
        while i < self.pending.len() {
            self.pending[i].attempts += 1;
            if self.pending[i].attempts > max_attempts {
                let gone = self.pending.remove(i).expect("index valid");
                dropped.push(gone);
                // 不 i+=1：remove 后下一个元素顶上来。
            } else {
                to_emit.push(self.pending[i].clone());
                i += 1;
            }
        }
        (to_emit, dropped)
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_argv_no_args_returns_none() {
        let argv = vec!["drawpaper.exe".to_string()];
        assert!(classify_argv(&argv).is_none());
    }

    #[test]
    fn classify_argv_empty_argv_returns_none() {
        let argv: Vec<String> = vec![];
        assert!(classify_argv(&argv).is_none());
    }

    #[test]
    fn classify_argv_kbnote_path_some() {
        let argv = vec![
            "drawpaper.exe".to_string(),
            r"C:\Users\me\Documents\note.kbnote".to_string(),
        ];
        let p = classify_argv(&argv).unwrap();
        assert_eq!(p, PathBuf::from(r"C:\Users\me\Documents\note.kbnote"));
    }

    #[test]
    fn classify_argv_non_kbnote_ignored() {
        let argv = vec![
            "drawpaper.exe".to_string(),
            r"C:\Users\me\Documents\note.txt".to_string(),
        ];
        assert!(classify_argv(&argv).is_none());
    }

    #[test]
    fn enqueue_assigns_increasing_seq() {
        let mut q = StartupQueueInner::new();
        let s1 = q.enqueue("a.kbnote".into(), "a".into(), "{}".into());
        let s2 = q.enqueue("b.kbnote".into(), "b".into(), "{}".into());
        assert_eq!(s1, 0);
        assert_eq!(s2, 1);
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn enqueue_same_path_dedupes() {
        let mut q = StartupQueueInner::new();
        let s1 = q.enqueue("a.kbnote".into(), "a".into(), "{}".into());
        // 热启动双击同一文件：第二次入队同 path，不应产生第二个载荷。
        let s2 = q.enqueue("a.kbnote".into(), "a".into(), "{}".into());
        assert_eq!(s1, s2, "duplicate enqueue returns existing seq");
        assert_eq!(q.len(), 1, "same path enqueued only once");
    }

    #[test]
    fn ack_removes_matching_path() {
        let mut q = StartupQueueInner::new();
        q.enqueue("a.kbnote".into(), "a".into(), "{}".into());
        q.enqueue("b.kbnote".into(), "b".into(), "{}".into());
        assert_eq!(q.len(), 2);
        assert!(q.ack("a.kbnote"));
        assert_eq!(q.len(), 1);
        assert_eq!(q.pending_paths(), vec!["b.kbnote".to_string()]);
        // 再 ack 一个不存在的 path：返回 false。
        assert!(!q.ack("nope.kbnote"));
    }

    #[test]
    fn ack_after_consuming_clears_queue() {
        let mut q = StartupQueueInner::new();
        q.enqueue("a.kbnote".into(), "a".into(), "{}".into());
        q.ack("a.kbnote");
        assert!(q.is_empty());
        // 泵再 tick 也不会重发。
        assert!(q.retry_tick(MAX_ATTEMPTS).0.is_empty());
    }

    #[test]
    fn retry_tick_increments_attempts_and_drops_after_max() {
        let mut q = StartupQueueInner::new();
        q.enqueue("a.kbnote".into(), "a".into(), "TEXT".into());
        // 前 max 次 tick：每次都返回该载荷，dropped 为空。
        for _ in 0..MAX_ATTEMPTS {
            let (emit, drop) = q.retry_tick(MAX_ATTEMPTS);
            assert_eq!(emit.len(), 1);
            assert_eq!(emit[0].text, "TEXT");
            assert!(drop.is_empty());
        }
        // 下一次 tick：attempts 已超 max，载荷被丢弃，to_emit 为空。
        let (emit, drop) = q.retry_tick(MAX_ATTEMPTS);
        assert!(emit.is_empty());
        assert_eq!(drop.len(), 1);
        assert_eq!(drop[0].path, "a.kbnote");
        assert!(q.is_empty());
    }

    #[test]
    fn retry_tick_does_not_consume_before_ack() {
        let mut q = StartupQueueInner::new();
        q.enqueue("a.kbnote".into(), "a".into(), "{}".into());
        // 连续 tick 三次（未 ack），每次都应返回载荷 —— 这正是重发语义。
        for _ in 0..3 {
            let (emit, _) = q.retry_tick(MAX_ATTEMPTS);
            assert_eq!(emit.len(), 1);
        }
        assert_eq!(q.len(), 1, "retry_tick must not remove pending before ack");
    }

    #[test]
    fn peek_does_not_consume() {
        let mut q = StartupQueueInner::new();
        q.enqueue("a.kbnote".into(), "a".into(), "{}".into());
        assert_eq!(q.peek().unwrap().path, "a.kbnote");
        assert_eq!(q.peek().unwrap().path, "a.kbnote", "peek is idempotent");
        assert_eq!(q.len(), 1);
    }
}

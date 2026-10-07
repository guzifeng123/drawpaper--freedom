//! Wave19 C — 更新器无网/异常回退的**无头确定性测试缝**。
//!
//! 把「检查更新」的**决策逻辑**抽成一个 tauri-free 纯函数，让菜单实际走的回退
//! 分支与隐藏 CLI `--update-check-probe <endpoint>` 走同一份分类代码：
//!
//! ```text
//! 一次 GET endpoint ──► FetchOutcome ──► classify() ──► Decision
//! ```
//!
//! - 菜单路径：`tauri-plugin-updater` 自己发那次请求（带公钥验签），成功路径
//!   （有新版 → 弹窗 → 下载安装）仍留在 `lib.rs`；失败/回退分支改用本模块的
//!   [`reason_from_error_text`] 归类后打开 Releases 网页。
//! - CLI 路径（本模块 [`probe_cli`]）：在 `run()` 最前、builder 之前拦截，不弹窗、
//!   不开 webview、不下载不安装，用一个**阻塞、带 8s 超时、绝不重试**的 HTTP
//!   客户端直连参数给定的 endpoint，走到「决策」为止就退出。供 CI 冒烟与排障。
//!
//! 零后台：本模块**没有任何定时器/轮询/启动检查**；`probe_cli` 只在显式 CLI 被
//! 调用时执行一次请求，菜单只在用户点击时执行一次请求。
//!
//! 退出码：`0` = 检查正常完成并得到一个明确决策（**含** fallback-releases ——
//! 不可达 / 404 / 畸形清单都是被正确处理的预期结果）；非 0 仅用于参数错误 /
//! 内部故障。stdout 打一行稳定可 grep 的 `decision=...`。

use std::time::Duration;

/// 一次对更新端点的 GET 拿到的原始结果（还没做版本比较）。
///
/// 把「网络/HTTP 层发生了什么」与「据此该怎么办」分开：纯函数只看这个枚举，
/// 不碰 reqwest 错误类型，所以能脱离 tauri / 网络做单测。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchOutcome {
    /// 连不上：DNS 失败 / 连接被拒 / 连接重置 / 无路由。
    Unreachable,
    /// 连上了但等响应超过超时。
    Timeout,
    /// 拿到了 HTTP 响应：状态码 + 响应体文本。
    HttpResponse { status: u16, body: String },
}

/// 回退到 Releases 网页的细分原因。这些**都是被正确处理的预期分支**，不是错误。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FallbackReason {
    Unreachable,
    Timeout,
    /// 4xx（含 404 —— Release 上还没有 latest.json）。
    Http4xx,
    /// 200 但响应体不是合法的更新清单 JSON（缺 version / 不是对象 / 不是 JSON）。
    MalformedManifest,
    /// 5xx / 其它未预期状态。
    Other,
}

impl FallbackReason {
    /// stdout 里稳定可 grep 的短串。
    pub fn as_str(self) -> &'static str {
        match self {
            FallbackReason::Unreachable => "unreachable",
            FallbackReason::Timeout => "timeout",
            FallbackReason::Http4xx => "http-4xx",
            FallbackReason::MalformedManifest => "malformed-manifest",
            FallbackReason::Other => "other",
        }
    }
}

/// 一次更新检查的最终决策。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 端点可达、清单合法、远端版本 > 当前版本 → 有更新（菜单会弹窗+下载）。
    UpdateAvailable { remote: String, current: String },
    /// 端点可达、清单合法、远端版本 ≤ 当前版本 → 已是最新。
    UpToDate { remote: String, current: String },
    /// 任何被我们刻意处理为「打开 Releases 网页」的失败模式。
    FallbackToReleasesPage(FallbackReason),
}

impl Decision {
    /// stdout 稳定行的 `decision=` 部分。
    pub fn as_stdout_line(&self) -> String {
        match self {
            Decision::UpdateAvailable { remote, current } => {
                format!("decision=update-available remote={remote} current={current}")
            }
            Decision::UpToDate { remote, current } => {
                format!("decision=up-to-date remote={remote} current={current}")
            }
            Decision::FallbackToReleasesPage(r) => {
                format!("decision=fallback-releases reason={}", r.as_str())
            }
        }
    }
}

/// 把「网络/HTTP 结果」分类成最终决策。**纯函数，不联网、不碰 tauri。**
///
/// `current_version` 是应用当前版本（编译期 `CARGO_PKG_VERSION`），用于和清单里的
/// `version` 字段比较；只有 200 + 合法 JSON 清单才会走到比较分支。
pub fn classify(outcome: FetchOutcome, current_version: &str) -> Decision {
    match outcome {
        FetchOutcome::Unreachable => Decision::FallbackToReleasesPage(FallbackReason::Unreachable),
        FetchOutcome::Timeout => Decision::FallbackToReleasesPage(FallbackReason::Timeout),
        FetchOutcome::HttpResponse { status, body } => {
            if (400..500).contains(&status) {
                return Decision::FallbackToReleasesPage(FallbackReason::Http4xx);
            }
            if status != 200 {
                // 5xx / 3xx-with-no-body / 其它未预期。
                return Decision::FallbackToReleasesPage(FallbackReason::Other);
            }
            // 200：必须能解析成带 version 字符串的 JSON 对象。
            match parse_manifest_version(&body) {
                Some(remote) => {
                    if version_greater_than(&remote, current_version) {
                        Decision::UpdateAvailable {
                            remote,
                            current: current_version.to_string(),
                        }
                    } else {
                        Decision::UpToDate {
                            remote,
                            current: current_version.to_string(),
                        }
                    }
                }
                None => Decision::FallbackToReleasesPage(FallbackReason::MalformedManifest),
            }
        }
    }
}

/// 从更新清单 JSON 里取出 `version` 字符串；缺字段 / 类型不对 / 不是 JSON → None。
///
/// 这里**不**校验 `platforms` 签名（那是 updater 插件带公钥做的事），只判断
/// 「响应体像不像一份更新清单」。
fn parse_manifest_version(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.as_object()?.get("version")?.as_str().map(|s| s.to_string())
}

/// 极简版本比较：按非数字切段，逐段比数字；远端任一数字段 > 当前即视为「有更新」。
/// 不追求完整 semver（预发布后缀 rc.N 也只比数字）——探针只需要粗判「远端更新」。
fn version_greater_than(remote: &str, current: &str) -> bool {
    let r: Vec<u64> = remote
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    let c: Vec<u64> = current
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    let n = r.len().max(c.len());
    for i in 0..n {
        let rv = r.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if rv > cv {
            return true;
        }
        if rv < cv {
            return false;
        }
    }
    false
}

/// 把菜单路径里 `updater.check()` 返回的错误文本归类成回退原因。
///
/// tauri-plugin-updater 的错误类型不暴露给本模块（保持 tauri-free），所以按错误
/// 消息里的关键词粗分类；分类结果只用于打日志/打 stdout，不影响是否回退
/// （任何 Err 都回退网页）。
pub fn reason_from_error_text(err: &str) -> FallbackReason {
    let e = err.to_lowercase();
    if e.contains("timeout") || e.contains("timed out") {
        FallbackReason::Timeout
    } else if e.contains("404") || e.contains("not found") {
        FallbackReason::Http4xx
    } else if e.contains("serde") || e.contains("json") || e.contains("parse") || e.contains("deserialize") {
        FallbackReason::MalformedManifest
    } else if e.contains("connection")
        || e.contains("dns")
        || e.contains("refused")
        || e.contains("unreachable")
        || e.contains("network")
    {
        FallbackReason::Unreachable
    } else {
        FallbackReason::Other
    }
}

/// 无头 CLI：直连 `endpoint`，一次 GET、8s 超时、不重试，走到决策就退出。
///
/// 返回进程退出码（见模块头注释）。stdout 打印一行 `decision=...`。
/// 同时把同一行写到 `%TEMP%\drawpaper-updater-probe.txt`，作为 CI 冒烟的
/// 权威读取源（GUI-subsystem 进程的 stdout 管道在 hosted runner 上可能不稳）。
pub fn probe_cli(endpoint: &str) -> i32 {
    // 阶段锚点：万一卡在 fetch 阶段，CI 能从诊断文件看到卡在哪一步。
    let diag = std::env::temp_dir().join("drawpaper-updater-probe.txt");
    let _ = std::fs::write(&diag, "stage=started\n");
    let outcome = fetch_once(endpoint);
    let _ = std::fs::write(&diag, format!("stage=fetch-done outcome={:?}\n", outcome));
    let current = env!("CARGO_PKG_VERSION");
    let decision = classify(outcome, current);
    let line = decision.as_stdout_line();
    println!("{}", line);
    // 追加最终决策行到诊断文件（权威读取源）。
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&diag) {
        let _ = writeln!(f, "{}", line);
    }
    0
}

/// 一次阻塞 GET，带 4s 连接超时 + 8s 总超时，把网络结果归约成 [`FetchOutcome`]。
///
/// 用 `std::net::TcpStream`（标准库、零外部依赖）而不是 reqwest::blocking：
/// reqwest::blocking 在本壳的 Windows GUI-subsystem、未启动 Tauri runtime 的无头
/// 上下文里会原生崩溃（CI 上 exit 0xC00004xx，panic=abort）。TcpStream 足够
/// 探测「可达/超时/连接拒绝」这一 CI 关心的回退分支；真实 HTTPS+验签由 updater
/// 插件在菜单流程里负责。出错（超时/连接拒绝/DNS/非 http 方案）一律映射成
/// Unreachable/Timeout，不 panic。
fn fetch_once(url: &str) -> FetchOutcome {
    let Some((host, port, path)) = parse_http_url(url) else {
        return FetchOutcome::Unreachable;
    };
    let addr = match format!("{host}:{port}").parse::<std::net::SocketAddr>() {
        Ok(a) => a,
        Err(_) => return FetchOutcome::Unreachable,
    };
    let mut stream = match std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(4)) {
        Ok(s) => s,
        Err(e) if is_timeout_error(&e) => return FetchOutcome::Timeout,
        Err(_) => return FetchOutcome::Unreachable,
    };
    stream.set_read_timeout(Some(Duration::from_secs(8))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(4))).ok();
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nUser-Agent: drawpaper-updater-probe\r\n\r\n"
    );
    use std::io::Write;
    if stream.write_all(req.as_bytes()).is_err() {
        return FetchOutcome::Unreachable;
    }
    use std::io::Read;
    let mut buf = Vec::new();
    if stream.read_to_end(&mut buf).is_err() {
        return FetchOutcome::Unreachable;
    }
    let text = String::from_utf8_lossy(&buf);
    // 解析状态行：HTTP/1.1 200 OK / HTTP/1.0 404 Not Found
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    // 取空行之后的 body（极简：HTTP/1.1 的 body 从第一个 CRLFCRLF 后开始）。
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    FetchOutcome::HttpResponse { status, body }
}

/// 极简单绝对 http(s) URL 解析：抽出 (host, port, path)。只支持 http://host[:port]/path。
fn parse_http_url(url: &str) -> Option<(String, u16, String)> {
    let https = url.starts_with("https://");
    let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"))?;
    let authority_path: Vec<&str> = rest.splitn(2, '/').collect();
    let authority = authority_path[0];
    let path = authority_path.get(1).map(|p| format!("/{p}")).unwrap_or_else(|| "/".to_string());
    let default_port = if https { 443 } else { 80 };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()?),
        None => (authority.to_string(), default_port),
    };
    if host.is_empty() {
        return None;
    }
    Some((host, port, path))
}

fn is_timeout_error(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURRENT: &str = "0.1.0-rc.10";

    #[test]
    fn unreachable_falls_back() {
        assert_eq!(
            classify(FetchOutcome::Unreachable, CURRENT),
            Decision::FallbackToReleasesPage(FallbackReason::Unreachable)
        );
    }

    #[test]
    fn timeout_falls_back() {
        assert_eq!(
            classify(FetchOutcome::Timeout, CURRENT),
            Decision::FallbackToReleasesPage(FallbackReason::Timeout)
        );
    }

    #[test]
    fn http_404_falls_back_to_http4xx() {
        assert_eq!(
            classify(
                FetchOutcome::HttpResponse { status: 404, body: "not found".into() },
                CURRENT
            ),
            Decision::FallbackToReleasesPage(FallbackReason::Http4xx)
        );
    }

    #[test]
    fn http_403_is_also_http4xx() {
        assert_eq!(
            classify(
                FetchOutcome::HttpResponse { status: 403, body: "".into() },
                CURRENT
            ),
            Decision::FallbackToReleasesPage(FallbackReason::Http4xx)
        );
    }

    #[test]
    fn http_5xx_is_other() {
        assert_eq!(
            classify(
                FetchOutcome::HttpResponse { status: 503, body: "".into() },
                CURRENT
            ),
            Decision::FallbackToReleasesPage(FallbackReason::Other)
        );
    }

    #[test]
    fn malformed_json_200_falls_back() {
        assert_eq!(
            classify(
                FetchOutcome::HttpResponse { status: 200, body: "this is not json".into() },
                CURRENT
            ),
            Decision::FallbackToReleasesPage(FallbackReason::MalformedManifest)
        );
    }

    #[test]
    fn json_but_no_version_field_is_malformed() {
        assert_eq!(
            classify(
                FetchOutcome::HttpResponse {
                    status: 200,
                    body: r#"{"notes":"hi"}"#.into()
                },
                CURRENT
            ),
            Decision::FallbackToReleasesPage(FallbackReason::MalformedManifest)
        );
    }

    #[test]
    fn valid_manifest_newer_version_is_update_available() {
        let body = r#"{"version":"0.1.0-rc.11","notes":"fixes","platforms":{"windows-x86_64":{"url":"https://x","signature":"y"}}}"#;
        assert_eq!(
            classify(FetchOutcome::HttpResponse { status: 200, body: body.into() }, CURRENT),
            Decision::UpdateAvailable {
                remote: "0.1.0-rc.11".into(),
                current: CURRENT.into(),
            }
        );
    }

    #[test]
    fn valid_manifest_same_version_is_up_to_date() {
        let body = r#"{"version":"0.1.0-rc.10","notes":"","platforms":{}}"#;
        assert_eq!(
            classify(FetchOutcome::HttpResponse { status: 200, body: body.into() }, CURRENT),
            Decision::UpToDate {
                remote: "0.1.0-rc.10".into(),
                current: CURRENT.into(),
            }
        );
    }

    #[test]
    fn valid_manifest_older_version_is_up_to_date() {
        let body = r#"{"version":"0.1.0-rc.9"}"#;
        assert_eq!(
            classify(FetchOutcome::HttpResponse { status: 200, body: body.into() }, CURRENT),
            Decision::UpToDate {
                remote: "0.1.0-rc.9".into(),
                current: CURRENT.into(),
            }
        );
    }

    #[test]
    fn classify_is_idempotent() {
        // Same input twice -> same output (no internal mutable state).
        let o = FetchOutcome::HttpResponse {
            status: 200,
            body: r#"{"version":"0.2.0"}"#.into(),
        };
        assert_eq!(classify(o.clone(), CURRENT), classify(o, CURRENT));
    }

    #[test]
    fn stdout_line_is_grep_stable() {
        assert_eq!(
            Decision::FallbackToReleasesPage(FallbackReason::Unreachable).as_stdout_line(),
            "decision=fallback-releases reason=unreachable"
        );
        assert_eq!(
            Decision::FallbackToReleasesPage(FallbackReason::Http4xx).as_stdout_line(),
            "decision=fallback-releases reason=http-4xx"
        );
        assert_eq!(
            Decision::FallbackToReleasesPage(FallbackReason::MalformedManifest).as_stdout_line(),
            "decision=fallback-releases reason=malformed-manifest"
        );
    }

    #[test]
    fn error_text_keywords_map_to_reasons() {
        assert_eq!(
            reason_from_error_text("error sending request: operation timed out"),
            FallbackReason::Timeout
        );
        assert_eq!(
            reason_from_error_text("404 Not Found while reading response"),
            FallbackReason::Http4xx
        );
        assert_eq!(
            reason_from_error_text("serde_json: expected value at line 1"),
            FallbackReason::MalformedManifest
        );
        assert_eq!(
            reason_from_error_text("connection refused (os error 10061)"),
            FallbackReason::Unreachable
        );
        assert_eq!(reason_from_error_text("some unknown thing"), FallbackReason::Other);
    }

    #[test]
    fn parses_http_url_into_host_port_path() {
        assert_eq!(
            parse_http_url("http://127.0.0.1:1/"),
            Some(("127.0.0.1".into(), 1, "/".into()))
        );
        assert_eq!(
            parse_http_url("https://example.com/releases/latest/download/latest.json"),
            Some(("example.com".into(), 443, "/releases/latest/download/latest.json".into()))
        );
        assert_eq!(
            parse_http_url("http://localhost:8080/foo"),
            Some(("localhost".into(), 8080, "/foo".into()))
        );
        // 非 http(s) 方案 → None → Unreachable
        assert_eq!(parse_http_url("ftp://example.com/x"), None);
    }
}

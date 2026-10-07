//! Wave15 C: 诊断信息导出（纯 Rust，零 web 改动）。
//!
//! 两条入口共用同一个收集核心 [`write_diagnostic_zip`]：
//!   1. 菜单「帮助 → 导出诊断信息」：原生 Save 对话框选目标 zip，完成后用原生消息框反馈。
//!   2. 隐藏 CLI：`drawpaper.exe --diag-export <zip路径>` —— 不弹窗、不进主循环，
//!      CI 无头冒烟直接调用。
//!
//! zip 内容（隐私红线：绝不读取/打包任何用户文档正文与资产字节）：
//!   * `system.json`            —— app 版本 / OS 版本与架构 / WebView2 Runtime 版本 / 时间戳
//!   * `logs/drawpaper.log`     —— 日志尾部（约最后 256 KB，日志是唯一被打包字节的文件）
//!   * `files-manifest.json`    —— 数据目录递归清单，**仅**相对路径 / 大小 / 修改时间
//!   * `README.txt`             —— 说明本包内容与隐私边界
//!
//! 收集逻辑刻意拆成可在 Linux 上 `cargo test` 的纯函数：清单 walk 只取元数据
//! （`read_dir` + `metadata`，从不 `File::open` 业务文件字节），字节读取仅发生在
//! 白名单内的 `logs/drawpaper.log`。

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use zip::write::SimpleFileOptions;

/// Tauri bundle identifier —— app_data_dir / app_config_dir 的末段。
/// CLI 无头路径没有 AppHandle，用 dirs crate 自行拼出同一路径。
pub const APP_IDENTIFIER: &str = "com.drawpaper.app";

/// 日志尾部最多打包的字节数（约 256 KB）。
const LOG_TAIL_BYTES: u64 = 256 * 1024;

/// 诊断包内 logs/ 条目的路径（zip 内固定名，不依赖原始日志文件名）。
const LOG_ZIP_ENTRY: &str = "logs/drawpaper.log";

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/// `system.json`。字段只增不删；CI 冒烟断言 version / arch / webview2 三个字段存在。
#[derive(Debug, Serialize)]
pub struct SystemInfo {
    /// 固定产品名。
    app: &'static str,
    /// env!("CARGO_PKG_VERSION")，与 tauri.conf 版本一致。
    version: String,
    /// std::env::consts::OS（"windows" 等）。
    os: &'static str,
    /// Windows 具体版本（读 HKLM\...\Windows NT\CurrentVersion）；非 Windows 为 "unknown"。
    os_version: String,
    /// std::env::consts::ARCH（"x86_64" / "aarch64" 等）。
    arch: &'static str,
    /// WebView2 Evergreen Runtime 版本号（EdgeUpdate Clients 注册表 pv）；
    /// 未检测到为 "unknown"。
    webview2_runtime_version: String,
    /// 收集时间（RFC3339 UTC）。
    collected_at: String,
}

/// `files-manifest.json` 的单个条目。**刻意只有三个字段**（CI 冒烟断言）。
/// name 为相对数据目录的 POSIX 风格路径；size 字节；mtime 为 RFC3339 UTC。
#[derive(Debug, Serialize, Clone)]
pub struct ManifestEntry {
    name: String,
    size: u64,
    mtime: String,
}

/// 写包结果，供日志 / CLI 打印。
#[derive(Debug, Clone)]
pub struct DiagnosticReport {
    pub out_zip: PathBuf,
    pub entry_names: Vec<String>,
    pub manifest_count: usize,
}

// ---------------------------------------------------------------------------
// 公开核心：菜单与 CLI 共用
// ---------------------------------------------------------------------------

/// 收集诊断信息并写出到 `out_zip`。
///
/// `data_dir` 是 app_data_dir（%APPDATA%\com.drawpaper.app）；`log_path` 指向
/// drawpaper.log（可能不存在，缺失时写一条说明而非失败）。
///
/// 隐私保证：除 `log_path` 外，本函数从不 `File::open` 任何业务文件；数据目录 walk
/// 只调用 `read_dir` / `metadata` 取元数据。
pub fn write_diagnostic_zip(
    data_dir: &Path,
    log_path: &Path,
    out_zip: &Path,
) -> std::io::Result<DiagnosticReport> {
    // 1) system.json（注册表探测在 #[cfg(windows)] 内，其它平台给 "unknown"）。
    let sys = SystemInfo {
        app: "drawpaper",
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS,
        os_version: detect_os_version(),
        arch: std::env::consts::ARCH,
        webview2_runtime_version: detect_webview2_runtime_version(),
        collected_at: now_rfc3339(),
    };
    let sys_bytes = serde_json::to_vec_pretty(&sys)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    // 2) 清单 walk（只取元数据）。
    let manifest = walk_manifest(data_dir);
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    // 3) 日志尾部（唯一被打包字节的文件；缺失则写占位说明）。
    let log_tail = match tail_file(log_path, LOG_TAIL_BYTES) {
        Ok(b) => b,
        Err(_) => format!(
            "(log not found at {} at collection time)\n",
            log_path.display()
        )
        .into_bytes(),
    };

    let readme = README_TEMPLATE;

    // 4) 写 zip。
    if let Some(parent) = out_zip.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let file = fs::File::create(out_zip)?;
    // NOTE: build `opts`/`zerr` BEFORE binding the writer to the name `zip`,
    // otherwise the local `zip` shadows the crate path and `zip::...` breaks.
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let zerr = |e: zip::ZipError| {
        std::io::Error::new(std::io::ErrorKind::Other, format!("zip: {e}"))
    };
    let mut zip = zip::ZipWriter::new(file);

    let mut entry_names: Vec<String> = Vec::new();
    macro_rules! put {
        ($name:expr, $bytes:expr) => {{
            zip.start_file($name, opts).map_err(zerr)?;
            zip.write_all($bytes)?;
            entry_names.push($name.to_string());
        }};
    }
    put!("system.json", &sys_bytes);
    put!(LOG_ZIP_ENTRY, &log_tail);
    put!("files-manifest.json", &manifest_bytes);
    put!("README.txt", readme.as_bytes());
    zip.finish().map_err(zerr)?;

    Ok(DiagnosticReport {
        out_zip: out_zip.to_path_buf(),
        entry_names,
        manifest_count: manifest.len(),
    })
}

/// 默认 zip 文件名：`drawpaper-diagnostic-YYYYMMDD.zip`。
pub fn diagnostic_default_filename() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d, ..) = unix_to_civil(secs);
    format!("drawpaper-diagnostic-{y:04}{m:02}{d:02}.zip")
}

/// CLI 无头入口：直接收集写出并以进程码退出（0 成功 / 非 0 失败）。
/// 由 `main.rs`/`lib.rs::run` 在构建 Tauri 之前拦截 `--diag-export <path>` 调用。
pub fn diag_export_cli(out_zip: &str) -> i32 {
    let data_dir = default_data_dir();
    let log_path = data_dir.join("logs").join("drawpaper.log");
    eprintln!(
        "[diag-export] data_dir={} log={} out={}",
        data_dir.display(),
        log_path.display(),
        out_zip
    );
    match write_diagnostic_zip(&data_dir, &log_path, Path::new(out_zip)) {
        Ok(report) => {
            eprintln!("[diag-export] OK entries={} manifest_files={}",
                report.entry_names.len(), report.manifest_count);
            for n in &report.entry_names {
                eprintln!("[diag-export]   - {n}");
            }
            0
        }
        Err(e) => {
            eprintln!("[diag-export] FAILED: {e}");
            1
        }
    }
}

/// CLI 路径自行解析 app_data_dir（与 Tauri 在 Windows 上的 %APPDATA%\<id> 一致）。
pub fn default_data_dir() -> PathBuf {
    std::env::var("APPDATA")
        .ok()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join(APP_IDENTIFIER)
}

// ---------------------------------------------------------------------------
// 纯函数：walk 清单（只取元数据，绝不开字节）
// ---------------------------------------------------------------------------

fn walk_manifest(root: &Path) -> Vec<ManifestEntry> {
    let mut out = Vec::new();
    walk_recursive(root, root, &mut out);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn walk_recursive(root: &Path, dir: &Path, out: &mut Vec<ManifestEntry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        // 只用 entry.metadata()（dirent 元数据，避免额外 open）；对符号链接取其目标。
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk_recursive(root, &path, out);
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        // POSIX 风格相对路径，跨平台可读。
        let name = rel.to_string_lossy().replace('\\', "/");
        let mtime = meta
            .modified()
            .ok()
            .map(|t| {
                t.duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .map(|d| unix_to_rfc3339(d.as_secs()))
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        out.push(ManifestEntry {
            name,
            size: meta.len(),
            mtime,
        });
    }
}

/// 读文件尾部最后 `max_bytes` 字节。
fn tail_file(path: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// 注册表探测（仅 Windows）
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn detect_webview2_runtime_version() -> String {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    // WebView2 Evergreen Runtime 的 CLSID。
    let clsid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    // 64 位系统上运行时写在 WOW6432Node（32 位视图）；HKCU 对应用户安装。
    let candidates: &[(String, winreg::HKEY)] = &[
        (
            format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{clsid}"),
            HKEY_LOCAL_MACHINE,
        ),
        (
            format!(r"Software\Microsoft\EdgeUpdate\Clients\{clsid}"),
            HKEY_CURRENT_USER,
        ),
    ];
    for (sub, hive) in candidates {
        if let Ok(k) = RegKey::predef(*hive).open_subkey_with_flags(sub, KEY_READ) {
            if let Ok(pv) = k.get_value::<String, _>("pv") {
                if !pv.is_empty() {
                    return pv;
                }
            }
        }
    }
    "unknown".to_string()
}

#[cfg(windows)]
fn detect_os_version() -> String {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    let ndp = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let Ok(k) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(ndp, KEY_READ) else {
        return "unknown".to_string();
    };
    let get = |name: &str| k.get_value::<String, _>(name).unwrap_or_default();
    let product = get("ProductName");
    let display = get("DisplayVersion");
    let build = get("CurrentBuild");
    let ubr: String = k.get_value::<u32, _>("UBR")
        .map(|n| n.to_string())
        .unwrap_or_default();
    let build_str = if ubr.is_empty() { build } else { format!("{build}.{ubr}") };
    let bits = [product, display, build_str]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if bits.is_empty() { "unknown".to_string() } else { bits }
}

#[cfg(not(windows))]
fn detect_webview2_runtime_version() -> String {
    "not-windows".to_string()
}

#[cfg(not(windows))]
fn detect_os_version() -> String {
    "unknown".to_string()
}

// ---------------------------------------------------------------------------
// 时间格式化（无 chrono 依赖：Unix 秒 → RFC3339 UTC）
// ---------------------------------------------------------------------------

fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    unix_to_rfc3339(secs)
}

fn unix_to_rfc3339(secs: u64) -> String {
    let (y, mo, d, h, mi, s) = unix_to_civil(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Unix 秒 → (年, 月, 日, 时, 分, 秒) UTC。Howard Hinnant `days_from_civil` 逆变换。
fn unix_to_civil(secs: u64) -> (i32, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let h = (rem / 3600) as u32;
    let mi = ((rem % 3600) / 60) as u32;
    let s = (rem % 60) as u32;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1,31]
    let mo = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1,12]
    let year = (if mo <= 2 { y + 1 } else { y }) as i32;
    (year, mo, d, h, mi, s)
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

const README_TEMPLATE: &str = "drawpaper 诊断信息包
====================================

本包由「帮助 → 导出诊断信息」或 `drawpaper.exe --diag-export <zip>` 生成，
仅用于向开发者反馈问题时定位环境与日志。

包内容：
  * system.json         ：app 版本、操作系统版本/架构、WebView2 Runtime 版本、收集时间。
  * logs/drawpaper.log  ：应用日志尾部（约最后 256 KB）。
  * files-manifest.json ：数据目录递归清单，仅含每个文件的相对路径 / 大小 / 修改时间。
  * README.txt          ：本说明。

隐私边界（重要）：
  * 本包【不包含】任何 .kbnote 文档正文。
  * 本包【不包含】任何 assets/ 图片 / 附件字节。
  * files-manifest.json 只记录文件的相对路径、大小、修改时间三项元数据，
    用于说明数据目录里有什么，不含任何文件内容。
  * 唯一被打包字节的文件是应用自身日志 logs/drawpaper.log。

发送前请打开 files-manifest.json 与 logs/drawpaper.log 自行确认无敏感信息。
";

// ---------------------------------------------------------------------------
// 单元测试：隐私红线（在 Windows runner 上随 `cargo test` 跑）
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use zip::read::ZipArchive;

    /// 构造一个假数据目录，里面埋：
    ///   * SECRET-canary.kbnote（正文 = 金丝雀秘密串）
    ///   * assets/img.png（字节 = 金丝雀秘密串）
    ///   * logs/drawpaper.log
    /// 然后跑 write_diagnostic_zip，断言：
    ///   * zip 里没有任何 *.kbnote 条目、没有 assets/ 条目
    ///   * 全部展开内容中金丝雀秘密串零命中
    ///   * manifest 每个条目恰好 name/size/mtime 三个字段
    ///   * system.json 含 version / arch / webview2 字段
    #[test]
    fn zip_never_leaks_note_or_asset_bytes() {
        let tmp = std::env::temp_dir().join(format!(
            "dp-diag-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        fs::create_dir_all(data_dir.join("logs")).unwrap();
        fs::create_dir_all(data_dir.join("assets")).unwrap();

        const CANARY: &str = "CANARY-7f3a9b2e4d5c-never-leak-body-9z8x";

        // 埋一个 .kbnote，正文是金丝雀串。
        fs::write(data_dir.join("SECRET-canary.kbnote"), CANARY).unwrap();
        // 埋一个资产文件，字节也是金丝雀串。
        fs::write(data_dir.join("assets").join("img.png"), CANARY.as_bytes()).unwrap();
        // 日志。
        fs::write(data_dir.join("logs").join("drawpaper.log"), "app started\n").unwrap();
        // 一个普通元数据文件。
        fs::write(data_dir.join("drawpaper-recents.json"), "[]").unwrap();

        let out_zip = tmp.join("out.zip");
        let report = write_diagnostic_zip(
            &data_dir,
            &data_dir.join("logs").join("drawpaper.log"),
            &out_zip,
        )
        .unwrap();

        // 1) 条目清单。
        let names = report.entry_names.join(",");
        assert!(names.contains("system.json"), "missing system.json: {names}");
        assert!(names.contains("logs/drawpaper.log"), "missing log: {names}");
        assert!(names.contains("files-manifest.json"), "missing manifest: {names}");
        assert!(names.contains("README.txt"), "missing readme: {names}");

        // 2) 打开 zip，逐条目断言。
        let file = fs::File::open(&out_zip).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        let mut all_text = String::new();
        for i in 0..zip.len() {
            let mut e = zip.by_index(i).unwrap();
            let p = e.name().to_string();
            // 2a) 没有任何 .kbnote 条目。
            assert!(
                !p.to_lowercase().ends_with(".kbnote"),
                "zip leaks a .kbnote entry: {p}"
            );
            // 2b) 没有任何 assets/ 条目。
            assert!(
                !p.starts_with("assets/"),
                "zip leaks an assets/ entry: {p}"
            );
            let mut buf = Vec::new();
            e.read_to_end(&mut buf).unwrap();
            all_text.push_str(&String::from_utf8_lossy(&buf));
        }
        // 3) 金丝雀串在任何展开内容里零命中。
        assert!(
            !all_text.contains(CANARY),
            "CANARY secret leaked into diagnostic zip!\n----zip content----\n{all_text}"
        );

        // 4) manifest 每个条目恰好 3 个字段。
        let manifest_entry = zip
            .by_name("files-manifest.json")
            .unwrap()
            .bytes()
            .collect::<Result<Vec<u8>, _>>()
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&manifest_entry).unwrap();
        let arr = v.as_array().expect("manifest root must be an array");
        assert!(!arr.is_empty(), "manifest should list files");
        for item in arr {
            let keys = item.as_object().unwrap();
            assert_eq!(
                keys.len(),
                3,
                "manifest entry must have exactly 3 fields, got: {keys:?}"
            );
            assert!(keys.contains_key("name"));
            assert!(keys.contains_key("size"));
            assert!(keys.contains_key("mtime"));
        }
        // 4b) 清单里应能看到 canary 文件名（仅元数据，不含正文）。
        let joined = arr
            .iter()
            .map(|i| i["name"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            joined.contains("SECRET-canary.kbnote"),
            "manifest should still list the canary file by name: {joined}"
        );

        // 5) system.json 关键字段存在。
        let sys_entry = zip.by_name("system.json").unwrap().bytes().collect::<Result<Vec<u8>, _>>().unwrap();
        let sys: serde_json::Value = serde_json::from_slice(&sys_entry).unwrap();
        assert!(sys.get("version").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()));
        assert!(sys.get("arch").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()));
        assert!(sys.get("webview2_runtime_version").is_some());
        assert!(sys.get("os").is_some());

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 日志超过 256KB 时只打包尾部。
    #[test]
    fn log_tail_is_capped() {
        let tmp = std::env::temp_dir().join(format!("dp-diag-tail-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        fs::create_dir_all(data_dir.join("logs")).unwrap();
        // 写 1MB 日志，尾部放一个独特标记。
        let big = vec![b'a'; LOG_TAIL_BYTES as usize * 2];
        fs::write(data_dir.join("logs").join("drawpaper.log"), &big).unwrap();
        let marker = b"TAIL_MARKER_AT_END";
        let mut f = fs::OpenOptions::new().append(true).open(data_dir.join("logs").join("drawpaper.log")).unwrap();
        f.write_all(marker).unwrap();

        let out_zip = tmp.join("out.zip");
        write_diagnostic_zip(&data_dir, &data_dir.join("logs").join("drawpaper.log"), &out_zip).unwrap();
        let file = fs::File::open(&out_zip).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        let mut e = zip.by_name("logs/drawpaper.log").unwrap();
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).unwrap();
        // 尾部标记在；且总长度约等于上限 + 标记，不含前 256KB 的 a。
        assert!(buf.windows(marker.len()).any(|w| w == marker), "tail marker missing");
        assert!(buf.len() <= (LOG_TAIL_BYTES as usize) + marker.len() + 4096);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn default_filename_is_yyyymmdd() {
        let n = diagnostic_default_filename();
        assert!(n.ends_with(".zip"));
        assert!(n.starts_with("drawpaper-diagnostic-"));
        // 形如 drawpaper-diagnostic-20261007.zip
        let digits = n.trim_start_matches("drawpaper-diagnostic-").trim_end_matches(".zip");
        assert_eq!(digits.len(), 8, "bad filename: {n}");
        digits.chars().for_each(|c| assert!(c.is_ascii_digit()));
    }
}

//! Wave17：原生文件夹自动保存（native folder auto-save store）。
//!
//! 桌面端让用户选定一个本地文件夹，文档变更（web 侧 500ms 防抖）由宿主直接把
//! `.kbnote` 文档与其引用资产落盘到该目录。**目录布局、相对路径、资产命名与 web
//! 现有 FSA 同步通道（packages/web/src/sync/fsachannel.ts）逐字节对齐**：
//!   * 文档本体：`<docId>.kbnote`（目录根）；
//!   * 资产二进制：`assets/<assetRef>`（assetRef = SHA-256 内容寻址 hex）。
//!
//! 本模块**不实现第二套文档格式**：`.kbnote` 的字节由 web 侧用既有
//! `serializeKBNote` 产出后 base64 传过来，Rust 只负责「受困于选定目录内」的
//! 纯磁盘写入。Rust 不解析、不改写文档 JSON。
//!
//! 安全模型：
//!   * 目录选择持久化到 app 配置目录下的 `drawpaper-autosave.json`（与
//!     `drawpaper-recents.json` 同款 JSON 持久化范式）；
//!   * 写文件命令只接受相对路径，纯函数 `is_safe_relative` / `join_within`
//!     拒绝绝对路径与 `..` 路径穿越；所有 IO 失败返回 `Err`，由 web 侧降级为
//!     现有 OPFS/IndexedDB 自动保存，绝不 panic。
//!
//! 零网络：本模块只碰本地磁盘，不发起任何外联。

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 配置文件名（app_config_dir 下），与 drawpaper-recents.json 同目录同款范式。
const AUTOSAVE_FILE: &str = "drawpaper-autosave.json";

/// 每会话可变状态：当前选定目录 + 是否已从磁盘加载过。
#[derive(Default)]
pub struct AutosaveState {
    dir: Mutex<Option<PathBuf>>,
    loaded: Mutex<bool>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    /// 选定目录的绝对路径；None = 未配置（web 侧回退 OPFS）。
    dir: Option<String>,
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(AUTOSAVE_FILE)
}

// ---------------------------------------------------------------------------
// 纯函数：相对路径清洗与受困目录解析（无 IO，单测直测）。
// ---------------------------------------------------------------------------

/// Pure：`rel` 是否是安全的相对路径——无绝对根 / 盘符前缀 / NUL / `..` 段，
/// 且至少含一个 Normal 分量。统一把 `\` 当 `/`（web 侧恒发 POSIX 相对路径；
/// 这样路径穿越用例在 Linux 开发机与 Windows 目标上判定一致）。
pub fn is_safe_relative(rel: &str) -> bool {
    if rel.is_empty() || rel.contains('\0') {
        return false;
    }
    let normalized = rel.replace('\\', "/");
    let mut saw_normal = false;
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::Normal(_) => saw_normal = true,
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    saw_normal
}

/// Pure：把受清洗后的相对路径 join 到 `base` 下。拒绝绝对路径 / 路径穿越。
/// 不含任何 IO，目标父目录由调用方（写命令）创建。
pub fn join_within(base: &Path, rel: &str) -> Result<PathBuf, String> {
    if !is_safe_relative(rel) {
        return Err(format!("unsafe relative path: {rel:?}"));
    }
    let normalized = rel.replace('\\', "/");
    let mut out = base.to_path_buf();
    for comp in Path::new(&normalized).components() {
        match comp {
            Component::Normal(part) => out.push(part),
            // CurDir 跳过；ParentDir/RootDir/Prefix 已被 is_safe_relative 拒绝。
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("unsafe relative path: {rel:?}"));
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 配置持久化（recents 同款 JSON）。
// ---------------------------------------------------------------------------

fn load_config(app: &tauri::AppHandle) -> Option<PathBuf> {
    let p = config_path(app);
    let raw = fs::read_to_string(&p).ok()?;
    let cfg: ConfigFile = serde_json::from_str(&raw).ok()?;
    cfg.dir.map(PathBuf::from)
}

fn persist_config(app: &tauri::AppHandle, dir: Option<&Path>) {
    let cfg = ConfigFile {
        dir: dir.map(|d| d.to_string_lossy().to_string()),
    };
    let path = config_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(&cfg) {
        let _ = fs::write(&path, s);
    }
}

/// 首次访问时把磁盘配置载入 state（幂等）。
fn ensure_loaded(app: &tauri::AppHandle, state: &AutosaveState) {
    {
        let loaded = state.loaded.lock().unwrap();
        if *loaded {
            return;
        }
    }
    let dir = load_config(app);
    let mut loaded = state.loaded.lock().unwrap();
    if *loaded {
        return;
    }
    *state.dir.lock().unwrap() = dir;
    *loaded = true;
}

// ---------------------------------------------------------------------------
// Tauri 命令（web 侧经 window.__TAURI__.core.invoke 调用）。
// ---------------------------------------------------------------------------

/// 弹原生目录选择框；选中后写入 state + 持久化配置文件。用户取消返回 None。
#[tauri::command]
pub async fn autosave_pick_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AutosaveState>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择自动保存文件夹")
        .pick_folder(move |res| {
            let _ = tx.send(res);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let folder: PathBuf = folder.into_path().map_err(|e| e.to_string())?;
    *state.dir.lock().unwrap() = Some(folder.clone());
    *state.loaded.lock().unwrap() = true;
    persist_config(&app, Some(&folder));
    log::info!("native autosave dir set: {}", folder.display());
    Ok(Some(folder.to_string_lossy().to_string()))
}

/// 取消自动保存：清空 state 并把配置文件写为 `{"dir": null}`。
#[tauri::command]
pub fn autosave_clear_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AutosaveState>,
) -> Result<(), String> {
    *state.dir.lock().unwrap() = None;
    persist_config(&app, None);
    log::info!("native autosave dir cleared");
    Ok(())
}

/// 查询当前已配置目录（首次调用时从磁盘载入）；未配置返回 None。
#[tauri::command]
pub fn autosave_get_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AutosaveState>,
) -> Result<Option<String>, String> {
    ensure_loaded(&app, &state);
    Ok(state
        .dir
        .lock()
        .unwrap()
        .clone()
        .map(|p| p.to_string_lossy().to_string()))
}

/// 探测当前目录是否可写（写一个探针文件再删掉）；未配置/目录消失返回 false。
#[tauri::command]
pub fn autosave_dir_writable(state: tauri::State<'_, AutosaveState>) -> Result<bool, String> {
    let dir = state.dir.lock().unwrap().clone();
    let Some(dir) = dir else {
        return Ok(false);
    };
    if !dir.is_dir() {
        return Ok(false);
    }
    let probe = dir.join(".drawpaper-write-probe.tmp");
    match fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// 把字节写到选定目录下的相对路径（文档 `<docId>.kbnote` 与资产
/// `assets/<ref>` 都走这里）。路径穿越一律 Err；IO 失败一律 Err（web 侧降级）。
#[tauri::command]
pub fn autosave_write_file(
    state: tauri::State<'_, AutosaveState>,
    rel_path: String,
    bytes_base64: String,
) -> Result<(), String> {
    let dir = state.dir.lock().unwrap().clone();
    let Some(dir) = dir else {
        return Err("native autosave dir not configured".to_string());
    };
    let target = join_within(&dir, &rel_path)?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.as_bytes())
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    fs::write(&target, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 隐藏无头自检：`--native-autosave-selftest <dir>`。
//
// 在构建任何 Tauri 插件之前拦截（与 --diag-export 同款）：不弹窗、不开 webview，
// 直接用纯函数 + 磁盘写验证落盘与路径穿越拒绝，exit 0/1。供本地/CI 冒烟调用。
// ---------------------------------------------------------------------------
pub fn selftest_cli(target_dir: &str) -> i32 {
    let base = PathBuf::from(target_dir);

    // 1. 写一份测试 .kbnote（根目录布局）。
    let doc_path = match join_within(&base, "selftest-doc.kbnote") {
        Ok(p) => p,
        Err(e) => {
            eprintln!("selftest FAIL: doc path rejected: {e}");
            return 1;
        }
    };
    if let Some(parent) = doc_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::write(&doc_path, b"{\"format\":\"knowledge-block-notes\",\"version\":4}") {
        eprintln!("selftest FAIL: write doc: {e}");
        return 1;
    }

    // 2. 写一份测试资产（assets/ 子目录布局，与 FSA 通道一致）。
    let asset_path = match join_within(&base, "assets/abc123def") {
        Ok(p) => p,
        Err(e) => {
            eprintln!("selftest FAIL: asset path rejected: {e}");
            return 1;
        }
    };
    if let Some(parent) = asset_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::write(&asset_path, b"FAKE-ASSET-BYTES") {
        eprintln!("selftest FAIL: write asset: {e}");
        return 1;
    }

    // 3. 路径穿越必须被拒绝。
    for bad in ["../evil.kbnote", "assets/../../evil.kbnote", "./../../evil.kbnote"] {
        if join_within(&base, bad).is_ok() {
            eprintln!("selftest FAIL: traversal accepted: {bad:?}");
            return 1;
        }
    }
    // 4. 绝对路径必须被拒绝。
    let abs = if cfg!(windows) {
        "C:/Windows/evil.kbnote"
    } else {
        "/etc/evil.kbnote"
    };
    if join_within(&base, abs).is_ok() {
        eprintln!("selftest FAIL: absolute accepted: {abs:?}");
        return 1;
    }

    // 5. 读回校验字节一致。
    let roundtrip = fs::read(&doc_path).unwrap_or_default();
    if roundtrip != b"{\"format\":\"knowledge-block-notes\",\"version\":4}" {
        eprintln!("selftest FAIL: doc roundtrip mismatch");
        return 1;
    }

    println!("native-autosave selftest OK under {}", base.display());
    0
}

// ---------------------------------------------------------------------------
// 单测：路径安全纯函数（cargo test）。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_relative_paths() {
        assert!(is_safe_relative("doc1.kbnote"));
        assert!(is_safe_relative("assets/abc123"));
        assert!(is_safe_relative("assets/sub/file.bin"));
        assert!(is_safe_relative("./doc.kbnote"));
    }

    #[test]
    fn rejects_traversal() {
        assert!(!is_safe_relative("../evil.kbnote"));
        assert!(!is_safe_relative("assets/../../evil.kbnote"));
        assert!(!is_safe_relative("a/../../../b"));
        // 反斜杠穿越（Windows 风格）也必须被拒。
        assert!(!is_safe_relative("..\\evil.kbnote"));
        assert!(!is_safe_relative("assets\\..\\..\\evil.kbnote"));
    }

    #[test]
    fn rejects_absolute_and_empty() {
        assert!(!is_safe_relative(""));
        assert!(!is_safe_relative("/etc/passwd"));
        assert!(!is_safe_relative("/"));
        assert!(!is_safe_relative(".")); // 只有 CurDir、无 Normal 分量
        assert!(!is_safe_relative("///"));
        // Windows 盘符前缀只在 Windows 上被 Component::Prefix 识别。
        #[cfg(windows)]
        {
            assert!(!is_safe_relative("C:/Windows/system32"));
            assert!(!is_safe_relative("C:\\Windows"));
        }
    }

    #[test]
    fn trailing_dir_separator_is_contained() {
        // "assets/" 有 Normal 分量 assets，解析到 base/assets（受困，安全；
        // 真当文件写时由 OS 报错，不是越界）。
        let base = Path::new("/data/folder");
        assert_eq!(join_within(base, "assets/").unwrap(), Path::new("/data/folder/assets"));
    }

    #[test]
    fn join_within_stays_under_base() {
        let base = Path::new("/data/folder");
        let out = join_within(base, "doc1.kbnote").unwrap();
        assert_eq!(out, Path::new("/data/folder/doc1.kbnote"));
        let asset = join_within(base, "assets/abc123").unwrap();
        assert_eq!(asset, Path::new("/data/folder/assets/abc123"));
    }

    #[test]
    fn join_within_rejects_escapes() {
        let base = Path::new("/data/folder");
        assert!(join_within(base, "../evil.kbnote").is_err());
        assert!(join_within(base, "/etc/passwd").is_err());
        assert!(join_within(base, "").is_err());
    }
}

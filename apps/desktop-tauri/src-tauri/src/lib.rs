//! drawpaper desktop shell (Tauri 2).
//!
//! Responsibilities (see docs/p2-shells.md and planning §4.9 / §4.12):
//!   * Native window menu (File / Edit / Export / View / Help); menu events are
//!     pushed to the web frontend as `app-menu` events, the frontend decides what
//!     to actually do (undo/redo are zustand actions, print enters the print CSS
//!     view).
//!   * HostAdapter commands: `open_kbnote`, `save_kbnote`, `print` (delegated to
//!     frontend), recents list, `.kbnote` file-association double-click launch.
//!   * Optional real-folder auto-save skeleton (P2 增强，未接线).
//!
//! Privacy: no outbound network calls here. CSP in tauri.conf.json is locked
//! down except for optional user-configured AI endpoints (planning §2.5).

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, Submenu};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_log::{Target, TargetKind};

/// GitHub repository URL — shared by 帮助→项目主页 / 检查更新 / About.
const GITHUB_REPO: &str = "https://github.com/guzifeng123/drawpaper--freedom";
const GITHUB_RELEASES_LATEST: &str =
    "https://github.com/guzifeng123/drawpaper--freedom/releases/latest";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const RECENTS_CAP: usize = 10;
const RECENTS_FILE: &str = "drawpaper-recents.json";
const AUTOSAVE_FILE: &str = "drawpaper-autosave.json";
/// Backup directory under app_data_dir: `backups/{title}_备份_{ts}.kbnote`.
const BACKUP_DIR: &str = "backups";
/// Keep at most N backups per app launch (pruned oldest-first on each write).
const BACKUP_KEEP: usize = 20;

/// Per-session mutable state. Accessed from commands via `State<AppState>`.
#[derive(Default)]
struct AppState {
    /// Files opened this session, most-recent-first. Persisted to disk on every
    /// change so the native "File → Open Recent" menu and the frontend's docs
    /// list share one source of truth.
    recents: Mutex<VecDeque<String>>,
    /// The `.kbnote` path the user most recently saved to / opened. When set,
    /// `save_kbnote` overwrites in place instead of prompting again. The frontend
    /// title bar shows "已保存到 xxx.kbnote".
    current_path: Mutex<Option<PathBuf>>,
    /// Optional directory the user picked for "real folder auto-save" (P2
    /// enhancement). When Some, debounced auto-save writes a sibling .kbnote
    /// into this folder keyed by document id. Not wired to the store yet.
    auto_save_dir: Mutex<Option<PathBuf>>,
    /// Wave12 close-guard: whether the CURRENT document is bound to a native
    /// `.kbnote` on disk (user opened/saved one via the native dialog). When
    /// true AND `native_dirty` is true, CloseRequested is intercepted and the
    /// frontend is asked 保存/不保存/取消. IDB-only documents leave this false
    /// so closing never blocks (auto-save is the durability net).
    native_bound: Mutex<bool>,
    /// Wave12 close-guard: frontend-reported dirty flag for the bound native
    /// file. Frontend keeps this in sync via `set_native_dirty`.
    native_dirty: Mutex<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecentEntry {
    path: String,
    opened_at: u64,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn config_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn recents_path(app: &tauri::AppHandle) -> PathBuf {
    config_dir(app).join(RECENTS_FILE)
}

fn autosave_path(app: &tauri::AppHandle) -> PathBuf {
    config_dir(app).join(AUTOSAVE_FILE)
}

fn load_recents(app: &tauri::AppHandle) -> VecDeque<String> {
    let p = recents_path(app);
    let Ok(raw) = fs::read_to_string(&p) else {
        return VecDeque::new();
    };
    let Ok(entries) = serde_json::from_str::<Vec<RecentEntry>>(&raw) else {
        return VecDeque::new();
    };
    entries.into_iter().map(|e| e.path).collect()
}

fn persist_recents(app: &tauri::AppHandle, recents: &VecDeque<String>) {
    let dir = config_dir(app);
    let _ = fs::create_dir_all(&dir);
    let entries: Vec<RecentEntry> = recents
        .iter()
        .cloned()
        .map(|path| RecentEntry {
            path,
            opened_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        })
        .collect();
    if let Ok(s) = serde_json::to_string_pretty(&entries) {
        let _ = fs::write(recents_path(app), s);
    }
}

fn push_recent(state: &AppState, app: &tauri::AppHandle, path: &Path) {
    {
        let mut recents = state.recents.lock().unwrap();
        let p = path.to_string_lossy().to_string();
        recents.retain(|x| x != &p);
        recents.push_front(p);
        while recents.len() > RECENTS_CAP {
            recents.pop_back();
        }
        persist_recents(app, &recents);
    } // drop the lock before rebuilding the menu (which re-locks recents)
    rebuild_menu(app);
}

// ---------------------------------------------------------------------------
// Commands — these are the HostAdapter seam. The frontend's TauriHostAdapter
// (packages/web/src/host/tauri-host.ts) invokes these by name.
// ---------------------------------------------------------------------------

/// Shape returned to the frontend. Must match `OpenFileResult` in
/// packages/core/src/store/adapters.ts: { name, text }.
#[derive(Debug, Serialize, Deserialize)]
struct OpenKbnoteResult {
    name: String,
    text: String,
    /// Absolute path on disk, so the frontend can show "已保存到 …" and the
    /// next `save_kbnote` can overwrite in place.
    path: String,
}

/// HostAdapter.showOpenFilePicker().
///
/// Native open dialog filtered to `.kbnote`. On cancel the dialog plugin
/// returns None and we resolve null (matches web semantics: user bailed).
#[tauri::command]
async fn open_kbnote(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<OpenKbnoteResult>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("打开 .kbnote 文档")
        .add_filter("drawpaper 文档", &["kbnote", "json"])
        .pick_file(move |res| {
            let _ = tx.send(res);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path: PathBuf = path.into_path().map_err(|e| e.to_string())?;
    let text = fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))?;
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled.kbnote".to_string());
    {
        let mut cur = state.current_path.lock().unwrap();
        *cur = Some(path.clone());
    }
    push_recent(&state, &app, &path);
    Ok(Some(OpenKbnoteResult {
        name,
        text,
        path: path.to_string_lossy().to_string(),
    }))
}

/// HostAdapter.showSaveFilePicker(filename, text).
///
/// If `current_path` is already set (user opened an existing file), we
/// overwrite in place — unless `force_pick` is true (Save As…). Otherwise we
/// prompt with a default filename and remember the chosen path.
#[tauri::command]
async fn save_kbnote(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    filename: String,
    text: String,
    force_pick: Option<bool>,
) -> Result<String, String> {
    let force = force_pick.unwrap_or(false);
    let existing = { state.current_path.lock().unwrap().clone() };

    let target: PathBuf = if let (Some(p), false) = (existing, force) {
        p
    } else {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let default_name = if filename.ends_with(".kbnote") {
            filename.clone()
        } else {
            format!("{filename}.kbnote")
        };
        app.dialog()
            .file()
            .set_title("保存 .kbnote 文档")
            .set_file_name(&default_name)
            .add_filter("drawpaper 文档", &["kbnote"])
            .save_file(move |res| {
                let _ = tx.send(res);
            });
        let picked = rx.await.map_err(|e| e.to_string())?;
        let Some(p) = picked else {
            // User cancelled the save dialog — treat as cancel, not error.
            return Err("cancelled".to_string());
        };
        p.into_path().map_err(|e| e.to_string())?
    };

    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&target, text).map_err(|e| format!("write failed: {e}"))?;
    {
        let mut cur = state.current_path.lock().unwrap();
        *cur = Some(target.clone());
    }
    push_recent(&state, &app, &target);
    Ok(target.to_string_lossy().to_string())
}

/// HostAdapter.print().
///
/// Strategy: emit `enter-print-mode` to the frontend, which switches to the
/// print CSS overlay (A4 tiles/flow) and then calls `window.print()` via the
/// WebView. We keep the print trigger on the frontend because all the paginate
/// logic lives there; Rust just owns the menu item.
#[tauri::command]
fn print(app: tauri::AppHandle) -> Result<(), String> {
    app.emit("app:menu", serde_json::json!({"id": "export:print"}))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Wave13: save_export — native Save dialog + Rust writes the exported bytes.
//
// The frontend renders PDF (bitmap-mode) / PNG / SVG / Markdown to bytes, sends
// them base64-encoded; Rust shows a native Save dialog, decodes and writes the
// file. Cancelling the dialog resolves `{status:"cancelled"}` (NOT an error),
// mirroring web showSaveFilePicker cancel semantics. The Ctrl+P browser print
// pipeline is untouched. Contract frozen in docs/wave13/native-gaps.md.
// ---------------------------------------------------------------------------

/// `save_export` return shape: a tagged union the frontend switches on.
/// Serializes to `{"status":"saved","path":"…"}` or `{"status":"cancelled"}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ExportSaveOutcome {
    /// User picked a path and Rust wrote the bytes successfully.
    Saved { path: String },
    /// User cancelled the native Save dialog — not an error.
    Cancelled,
}

/// HostAdapter export save: PDF / PNG / SVG / MD all funnel through this one
/// command. `ext` selects the dialog file filter; `bytes_base64` is the payload.
#[tauri::command]
async fn save_export(
    app: tauri::AppHandle,
    suggested_name: String,
    ext: String,
    bytes_base64: String,
) -> Result<ExportSaveOutcome, String> {
    // Map the extension to a native Save-dialog filter.
    let (filter_label, exts): (&str, &[&str]) = match ext.to_lowercase().as_str() {
        "pdf" => ("PDF 文档", &["pdf"][..]),
        "png" => ("PNG 图片", &["png"][..]),
        "svg" => ("SVG 图片", &["svg"][..]),
        "md" | "markdown" => ("Markdown 文档", &["md", "markdown"][..]),
        other => return Err(format!("unsupported ext: {other}")),
    };

    // Ensure the suggested default name carries the right extension.
    let dot_ext = format!(".{}", ext.to_lowercase());
    let default_name = if suggested_name.to_lowercase().ends_with(&dot_ext) {
        suggested_name.clone()
    } else {
        format!("{suggested_name}{dot_ext}")
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出为")
        .set_file_name(&default_name)
        .add_filter(filter_label, exts)
        .save_file(move |res| {
            let _ = tx.send(res);
        });
    let picked = rx.await.map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        // User cancelled — resolve as cancelled, NOT an error.
        return Ok(ExportSaveOutcome::Cancelled);
    };
    let target = picked.into_path().map_err(|e| e.to_string())?;

    // Decode the base64 payload, then write with std::fs (no fs-plugin IPC
    // needed; this command runs entirely in Rust).
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.as_bytes())
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&target, &bytes).map_err(|e| format!("write failed: {e}"))?;
    log::info!("exported {ext} -> {}", target.display());
    Ok(ExportSaveOutcome::Saved {
        path: target.to_string_lossy().to_string(),
    })
}

/// Recent files list (native File → Open Recent menu + frontend docs list).
#[tauri::command]
fn list_recents(state: tauri::State<'_, AppState>) -> Vec<String> {
    state.recents.lock().unwrap().iter().cloned().collect()
}

/// Clear recents.
#[tauri::command]
fn clear_recents(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    {
        let mut r = state.recents.lock().unwrap();
        r.clear();
        persist_recents(&app, &r);
    }
    rebuild_menu(&app);
}

/// Absolute path of the `.kbnote` the user double-clicked to launch the app
/// (file association). Returns None if the app was launched normally. The
/// frontend calls this once on boot; if non-null, it loads that file.
#[tauri::command]
fn get_startup_file(state: tauri::State<'_, AppState>) -> Option<String> {
    state.current_path.lock().unwrap().clone().map(|p| p.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Wave12: 动态窗口标题 + 原生关闭守卫
// ---------------------------------------------------------------------------

/// Frontend → native window title. Frontend formats the string (dirty bullet
/// / doc name) and pushes it on every doc switch / rename / dirty-toggle /
/// save. Browser build never calls this (host bridge no-ops outside Tauri).
#[tauri::command]
fn set_window_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|e| e.to_string())
}

/// Frontend tells the shell whether the current document is bound to a native
/// `.kbnote` on disk. `Some(path)` = bound; `None` = IDB-only doc (closing it
/// never prompts — IndexedDB auto-save is the durability net).
#[tauri::command]
fn bind_native_file(state: tauri::State<'_, AppState>, path: Option<String>) {
    let mut bound = state.native_bound.lock().unwrap();
    *bound = path.is_some();
}

/// Frontend pushes the dirty flag of the bound native file. Combined with
/// `native_bound`, this decides whether CloseRequested is intercepted.
#[tauri::command]
fn set_native_dirty(state: tauri::State<'_, AppState>, dirty: bool) {
    let mut d = state.native_dirty.lock().unwrap();
    *d = dirty;
}

/// Hard exit. Called by the frontend AFTER the user chose 保存/不保存 in the
/// close-guard dialog — it bypasses the CloseRequested interception on the way
/// out (we flip the dirty flag off first so the guard lets us through).
#[tauri::command]
fn force_quit(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    *state.native_dirty.lock().unwrap() = false;
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Optional: real-folder auto-save skeleton (planning §4.9 P2).
//
// The idea: user picks a folder once; every debounced autosave writes
// `<doc-id>.kbnote` into that folder. This is an alternative to OPFS for users
// who want the folder in Explorer / synced with OneDrive.
//
// NOT wired to the store in this scaffold — the store's StorageAdapter still
// uses Dexie/IndexedDB. The commands below compile and express the contract;
// wiring them into the editor-store is a follow-up (see docs/p2-shells.md).
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct AutoSaveManifest {
    dir: String,
    /// doc_id -> filename on disk.
    docs: Vec<(String, String)>,
}

#[tauri::command]
async fn choose_auto_save_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
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
    let folder = folder.into_path().map_err(|e| e.to_string())?;
    {
        let mut d = state.auto_save_dir.lock().unwrap();
        *d = Some(folder.clone());
    }
    // Persist manifest so next launch remembers the folder.
    let manifest = AutoSaveManifest {
        dir: folder.to_string_lossy().to_string(),
        docs: vec![],
    };
    let _ = fs::write(
        autosave_path(&app),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    );
    Ok(Some(folder.to_string_lossy().to_string()))
}

/// Skeleton: write doc text into the configured auto-save folder as
/// `<doc_id>.kbnote`. Debouncing (500ms) is the caller's responsibility, same
/// as the OPFS path.
#[tauri::command]
fn auto_save_doc(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    text: String,
) -> Result<Option<String>, String> {
    let dir = { state.auto_save_dir.lock().unwrap().clone() };
    let Some(dir) = dir else {
        return Ok(None);
    };
    let name = format!("{doc_id}.kbnote");
    let target = dir.join(&name);
    fs::write(&target, text).map_err(|e| format!("autosave write failed: {e}"))?;
    Ok(Some(target.to_string_lossy().to_string()))
}

// ---------------------------------------------------------------------------
// Native notifications + auto-backup (P2 收尾).
//
// The web side already has an in-app toast; on the desktop shell we ALSO post
// a native Windows Action Center notification so the user sees "保存成功" even
// when the window is backgrounded. Browsers fall back to the existing toast.
// ---------------------------------------------------------------------------

/// Post a native system notification. No-op / best-effort on failure (e.g.
/// user revoked notification permission) — never rejects the caller.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .unwrap_or_else(|e| log::warn!("notification failed: {e}"));
}

/// Sanitize a doc title into a filesystem-safe filename stem.
fn safe_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Write a timestamped backup copy under app_data_dir/backups/ and prune to
/// the newest BACKUP_KEEP files. Called by the web side after a successful save
/// (debounced by the caller, same 500ms rhythm as OPFS autosave).
///
/// This is the "real folder backup" safety net on top of Dexie: even if the
/// browser storage is corrupted/cleared, the user has N on-disk .kbnote
/// snapshots they can double-click to reopen.
#[tauri::command]
fn backup_doc(
    app: tauri::AppHandle,
    title: String,
    text: String,
) -> Result<String, String> {
    let backup_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join(BACKUP_DIR);
    fs::create_dir_all(&backup_dir).map_err(|e| format!("mkdir backups: {e}"))?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = format!("{}_备份_{ts}.kbnote", safe_stem(&title));
    let target = backup_dir.join(&name);
    fs::write(&target, text).map_err(|e| format!("backup write: {e}"))?;

    // Prune: list *.kbnote in backup_dir, sort by mtime, drop oldest beyond KEEP.
    if let Ok(entries) = fs::read_dir(&backup_dir) {
        let mut files: Vec<(PathBuf, std::time::SystemTime)> = entries
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("kbnote"))
            .filter_map(|e| {
                let p = e.path();
                let mtime = fs::metadata(&p).ok()?.modified().ok()?;
                Some((p, mtime))
            })
            .collect();
        files.sort_by_key(|(_, mtime)| *mtime);
        let excess = files.len().saturating_sub(BACKUP_KEEP);
        for (old, _) in files.into_iter().take(excess) {
            let _ = fs::remove_file(old);
        }
    }

    Ok(target.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

fn build_menu(handle: &tauri::AppHandle, state: &AppState) -> Menu<tauri::Wry> {
    use tauri::menu::PredefinedMenuItem;

    // `MenuItem::with_id` returns a Result; build an owned item in one call.
    fn item(handle: &tauri::AppHandle, id: &str, text: &str) -> MenuItem<tauri::Wry> {
        MenuItem::with_id(handle, id, text, true, None::<&str>).unwrap()
    }

    let file = Submenu::new(handle, "文件", true).unwrap();
    file.append(&item(handle, "file:new", "新建画布")).unwrap();
    file.append(&item(handle, "file:open", "打开…\tCtrl+O")).unwrap();
    file.append(&item(handle, "file:save", "保存\tCtrl+S")).unwrap();
    // Wave13: real accelerator bound via the accelerator field (the menu shows
    // it on the right); Ctrl+Shift+S triggers `app:menu{id:"file:save-as"}`.
    file.append(
        &MenuItem::with_id(
            handle,
            "file:save-as",
            "另存为…",
            true,
            Some("CmdOrCtrl+Shift+S"),
        )
        .unwrap(),
    )
    .unwrap();
    file.append(&PredefinedMenuItem::separator(handle).unwrap()).unwrap();
    // Wave13: real dynamic submenu rebuilt from `state.recents`.
    file.append(&build_open_recent_submenu(handle, state)).unwrap();

    let edit = Submenu::new(handle, "编辑", true).unwrap();
    edit.append(&item(handle, "edit:undo", "撤销\tCtrl+Z")).unwrap();
    edit.append(&item(handle, "edit:redo", "重做\tCtrl+Shift+Z")).unwrap();
    edit.append(&PredefinedMenuItem::separator(handle).unwrap()).unwrap();
    // Wave12: 原生剪贴板角色——WebView2 对聚焦的可编辑元素自动执行
    // 剪切/复制/粘贴/全选（Tiptap contenteditable 原生支持），前端无需接线。
    edit.append(&PredefinedMenuItem::cut(handle, Some("剪切")).unwrap()).unwrap();
    edit.append(&PredefinedMenuItem::copy(handle, Some("复制")).unwrap()).unwrap();
    edit.append(&PredefinedMenuItem::paste(handle, Some("粘贴")).unwrap()).unwrap();
    edit.append(&PredefinedMenuItem::select_all(handle, Some("全选")).unwrap()).unwrap();

    let export = Submenu::new(handle, "导出", true).unwrap();
    export.append(&item(handle, "export:print", "打印 / 另存为 PDF\tCtrl+P")).unwrap();
    export.append(&item(handle, "export:pdf", "直接下载 PDF")).unwrap();
    export.append(&item(handle, "export:png", "导出 PNG")).unwrap();
    export.append(&item(handle, "export:svg", "导出 SVG")).unwrap();
    export.append(&item(handle, "export:md", "导出 Markdown")).unwrap();

    let view = Submenu::new(handle, "视图", true).unwrap();
    view.append(&item(handle, "view:fit", "适应屏幕\tCtrl+0")).unwrap();
    view.append(&item(handle, "view:zoom-in", "放大\tCtrl+=")).unwrap();
    view.append(&item(handle, "view:zoom-out", "缩小\tCtrl+-")).unwrap();
    view.append(&PredefinedMenuItem::separator(handle).unwrap()).unwrap();
    view.append(&item(handle, "view:dark-mode", "深色模式")).unwrap();
    view.append(&item(handle, "view:outline", "大纲面板")).unwrap();
    view.append(&item(handle, "view:search", "搜索…\tCtrl+F")).unwrap();

    // Wave12: 同步子菜单——打开前端的同步设置对话框（emit sync:settings，
    // 前端 setSyncOpen(true)）。
    let sync = Submenu::new(handle, "同步", true).unwrap();
    sync.append(&item(handle, "sync:settings", "同步设置…")).unwrap();

    let help = Submenu::new(handle, "帮助", true).unwrap();
    help.append(
        &PredefinedMenuItem::about(
            handle,
            Some("关于 drawpaper"),
            Some(AboutMetadata {
                name: Some("drawpaper".to_string()),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
                authors: Some(vec!["drawpaper contributors".to_string()]),
                comments: Some("本地优先的无限画布知识块笔记。数据留在本机，无账号、无云同步。".to_string()),
                website: Some(GITHUB_REPO.to_string()),
                ..Default::default()
            }),
        )
        .unwrap(),
    )
    .unwrap();
    // Wave13: 仅在用户点击时打开 releases/latest —— 零后台/启动网络请求。
    help.append(&item(handle, "help:check-update", "检查更新…")).unwrap();
    help.append(&item(handle, "help:open-data-dir", "打开数据目录")).unwrap();
    help.append(&PredefinedMenuItem::separator(handle).unwrap()).unwrap();
    help.append(&item(handle, "help:home", "项目主页")).unwrap();

    Menu::with_items(
        handle,
        &[&file, &edit, &export, &view, &sync, &help],
    )
    .unwrap()
}

/// Build the native File → 打开最近 submenu from the live recents list.
///
/// Items are `recent:<n>` (n = index into recents, most-recent first); the label
/// is the file name (full path is the tooltip, see contract doc). A disabled
/// placeholder shows when the list is empty. Always ends with a separator +
/// 「清空最近」(`recent:clear`), disabled when there is nothing to clear.
fn build_open_recent_submenu(handle: &tauri::AppHandle, state: &AppState) -> Submenu<tauri::Wry> {
    use tauri::menu::PredefinedMenuItem;
    let sub = Submenu::new(handle, "打开最近", true).unwrap();
    let recents = state.recents.lock().unwrap();

    if recents.is_empty() {
        let placeholder =
            MenuItem::with_id(handle, "recent:empty", "（无）", false, None::<&str>).unwrap();
        sub.append(&placeholder).unwrap();
    } else {
        for (n, path) in recents.iter().enumerate() {
            let label = Path::new(path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            let item = MenuItem::with_id(handle, format!("recent:{n}"), label, true, None::<&str>).unwrap();
            sub.append(&item).unwrap();
        }
        sub.append(&PredefinedMenuItem::separator(handle).unwrap()).unwrap();
    }

    let clear = MenuItem::with_id(
        handle,
        "recent:clear",
        "清空最近",
        !recents.is_empty(),
        None::<&str>,
    )
    .unwrap();
    sub.append(&clear).unwrap();
    sub
}

/// Rebuild the whole app menu (preserving every static item + accelerators) and
/// re-apply it. Called after recents change (open / save / clear) so the
/// dynamic 打开最近 submenu stays in sync. Best-effort: logs on failure.
fn rebuild_menu(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let menu = build_menu(app, &state);
    if let Err(e) = app.set_menu(menu) {
        log::warn!("rebuild_menu failed: {e}");
    }
}

/// Shared "open a `.kbnote` off disk" routine used by THREE entry points:
///   * File → 打开最近 → `recent:<n>` (menu click)
///   * file-association double-click on COLD start (argv[1], no instance running)
///   * single-instance second launch on HOT start (another `.kbnote` double-clicked
///     while the app is already running) — Wave14 修复 #2。
///
/// Rust reads the file itself (the webview has no arbitrary-path read) and emits a
/// rich `app:open-file` `{path,name,text,external:true}` — byte-identical to the
/// 文件→打开 success flow — so the frontend loads it via
/// `parseKBNote(text) → loadDoc → bindNativeFile(path)`.
///
/// On read failure the stale recents entry (if any) is dropped and the menu
/// rebuilt, and a lightweight `app:open-file-error` is emitted so the running
/// window can toast a friendly message. Never panics; never rejects a caller.
fn open_external_path(app: &tauri::AppHandle, p: &Path) {
    // Only act on `.kbnote` files (argv may carry a stray non-doc arg, e.g. when
    // the single-instance plugin forwards a launch without a file association).
    if p.extension().and_then(|e| e.to_str()) != Some("kbnote") {
        return;
    }
    let path_s = p.to_string_lossy().to_string();

    match fs::read_to_string(p) {
        Ok(text) => {
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path_s.clone());
            // Bind so the next 保存 overwrites in place; move to front + rebuild.
            let state = app.state::<AppState>();
            *state.current_path.lock().unwrap() = Some(p.to_path_buf());
            push_recent(&state, app, p);
            // Wave15 D: observability. The error branch already logs; log a
            // success line too so release-windows smoke can assert (via
            // drawpaper.log) that Rust received and processed the argv[1] /
            // recent / single-instance file-open — independent of whether the
            // webview listener was mounted in time (cold-start race, see
            // docs/wave15/desktop-gap-audit.md).
            log::info!("open-file (external): {path_s} (name={name})");
            let _ = app.emit(
                "app:open-file",
                serde_json::json!({
                    "path": path_s,
                    "name": name,
                    "text": text,
                    "external": true,
                }),
            );
        }
        Err(e) => {
            log::warn!("external .kbnote unreadable, dropping from recents: {path_s}: {e}");
            {
                let state = app.state::<AppState>();
                let mut r = state.recents.lock().unwrap();
                r.retain(|x| x != &path_s);
                persist_recents(app, &r);
            }
            rebuild_menu(app);
            // Lightweight error the running window can toast (no panic).
            let _ = app.emit(
                "app:open-file-error",
                serde_json::json!({
                    "path": path_s,
                    "message": format!("无法打开文件：{e}"),
                }),
            );
        }
    }
}

/// Click on File → 打开最近 → `recent:<n>`. Looks up the path by index, then
/// delegates to the shared [`open_external_path`] rich-open routine.
fn open_recent_by_index(app: &tauri::AppHandle, n: usize) {
    let state = app.state::<AppState>();
    let path: Option<String> = { state.recents.lock().unwrap().get(n).cloned() };
    let Some(path) = path else { return };
    open_external_path(app, &PathBuf::from(path));
}

// ---------------------------------------------------------------------------
// File-association launch: when Windows hands us a .kbnote path on the command
// line (double-click), stash it in state and emit to the frontend.
// ---------------------------------------------------------------------------

fn maybe_seed_startup_file(app: &tauri::AppHandle) {
    let argv: Vec<String> = std::env::args().collect();
    // argv[0] is the exe; a file association launch passes the path as argv[1].
    if let Some(path) = argv.get(1) {
        // Delegate to the shared rich-open helper: validates the `.kbnote`
        // extension/existence, reads the file, binds current_path, pushes
        // recents and emits the rich `app:open-file` payload — identical to the
        // hot-start (single-instance) path so cold/hot launches behave the same.
        open_external_path(app, Path::new(path));
    }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

pub fn run() {
    // Wave13: tauri-plugin-log is the global `log` logger (file + stdout +
    // webview). It replaces the previous env_logger bootstrap; do NOT init a
    // second global logger here or the process will panic on setup.

    tauri::Builder::default()
        // single-instance MUST be registered before any other plugin so it can
        // exit the second process before the rest of the app initializes.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second instance was launched (e.g. user double-clicked another
            // .kbnote). Wave14 #2: delegate to the shared rich-open helper so
            // Rust reads the file and emits the SAME rich `app:open-file`
            // payload `{path,name,text,external:true}` the "打开最近" menu uses —
            // the running window actually loads the document instead of just
            // focusing with a stale path.
            if let Some(path) = argv.get(1) {
                open_external_path(app, Path::new(path));
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        // Wave13: file + stdout + webview logging, info level, drawpaper.log.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("drawpaper".into()),
                    }),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        // Wave13: remember window position/size/maximized; clamped to the
        // tauri.conf minWidth/minHeight (960x600) on restore.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|app| {
            // Load persisted recents into state.
            {
                let state: tauri::State<AppState> = app.state();
                let loaded = load_recents(&app.handle());
                let mut r = state.recents.lock().unwrap();
                *r = loaded;
            }

            // Seed startup .kbnote (double-click association).
            maybe_seed_startup_file(&app.handle());

            // Build native menu and route events to the frontend.
            let menu = build_menu(app.handle(), &app.state::<AppState>());
            app.set_menu(menu)?;
            app.on_menu_event(move |app: &tauri::AppHandle, event: MenuEvent| {
                let id = event.id.0.as_str();

                // --- 帮助：纯 Rust 侧动作，不绕前端，零后台网络 ---
                if id == "help:home" {
                    let _ = app.opener().open_url(GITHUB_REPO, None::<&str>);
                    return;
                }
                // 仅在用户点击时打开 releases/latest；没有任何定时/启动检查。
                if id == "help:check-update" {
                    let _ = app.opener().open_url(GITHUB_RELEASES_LATEST, None::<&str>);
                    return;
                }
                // 在资源管理器中 reveal 数据目录。
                if id == "help:open-data-dir" {
                    if let Ok(dir) = app.path().app_data_dir() {
                        let _ = app.opener().reveal_item_in_dir(&dir);
                    }
                    return;
                }

                // --- 打开最近：动态子菜单 ---
                if id == "recent:clear" {
                    let state = app.state::<AppState>();
                    {
                        let mut r = state.recents.lock().unwrap();
                        r.clear();
                        persist_recents(app, &r);
                    }
                    rebuild_menu(app);
                    return;
                }
                if let Some(n) = id.strip_prefix("recent:").and_then(|s| s.parse::<usize>().ok()) {
                    open_recent_by_index(app, n);
                    return;
                }

                // Every other menu click becomes an `app:menu` event with the item id.
                // The frontend maps ids to store actions (undo/redo/print/fit).
                let _ = app.emit("app:menu", serde_json::json!({ "id": id }));
            });

            Ok(())
        })
        // Wave12 close-guard: when the user closes the window while a native
        // .kbnote is bound AND dirty, intercept and ask the frontend.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let bound = *state.native_bound.lock().unwrap();
                let dirty = *state.native_dirty.lock().unwrap();
                if bound && dirty {
                    api.prevent_close();
                    let _ = window.emit(
                        "app:close-requested",
                        serde_json::json!({ "docTitle": window.title().unwrap_or_default() }),
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_kbnote,
            save_kbnote,
            save_export,
            print,
            list_recents,
            clear_recents,
            get_startup_file,
            choose_auto_save_dir,
            auto_save_doc,
            notify,
            backup_doc,
            set_window_title,
            bind_native_file,
            set_native_dirty,
            force_quit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running drawpaper desktop shell");
}

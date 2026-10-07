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
// Wave15 A: manual updater (UpdaterExt::updater/.check/.download_and_install).
use tauri_plugin_updater::UpdaterExt;

/// Wave16-I: Windows portable-mode decision (pure function + fs probe). See
/// `portable.rs`. Setting `app_directories_override` moves Tauri's path resolver
/// itself, so every app-data call site in this file follows into `./data/`.
mod portable;

// Wave15 C: 诊断信息导出（纯 Rust，见 diagnostics.rs）。
mod diagnostics;

// Wave17: 原生文件夹自动保存（见 native_autosave.rs）。选择/读取目录、
// 受困相对路径写文件、配置持久化全部在该模块；本文件只做命令注册。
mod native_autosave;

/// GitHub repository URL — shared by 帮助→项目主页 / 检查更新 / About.
const GITHUB_REPO: &str = "https://github.com/guzifeng123/drawpaper--freedom";
const GITHUB_RELEASES_LATEST: &str =
    "https://github.com/guzifeng123/drawpaper--freedom/releases/latest";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const RECENTS_CAP: usize = 10;
const RECENTS_FILE: &str = "drawpaper-recents.json";
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
// Wave17: 原生文件夹自动保存。
//
// 选择/读取/清空目录、受困相对路径写文件、配置持久化全部在
// native_autosave.rs（autosave_pick_dir / autosave_get_dir / autosave_clear_dir /
// autosave_write_file / autosave_dir_writable）。落盘布局 <docId>.kbnote +
// assets/<ref> 与 web FSA 通道逐字节一致；本文件只注册命令。旧
// choose_auto_save_dir/auto_save_doc 骨架已被本模块取代移除。
// ---------------------------------------------------------------------------

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
// Wave15 A: manual "帮助 → 检查更新…" updater flow.
//
// ZERO-BACKEND / ZERO-BACKOUT NETWORK INVARIANT: this is the ONLY place in the
// whole crate that touches the updater. It is reached EXCLUSIVELY from the menu
// event handler when the user clicks the "检查更新…" item. There is NO startup
// check, NO timer, NO polling, NO automatic download — the single network
// request happens exactly once per user click.
//
// Behaviour:
//   * build the updater and `check()` the configured latest.json endpoint once;
//   * if a newer SIGNED release is found -> native confirm dialog showing the
//     current version / latest version / release notes (latest.json `body`);
//     user confirms -> `download_and_install` (NSIS installer self-restarts);
//     user cancels -> do nothing at all;
//   * no update / offline / endpoint missing (no latest.json yet) / bad or
//     absent signature / any check error -> transparently fall back to opening
//     the Releases web page (the Wave13 behaviour). No scary error dialog.
// ---------------------------------------------------------------------------

/// Fallback used for every non-"new version available" outcome: open the
/// Releases web page in the system browser (identical to the Wave13 flow).
fn open_releases_page(app: &tauri::AppHandle) {
    let _ = app.opener().open_url(GITHUB_RELEASES_LATEST, None::<&str>);
}

fn run_manual_update_check(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Build the updater from tauri.conf plugins.updater (endpoints + pubkey).
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                log::warn!("updater build failed, falling back to Releases web page: {e}");
                open_releases_page(&app);
                return;
            }
        };

        // The ONE network request, fired only because the user clicked the menu.
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            // Ok(None) -> already on the latest version; Err -> offline / 404 /
            // no latest.json yet / signature / parse error. Both fall back.
            Ok(None) => {
                log::info!("updater: already on the latest version");
                open_releases_page(&app);
                return;
            }
            Err(e) => {
                log::warn!("updater check failed, falling back to Releases web page: {e}");
                open_releases_page(&app);
                return;
            }
        };

        let current = update.current_version.clone();
        let latest = update.version.clone();
        let notes = update.body.clone().unwrap_or_default();

        // Ask before downloading. The dialog callback runs on the main thread;
        // block on a oneshot so the async task waits for the user's choice.
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        let message = format!(
            "发现新版本 {latest}\n\n当前版本：{current}\n\n{notes}\n\n现在下载并安装？安装完成后会自动重启。"
        );
        app.dialog()
            .message(message)
            .title(format!("发现新版本 {latest}"))
            .kind(tauri_plugin_dialog::MessageDialogKind::Info)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::YesNo)
            .show(move |yes: bool| {
                let _ = tx.send(yes);
            });
        let confirmed = rx.await.unwrap_or(false);
        if !confirmed {
            // User cancelled — do nothing, stay on the current version.
            log::info!("updater: user cancelled the update");
            return;
        }

        // Download + verify signature + run the installer. On Windows NSIS this
        // launches the updater installer (which replaces files and restarts).
        match update
            .download_and_install(|_chunk: usize, _total: Option<u64>| {}, || {})
            .await
        {
            Ok(()) => {
                // On Windows the installer restarts the app; restart() is the
                // cross-platform safety net (macOS/Linux need it).
                app.restart();
            }
            Err(e) => {
                log::warn!("updater download/install failed, falling back to Releases web page: {e}");
                open_releases_page(&app);
            }
        }
    });
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
    // Wave15 C: 导出诊断信息（纯 Rust 全流程：原生 Save 对话框 → 收集 → zip，
    // 完成后原生消息框反馈；取消不报错；零 web 改动）。
    help.append(&item(handle, "help:export-diagnostics", "导出诊断信息…")).unwrap();
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
    // Wave15 C: 隐藏无头 CLI `--diag-export <zip>`。在构建任何 Tauri 插件
    // （含 single-instance）之前拦截：不弹窗、不开 webview、不进主循环，
    // 直接收集写出后以进程码退出。CI 冒烟与菜单共用 diagnostics::write_diagnostic_zip。
    let argv: Vec<String> = std::env::args().collect();
    if let Some(pos) = argv.iter().position(|a| a == "--diag-export") {
        if let Some(out) = argv.get(pos + 1) {
            std::process::exit(diagnostics::diag_export_cli(out));
        } else {
            eprintln!("[diag-export] missing <zip path> argument");
            std::process::exit(2);
        }
    }

    // Wave17: 隐藏无头自检 `--native-autosave-selftest <dir>`。在构建任何 Tauri
    // 插件之前拦截：不弹窗、不开 webview，写一份测试 .kbnote+assets 再校验落盘与
    // 路径穿越拒绝，exit 0/1。供本地/CI 冒烟；不影响正常启动。
    if let Some(pos) = argv.iter().position(|a| a == "--native-autosave-selftest") {
        if let Some(dir) = argv.get(pos + 1) {
            std::process::exit(native_autosave::selftest_cli(dir));
        } else {
            eprintln!("[native-autosave-selftest] missing <dir> argument");
            std::process::exit(2);
        }
    }

    // Wave13: tauri-plugin-log is the global `log` logger (file + stdout +
    // webview). It replaces the previous env_logger bootstrap; do NOT init a
    // second global logger here or the process will panic on setup.

    // Wave16-I: Windows portable mode. Decide BEFORE building the app whether to
    // redirect all app data next to the exe. The decision is a pure function fed
    // by a one-shot filesystem probe; on redirect we set Tauri's
    // `appDirectoriesOverride::Root`, which moves the path resolver itself, so
    // every existing call site (recents, logs, window-state, backups, and the
    // WebView2 user-data dir derived from app_local_data_dir) follows without a
    // second set of path joins. No marker -> system dirs, behavior unchanged.
    let exe_dir = portable::current_exe_dir();
    let probe = portable::probe_exe_dir(&exe_dir);
    let decision = portable::decide_portable(&probe);
    // The global logger is not installed yet, so bootstrap via stderr; the log
    // plugin repeats nothing here, but this line shows up in release console /
    // CI captures when something looks off.
    eprintln!(
        "[drawpaper] portable={}: {}",
        decision.portable, decision.reason
    );

    let mut context = tauri::generate_context!();
    if let Some(root) = &decision.override_root {
        context.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(
                root.clone(),
            ));
    }

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
        // Wave15 A: manual updater. Registers the plugin + its JS commands, but
        // performs NO background check — we only call .check() from the menu
        // handler on user click (see run_manual_update_check).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        // Wave17: 原生文件夹自动保存的独立状态（选定目录）。
        .manage(native_autosave::AutosaveState::default())
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
                // Wave15 A: 纯用户手动触发的原生更新流程。这是整个 crate 里
                // 唯一触发 updater 网络请求的地方——没有启动检查、没有定时器、
                // 没有轮询、没有自动下载。无更新 / 离线 / 端点未就绪 / 任意报错
                // 一律回退为打开 Releases 网页（见 run_manual_update_check）。
                if id == "help:check-update" {
                    run_manual_update_check(app);
                    return;
                }
                // 在资源管理器中 reveal 数据目录。
                if id == "help:open-data-dir" {
                    if let Ok(dir) = app.path().app_data_dir() {
                        let _ = app.opener().reveal_item_in_dir(&dir);
                    }
                    return;
                }
                // Wave15 C: 导出诊断信息。菜单回调是同步的，spawn 一个 async 任务
                // 去 await 原生 Save 对话框 oneshot；取消即静默返回（不报错）。
                if id == "help:export-diagnostics" {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let default_name = diagnostics::diagnostic_default_filename();
                        let (tx, rx) = tokio::sync::oneshot::channel();
                        app.dialog()
                            .file()
                            .set_title("导出诊断信息")
                            .set_file_name(&default_name)
                            .add_filter("ZIP 压缩包", &["zip"])
                            .save_file(move |res| {
                                let _ = tx.send(res);
                            });
                        let picked = match rx.await {
                            Ok(p) => p,
                            Err(_) => return,
                        };
                        let Some(picked) = picked else {
                            // 用户取消 —— 不报错、不弹窗。
                            return;
                        };
                        let out: std::path::PathBuf =
                            match picked.into_path() { Ok(p) => p, Err(_) => return };
                        let data_dir = app
                            .path()
                            .app_data_dir()
                            .unwrap_or_else(|_| std::path::PathBuf::from("."));
                        let log_path =
                            data_dir.join("logs").join("drawpaper.log");
                        let result =
                            diagnostics::write_diagnostic_zip(&data_dir, &log_path, &out);
                        match result {
                            Ok(report) => {
                                let msg = format!(
                                    "诊断信息已导出到：\n{}\n\n包内 {} 个条目，清单 {} 个文件。\n（不含任何 .kbnote 正文或 assets 资产字节）",
                                    out.display(),
                                    report.entry_names.len(),
                                    report.manifest_count
                                );
                                app.dialog()
                                    .message(msg)
                                    .title("导出诊断信息")
                                    .show(|_| {});
                            }
                            Err(e) => {
                                app.dialog()
                                    .message(format!("导出诊断信息失败：{e}"))
                                    .title("导出诊断信息")
                                    .show(|_| {});
                            }
                        }
                    });
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
            notify,
            backup_doc,
            set_window_title,
            bind_native_file,
            set_native_dirty,
            force_quit,
            // Wave17: 原生文件夹自动保存（实现在 native_autosave.rs）。
            native_autosave::autosave_pick_dir,
            native_autosave::autosave_clear_dir,
            native_autosave::autosave_get_dir,
            native_autosave::autosave_dir_writable,
            native_autosave::autosave_write_file,
        ])
        .run(context)
        .expect("error while running drawpaper desktop shell");
}

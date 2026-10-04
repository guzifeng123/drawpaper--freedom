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
use tauri::{
    Emitter, Manager, Menu, MenuEvent, Submenu, AboutMetadata, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const RECENTS_CAP: usize = 10;
const RECENTS_FILE: &str = "drawpaper-recents.json";
const AUTOSAVE_FILE: &str = "drawpaper-autosave.json";

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
    let mut recents = state.recents.lock().unwrap();
    let p = path.to_string_lossy().to_string();
    recents.retain(|x| x != &p);
    recents.push_front(p);
    while recents.len() > RECENTS_CAP {
        recents.pop_back();
    }
    persist_recents(app, &recents);
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
    let path: PathBuf = path.into();
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
        p.into()
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

/// Recent files list (native File → Open Recent menu + frontend docs list).
#[tauri::command]
fn list_recents(state: tauri::State<'_, AppState>) -> Vec<String> {
    state.recents.lock().unwrap().iter().cloned().collect()
}

/// Clear recents.
#[tauri::command]
fn clear_recents(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    let mut r = state.recents.lock().unwrap();
    r.clear();
    persist_recents(&app, &r);
}

/// Absolute path of the `.kbnote` the user double-clicked to launch the app
/// (file association). Returns None if the app was launched normally. The
/// frontend calls this once on boot; if non-null, it loads that file.
#[tauri::command]
fn get_startup_file(state: tauri::State<'_, AppState>) -> Option<String> {
    state.current_path.lock().unwrap().clone().map(|p| p.to_string_lossy().to_string())
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
    let folder: PathBuf = folder.into();
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
// Menu
// ---------------------------------------------------------------------------

fn build_menu(app: &tauri::App) -> Menu {
    use tauri::menu::{AboutMenuItem, PredefinedMenuItem, Submenu};

    let file = Submenu::new(app, "文件", true).unwrap();
    file.append(&tauri::menu::MenuItem::with_id(
        app, "file:new", "新建画布", true, None::<&str>,
    ))
    .unwrap();
    file.append(&tauri::menu::MenuItem::with_id(
        app, "file:open", "打开…\tCtrl+O", true, None::<&str>,
    ))
    .unwrap();
    file.append(&tauri::menu::MenuItem::with_id(
        app, "file:save", "保存\tCtrl+S", true, None::<&str>,
    ))
    .unwrap();
    file.append(&tauri::menu::MenuItem::with_id(
        app, "file:save-as", "另存为…", true, None::<&str>,
    ))
    .unwrap();
    file.append(&PredefinedMenuItem::separator(app)).unwrap();
    file.append(&tauri::menu::MenuItem::with_id(
        app, "file:open-recent", "打开最近", true, None::<&str>,
    ))
    .unwrap();
    file.append(&tauri::menu::MenuItem::with_id(
        app, "file:clear-recent", "清空最近", true, None::<&str>,
    ))
    .unwrap();

    let edit = Submenu::new(app, "编辑", true).unwrap();
    edit.append(&tauri::menu::MenuItem::with_id(
        app, "edit:undo", "撤销\tCtrl+Z", true, None::<&str>,
    ))
    .unwrap();
    edit.append(&tauri::menu::MenuItem::with_id(
        app, "edit:redo", "重做\tCtrl+Shift+Z", true, None::<&str>,
    ))
    .unwrap();

    let export = Submenu::new(app, "导出", true).unwrap();
    export
        .append(&tauri::menu::MenuItem::with_id(
            app, "export:print", "打印 / 另存为 PDF\tCtrl+P", true, None::<&str>,
        ))
        .unwrap();
    export
        .append(&tauri::menu::MenuItem::with_id(
            app, "export:pdf", "直接下载 PDF", true, None::<&str>,
        ))
        .unwrap();

    let view = Submenu::new(app, "视图", true).unwrap();
    view.append(&tauri::menu::MenuItem::with_id(
        app, "view:fit", "适应屏幕\tCtrl+0", true, None::<&str>,
    ))
    .unwrap();
    view.append(&tauri::menu::MenuItem::with_id(
        app, "view:zoom-in", "放大\tCtrl+=", true, None::<&str>,
    ))
    .unwrap();
    view.append(&tauri::menu::MenuItem::with_id(
        app, "view:zoom-out", "缩小\tCtrl+-", true, None::<&str>,
    ))
    .unwrap();

    let help = Submenu::new(app, "帮助", true).unwrap();
    help.append(&AboutMenuItem::new(
        app,
        Some(AboutMetadata {
            name: Some("drawpaper".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            authors: Some(vec!["drawpaper contributors".to_string()]),
            comments: Some("Local-first infinite-canvas knowledge-block notes.".to_string()),
            ..Default::default()
        }),
    ))
    .unwrap();

    Menu::with_items(
        app,
        &[&file, &edit, &export, &view, &help],
    )
    .unwrap()
}

// ---------------------------------------------------------------------------
// File-association launch: when Windows hands us a .kbnote path on the command
// line (double-click), stash it in state and emit to the frontend.
// ---------------------------------------------------------------------------

fn maybe_seed_startup_file(state: &AppState, app: &tauri::AppHandle) {
    let argv: Vec<String> = std::env::args().collect();
    // argv[0] is the exe; a file association launch passes the path as argv[1].
    if let Some(path) = argv.get(1) {
        let p = Path::new(path).to_path_buf();
        if p.extension().and_then(|e| e.to_str()) == Some("kbnote") && p.exists() {
            {
                let mut cur = state.current_path.lock().unwrap();
                *cur = Some(p.clone());
            }
            push_recent(state, app, &p);
            // Emit so the frontend immediately loads it.
            let _ = app.emit(
                "app:open-file",
                serde_json::json!({ "path": p.to_string_lossy().to_string() }),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second instance was launched (e.g. user double-clicked another
            // .kbnote). Forward the argv path to the already-running window.
            if let Some(path) = argv.get(1) {
                let _ = app.emit(
                    "app:open-file",
                    serde_json::json!({ "path": path, "external": true }),
                );
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
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
            {
                let state: tauri::State<AppState> = app.state();
                maybe_seed_startup_file(&state, &app.handle());
            }

            // Build native menu and route events to the frontend.
            let menu = build_menu(app);
            app.set_menu(menu.clone())?;
            app.on_menu_event(move |app: &tauri::AppHandle, event: MenuEvent| {
                // Every menu click becomes an `app:menu` event with the item id.
                // The frontend maps ids to store actions (undo/redo/print/fit).
                let _ = app.emit("app:menu", serde_json::json!({ "id": event.as_ref() }));
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_kbnote,
            save_kbnote,
            print,
            list_recents,
            clear_recents,
            get_startup_file,
            choose_auto_save_dir,
            auto_save_doc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running drawpaper desktop shell");
}

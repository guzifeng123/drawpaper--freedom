//! Wave16-I: Windows portable ("USB drive") mode.
//!
//! When a `drawpaper.portable` marker file (empty file is fine) **or** a
//! pre-existing `data/` directory sits next to `drawpaper.exe`, the app redirects
//! ALL Rust-managed app data into `./data/` beside the exe instead of
//! `%APPDATA%` / `%LOCALAPPDATA%`. The installed build (no marker) is unchanged.
//!
//! Mechanism: the decision in [`decide_portable`] is a PURE function over
//! already-probed facts. When it decides "portable", the caller hands Tauri an
//! `AppDirectoriesOverride::Root(<exe_dir>/data)` *before* the app builds, which
//! moves the path resolver itself. Every existing call site then follows for free:
//!
//!   * `app_config_dir()`   -> `<exe_dir>/data`            (recents JSON, autosave
//!                                                           manifest, window-state)
//!   * `app_data_dir()`     -> `<exe_dir>/data`            (backups/)
//!   * `app_log_dir()`      -> `<exe_dir>/data/logs`       (drawpaper.log)
//!   * `app_local_data_dir()`-> `<exe_dir>/data`           (WebView2 EBWebView user
//!                                                           data dir — Tauri forces
//!                                                           the webview data dir from
//!                                                           this resolver on Windows)
//!   * `app_cache_dir()`    -> `<exe_dir>/data/caches`
//!
//! So there is exactly ONE place that decides where data lives; the rest of the
//! shell keeps using `app.path()` and never re-concatenates paths.
//!
//! The pure decision has no `#[cfg(windows)]` gating inside it — the OS is passed
//! in as [`Platform`] — so `cargo test` on the Linux host exercises every branch.

use std::path::{Path, PathBuf};

/// Marker file next to the exe that forces portable mode. May be empty.
pub const PORTABLE_MARKER: &str = "drawpaper.portable";
/// Data directory beside the exe that holds all app data in portable mode.
pub const PORTABLE_DATA_DIR: &str = "data";

/// The OS the process is running on. Passed into the pure decision instead of
/// using `#[cfg]` inside it, so the same test binary runs on any host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Linux,
    Macos,
    Other,
}

impl Platform {
    /// Current OS, derived from `#[cfg]` exactly once at the call boundary.
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else if cfg!(target_os = "linux") {
            Platform::Linux
        } else {
            Platform::Other
        }
    }
}

/// Already-probed facts about the exe directory. The decision function does no
/// I/O; the caller gathers these once at startup (see [`probe_exe_dir`]).
#[derive(Debug, Clone)]
pub struct PortableProbe {
    /// Absolute directory containing the running exe.
    pub exe_dir: PathBuf,
    /// Whether `drawpaper.portable` exists next to the exe (any size).
    pub marker_present: bool,
    /// Whether a `data/` directory already exists next to the exe.
    pub data_dir_present: bool,
    /// The OS. Portable mode is a Windows-distribution feature.
    pub platform: Platform,
    /// Whether we could create `exe_dir/data/` and write+delete a probe file in it.
    pub portable_dir_writable: bool,
}

/// Result of the portable-mode decision.
#[derive(Debug, Clone)]
pub struct PortableDecision {
    /// The root to hand Tauri as `AppDirectoriesOverride::Root`. `None` means
    /// installed mode: leave Tauri's default system dirs untouched.
    pub override_root: Option<PathBuf>,
    /// True iff portable mode is active.
    pub portable: bool,
    /// Human-readable reason, safe to log at startup.
    pub reason: String,
}

/// Pure decision: should app data be redirected next to the exe?
///
/// No fs, no env, no panics. Portable mode activates only when ALL hold:
///   1. the OS is Windows,
///   2. a trigger exists (`drawpaper.portable` marker OR an existing `data/` dir),
///   3. `exe_dir/data/` is writable.
/// Otherwise it returns `None` (installed mode) with an explanatory reason.
pub fn decide_portable(probe: &PortableProbe) -> PortableDecision {
    let wants_portable = probe.marker_present || probe.data_dir_present;

    // Portable mode is a Windows distribution feature. Never flip the dev / Linux
    // build into it even if a stray `data/` dir exists in the repo checkout.
    if probe.platform != Platform::Windows {
        return PortableDecision {
            override_root: None,
            portable: false,
            reason: format!(
                "portable mode skipped: platform is not Windows ({:?}); using system app-data dirs",
                probe.platform
            ),
        };
    }

    if !wants_portable {
        return PortableDecision {
            override_root: None,
            portable: false,
            reason: format!(
                "installed mode: no `{PORTABLE_MARKER}` marker and no `{PORTABLE_DATA_DIR}/` dir next to the exe; using system app-data dirs"
            ),
        };
    }

    if !probe.portable_dir_writable {
        return PortableDecision {
            override_root: None,
            portable: false,
            reason: format!(
                "portable trigger present but `{}/{}/` is NOT writable (read-only media?); falling back to system app-data dirs",
                probe.exe_dir.display(),
                PORTABLE_DATA_DIR
            ),
        };
    }

    let root = probe.exe_dir.join(PORTABLE_DATA_DIR);
    PortableDecision {
        portable: true,
        override_root: Some(root.clone()),
        reason: format!(
            "portable mode ON: redirecting app data to `{}` (marker={}, existing data/={})",
            root.display(),
            probe.marker_present,
            probe.data_dir_present
        ),
    }
}

/// Absolute directory containing the current exe. Falls back to `.` if the exe
/// path cannot be determined (e.g. running under a bare loader).
pub fn current_exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Gather the facts [`decide_portable`] needs by touching the filesystem once.
/// Best-effort: any error degrades to "not present / not writable", never panics.
pub fn probe_exe_dir(exe_dir: &Path) -> PortableProbe {
    let marker = exe_dir.join(PORTABLE_MARKER);
    let data_dir = exe_dir.join(PORTABLE_DATA_DIR);

    let marker_present = marker.is_file();
    let data_dir_present = data_dir.is_dir();

    // Only probe writability when a trigger is actually present — otherwise the
    // installed build must not create a spurious `data/` next to the exe.
    let portable_dir_writable = if marker_present || data_dir_present {
        dir_is_writable(&data_dir)
    } else {
        false
    };

    PortableProbe {
        exe_dir: exe_dir.to_path_buf(),
        marker_present,
        data_dir_present,
        platform: Platform::current(),
        portable_dir_writable,
    }
}

/// Create `dir` if needed, then write+remove a probe file. False on any error
/// (read-only media, permission denied, etc.) — the caller then falls back.
fn dir_is_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decide(
        exe: &Path,
        marker: bool,
        data_dir: bool,
        writable: bool,
        platform: Platform,
    ) -> PortableDecision {
        decide_portable(&PortableProbe {
            exe_dir: exe.to_path_buf(),
            marker_present: marker,
            data_dir_present: data_dir,
            platform,
            portable_dir_writable: writable,
        })
    }

    // Case 1: marker present, on Windows, writable -> redirect to ./data.
    #[test]
    fn marker_present_redirects_to_exe_data() {
        let exe = Path::new("D:/usb/drawpaper");
        let d = decide(exe, true, false, true, Platform::Windows);
        assert!(d.portable, "expected portable on with marker; reason={}", d.reason);
        assert_eq!(
            d.override_root.as_deref(),
            Some(exe.join("data").as_path())
        );
    }

    // Case 2: no marker and no data/ dir -> installed mode, system dirs.
    #[test]
    fn no_trigger_uses_system_dirs() {
        let exe = Path::new("C:/Program Files/drawpaper");
        let d = decide(exe, false, false, false, Platform::Windows);
        assert!(!d.portable);
        assert_eq!(d.override_root, None);
    }

    // Case 3: trigger present but ./data NOT writable -> safe fallback, no panic.
    #[test]
    fn read_only_data_dir_falls_back_safely() {
        let exe = Path::new("E:/cdrom/drawpaper");
        let d = decide(exe, true, true, false, Platform::Windows);
        assert!(!d.portable, "must fall back when ./data is not writable");
        assert_eq!(d.override_root, None);
        assert!(
            d.reason.contains("writable"),
            "reason should explain the fallback: {}",
            d.reason
        );
    }

    // data/ dir alone (no marker) is also a trigger.
    #[test]
    fn existing_data_dir_also_triggers_portable() {
        let exe = Path::new("D:/usb/drawpaper");
        let d = decide(exe, false, true, true, Platform::Windows);
        assert!(d.portable);
        assert_eq!(
            d.override_root.as_deref(),
            Some(exe.join("data").as_path())
        );
    }

    // Portable mode must NOT activate off Windows, even with a trigger — the dev
    // build on Linux must never redirect into the repo checkout.
    #[test]
    fn non_windows_never_enters_portable() {
        let exe = Path::new("/home/dev/drawpaper");
        let d = decide(exe, true, true, true, Platform::Linux);
        assert!(!d.portable);
        assert_eq!(d.override_root, None);
    }

    // Marker present but writability unknown/false with no pre-existing data dir
    // must also fall back rather than claim portable.
    #[test]
    fn marker_but_unwritable_falls_back() {
        let exe = Path::new("F:/locked/drawpaper");
        let d = decide(exe, true, false, false, Platform::Windows);
        assert!(!d.portable);
        assert_eq!(d.override_root, None);
    }
}

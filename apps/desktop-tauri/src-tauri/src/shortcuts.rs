//! Wave17: desktop GLOBAL shortcuts — pure logic, no Tauri imports.
//!
//! This file intentionally has ZERO Tauri / serde imports so it compiles and
//! unit-tests standalone under `rustc --test src/shortcuts.rs --test`. The
//! Tauri wiring (parsing accelerators into `Accelerator`, calling
//! `global_shortcut().on_shortcut(...)`, emitting `app:menu`) lives in
//! `lib.rs`. Everything here is data: the default binding set, the
//! accelerator→action table, config override resolution, and the failure
//! taxonomy that gets rendered into `log::warn!` lines.
//!
//! Failure contract (never panic, never block startup):
//!   * config file missing       → silently use defaults
//!   * config file unreadable/corrupt → warn, use defaults
//!   * unknown action            → warn, skip that entry
//!   * malformed accelerator     → warn, skip that entry
//!   * duplicate accelerator     → warn, keep the first, drop the later
//!   * OS-level register conflict → handled in lib.rs (register returns Err)

use std::collections::HashMap;

/// Action that is NOT routed through the menu channel: it asks the main window
/// to show itself, un-minimize, and take focus.
pub const ACTION_FOCUS_WINDOW: &str = "focus_window";

/// File name (under the app config dir) holding the user's accelerator→action
/// overrides. Mirrors `drawpaper-recents.json` / `drawpaper-autosave.json`.
pub const SHORTCUTS_FILE: &str = "drawpaper-shortcuts.json";

/// One resolved accelerator→action binding.
///
/// `action` is either [`ACTION_FOCUS_WINDOW`] or a native menu id that the
/// existing `app:menu` event channel already understands (e.g. `file:save`).
/// The global-shortcut callback therefore reuses the exact same code path as a
/// user clicking the corresponding menu item — no new business logic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    /// Tauri accelerator string, e.g. `"Ctrl+Shift+D"`.
    pub accelerator: String,
    /// Either [`ACTION_FOCUS_WINDOW`] or a menu id.
    pub action: String,
}

/// Every action we recognise. Anything else in the user's config is rejected
/// (warn + skip), never a panic.
pub fn known_actions() -> [&'static str; 4] {
    [
        ACTION_FOCUS_WINDOW,
        "file:save",
        "export:print",
        "view:search",
    ]
}

/// Built-in default accelerator→action set. The menu-id actions are chosen so
/// the global shortcut triggers the SAME `app:menu{id}` event as clicking the
/// corresponding native menu item:
///
///   * `Ctrl+Shift+D` → focus main window (special-cased, not a menu id)
///   * `Ctrl+S`       → menu `file:save`   (文件 → 保存)
///   * `Ctrl+P`       → menu `export:print`(导出 → 打印 / 另存为 PDF)
///   * `Ctrl+F`       → menu `view:search` (视图 → 搜索…)
pub fn default_bindings() -> Vec<Binding> {
    vec![
        Binding {
            accelerator: "Ctrl+Shift+D".to_string(),
            action: ACTION_FOCUS_WINDOW.to_string(),
        },
        Binding {
            accelerator: "Ctrl+S".to_string(),
            action: "file:save".to_string(),
        },
        Binding {
            accelerator: "Ctrl+P".to_string(),
            action: "export:print".to_string(),
        },
        Binding {
            accelerator: "Ctrl+F".to_string(),
            action: "view:search".to_string(),
        },
    ]
}

/// How the user's config file was seen on disk. lib.rs does the IO + serde
/// step and hands us a discriminated result; this module only reasons about it.
#[derive(Debug, Clone)]
pub enum ConfigSource {
    /// No config file present — silently use defaults (not an error).
    Absent,
    /// File present but unreadable / not valid JSON / wrong shape. Carries a
    /// human reason. We warn and fall back to defaults.
    Invalid(String),
    /// Parsed flat `{ accelerator: action }` entries from the file, in file
    /// order. We keep pairs (not a HashMap) so a duplicated JSON key is
    /// detectable here instead of being silently collapsed by serde.
    Parsed(Vec<(String, String)>),
}

/// Why a binding was dropped / config rejected. Rendered verbatim into a
/// `log::warn!` by lib.rs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Issue {
    /// Config present but unusable — whole file ignored, defaults used.
    ConfigInvalid(String),
    /// User bound an accelerator to an action we don't know.
    UnknownAction { accelerator: String, action: String },
    /// Accelerator string is obviously malformed before Tauri even parses it.
    MalformedAccelerator { accelerator: String, reason: String },
    /// Same accelerator resolved twice; the later copy was dropped.
    DuplicateBinding { accelerator: String, kept: String, dropped: String },
}

impl std::fmt::Display for Issue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Issue::ConfigInvalid(reason) => {
                write!(f, "shortcuts config unusable, using defaults: {reason}")
            }
            Issue::UnknownAction { accelerator, action } => write!(
                f,
                "skipping '{accelerator}': unknown action '{action}' (known: {})",
                known_actions().join(", ")
            ),
            Issue::MalformedAccelerator { accelerator, reason } => {
                write!(f, "skipping accelerator '{accelerator}': {reason}")
            }
            Issue::DuplicateBinding {
                accelerator,
                kept,
                dropped,
            } => write!(
                f,
                "accelerator '{accelerator}' bound to both '{kept}' and '{dropped}'; keeping '{kept}'"
            ),
        }
    }
}

/// Result of merging defaults + user overrides.
#[derive(Debug)]
pub struct Resolved {
    /// The final, deduped binding set to hand to Tauri.
    pub bindings: Vec<Binding>,
    /// Everything we warned about while resolving (caller logs each).
    pub issues: Vec<Issue>,
    /// True iff we actually used a (valid) user config file. False = defaults.
    pub used_config: bool,
}

/// Minimal sanity check before Tauri parses the accelerator. Tauri's own
/// `FromStr`/`TryInto<ShortcutWrapper>` is the source of truth at register
/// time; this only catches obviously-broken entries early so we can warn
/// instead of waiting for `register` to fail.
fn looks_valid_accelerator(raw: &str) -> Result<(), String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("empty accelerator".to_string());
    }
    if t.chars().any(char::is_whitespace) {
        return Err(format!("whitespace not allowed in accelerator '{t}'"));
    }
    // Must end in a non-modifier key (e.g. '+S' alone is bogus).
    let last = t.rsplit('+').next().unwrap_or("");
    if last.is_empty() {
        return Err(format!("accelerator '{t}' ends in '+' with no key"));
    }
    Ok(())
}

/// Normalize an accelerator key for conflict detection: trim surrounding
/// whitespace. We deliberately do NOT case-fold modifiers (Tauri treats
/// `ctrl` and `Ctrl` as equivalent at parse time, but keeping the user's
/// spelling in the log makes debugging easier).
fn norm(s: &str) -> String {
    s.trim().to_string()
}

/// Resolve the final binding set from defaults + optional user overrides.
/// Pure: same input → same output, no IO, no Tauri.
pub fn resolve(source: ConfigSource) -> Resolved {
    let mut issues: Vec<Issue> = Vec::new();
    let mut used_config = false;

    // Start from defaults, keyed by normalized accelerator.
    let mut map: HashMap<String, Binding> = HashMap::new();
    for b in default_bindings() {
        map.insert(norm(&b.accelerator), b);
    }

    match source {
        ConfigSource::Absent => {
            // Silent: first run, no config yet.
        }
        ConfigSource::Invalid(reason) => {
            issues.push(Issue::ConfigInvalid(reason));
            // Bindings stay as defaults.
        }
        ConfigSource::Parsed(user) => {
            used_config = true;
            // Accelerators the user has already explicitly set this run. We
            // only warn on a conflict when the SAME accelerator appears twice in
            // the user's own file — overriding a default is a feature, not a
            // conflict.
            let mut user_touched: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (accel_raw, action) in user {
                let accel = norm(&accel_raw);

                // Empty action means "unbind this accelerator".
                if action.trim().is_empty() {
                    map.remove(&accel);
                    user_touched.insert(accel);
                    continue;
                }

                if let Err(reason) = looks_valid_accelerator(&accel) {
                    issues.push(Issue::MalformedAccelerator {
                        accelerator: accel,
                        reason,
                    });
                    continue;
                }

                if !known_actions().contains(&action.as_str()) {
                    issues.push(Issue::UnknownAction {
                        accelerator: accel.clone(),
                        action,
                    });
                    continue;
                }

                // Duplicate accelerator WITHIN the user's own file: if it was
                // already set by an earlier user entry and now points at a
                // DIFFERENT action, warn and keep the first. Same action twice
                // is a harmless no-op.
                if user_touched.contains(&accel) {
                    let existing_action = map.get(&accel).map(|b| b.action.clone());
                    if existing_action.as_deref() != Some(action.as_str()) {
                        issues.push(Issue::DuplicateBinding {
                            accelerator: accel.clone(),
                            kept: existing_action.unwrap_or_default(),
                            dropped: action.clone(),
                        });
                        continue;
                    }
                    continue;
                }
                user_touched.insert(accel.clone());

                // Replace (override a default) or insert (new accelerator).
                map.insert(
                    accel.clone(),
                    Binding {
                        accelerator: accel,
                        action,
                    },
                );
            }
        }
    }

    // Stable, predictable order: defaults first (in default order), then any
    // extra user bindings appended alphabetically. This keeps log output
    // deterministic across runs, which the CI smoke anchors on.
    let mut bindings: Vec<Binding> = Vec::new();
    for d in default_bindings() {
        if let Some(b) = map.get(&norm(&d.accelerator)) {
            bindings.push(b.clone());
        }
    }
    let mut extras: Vec<Binding> = map
        .into_values()
        .filter(|b| !default_bindings().iter().any(|d| d.accelerator == b.accelerator))
        .collect();
    extras.sort_by(|a, b| a.accelerator.cmp(&b.accelerator));
    bindings.extend(extras);

    Resolved {
        bindings,
        issues,
        used_config,
    }
}

/// Look up the menu id a binding should emit, if any.
/// Returns `None` for [`ACTION_FOCUS_WINDOW`] (handled via window API, not the
/// menu channel).
pub fn action_to_menu_id(action: &str) -> Option<&str> {
    if action == ACTION_FOCUS_WINDOW {
        None
    } else {
        Some(action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_set_is_four_bindings_and_stable_order() {
        let b = default_bindings();
        assert_eq!(b.len(), 4);
        assert_eq!(b[0].accelerator, "Ctrl+Shift+D");
        assert_eq!(b[0].action, ACTION_FOCUS_WINDOW);
        assert_eq!(b[1].accelerator, "Ctrl+S");
        assert_eq!(b[1].action, "file:save");
        assert_eq!(b[2].accelerator, "Ctrl+P");
        assert_eq!(b[2].action, "export:print");
        assert_eq!(b[3].accelerator, "Ctrl+F");
        assert_eq!(b[3].action, "view:search");
    }

    #[test]
    fn absent_config_uses_defaults_silently() {
        let r = resolve(ConfigSource::Absent);
        assert_eq!(r.bindings.len(), 4);
        assert!(!r.used_config);
        assert!(r.issues.is_empty());
    }

    #[test]
    fn corrupt_config_falls_back_to_defaults_with_one_issue() {
        let r = resolve(ConfigSource::Invalid("expected value at line 1 column 1".into()));
        assert_eq!(r.bindings.len(), 4);
        assert!(!r.used_config);
        assert_eq!(r.issues.len(), 1);
        match &r.issues[0] {
            Issue::ConfigInvalid(_) => {}
            other => panic!("expected ConfigInvalid, got {:?}", other),
        }
    }

    #[test]
    fn user_override_remaps_an_existing_accelerator() {
        let r = resolve(ConfigSource::Parsed(vec![(
            "Ctrl+Shift+D".to_string(),
            "view:search".to_string(),
        )]));
        assert!(r.used_config);
        let d = r.bindings.iter().find(|b| b.accelerator == "Ctrl+Shift+D").unwrap();
        assert_eq!(d.action, "view:search");
        assert!(r.issues.is_empty());
    }

    #[test]
    fn unknown_action_is_skipped_with_issue() {
        let r = resolve(ConfigSource::Parsed(vec![(
            "Ctrl+Shift+X".to_string(),
            "does:not-exist".to_string(),
        )]));
        // New accelerator dropped; defaults intact.
        assert!(!r.bindings.iter().any(|b| b.accelerator == "Ctrl+Shift+X"));
        assert_eq!(r.bindings.len(), 4);
        assert_eq!(r.issues.len(), 1);
        match &r.issues[0] {
            Issue::UnknownAction { accelerator, action } => {
                assert_eq!(accelerator, "Ctrl+Shift+X");
                assert_eq!(action, "does:not-exist");
            }
            other => panic!("expected UnknownAction, got {:?}", other),
        }
    }

    #[test]
    fn malformed_accelerator_is_skipped_with_issue() {
        let r = resolve(ConfigSource::Parsed(vec![
            ("Ctrl+".to_string(), "file:save".to_string()),
            ("  ".to_string(), "file:save".to_string()),
        ]));
        assert_eq!(r.issues.len(), 2);
        assert!(r.issues.iter().any(|i| matches!(i, Issue::MalformedAccelerator { .. })));
    }

    #[test]
    fn empty_action_unbinds_a_default() {
        let r = resolve(ConfigSource::Parsed(vec![(
            "Ctrl+F".to_string(),
            "".to_string(),
        )]));
        assert!(!r.bindings.iter().any(|b| b.accelerator == "Ctrl+F"));
        assert_eq!(r.bindings.len(), 3);
    }

    #[test]
    fn duplicate_accelerator_with_conflicting_action_keeps_first() {
        // First entry binds Ctrl+Shift+G to file:save; second rebinds the same
        // accelerator to export:print. The first must win, second warned.
        let r = resolve(ConfigSource::Parsed(vec![
            ("Ctrl+Shift+G".to_string(), "file:save".to_string()),
            ("Ctrl+Shift+G".to_string(), "export:print".to_string()),
        ]));
        let g = r.bindings.iter().find(|b| b.accelerator == "Ctrl+Shift+G").unwrap();
        assert_eq!(g.action, "file:save");
        assert!(r.issues.iter().any(|i| matches!(i, Issue::DuplicateBinding { .. })));
    }

    #[test]
    fn duplicate_accelerator_same_action_is_harmless_noop() {
        let r = resolve(ConfigSource::Parsed(vec![
            ("Ctrl+Shift+G".to_string(), "file:save".to_string()),
            ("Ctrl+Shift+G".to_string(), "file:save".to_string()),
        ]));
        let g: Vec<_> = r.bindings.iter().filter(|b| b.accelerator == "Ctrl+Shift+G").collect();
        assert_eq!(g.len(), 1);
        assert!(!r.issues.iter().any(|i| matches!(i, Issue::DuplicateBinding { .. })));
    }

    #[test]
    fn action_to_menu_id_separates_window_focus() {
        assert_eq!(action_to_menu_id("file:save"), Some("file:save"));
        assert_eq!(action_to_menu_id(ACTION_FOCUS_WINDOW), None);
    }

    #[test]
    fn extra_user_binding_appended_after_defaults() {
        let r = resolve(ConfigSource::Parsed(vec![(
            "Ctrl+Shift+V".to_string(),
            "export:print".to_string(),
        )]));
        assert_eq!(r.bindings.len(), 5);
        // Defaults still first in order.
        assert_eq!(r.bindings[0].accelerator, "Ctrl+Shift+D");
        // Extra appended last.
        assert_eq!(r.bindings[4].accelerator, "Ctrl+Shift+V");
    }
}

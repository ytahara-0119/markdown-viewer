#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod markdown;
mod tree;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::event::ModifyKind;
use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    /// A path handed to us by the OS (Finder double-click, drag & drop, CLI arg)
    /// that the UI has not picked up yet.
    pending: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

#[derive(Serialize)]
struct OpenTarget {
    root: String,
    file: Option<String>,
}

#[derive(Serialize, Clone)]
struct FsChanged {
    paths: Vec<String>,
    structural: bool,
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tauri::command]
fn take_pending(state: State<AppState>) -> Option<String> {
    state.pending.lock().unwrap().take().map(|p| path_str(&p))
}

#[tauri::command]
fn resolve_open(path: String) -> Result<OpenTarget, String> {
    let p = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("{path}: {e}"))?;
    if p.is_dir() {
        let file = tree::find_index(&p).map(|f| path_str(&f));
        Ok(OpenTarget { root: path_str(&p), file })
    } else {
        let root = p.parent().map(Path::to_path_buf).unwrap_or_else(|| p.clone());
        Ok(OpenTarget { root: path_str(&root), file: Some(path_str(&p)) })
    }
}

#[tauri::command]
async fn list_tree(root: String) -> Result<tree::Node, String> {
    tree::build(Path::new(&root)).map_err(|e| format!("{root}: {e}"))
}

#[tauri::command]
async fn render_file(path: String) -> Result<markdown::Rendered, String> {
    markdown::render_file(Path::new(&path)).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn watch_root(app: AppHandle, state: State<AppState>, root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    let filter_root = root_path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let structural = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        );
        if !structural && !matches!(event.kind, EventKind::Modify(_)) {
            return;
        }
        let paths: Vec<String> = event
            .paths
            .iter()
            .filter(|p| !tree::is_ignored_path(&filter_root, p))
            .filter(|p| structural || tree::is_markdown(p))
            .map(|p| path_str(p))
            .collect();
        if !paths.is_empty() {
            let _ = app.emit("fs-changed", FsChanged { paths, structural });
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // Replacing the old watcher drops it, which stops watching the previous folder.
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

/// Queue a path from the OS and tell the UI to pick it up.
fn deliver_path(app: &AppHandle, path: PathBuf) {
    *app.state::<AppState>().pending.lock().unwrap() = Some(path);
    let _ = app.emit("open-requested", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            // `md-viewer path/to/file.md` from a terminal.
            if let Some(arg) = std::env::args_os()
                .skip(1)
                .find(|a| !a.to_string_lossy().starts_with('-'))
            {
                *app.state::<AppState>().pending.lock().unwrap() = Some(PathBuf::from(arg));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(p) = paths.first() {
                    deliver_path(window.app_handle(), p.clone());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            take_pending,
            resolve_open,
            list_tree,
            render_file,
            watch_root
        ])
        .build(tauri::generate_context!())
        .expect("failed to build MD Viewer");

    app.run(|_app, _event| {
        // Finder double-click / "Open With" / dropping onto the Dock icon.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                deliver_path(_app, path);
            }
        }
    });
}

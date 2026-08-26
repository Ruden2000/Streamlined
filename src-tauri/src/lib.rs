// Streamlined desktop shell.
//
// Goal: when the window is closed to the tray, the webview is destroyed (its
// memory is freed) and only a tiny background task remains — one WebSocket to
// the signaling server, waiting for an "incoming file" notice so it can raise a
// native notification. This is the lowest-footprint design that can still
// notify. The app stays alive with no window via prevent_exit + a tray icon.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;

// true while the main webview window exists/visible; gates whether the
// background helper raises a native notification (the webview handles its own).
static WINDOW_VISIBLE: AtomicBool = AtomicBool::new(true);
// set only by the tray "Quit" item, so window-close keeps the app running.
static QUITTING: AtomicBool = AtomicBool::new(false);
// true when launched by the OS at sign-in (--hidden): the webview boots just
// long enough to hand the room to the helper, then retires to the tray.
static LAUNCHED_HIDDEN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoomInfo {
    signaling_url: String,
    room: String,
    code: String,
    self_id: String,
}

#[derive(Default)]
struct Helper {
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    room: Mutex<Option<RoomInfo>>,
}

// ---- background WebSocket helper -------------------------------------------

async fn run_helper(app: AppHandle, info: RoomInfo) {
    let url = format!("{}?room={}", info.signaling_url, info.room);
    loop {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => {
                let (mut write, mut read) = ws.split();
                // Join as a LISTENER under a distinct id. Using the webview's own
                // device id here made the server route WebRTC signalling to
                // whichever socket it found first — often this one, which drops
                // it — so peers could never finish connecting. Listeners are
                // excluded from the peer mesh and only receive "notify".
                let join = serde_json::json!({
                    "type": "join",
                    "room": info.room,
                    "id": format!("{}#helper", info.self_id),
                    "role": "listener"
                })
                .to_string();
                if write
                    .send(tokio_tungstenite::tungstenite::Message::Text(join))
                    .await
                    .is_err()
                {
                    // fall through to reconnect
                } else {
                    while let Some(Ok(msg)) = read.next().await {
                        if let tokio_tungstenite::tungstenite::Message::Text(txt) = msg {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                                if v.get("type").and_then(|t| t.as_str()) == Some("notify") {
                                    // The webview, when present, shows its own
                                    // in-app + OS notification; only notify from
                                    // here when there's no window to do so.
                                    if !WINDOW_VISIBLE.load(Ordering::Relaxed) {
                                        let name =
                                            v.get("name").and_then(|n| n.as_str()).unwrap_or("a file");
                                        let from = v
                                            .get("fromName")
                                            .and_then(|n| n.as_str())
                                            .unwrap_or("a linked device");
                                        let _ = app
                                            .notification()
                                            .builder()
                                            .title("Streamlined — incoming file")
                                            .body(format!("\"{}\" from {}", name, from))
                                            .show();
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => log::warn!("helper ws connect failed: {e}"),
        }
        // reconnect after a short backoff (task is aborted on leave/replace)
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}

// ---- commands invoked from the webview -------------------------------------

#[tauri::command]
fn set_active_room(app: AppHandle, helper: State<'_, Helper>, info: RoomInfo) {
    *helper.room.lock().unwrap() = Some(info.clone());
    let mut h = helper.handle.lock().unwrap();
    if let Some(old) = h.take() {
        old.abort();
    }
    let app2 = app.clone();
    *h = Some(tauri::async_runtime::spawn(
        async move { run_helper(app2, info).await },
    ));
}

#[tauri::command]
fn get_active_room(helper: State<'_, Helper>) -> Option<RoomInfo> {
    helper.room.lock().unwrap().clone()
}

#[tauri::command]
fn clear_active_room(helper: State<'_, Helper>) {
    *helper.room.lock().unwrap() = None;
    if let Some(old) = helper.handle.lock().unwrap().take() {
        old.abort();
    }
}

// Download + install the latest signed update, then relaunch.
#[tauri::command]
async fn run_update(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            app.restart();
            #[allow(unreachable_code)]
            Ok(true)
        }
        None => Ok(false),
    }
}

// Rollback: open the prior release's signed installer so the user can reinstall
// it. (Silent in-place rollback is a later refinement.)
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // This can be reached with a link pasted on ANOTHER device via the synced
    // clipboard, so only ever hand plain http(s) URLs to the shell — never a
    // string that could carry shell metacharacters into `cmd /C`.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    if url.chars().any(|c| matches!(c, '"' | '^' | '&' | '|' | '<' | '>' | '\n' | '\r')) {
        return Err("link contains unsupported characters".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
        Err("unsupported".into())
    }
}

// ---- save-to-folder ----------------------------------------------------------

/// Ask the user for a destination folder. Returns None if they cancel.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = rx.await.map_err(|e| e.to_string())?;
    Ok(picked.map(|p| p.to_string()))
}

/// Write a received file into `dir`. `b64` is the file's bytes, base64-encoded.
#[tauri::command]
fn save_into_folder(dir: String, name: String, b64: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::path::{Path, PathBuf};

    let dir_path = PathBuf::from(&dir);
    if !dir_path.is_dir() {
        return Err("save folder is not available".into());
    }

    let rel = safe_relative_path(&name)?;
    let mut target = dir_path.join(&rel);

    // Belt and braces: whatever the segments were, the result must still sit
    // inside the chosen folder once the OS has normalised it.
    let canon_dir = dir_path.canonicalize().map_err(|e| e.to_string())?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let canon_parent = parent.canonicalize().map_err(|e| e.to_string())?;
        if !canon_parent.starts_with(&canon_dir) {
            return Err("unsafe file path".into());
        }
    }

    // Never overwrite: fall back to "name (2).ext", "name (3).ext", ...
    if target.exists() {
        let file_name = target
            .file_name()
            .map(|s| s.to_owned())
            .ok_or_else(|| "invalid file name".to_string())?;
        let parent = target.parent().map(|p| p.to_path_buf()).unwrap_or(dir_path.clone());
        let stem = Path::new(&file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let ext = Path::new(&file_name)
            .extension()
            .map(|s| format!(".{}", s.to_string_lossy()))
            .unwrap_or_default();
        for n in 2..10_000 {
            let cand = parent.join(format!("{} ({}){}", stem, n, ext));
            if !cand.exists() {
                target = cand;
                break;
            }
        }
    }

    let bytes = STANDARD.decode(b64.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Turn a peer-supplied file name into a relative path that cannot escape the
/// destination folder. A sent folder keeps its structure in the name
/// ("trip/day1/a.jpg") and we want that recreated — but the name arrives from
/// another device, so every segment is checked.
fn safe_relative_path(name: &str) -> Result<std::path::PathBuf, String> {
    use std::path::PathBuf;
    let mut rel = PathBuf::new();
    let segments: Vec<&str> = name.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if segments.is_empty() {
        return Err("invalid file name".into());
    }
    for seg in &segments {
        let t = seg.trim();
        // "." and ".." climb or stall; a colon smuggles in a drive letter or an
        // NTFS alternate data stream; control characters have no business here.
        if t.is_empty()
            || t == "."
            || t == ".."
            || t.contains(':')
            || t.chars().any(|c| c.is_control())
        {
            return Err("unsafe file name".into());
        }
        rel.push(t);
    }
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::safe_relative_path;
    use std::path::Path;

    #[test]
    fn keeps_a_sent_folders_structure() {
        let p = safe_relative_path("trip/day1/a.jpg").unwrap();
        assert_eq!(p, Path::new("trip").join("day1").join("a.jpg"));
    }

    #[test]
    fn plain_names_pass_through() {
        assert_eq!(safe_relative_path("photo.png").unwrap(), Path::new("photo.png"));
    }

    #[test]
    fn rejects_traversal() {
        for bad in ["../evil.exe", "a/../../evil", "..", "./../x", "a/./../../b"] {
            assert!(safe_relative_path(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn rejects_drive_qualified_paths() {
        for bad in ["C:/Windows/System32/x.dll", "C:evil", "a/b:stream"] {
            assert!(safe_relative_path(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn rejects_backslash_traversal() {
        assert!(safe_relative_path("..\\..\\evil").is_err());
        assert!(safe_relative_path("a\\..\\..\\b").is_err());
    }

    #[test]
    fn rejects_empty_and_control_characters() {
        assert!(safe_relative_path("").is_err());
        assert!(safe_relative_path("///").is_err());
        assert!(safe_relative_path("bad\u{0}name").is_err());
    }

    #[test]
    fn a_leading_slash_stays_relative() {
        // "/a/b.txt" must land at a/b.txt INSIDE the chosen folder, not at the
        // filesystem root.
        assert_eq!(safe_relative_path("/a/b.txt").unwrap(), Path::new("a").join("b.txt"));
    }
}

/// Open a saved file with whatever application handles it.
#[tauri::command]
fn open_saved_file(path: String) -> Result<(), String> {
    use std::path::Path;
    let p = Path::new(&path);
    if !p.is_file() {
        return Err("that file is no longer there".into());
    }
    // explorer.exe receives the path as a single argument, so there is no shell
    // to reinterpret anything inside it.
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // Attributes can't sit on a bare expression, so the fallback needs a block
    // (same shape as open_external above).
    #[cfg(not(target_os = "windows"))]
    {
        let _ = p;
        Err("unsupported".into())
    }
}

/// Reveal a saved file in the file manager, selected.
#[tauri::command]
fn reveal_saved_file(path: String) -> Result<(), String> {
    use std::path::Path;
    let p = Path::new(&path);
    if !p.exists() {
        return Err("that file is no longer there".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // Attributes can't sit on a bare expression, so the fallback needs a block
    // (same shape as open_external above).
    #[cfg(not(target_os = "windows"))]
    {
        let _ = p;
        Err("unsupported".into())
    }
}

// ---- startup launch (autostart) ----------------------------------------------

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    if enable {
        al.enable().map_err(|e| e.to_string())
    } else {
        al.disable().map_err(|e| e.to_string())
    }
}

// Did the OS launch us at sign-in? (--hidden is passed by the autostart entry.)
#[tauri::command]
fn launch_hidden() -> bool {
    LAUNCHED_HIDDEN.load(Ordering::Relaxed)
}

// Close the main window (webview destroyed, memory freed); tray + helper live on.
#[tauri::command]
fn retire_to_tray(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        WINDOW_VISIBLE.store(false, Ordering::Relaxed);
        let _ = w.close();
    }
}

// ---- window/tray helpers ----------------------------------------------------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // restore rather than spawn: unminimize first, or a minimized window
        // "shows" without ever appearing.
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    } else if WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("Streamlined")
        .inner_size(1040.0, 760.0)
        .min_inner_size(380.0, 560.0)
        .build()
        .is_ok()
    {
        // A rebuilt window is a NEW window object — re-arm the close-to-tray
        // handler, otherwise closing it a second time bypasses the tray logic.
        attach_close_to_tray(app);
    }
    WINDOW_VISIBLE.store(true, Ordering::Relaxed);
}

fn attach_close_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Let the webview be destroyed (frees its memory). prevent_exit
                // in the run loop keeps the process + tray + helper alive.
                WINDOW_VISIBLE.store(false, Ordering::Relaxed);
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered FIRST. The app deliberately outlives its window
        // (tray + background helper), so launching it again — Start menu,
        // desktop shortcut, autostart — used to spawn a whole second process,
        // each adding its own tray icon. Now the second launch just restores
        // the running one and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(Helper::default())
        .invoke_handler(tauri::generate_handler![
            set_active_room,
            get_active_room,
            clear_active_room,
            run_update,
            open_external,
            get_autostart,
            set_autostart,
            pick_folder,
            save_into_folder,
            open_saved_file,
            reveal_saved_file,
            launch_hidden,
            retire_to_tray
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle();

            // tray with Show / Quit
            let show_item = MenuItem::with_id(app, "show", "Show Streamlined", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Streamlined")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => {
                        QUITTING.store(true, Ordering::Relaxed);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Autostart boot: keep the window hidden. The webview loads, rejoins
            // the network, hands it to the helper, then calls retire_to_tray.
            if std::env::args().any(|a| a == "--hidden") {
                LAUNCHED_HIDDEN.store(true, Ordering::Relaxed);
                WINDOW_VISIBLE.store(false, Ordering::Relaxed);
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }

            attach_close_to_tray(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // code == None  -> the last window closed: stay alive in the tray.
                // code == Some  -> an explicit exit (tray Quit, or the updater
                // restarting into the new version): MUST be allowed through,
                // otherwise in-place updates deadlock against the installer.
                if code.is_none() && !QUITTING.load(Ordering::Relaxed) {
                    api.prevent_exit();
                }
            }
        });
}

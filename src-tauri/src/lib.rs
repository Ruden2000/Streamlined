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
                let join = serde_json::json!({ "type": "join", "room": info.room, "id": info.self_id })
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
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
            .title("Streamlined")
            .inner_size(1040.0, 760.0)
            .min_inner_size(380.0, 560.0)
            .build();
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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

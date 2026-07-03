pub mod accounts;
pub mod bdm;
pub mod download;
pub mod drive;
pub mod dropbox;
pub mod hls;
pub mod index;
pub mod ingest;
pub mod locate;
pub mod provider;
pub mod rclone;
pub mod search;
pub mod secrets;
pub mod speedtest;
pub mod stream;
pub mod transfer;
pub mod wetransfer;

use base64::Engine;
use download::{JobsState, NativeJobsState};
use rclone::supervisor::{start_rclone, stop_rclone, RcloneState};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// True once the user has chosen to really quit (tray "Quit" or Settings →
/// Quit). Closing the window normally only HIDES it (downloads keep running);
/// this flag lets the close handler tell a genuine quit apart from a hide.
#[derive(Default)]
struct Quitting(AtomicBool);

/// True once the system tray was built successfully. Close-to-hide is ONLY safe
/// when there's a tray to bring the window back — on a build with no icon (so no
/// tray) hiding would strand the window with no way to reopen it, so there we
/// let close actually close.
#[derive(Default)]
struct TrayReady(AtomicBool);

/// Run the shutdown cleanup that must happen on a REAL quit: kill the rclone
/// daemon and clear the HLS segment cache. Idempotent, so it's safe to call
/// from the quit path AND from the window `Destroyed` handler.
fn shutdown_cleanup(app: &tauri::AppHandle) {
    stop_rclone(&app.state::<RcloneState>());
    hls::cleanup(app);
}

/// Reveal + focus the main window (from the tray icon / its menu).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Really quit the app: mark quitting (so the close handler doesn't intercept),
/// run cleanup, then exit. Invoked by the Settings "Quit" button.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.state::<Quitting>().0.store(true, Ordering::SeqCst);
    shutdown_cleanup(&app);
    app.exit(0);
}

#[tauri::command]
async fn rc_call(
    state: tauri::State<'_, RcloneState>,
    endpoint: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Clone the connection out of the lock synchronously (fast, non-blocking),
    // then run the blocking HTTP call on the blocking-thread pool. This is the
    // hot path for every folder listing / browse call, so keeping it OFF the
    // main thread is what prevents the window from going "Not Responding".
    let conn = state
        .connection
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rclone::supervisor::rc_post(&conn, &endpoint, &params)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write base64-encoded bytes to a path on disk (used to save an exported review
/// PDF the frontend generates in-memory).
#[tauri::command]
fn write_binary_file(path: String, base64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64.as_bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("write {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // MUST be registered first: it intercepts a second launch before the
        // rest of the app (and a second rclone daemon) can start.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Launch-on-startup. `--minimized` lets a startup launch come up hidden
        // to the tray instead of popping the window (the frontend checks for it).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(Quitting::default())
        .manage(TrayReady::default())
        .manage(RcloneState::default())
        .manage(JobsState::default())
        .manage(NativeJobsState::default())
        .manage(accounts::OAuthState::default())
        .manage(index::IndexState::default())
        .manage(stream::StreamState::default())
        .manage(hls::HlsState::default())
        .manage(bdm::BdmState::default())
        .manage(speedtest::SpeedTestState::default())
        .invoke_handler(tauri::generate_handler![
            rc_call,
            quit_app,
            write_binary_file,
            stream::stream_base,
            hls::stream_mode,
            ingest::ingest_token,
            ingest::prepare_extension,
            ingest::reveal_path,
            bdm::bdm_get_config,
            bdm::bdm_set_config,
            accounts::list_accounts,
            accounts::remove_account,
            accounts::add_account,
            accounts::set_secret,
            accounts::get_secret,
            accounts::delete_secret,
            accounts::account_email,
            accounts::add_drive_link,
            dropbox::add_dropbox_link,
            download::start_download,
            download::upload_start,
            download::list_jobs,
            download::cancel_job,
            download::clear_finished_jobs,
            download::delete_item,
            drive::drive_uploader,
            index::index_start,
            index::index_recrawl,
            index::index_folder,
            index::index_cancel,
            index::index_get,
            index::index_status,
            index::index_remove,
            search::account_search,
            search::account_recent,
            search::search_all_accounts,
            speedtest::start_speed_test,
            speedtest::cancel_speed_test,
        ])
        .setup(|app| {
            // System-tray / menu-bar icon: left-click (or "Show") reveals the
            // window; "Quit" is the ONLY thing that actually exits (close just
            // hides — see the CloseRequested handler below). Building the tray is
            // a quick UI call, safe to do synchronously here.
            if let Some(icon) = app.default_window_icon().cloned() {
                let show_i = MenuItem::with_id(app, "show", "Show FDM", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit FDM", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                TrayIconBuilder::with_id("main-tray")
                    .icon(icon)
                    .tooltip("FDM")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => {
                            app.state::<Quitting>().0.store(true, Ordering::SeqCst);
                            shutdown_cleanup(app);
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
                // Only now is close-to-hide safe: there's a tray to reopen from.
                app.state::<TrayReady>().0.store(true, Ordering::SeqCst);
            }

            // CRITICAL: the setup closure runs on the main thread BEFORE Tauri's
            // event loop starts pumping, so anything blocking here freezes the
            // window at launch. `start_rclone` spawns the large unsigned
            // `rclone.exe` (Windows Defender real-time-scans it on the first
            // launch after every fresh install) and then blocks polling the rcd
            // daemon until it answers — easily several seconds under a Defender
            // scan. Doing that on the setup thread is exactly the startup freeze.
            //
            // Move ALL startup I/O to a background thread: the window paints
            // instantly, the daemon comes up asynchronously, and the frontend
            // (which already tolerates a not-ready daemon and re-loads on the
            // "rclone-ready" event below) catches up once it's live.
            // FAILSAFE: the window starts hidden (visible:false) and the
            // frontend reveals it after its first paint — but if that reveal
            // ever fails (JS error, missing capability, webview stall), the
            // app would sit invisible in the task manager forever. Force-show
            // after a short grace period; showing an already-visible window
            // is a no-op, so the healthy path is unaffected.
            let show_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(win) = show_handle.get_webview_window("main") {
                    if !win.is_visible().unwrap_or(true) {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                match start_rclone(&handle) {
                    Ok(_) => {
                        // Tell the frontend the daemon is live so it can (re)load
                        // accounts/browse — its initial mount may have run before
                        // the daemon was ready and silently shown the empty state.
                        let _ = handle.emit("rclone-ready", ());
                    }
                    Err(e) => eprintln!("rclone failed to start: {e}"),
                }
                // Loopback streaming proxy for the review player (best-effort).
                if let Err(e) = stream::start_stream_server(&handle) {
                    eprintln!("stream server failed to start: {e}");
                }
                // Loopback ingest server for the FDM browser extension (best-effort;
                // a taken port just disables browser ingest, logged inside).
                ingest::start_ingest_server(&handle);
                // Resolve the ffmpeg/ffprobe sidecars + HLS cache dir (best-effort;
                // failure just leaves HLS unavailable and the player uses direct /media).
                hls::setup(&handle);
                // BDM sync agent (no-op until enabled + configured in Settings → Sync).
                bdm::start_agent(&handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Close hides the window to the tray / menu bar instead of quitting —
            // rclone and any in-flight downloads keep running. A real quit (tray
            // "Quit" / Settings) sets the Quitting flag first, so it falls through
            // and the window actually closes. Minimize is untouched (it doesn't
            // emit CloseRequested).
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Hide instead of quit — but ONLY when a tray exists to reopen
                // from. Without a tray (icon-less build) let close actually close,
                // so the window can never get stranded invisibly.
                let quitting = window.state::<Quitting>().0.load(Ordering::SeqCst);
                let tray_ready = window.state::<TrayReady>().0.load(Ordering::SeqCst);
                if !quitting && tray_ready {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Destroyed => {
                stop_rclone(&window.state::<RcloneState>());
                // Best-effort: clear the HLS segment cache dir on exit.
                hls::cleanup(window.app_handle());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

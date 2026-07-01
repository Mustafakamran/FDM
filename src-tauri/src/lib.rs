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
use tauri::{Emitter, Manager};

#[tauri::command]
fn rc_call(
    state: tauri::State<RcloneState>,
    endpoint: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let conn = state
        .connection
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    rclone::supervisor::rc_post(&conn, &endpoint, &params)
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            speedtest::start_speed_test,
            speedtest::cancel_speed_test,
        ])
        .setup(|app| {
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<RcloneState>();
                stop_rclone(&state);
                // Best-effort: clear the HLS segment cache dir on exit.
                hls::cleanup(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

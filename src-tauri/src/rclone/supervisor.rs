use crate::rclone::config::{build_rcd_args, pick_free_port, random_secret, RcConfig};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

/// Connection info shared with the frontend.
///
/// Carries ONE shared `reqwest::blocking::Client` (internally `Arc`-based:
/// `Clone`, `Send`, `Sync`, with a keep-alive connection pool). Building it once
/// and reusing it for every rc call avoids a fresh TCP/HTTP handshake — and the
/// blocking stall that handshake costs — on each rclone interaction. The client
/// is skipped during serialization since only the connection coordinates travel
/// to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct RcConnection {
    pub base_url: String,
    pub user: String,
    pub pass: String,
    #[serde(skip)]
    client: reqwest::blocking::Client,
}

impl RcConnection {
    /// Build a connection, constructing the shared HTTP client once.
    pub fn new(base_url: String, user: String, pass: String) -> Self {
        RcConnection {
            base_url,
            user,
            pass,
            client: reqwest::blocking::Client::new(),
        }
    }
}

/// Holds the running rclone child + connection; lives in Tauri managed state.
#[derive(Default)]
pub struct RcloneState {
    pub child: Mutex<Option<CommandChild>>,
    pub connection: Mutex<Option<RcConnection>>,
}

/// Kill ORPHANED rclone daemons left behind by previous FDM runs.
///
/// The graceful shutdown path (window Destroyed → `stop_rclone`) never runs on
/// a crash, a force-quit, or a SIGKILL — each such exit leaves an `rclone rcd`
/// daemon running forever (one real-world machine had 30+ accumulated). An
/// orphan is identified by BOTH of:
///   1. its command line references OUR config file (`<app-data>/rclone.conf`),
///      so daemons from other apps/tools are never touched, and
///   2. its parent process is gone (reparented to init/launchd on macOS, or a
///      dead ParentProcessId on Windows) — so a daemon belonging to another
///      LIVE FDM instance is left alone.
///
/// Best-effort: any failure here is ignored and startup proceeds normally.
fn reap_orphans(config_path: &str) {
    #[cfg(target_os = "windows")]
    {
        // PowerShell: rclone.exe processes whose command line uses our config
        // and whose parent pid is no longer alive.
        let script = format!(
            "$ps = Get-CimInstance Win32_Process; $alive = $ps.ProcessId; \
             $ps | Where-Object {{ $_.Name -eq 'rclone.exe' -and $_.CommandLine -like '*{}*' \
             -and ($alive -notcontains $_.ParentProcessId) }} | \
             ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}",
            config_path.replace('\'', "").replace('\\', "\\\\")
        );
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // ps: pid, ppid, full command — orphans have been reparented to pid 1.
        let Ok(out) = std::process::Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output() else {
            return;
        };
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(pid) = orphan_rclone_pid(line, config_path) {
                let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).output();
            }
        }
    }
}

/// Parse one `ps -axo pid=,ppid=,command=` line; return the pid if it is an
/// ORPHANED (ppid 1) rclone daemon using our config file. ps pads its columns
/// with a VARIABLE number of spaces, so this must split on whitespace runs —
/// a naive splitn on single whitespace chars reads ppid as "". Pure, tested.
#[cfg(not(target_os = "windows"))]
fn orphan_rclone_pid(line: &str, config_path: &str) -> Option<i32> {
    let mut parts = line.split_whitespace();
    let pid: i32 = parts.next()?.parse().ok()?;
    let ppid: i32 = parts.next()?.parse().ok()?;
    if ppid != 1 {
        return None;
    }
    // Rejoin the command tail (paths with single spaces survive the rejoin).
    let cmd = parts.collect::<Vec<_>>().join(" ");
    // The EXECUTABLE must be an rclone binary running `rcd`. Two traps handled:
    // - matching the whole line against "rclone" would false-positive on any
    //   process merely referencing our config path (it contains "rclone.conf");
    // - the executable path itself may contain spaces (a dev checkout does),
    //   so split at the " rcd " boundary rather than by token position.
    let exe = cmd.split(" rcd ").next().unwrap_or("");
    let is_rclone_rcd = (exe == "rclone" || exe.ends_with("/rclone")) && cmd.len() > exe.len();
    let args = &cmd[exe.len()..];
    (is_rclone_rcd && args.contains(config_path)).then_some(pid)
}

/// Launch the rclone sidecar in rc daemon mode and wait until it answers.
pub fn start_rclone(app: &AppHandle) -> Result<RcConnection, String> {
    let port = pick_free_port().map_err(|e| format!("port: {e}"))?;
    // Use a fixed config file in the app data dir so remotes/tokens persist
    // across restarts. Create the dir if it doesn't exist yet.
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("create app_data_dir: {e}"))?;
    let config_path = data_dir.join("rclone.conf").to_string_lossy().into_owned();
    // Clean up daemons orphaned by a previous crash/force-quit BEFORE spawning
    // ours (so we can never reap the one we're about to start).
    reap_orphans(&config_path);
    let cfg = RcConfig {
        host: "127.0.0.1".into(),
        port,
        user: random_secret(16),
        pass: random_secret(32),
        config_path,
    };
    let args = build_rcd_args(&cfg);

    let sidecar = app
        .shell()
        .sidecar("rclone")
        .map_err(|e| format!("sidecar: {e}"))?
        .args(args);
    let (_rx, child) = sidecar.spawn().map_err(|e| format!("spawn: {e}"))?;

    let connection = RcConnection::new(
        format!("http://{}:{}", cfg.host, cfg.port),
        cfg.user,
        cfg.pass,
    );

    // Publish the child + connection BEFORE waiting for the daemon to answer.
    // rc commands and the frontend's retry logic can then attempt calls (which
    // fail with a connection error, not "rclone not started", and get retried)
    // while the port is still binding — and on Windows, while Defender finishes
    // scanning the freshly-extracted rclone.exe on first launch.
    let state = app.state::<RcloneState>();
    *state.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
    *state.connection.lock().unwrap_or_else(|e| e.into_inner()) = Some(connection.clone());

    wait_until_ready(&connection)?;
    Ok(connection)
}

/// Poll `core/version` until the daemon responds or we time out.
pub fn wait_until_ready(conn: &RcConnection) -> Result<(), String> {
    // Reuse the connection's shared keep-alive client (no per-poll handshake).
    // Generous window (~30s): this runs off the main thread, so a slow first
    // launch (Windows Defender scanning the unsigned rclone.exe) never freezes
    // the UI — it just delays the "rclone-ready" signal.
    let url = format!("{}/core/version", conn.base_url);
    for _ in 0..300 {
        let resp = conn
            .client
            .post(&url)
            .basic_auth(&conn.user, Some(&conn.pass))
            .send();
        if let Ok(r) = resp {
            if r.status().is_success() {
                return Ok(());
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err("rclone daemon did not become ready in time".into())
}

/// POST a JSON params object to an rc endpoint with basic auth; return parsed JSON.
pub fn rc_post(
    conn: &RcConnection,
    endpoint: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    // Reuse the connection's shared keep-alive client instead of building a fresh
    // one (and paying a new TCP/HTTP handshake) on every rc call.
    let url = format!("{}/{}", conn.base_url, endpoint);
    let body = serde_json::to_string(params).map_err(|e| e.to_string())?;
    let resp = conn
        .client
        .post(&url)
        .basic_auth(&conn.user, Some(&conn.pass))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("rc {endpoint} failed: {status} {text}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Kill the daemon on shutdown.
pub fn stop_rclone(state: &RcloneState) {
    // Recover from a poisoned lock so shutdown still kills the child.
    if let Some(child) = state.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = child.kill();
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::orphan_rclone_pid;

    const CONF: &str = "/Users/zz/Library/Application Support/com.zz.google-drive-downloader/rclone.conf";

    #[test]
    fn matches_an_orphaned_daemon_despite_ps_column_padding() {
        // Real ps output pads pid/ppid columns with runs of spaces.
        let line = format!("90822     1 /Applications/FDM.app/Contents/MacOS/rclone rcd --rc-addr 127.0.0.1:59987 --config {CONF}");
        assert_eq!(orphan_rclone_pid(&line, CONF), Some(90822));
    }

    #[test]
    fn skips_a_daemon_whose_parent_is_alive() {
        let line = format!("91236 89009 /Applications/FDM.app/Contents/MacOS/rclone rcd --config {CONF}");
        assert_eq!(orphan_rclone_pid(&line, CONF), None);
    }

    #[test]
    fn skips_orphans_that_are_not_our_rclone() {
        // Orphaned, but a different config file / a different program entirely.
        assert_eq!(orphan_rclone_pid("500     1 /usr/local/bin/rclone rcd --config /tmp/other.conf", CONF), None);
        assert_eq!(orphan_rclone_pid(&format!("501     1 /usr/bin/tail -f {CONF}"), CONF), None);
        assert_eq!(orphan_rclone_pid("garbage line", CONF), None);
    }

    #[test]
    fn matches_a_dev_binary_whose_path_contains_spaces() {
        let line = format!(
            "502     1 /Users/zz/Google Drive Downloader/src-tauri/target/debug/rclone rcd --rc-addr 127.0.0.1:1 --config {CONF}"
        );
        assert_eq!(orphan_rclone_pid(&line, CONF), Some(502));
    }
}

//! Network speed test against Cloudflare's edge (like fast.com), measuring the
//! user's raw internet connection rather than provider-side throttling. Phases
//! stream progress to the frontend for a live graph:
//! 1. meta — client IP + location and the serving Cloudflare colo (server), from
//!    `cdn-cgi/trace`.
//! 2. ping — time-to-first-byte on a tiny request.
//! 3. down — sustained download (`__down`) for a fixed window.
//! 4. up — sustained upload (`__up`, chunked POSTs) for a fixed window.

use serde_json::json;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const DOWN_URL: &str = "https://speed.cloudflare.com/__down?bytes=25000000";
const UP_URL: &str = "https://speed.cloudflare.com/__up";
const TRACE_URL: &str = "https://speed.cloudflare.com/cdn-cgi/trace";
const DOWNLOAD_DURATION: Duration = Duration::from_secs(7);
const UPLOAD_DURATION: Duration = Duration::from_secs(7);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
const READ_BUF_SIZE: usize = 256 * 1024;
/// Per upload POST. Small enough that a slow link still finishes a chunk within
/// the window (so the loop can re-check the clock), large enough to amortize
/// request overhead on a fast link.
const UP_CHUNK: usize = 2_000_000;

#[derive(Default)]
pub struct SpeedTestState(pub Arc<AtomicBool>);

/// Aborted mid-run (an error/cancel event was already emitted).
struct Aborted;

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "The speed test timed out — check your connection and try again.".to_string()
    } else if e.is_connect() {
        "Couldn't reach the speed test server. Check your connection and try again.".to_string()
    } else {
        format!("Speed test failed: {e}")
    }
}

/// (client IP, client location code, serving Cloudflare colo) from cdn-cgi/trace.
fn fetch_meta(c: &reqwest::blocking::Client) -> Option<(String, String, String)> {
    let text = c.get(TRACE_URL).send().ok()?.text().ok()?;
    let (mut ip, mut loc, mut colo) = (String::new(), String::new(), String::new());
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("ip=") {
            ip = v.to_string();
        } else if let Some(v) = line.strip_prefix("loc=") {
            loc = v.to_string();
        } else if let Some(v) = line.strip_prefix("colo=") {
            colo = v.to_string();
        }
    }
    Some((ip, loc, colo))
}

/// Ping: time-to-first-byte on a tiny request, before the throughput run.
fn measure_ping_ms(c: &reqwest::blocking::Client) -> Option<f64> {
    let start = Instant::now();
    let resp = c.get("https://speed.cloudflare.com/__down?bytes=0").send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    Some(start.elapsed().as_secs_f64() * 1000.0)
}

fn mbps(bytes: u64, secs: f64) -> f64 {
    (bytes as f64 * 8.0) / secs.max(0.001) / 1_000_000.0
}

fn emit_progress(app: &AppHandle, phase: &str, total: u64, elapsed: f64) {
    let _ = app.emit(
        "speedtest-progress",
        json!({ "phase": phase, "bytes": total, "elapsedSecs": elapsed, "mbps": mbps(total, elapsed) }),
    );
}

/// Sustained download for the window. Returns (final mbps, peak mbps).
fn run_download(app: &AppHandle, c: &reqwest::blocking::Client, cancel: &Arc<AtomicBool>) -> Result<(f64, f64), Aborted> {
    let start = Instant::now();
    let mut total: u64 = 0;
    let mut peak: f64 = 0.0;
    let mut last_emit = Instant::now();
    let mut buf = vec![0u8; READ_BUF_SIZE];

    'outer: while start.elapsed() < DOWNLOAD_DURATION {
        if cancel.load(Ordering::SeqCst) {
            let _ = app.emit("speedtest-cancelled", json!({}));
            return Err(Aborted);
        }
        let mut resp = match c.get(DOWN_URL).send() {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let _ = app.emit("speedtest-error", json!({ "error": format!("Speed test server returned {}", r.status()) }));
                return Err(Aborted);
            }
            Err(e) => {
                let _ = app.emit("speedtest-error", json!({ "error": net_err(e) }));
                return Err(Aborted);
            }
        };
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = app.emit("speedtest-cancelled", json!({}));
                return Err(Aborted);
            }
            if start.elapsed() >= DOWNLOAD_DURATION {
                break 'outer;
            }
            let n = match resp.read(&mut buf) {
                Ok(0) => break, // body exhausted — the outer loop opens a fresh request
                Ok(n) => n,
                Err(e) => {
                    let _ = app.emit("speedtest-error", json!({ "error": format!("Speed test failed: {e}") }));
                    return Err(Aborted);
                }
            };
            total += n as u64;
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                let elapsed = start.elapsed().as_secs_f64();
                peak = peak.max(mbps(total, elapsed));
                emit_progress(app, "download", total, elapsed);
                last_emit = Instant::now();
            }
        }
    }
    let final_mbps = mbps(total, start.elapsed().as_secs_f64());
    Ok((final_mbps, peak.max(final_mbps)))
}

/// Sustained upload for the window via chunked POSTs. Returns (final, peak) mbps.
fn run_upload(app: &AppHandle, c: &reqwest::blocking::Client, cancel: &Arc<AtomicBool>) -> Result<(f64, f64), Aborted> {
    let payload = vec![0u8; UP_CHUNK];
    let start = Instant::now();
    let mut total: u64 = 0;
    let mut peak: f64 = 0.0;
    let mut last_emit = Instant::now();

    while start.elapsed() < UPLOAD_DURATION {
        if cancel.load(Ordering::SeqCst) {
            let _ = app.emit("speedtest-cancelled", json!({}));
            return Err(Aborted);
        }
        // Bound a single chunk so a very slow link can't hang the phase.
        let resp = c.post(UP_URL).timeout(Duration::from_secs(30)).body(payload.clone()).send();
        match resp {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => {
                let _ = app.emit("speedtest-error", json!({ "error": format!("Speed test server returned {}", r.status()) }));
                return Err(Aborted);
            }
            Err(e) => {
                let _ = app.emit("speedtest-error", json!({ "error": net_err(e) }));
                return Err(Aborted);
            }
        }
        total += payload.len() as u64;
        let elapsed = start.elapsed().as_secs_f64();
        peak = peak.max(mbps(total, elapsed));
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            emit_progress(app, "upload", total, elapsed);
            last_emit = Instant::now();
        }
    }
    let elapsed = start.elapsed().as_secs_f64();
    emit_progress(app, "upload", total, elapsed); // settle the final number
    let final_mbps = mbps(total, elapsed);
    Ok((final_mbps, peak.max(final_mbps)))
}

fn run(app: &AppHandle, cancel: Arc<AtomicBool>) {
    let client = match client() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit("speedtest-error", json!({ "error": e }));
            return;
        }
    };

    if let Some((ip, loc, colo)) = fetch_meta(&client) {
        let _ = app.emit("speedtest-meta", json!({ "clientIp": ip, "clientLoc": loc, "serverColo": colo }));
    }

    let ping_ms = measure_ping_ms(&client);
    let _ = app.emit("speedtest-ping", json!({ "pingMs": ping_ms }));

    let (down, down_peak) = match run_download(app, &client, &cancel) {
        Ok(v) => v,
        Err(Aborted) => return,
    };
    let (up, up_peak) = match run_upload(app, &client, &cancel) {
        Ok(v) => v,
        Err(Aborted) => return,
    };

    let _ = app.emit(
        "speedtest-done",
        json!({
            "downloadMbps": down,
            "uploadMbps": up,
            "peakDownMbps": down_peak,
            "peakUpMbps": up_peak,
            "pingMs": ping_ms,
        }),
    );
}

#[tauri::command]
pub fn start_speed_test(app: AppHandle, state: State<SpeedTestState>) -> Result<(), String> {
    state.0.store(false, Ordering::SeqCst);
    let cancel = state.0.clone();
    std::thread::spawn(move || run(&app, cancel));
    Ok(())
}

#[tauri::command]
pub fn cancel_speed_test(state: State<SpeedTestState>) -> Result<(), String> {
    state.0.store(true, Ordering::SeqCst);
    Ok(())
}

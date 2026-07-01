//! Network speed test: downloads from a public, no-auth CDN endpoint
//! (Cloudflare's speed-test target) for a fixed wall-clock window, sampling
//! throughput as it goes so the frontend can render a live graph — the same
//! idea as fast.com/speedtest.net, run against Cloudflare's edge instead of a
//! Drive/Dropbox account (this measures the user's raw internet connection,
//! not provider-side throttling).

use serde_json::json;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// 25MB per request — small enough that a slow connection still gets several
/// requests strung together (so a stall on one doesn't stall the whole test),
/// large enough that a fast connection isn't dominated by TLS/connection setup.
const CHUNK_URL: &str = "https://speed.cloudflare.com/__down?bytes=25000000";
const TEST_DURATION: Duration = Duration::from_secs(8);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);
const READ_BUF_SIZE: usize = 256 * 1024;

#[derive(Default)]
pub struct SpeedTestState(pub Arc<AtomicBool>);

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

/// Ping: time-to-first-byte on a tiny request, before the throughput run.
fn measure_ping_ms(c: &reqwest::blocking::Client) -> Option<f64> {
    let start = Instant::now();
    let resp = c.get("https://speed.cloudflare.com/__down?bytes=0").send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    Some(start.elapsed().as_secs_f64() * 1000.0)
}

fn run(app: &AppHandle, cancel: Arc<AtomicBool>) {
    let client = match client() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit("speedtest-error", json!({ "error": e }));
            return;
        }
    };

    let ping_ms = measure_ping_ms(&client);
    let _ = app.emit("speedtest-ping", json!({ "pingMs": ping_ms }));

    let start = Instant::now();
    let mut total: u64 = 0;
    let mut peak_mbps: f64 = 0.0;
    let mut last_emit = Instant::now();
    let mut buf = vec![0u8; READ_BUF_SIZE];

    'outer: while start.elapsed() < TEST_DURATION {
        if cancel.load(Ordering::SeqCst) {
            let _ = app.emit("speedtest-cancelled", json!({}));
            return;
        }
        let resp = match client.get(CHUNK_URL).send() {
            Ok(r) => r,
            Err(e) => {
                let _ = app.emit("speedtest-error", json!({ "error": net_err(e) }));
                return;
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let _ = app.emit("speedtest-error", json!({ "error": format!("Speed test server returned {status}") }));
            return;
        }
        let mut resp = resp;
        loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = app.emit("speedtest-cancelled", json!({}));
                return;
            }
            if start.elapsed() >= TEST_DURATION {
                break 'outer;
            }
            let n = match resp.read(&mut buf) {
                Ok(0) => break, // this request's body is exhausted — outer loop opens a fresh one
                Ok(n) => n,
                Err(e) => {
                    let _ = app.emit("speedtest-error", json!({ "error": format!("Speed test failed: {e}") }));
                    return;
                }
            };
            total += n as u64;
            if last_emit.elapsed() >= PROGRESS_INTERVAL {
                let elapsed = start.elapsed().as_secs_f64();
                let mbps = (total as f64 * 8.0) / elapsed / 1_000_000.0;
                peak_mbps = peak_mbps.max(mbps);
                let _ = app.emit(
                    "speedtest-progress",
                    json!({ "bytes": total, "elapsedSecs": elapsed, "mbps": mbps }),
                );
                last_emit = Instant::now();
            }
        }
    }

    let elapsed = start.elapsed().as_secs_f64().max(0.001);
    let mbps = (total as f64 * 8.0) / elapsed / 1_000_000.0;
    let _ = app.emit(
        "speedtest-done",
        json!({
            "bytes": total,
            "elapsedSecs": elapsed,
            "mbps": mbps,
            "peakMbps": peak_mbps.max(mbps),
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

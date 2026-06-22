//! Local loopback streaming proxy for the in-app review player.
//!
//! Browser `<video>` can't authenticate to Drive/Dropbox, so a tiny loopback
//! HTTP server sits in front and forwards HTTP **Range** requests to the right
//! provider with the right token:
//!   - Drive / Drive-link → `files/{id}?alt=media` (+ Range),
//!   - Dropbox            → `files/download` (+ Range),
//!   - Dropbox-link       → `sharing/get_shared_link_file` (+ Range).
//!
//! Each response is capped to one CHUNK so memory stays bounded and the player
//! pulls the file progressively as the user scrubs — nothing is fully downloaded.
//! The URL carries a per-session secret so only this app's webview can use it.

use crate::provider;
use crate::rclone::config::{pick_free_port, random_secret};
use crate::rclone::supervisor::{RcConnection, RcloneState};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Response, Server};

/// Bytes per range response. The player asks for more as it plays.
const CHUNK: u64 = 4 * 1024 * 1024;

/// Holds the proxy's base URL (http://127.0.0.1:port/secret) for the frontend.
#[derive(Default)]
pub struct StreamState {
    pub base: Mutex<Option<String>>,
}

/// The streaming proxy base URL (frontend appends `/media?...`).
#[tauri::command]
pub fn stream_base(state: tauri::State<StreamState>) -> Result<String, String> {
    state
        .base
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "stream server not started".to_string())
}

/// Parse a `Range` header value (`bytes=START-END` / `bytes=START-`). Missing or
/// malformed → (0, None).
fn parse_range(h: Option<&str>) -> (u64, Option<u64>) {
    let v = match h {
        Some(v) => v.trim(),
        None => return (0, None),
    };
    let v = v.strip_prefix("bytes=").unwrap_or(v);
    let mut parts = v.splitn(2, '-');
    let start = parts.next().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
    let end = parts.next().and_then(|s| {
        let s = s.trim();
        if s.is_empty() {
            None
        } else {
            s.parse::<u64>().ok()
        }
    });
    (start, end)
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

fn parse_query(q: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            m.insert(k.to_string(), v.to_string());
        }
    }
    m
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).expect("valid header")
}

/// Fetch byte range [start, end] (inclusive) for a file from its provider.
fn fetch_range(
    app: &AppHandle,
    conn: &RcConnection,
    acct: &str,
    fid: &str,
    path: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    let kind = provider::kind_of(acct);
    let (token_acct, link) = provider::token_account(app, acct);
    let token = provider::fetch_token(conn, kind, &token_acct)?;
    let client = reqwest::blocking::Client::new();
    let resp = provider::send_range(&client, &token, kind, fid, path, &link, start, end, false)
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let s = resp.status();
        let b = resp.text().unwrap_or_default();
        return Err(format!("range fetch {s}: {b}"));
    }
    Ok(resp.bytes().map_err(|e| e.to_string())?.to_vec())
}

/// Resolve a request into (data, start, end, total, content-type).
fn build_response(
    app: &AppHandle,
    secret: &str,
    url: &str,
    range_hdr: Option<&str>,
) -> Result<(Vec<u8>, u64, u64, u64, &'static str), String> {
    let prefix = format!("/{secret}/media?");
    let q = url.strip_prefix(&prefix).ok_or_else(|| "bad request path".to_string())?;
    let params = parse_query(q);

    let acct = params.get("acct").ok_or_else(|| "missing acct".to_string())?;
    let fid = params.get("fid").map(|s| s.as_str()).unwrap_or("");
    let ext = params.get("ext").map(|s| s.as_str()).unwrap_or("");
    let size: u64 = params
        .get("size")
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "missing size".to_string())?;
    if size == 0 {
        return Err("zero size".into());
    }
    let path_b64 = params.get("path").ok_or_else(|| "missing path".to_string())?;
    let path = String::from_utf8(URL_SAFE_NO_PAD.decode(path_b64).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let (start, end_opt) = parse_range(range_hdr);
    let start = start.min(size - 1);
    let end = end_opt
        .unwrap_or(u64::MAX)
        .min(size - 1)
        .min(start + CHUNK - 1)
        .max(start);

    let conn = app
        .state::<RcloneState>()
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    let data = fetch_range(app, &conn, acct, fid, &path, start, end)?;
    Ok((data, start, end, size, mime_for_ext(ext)))
}

/// Serve an HLS request (`/{secret}/hls/<path>?<query>`). On any error the response
/// is a 500 so hls.js can retry/drop a level — and the frontend can fall back to
/// direct `/media` if the whole HLS path is unavailable.
fn serve_hls(app: &AppHandle, base: &str, secret: &str, url: &str, req: tiny_http::Request) {
    let prefix = format!("/{secret}/hls/");
    let rest = match url.strip_prefix(&prefix) {
        Some(r) => r,
        None => {
            let _ = req.respond(
                Response::from_string("bad hls path")
                    .with_status_code(404)
                    .with_header(header("Access-Control-Allow-Origin", "*")),
            );
            return;
        }
    };
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));

    match crate::hls::handle(app, path, query, base) {
        Ok(crate::hls::HlsResponse::Playlist(text)) => {
            let _ = req.respond(
                Response::from_string(text)
                    .with_status_code(200)
                    .with_header(header("Content-Type", "application/vnd.apple.mpegurl"))
                    .with_header(header("Access-Control-Allow-Origin", "*")),
            );
        }
        Ok(crate::hls::HlsResponse::Segment(bytes)) => {
            let _ = req.respond(
                Response::from_data(bytes)
                    .with_status_code(200)
                    .with_header(header("Content-Type", "video/mp2t"))
                    .with_header(header("Access-Control-Allow-Origin", "*")),
            );
        }
        Err(e) => {
            let _ = req.respond(
                Response::from_string(e)
                    .with_status_code(500)
                    .with_header(header("Access-Control-Allow-Origin", "*")),
            );
        }
    }
}

fn serve(app: AppHandle, base: String, secret: String, req: tiny_http::Request) {
    let url = req.url().to_string();

    // Dispatch HLS requests; the legacy /media path below is unchanged (it is both
    // the legacy player source and the ffmpeg cloud input).
    if url.starts_with(&format!("/{secret}/hls/")) {
        serve_hls(&app, &base, &secret, &url, req);
        return;
    }

    let range_hdr = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let response = match build_response(&app, &secret, &url, range_hdr.as_deref()) {
        Ok((data, start, end, total, ctype)) => Response::from_data(data)
            .with_status_code(206)
            .with_header(header("Content-Type", ctype))
            .with_header(header("Accept-Ranges", "bytes"))
            .with_header(header("Content-Range", &format!("bytes {start}-{end}/{total}")))
            .with_header(header("Access-Control-Allow-Origin", "*")),
        Err(e) => Response::from_string(e)
            .with_status_code(404)
            .with_header(header("Access-Control-Allow-Origin", "*")),
    };
    let _ = req.respond(response);
}

/// Start the loopback streaming server on a free port. Idempotent-ish: call once
/// at setup. Stores the base URL in `StreamState`.
pub fn start_stream_server(app: &AppHandle) -> Result<(), String> {
    let port = pick_free_port().map_err(|e| e.to_string())?;
    let secret = random_secret(24);
    let server = Server::http(format!("127.0.0.1:{port}")).map_err(|e| e.to_string())?;
    let base = format!("http://127.0.0.1:{port}/{secret}");
    *app.state::<StreamState>().base.lock().unwrap_or_else(|e| e.into_inner()) = Some(base.clone());

    let app = app.clone();
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let app = app.clone();
            let base = base.clone();
            let secret = secret.clone();
            std::thread::spawn(move || serve(app, base, secret, req));
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_range_variants() {
        assert_eq!(parse_range(Some("bytes=0-")), (0, None));
        assert_eq!(parse_range(Some("bytes=100-199")), (100, Some(199)));
        assert_eq!(parse_range(Some("bytes=500-")), (500, None));
        assert_eq!(parse_range(None), (0, None));
        assert_eq!(parse_range(Some("garbage")), (0, None));
    }

    #[test]
    fn maps_mime_types() {
        assert_eq!(mime_for_ext("MP4"), "video/mp4");
        assert_eq!(mime_for_ext("mov"), "video/quicktime");
        assert_eq!(mime_for_ext("webm"), "video/webm");
        assert_eq!(mime_for_ext("mxf"), "application/octet-stream");
    }

    #[test]
    fn parses_query_pairs() {
        let m = parse_query("acct=drive_x&size=123&ext=mp4");
        assert_eq!(m.get("acct").unwrap(), "drive_x");
        assert_eq!(m.get("size").unwrap(), "123");
        assert_eq!(m.get("ext").unwrap(), "mp4");
    }
}

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
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Response, Server};

/// Bytes per range response. The player asks for more as it plays. Larger chunks
/// mean fewer round-trips for a big clip (a 10 GB file is ~1300 chunks at 8 MiB
/// vs ~2600 at 4 MiB) while keeping per-request memory bounded.
const CHUNK: u64 = 8 * 1024 * 1024;

/// Provider access tokens live ~3600s; reuse a cached one for this long before
/// refreshing (comfortably under the real lifetime).
const TOKEN_TTL: Duration = Duration::from_secs(3000);

/// Holds the proxy's base URL (http://127.0.0.1:port/secret) for the frontend,
/// plus the shared HTTP client + token cache that make streaming fast.
pub struct StreamState {
    pub base: Mutex<Option<String>>,
    /// ONE keep-alive HTTP client, built once and reused for every range fetch,
    /// so each 8 MiB chunk reuses the connection pool instead of paying a fresh
    /// TCP + TLS handshake per request (`Client::new()` per chunk was a major
    /// cause of the crawling playback throughput).
    client: reqwest::blocking::Client,
    /// Cached provider access token per token-owning account, with when it was
    /// fetched. Streaming a large clip pulls hundreds/thousands of chunks; the
    /// old code did a FULL OAuth refresh (config/dump + token POST) on EVERY
    /// chunk, which Google then throttled — throttling throughput to ~KB/s. With
    /// the cache the token is fetched roughly once per hour, not per chunk.
    token_cache: Mutex<HashMap<String, (String, Instant)>>,
}

impl Default for StreamState {
    fn default() -> Self {
        StreamState {
            base: Mutex::new(None),
            client: reqwest::blocking::Client::builder()
                .pool_max_idle_per_host(8)
                .build()
                .unwrap_or_default(),
            token_cache: Mutex::new(HashMap::new()),
        }
    }
}

/// Get a provider access token for `token_acct`, reusing a cached one while it's
/// still fresh. `force_refresh` bypasses the cache (used to recover from a 401).
fn cached_token(
    state: &StreamState,
    conn: &RcConnection,
    kind: provider::Kind,
    token_acct: &str,
    force_refresh: bool,
) -> Result<String, String> {
    if !force_refresh {
        if let Some((tok, at)) = state
            .token_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token_acct)
        {
            if at.elapsed() < TOKEN_TTL {
                return Ok(tok.clone());
            }
        }
    }
    let tok = provider::fetch_token(conn, kind, token_acct)?;
    if !tok.is_empty() {
        state
            .token_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(token_acct.to_string(), (tok.clone(), Instant::now()));
    }
    Ok(tok)
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
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "heic" | "heif" => "image/heic",
        _ => "application/octet-stream",
    }
}

/// If `dest_root` already has a file at the sanitized location a download of
/// `rel_path` would have landed at (the exact same sanitization the
/// downloader uses — see `transfer::safe_join`), return its path. Lets an
/// already-downloaded file play/preview straight from disk: instant, and
/// works with no internet connection at all (this loopback server only ever
/// binds 127.0.0.1, so serving local bytes through it needs no network).
fn local_file_for(dest_root: &str, rel_path: &str) -> Option<PathBuf> {
    if dest_root.is_empty() {
        return None;
    }
    let p = crate::transfer::safe_join(Path::new(dest_root), rel_path);
    p.is_file().then_some(p)
}

/// Read the inclusive byte range [start, end] from a local file.
fn read_local_range(path: &Path, start: u64, end: u64) -> Result<Vec<u8>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let len = (end - start + 1) as usize;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
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

/// Parallel sub-connections used to pull ONE range response. The single-connection
/// stream proxy topped out well below a Drive/Dropbox account's real throughput,
/// so a high-bitrate clip couldn't stream in real time even though the (parallel)
/// downloader saturates the link. Splitting each chunk across several concurrent
/// range requests — exactly how transfer.rs downloads — closes that gap. Kept at
/// the downloader's default so it's no more likely to hit a provider rate limit.
const STREAM_CONNECTIONS: u64 = 4;
/// Below this, a chunk is fetched on one connection (parallelism isn't worth the
/// thread + extra-request overhead for tiny ranges, e.g. the player's probe reads).
const SUBRANGE_MIN: u64 = 1024 * 1024;

/// Per-fetch failure. `auth` marks a 401 (a stale/revoked token → refresh + retry);
/// everything else is transient (rate limit, network, short read) and triggers the
/// single-connection fallback rather than a token refresh.
struct FetchErr {
    auth: bool,
    msg: String,
}

/// One range request on one connection. `exact`: require the response to contain
/// EXACTLY `end-start+1` bytes. Parallel sub-ranges MUST be exact — a short read
/// would misalign the concatenation into corrupt data (the cause of the ffmpeg
/// "partial file / invalid data" decode failures) — so a wrong length is rejected
/// and the caller falls back to a single contiguous fetch. The contiguous fallback
/// passes `exact=false`: one connection is inherently in-order, so a short read is
/// harmless (the response just carries fewer bytes and Content-Range is set from
/// the actual length by build_response).
#[allow(clippy::too_many_arguments)]
fn fetch_one(
    client: &reqwest::blocking::Client,
    token: &str,
    kind: provider::Kind,
    fid: &str,
    path: &str,
    link: &str,
    start: u64,
    end: u64,
    exact: bool,
) -> Result<Vec<u8>, FetchErr> {
    let resp = provider::send_range(client, token, kind, fid, path, link, start, end, false)
        .map_err(|e| FetchErr { auth: false, msg: e.to_string() })?;
    let status = resp.status();
    // Only a 401 means the token is bad; 403/429 are rate limits (retrying with a
    // fresh token wouldn't help), 5xx/network are transient — all fall back.
    if status.as_u16() == 401 {
        return Err(FetchErr { auth: true, msg: format!("401 {}", resp.text().unwrap_or_default()) });
    }
    if !status.is_success() {
        return Err(FetchErr { auth: false, msg: format!("range fetch {status}: {}", resp.text().unwrap_or_default()) });
    }
    let data = resp.bytes().map_err(|e| FetchErr { auth: false, msg: e.to_string() })?.to_vec();
    if exact {
        let want = (end - start + 1) as usize;
        if data.len() != want {
            return Err(FetchErr { auth: false, msg: format!("short range: got {} want {}", data.len(), want) });
        }
    }
    Ok(data)
}

/// Fetch [start, end] across up to STREAM_CONNECTIONS concurrent exact sub-ranges,
/// concatenated in order. Any sub-range that isn't exactly its requested length
/// fails the whole fetch (so the caller can fall back), guaranteeing the assembled
/// bytes are never misaligned.
#[allow(clippy::too_many_arguments)]
fn fetch_parallel(
    client: &reqwest::blocking::Client,
    token: &str,
    kind: provider::Kind,
    fid: &str,
    path: &str,
    link: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, FetchErr> {
    let total = end - start + 1;
    if total <= SUBRANGE_MIN || STREAM_CONNECTIONS <= 1 {
        return fetch_one(client, token, kind, fid, path, link, start, end, true);
    }
    let sub = total.div_ceil(STREAM_CONNECTIONS);
    let mut handles = Vec::new();
    let mut i = 0u64;
    while start + i * sub <= end {
        let s = start + i * sub;
        let e = (s + sub - 1).min(end);
        let (client, token, fid, path, link) =
            (client.clone(), token.to_string(), fid.to_string(), path.to_string(), link.to_string());
        handles.push(std::thread::spawn(move || fetch_one(&client, &token, kind, &fid, &path, &link, s, e, true)));
        i += 1;
    }
    let mut out = Vec::with_capacity(total as usize);
    for h in handles {
        let part = h.join().map_err(|_| FetchErr { auth: false, msg: "sub-fetch thread panicked".into() })??;
        out.extend_from_slice(&part);
    }
    Ok(out)
}

/// Fetch byte range [start, end] (inclusive) for a file from its provider.
///
/// Strategy: try the fast parallel path first; if the token is stale (401),
/// refresh once and retry; on any OTHER failure (rate limit, transient network,
/// or a non-exact sub-range) fall back to a single contiguous connection, which
/// can't corrupt data and is far less likely to trip a provider rate limit. The
/// returned length may be shorter than requested — build_response sets the
/// Content-Range from the ACTUAL length so the HTTP response is always
/// self-consistent (no truncated-read errors on the client).
#[allow(clippy::too_many_arguments)]
fn fetch_range(
    app: &AppHandle,
    conn: &RcConnection,
    state: &StreamState,
    acct: &str,
    fid: &str,
    path: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    let kind = provider::kind_of(acct);
    let (token_acct, link) = provider::token_account(app, acct);

    // Fast path: parallel, with one token refresh on a 401.
    let mut force = false;
    loop {
        let token = cached_token(state, conn, kind, &token_acct, force)?;
        match fetch_parallel(&state.client, &token, kind, fid, path, &link, start, end) {
            Ok(data) => return Ok(data),
            Err(e) if e.auth && !force && !token.is_empty() => {
                force = true;
                continue;
            }
            Err(_) => break, // fall through to the single-connection fallback
        }
    }

    // Robust fallback: one contiguous connection (accepts a short read).
    let mut force = false;
    loop {
        let token = cached_token(state, conn, kind, &token_acct, force)?;
        match fetch_one(&state.client, &token, kind, fid, path, &link, start, end, false) {
            Ok(data) => return Ok(data),
            Err(e) if e.auth && !force && !token.is_empty() => {
                force = true;
                continue;
            }
            Err(e) => return Err(e.msg),
        }
    }
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
    // Optional: the destination folder this exact item was already downloaded
    // to, if the frontend found a matching completed job in history. Present
    // → try local disk first (instant, works offline); absent or no match on
    // disk → fall through to the cloud fetch below, unchanged.
    let dest_root = match params.get("dest") {
        Some(b64) if !b64.is_empty() => {
            String::from_utf8(URL_SAFE_NO_PAD.decode(b64).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        }
        _ => String::new(),
    };

    let (start, end_opt) = parse_range(range_hdr);
    let start = start.min(size - 1);
    let end = end_opt
        .unwrap_or(u64::MAX)
        .min(size - 1)
        .min(start + CHUNK - 1)
        .max(start);

    if let Some(local_path) = local_file_for(&dest_root, &path) {
        let data = read_local_range(&local_path, start, end)?;
        return Ok((data, start, end, size, mime_for_ext(ext)));
    }

    let conn = app
        .state::<RcloneState>()
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;
    let state = app.state::<StreamState>();
    let data = fetch_range(app, &conn, &state, acct, fid, &path, start, end)?;
    if data.is_empty() {
        return Err("empty range response".into());
    }
    // Set the response's end from the ACTUAL bytes returned, not the requested
    // end. The fetch may return fewer bytes (a fallback short read); reporting the
    // real length keeps Content-Range == Content-Length so the client (the player
    // AND ffmpeg) never sees a truncated response — it just requests the next
    // range from where this one ended.
    let end = start + data.len() as u64 - 1;
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

    #[test]
    fn maps_image_mime_types() {
        assert_eq!(mime_for_ext("JPG"), "image/jpeg");
        assert_eq!(mime_for_ext("png"), "image/png");
        assert_eq!(mime_for_ext("heic"), "image/heic");
    }

    #[test]
    fn local_file_for_finds_an_already_downloaded_file() {
        let root = std::env::temp_dir().join(format!("fdm-stream-test-{}-a", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("clip.mp4"), b"hello world").unwrap();

        let found = local_file_for(root.to_str().unwrap(), "clip.mp4").unwrap();
        assert!(found.is_file());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn local_file_for_returns_none_when_not_downloaded_or_no_dest() {
        let root = std::env::temp_dir().join(format!("fdm-stream-test-{}-b", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        assert!(local_file_for(root.to_str().unwrap(), "missing.mp4").is_none());
        assert!(local_file_for("", "clip.mp4").is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_local_range_reads_the_requested_bytes() {
        let root = std::env::temp_dir().join(format!("fdm-stream-test-{}-c", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("data.bin");
        std::fs::write(&path, b"0123456789").unwrap();

        assert_eq!(read_local_range(&path, 2, 4).unwrap(), b"234");
        assert_eq!(read_local_range(&path, 0, 9).unwrap(), b"0123456789");

        std::fs::remove_dir_all(&root).ok();
    }
}

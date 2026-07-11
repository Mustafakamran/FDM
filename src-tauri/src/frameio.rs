//! Native Frame.io downloader (public share links, no creds).
//!
//! Reverse-engineered Frame.io V4 public-share GraphQL API — the same calls the
//! `next.frame.io/share/<shareId>/` recipient page makes:
//!   POST https://api.frame.io/graphql
//! Auth needs no secret: the share token is just `base64(<shareId>)`, sent as the
//! `x-frameio-share-authentication` header alongside a random session id and the
//! web-app client headers (see the header set in `gql`).
//!
//! Flow:
//!   1. `GetShareCollectionAssets` enumerates the share's file + folder nodes
//!      (cursor-paginated), recursed through folders so nested structure is kept.
//!   2. `GetAssetForDownload` resolves one asset to its media URLs: the presigned
//!      S3 **original** (`assets.frame.io/uploads/<id>/original`, Range-capable)
//!      and every **proxy** transcode (`stream-download.frame.io/manifest/hls`,
//!      a server-muxed MP4). The caller picks originals or a proxy rendition.
//!   3. Each file is Range-streamed to disk with `.fdmpart` resume; a stale
//!      presigned URL (403/410) is re-resolved once.

use crate::download::NativeHandles;
use base64::Engine;
use rand::Rng;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const GQL: &str = "https://api.frame.io/graphql";
const CLIENT_NAME: &str = "web-app";
const CLIENT_VERSION: &str = "@frameio/next-web-app@600.0";

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(None)
        .connect_timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// A random UUID v4 string for the `x-frameio-session-id` header (any valid UUID
/// is accepted; the API only checks it is present + well-formed).
fn session_id() -> String {
    let mut b = [0u8; 16];
    rand::rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

/// Which media rendition to fetch for each asset.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Quality {
    /// The full-resolution master (`media.original`).
    Original,
    /// Highest-resolution proxy transcode available.
    ProxyHighest,
    /// ~1080p proxy (nearest ≤1080 else smallest).
    Proxy1080,
    /// ~720p proxy (nearest ≤720 else smallest).
    Proxy720,
    /// Smallest proxy transcode.
    ProxySmallest,
}

impl Quality {
    /// Parse the `x-fdm-frameio-quality` header value; defaults to originals.
    pub fn parse(s: &str) -> Quality {
        match s.trim().to_ascii_lowercase().as_str() {
            "proxy-highest" | "proxy" => Quality::ProxyHighest,
            "proxy-1080" => Quality::Proxy1080,
            "proxy-720" => Quality::Proxy720,
            "proxy-smallest" => Quality::ProxySmallest,
            _ => Quality::Original,
        }
    }
    fn is_proxy(self) -> bool {
        self != Quality::Original
    }
}

/// Looks like a Frame.io asset/share UUID: 8-4-4-4-12 hex.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b[8] == b'-'
        && b[13] == b'-'
        && b[18] == b'-'
        && b[23] == b'-'
        && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The share id from a Frame.io link. Accepts `next.frame.io/share/<uuid>/...`
/// (and the `/view/<assetId>` deep link — the share id is the segment right
/// after `/share/`). A `f.io/...` short link is resolved by following its
/// redirect to the canonical share URL first.
fn parse_share_id(url: &str) -> Option<String> {
    let s = url.trim();
    if let Some(i) = s.find("/share/") {
        let rest = &s[i + "/share/".len()..];
        if let Some(seg) = rest.split(['/', '?', '#']).find(|x| !x.is_empty()) {
            if is_uuid(seg) {
                return Some(seg.to_string());
            }
        }
    }
    None
}

/// Resolve a link to its share id, following a short-link redirect if needed.
fn resolve_share_id(c: &reqwest::blocking::Client, url: &str) -> Option<String> {
    if let Some(id) = parse_share_id(url) {
        return Some(id);
    }
    // f.io short link (or any redirector): follow it and re-parse the final URL.
    let resp = c.get(url).header("User-Agent", UA).send().ok()?;
    parse_share_id(resp.url().as_str())
}

/// POST one GraphQL operation with the anonymous-share auth headers.
fn gql(
    c: &reqwest::blocking::Client,
    share_id: &str,
    session: &str,
    op: &str,
    query: &str,
    variables: Value,
) -> Result<Value, String> {
    let auth = base64::engine::general_purpose::STANDARD.encode(share_id);
    let body = json!({ "operationName": op, "query": query, "variables": variables });
    let resp = c
        .post(GQL)
        .header("User-Agent", UA)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("x-frameio-share-authentication", auth)
        .header("x-frameio-session-id", session)
        .header("apollographql-client-name", CLIENT_NAME)
        .header("apollographql-client-version", CLIENT_VERSION)
        .header("x-gql-op", op)
        .body(body.to_string())
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text)
        .map_err(|_| format!("frame.io {status}: {}", text.chars().take(200).collect::<String>()))?;
    if let Some(errs) = v.get("errors").and_then(|x| x.as_array()) {
        let msg = errs
            .first()
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("request failed");
        return Err(format!("frame.io: {msg}"));
    }
    Ok(v)
}

const Q_LIST: &str = "query GetShareCollectionAssets($shareId: ID!, $assetType: ChildAssetTypeInput, $folderId: ID, $page: PageInput!) { share(shareId: $shareId) { id ... on Share { collectionAssets(page: $page, assetType: $assetType, folderId: $folderId) { pageInfo { endCursor hasNextPage } nodes { id } totalCount } } } }";
const Q_AGG: &str = "query ShareAggregate($shareId: ID!) { share(shareId: $shareId) { id aggregateData { totalFileSize } } }";
const Q_NAME: &str = "query GetAssetForDownload($assetId: ID!) { asset(assetId: $assetId) { id name } }";
const Q_DOWNLOAD: &str = "query GetAssetForDownload($assetId: ID!) { asset(assetId: $assetId) { id name assetType ... on VideoAsset { media { original { downloadUrl filesizeInBytes } videoTranscodes { key width height filesizeInBytes downloadUrl encodeStatus } } } ... on ImageAsset { media { original { downloadUrl filesizeInBytes } imageTranscodes { key downloadUrl encodeStatus } } } ... on AudioAsset { media { original { downloadUrl filesizeInBytes } audioTranscodes { key downloadUrl encodeStatus } } } ... on DocumentAsset { media { original { downloadUrl filesizeInBytes } } } ... on UnsupportedAsset { media { original { downloadUrl filesizeInBytes } } } ... on InteractiveAsset { media { original { downloadUrl filesizeInBytes } } } } }";

/// One node id (a file or a folder) inside the share, with its relative folder
/// path so nested structure is recreated under the destination.
struct PlanItem {
    asset_id: String,
    dir: PathBuf,
}

/// List the child node ids of `folder_id` (or the share root when `None`) of the
/// given type, following cursor pages until exhausted.
fn list_nodes(
    c: &reqwest::blocking::Client,
    share_id: &str,
    session: &str,
    asset_type: &str,
    folder_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let mut page = json!({ "first": 200 });
        if let Some(cur) = &after {
            page["after"] = json!(cur);
        }
        let vars = json!({
            "shareId": share_id,
            "assetType": asset_type,
            "folderId": folder_id,
            "page": page,
        });
        let v = gql(c, share_id, session, "GetShareCollectionAssets", Q_LIST, vars)?;
        let ca = v
            .pointer("/data/share/collectionAssets")
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(nodes) = ca.get("nodes").and_then(|x| x.as_array()) {
            for n in nodes {
                if let Some(id) = n.get("id").and_then(|x| x.as_str()) {
                    ids.push(id.to_string());
                }
            }
        }
        let has_next = ca
            .pointer("/pageInfo/hasNextPage")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let cursor = ca
            .pointer("/pageInfo/endCursor")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        if has_next && cursor.is_some() {
            after = cursor;
        } else {
            break;
        }
    }
    Ok(ids)
}

fn folder_name(c: &reqwest::blocking::Client, share_id: &str, session: &str, folder_id: &str) -> String {
    gql(c, share_id, session, "GetAssetForDownload", Q_NAME, json!({ "assetId": folder_id }))
        .ok()
        .and_then(|v| v.pointer("/data/asset/name").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Folder".to_string())
}

/// Recursively enumerate every file in the share, preserving folder paths.
fn walk(
    c: &reqwest::blocking::Client,
    share_id: &str,
    session: &str,
    folder_id: Option<&str>,
    prefix: &Path,
    out: &mut Vec<PlanItem>,
    h: &NativeHandles,
) -> Result<(), String> {
    if h.cancelled.load(Ordering::SeqCst) {
        return Err("paused".into());
    }
    for id in list_nodes(c, share_id, session, "FILE", folder_id)? {
        out.push(PlanItem { asset_id: id, dir: prefix.to_path_buf() });
    }
    for fid in list_nodes(c, share_id, session, "FOLDER", folder_id)? {
        let name = folder_name(c, share_id, session, &fid);
        let sub = prefix.join(safe_seg(&name));
        walk(c, share_id, session, Some(&fid), &sub, out, h)?;
    }
    Ok(())
}

/// The chosen media file for one asset.
struct Media {
    name: String,
    url: String,
    size: i64,
}

/// Resolve an asset to the download URL for the requested quality. Falls back to
/// the original when a proxy was asked for but none exists (e.g. images, audio).
fn resolve_media(
    c: &reqwest::blocking::Client,
    share_id: &str,
    session: &str,
    asset_id: &str,
    quality: Quality,
) -> Result<Media, String> {
    let v = gql(c, share_id, session, "GetAssetForDownload", Q_DOWNLOAD, json!({ "assetId": asset_id }))?;
    let asset = v.pointer("/data/asset").ok_or("frame.io: asset not found")?;
    let name = asset.get("name").and_then(|x| x.as_str()).unwrap_or("file").to_string();
    let media = asset.get("media").cloned().unwrap_or(Value::Null);

    let original_url = media.pointer("/original/downloadUrl").and_then(|x| x.as_str()).unwrap_or("");
    let original_size = media.pointer("/original/filesizeInBytes").and_then(|x| x.as_i64()).unwrap_or(0);

    if quality.is_proxy() {
        if let Some(m) = pick_proxy(&media, quality) {
            return Ok(Media { name, url: m.0, size: m.1 });
        }
        // No proxy for this asset type — fall back to the original master.
    }
    if original_url.is_empty() {
        return Err(format!("frame.io: no downloadable media for {name}"));
    }
    Ok(Media { name, url: original_url.to_string(), size: original_size })
}

/// Choose a proxy transcode `(url, size)` from `media.videoTranscodes` per the
/// requested quality. Only SUCCESS transcodes with a real download URL, skipping
/// the duplicate `original` entry. Returns `None` when there are no proxies.
fn pick_proxy(media: &Value, quality: Quality) -> Option<(String, i64)> {
    let arr = media.get("videoTranscodes").and_then(|x| x.as_array())?;
    let mut cands: Vec<(&str, i64, i64, i64, &str)> = Vec::new(); // key, w, h, size, url
    for t in arr {
        let key = t.get("key").and_then(|x| x.as_str()).unwrap_or("");
        let status = t.get("encodeStatus").and_then(|x| x.as_str()).unwrap_or("");
        let url = t.get("downloadUrl").and_then(|x| x.as_str()).unwrap_or("");
        if key == "original" || status != "SUCCESS" || url.is_empty() {
            continue;
        }
        let w = t.get("width").and_then(|x| x.as_i64()).unwrap_or(0);
        let hgt = t.get("height").and_then(|x| x.as_i64()).unwrap_or(0);
        let size = t.get("filesizeInBytes").and_then(|x| x.as_i64()).unwrap_or(0);
        cands.push((key, w, hgt, size, url));
    }
    if cands.is_empty() {
        return None;
    }
    // Prefer a height cap for the 1080/720 targets, else fall back to smallest.
    let by_cap = |cap: i64| -> Option<&(&str, i64, i64, i64, &str)> {
        cands
            .iter()
            .filter(|c| c.2 > 0 && c.2 <= cap)
            .max_by_key(|c| c.2)
            .or_else(|| cands.iter().min_by_key(|c| c.3.max(0)))
    };
    let chosen = match quality {
        Quality::ProxyHighest => cands.iter().max_by_key(|c| (c.1 * c.2, c.3)),
        Quality::Proxy1080 => by_cap(1080),
        Quality::Proxy720 => by_cap(720),
        Quality::ProxySmallest => cands.iter().min_by_key(|c| c.3.max(0)),
        Quality::Original => None,
    }?;
    Some((chosen.4.to_string(), chosen.3))
}

/// Sanitize one path segment so it stays inside the destination folder.
fn safe_seg(seg: &str) -> String {
    let s = seg.trim();
    if s.is_empty() || s == "." || s == ".." {
        return "_".to_string();
    }
    s.chars().map(|c| if ":*?\"<>|/\\".contains(c) { '_' } else { c }).collect()
}

/// Range-stream one resolved file to disk under `dir`, resuming from any
/// `.fdmpart`. On a 403/410 (expired presigned URL) it re-resolves the asset once
/// to get a fresh URL. Handles servers that ignore Range (200 instead of 206).
#[allow(clippy::too_many_arguments)]
fn stream_file(
    c: &reqwest::blocking::Client,
    share_id: &str,
    session: &str,
    asset_id: &str,
    quality: Quality,
    media: &Media,
    dir: &Path,
    h: &NativeHandles,
) -> Result<(), String> {
    let dest_file = dir.join(safe_seg(&media.name));
    if let Some(p) = dest_file.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let total = media.size;
    if total > 0 && std::fs::metadata(&dest_file).map(|m| m.len()).unwrap_or(0) == total as u64 {
        h.transferred.fetch_add(total, Ordering::SeqCst);
        return Ok(());
    }
    let mut part = dest_file.as_os_str().to_owned();
    part.push(".fdmpart");
    let part = PathBuf::from(part);
    let mut offset = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if total > 0 && offset > total as u64 {
        offset = 0;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .truncate(false)
        .open(&part)
        .map_err(|e| e.to_string())?;
    if offset == 0 {
        let _ = file.set_len(0);
    }
    h.transferred.fetch_add(offset as i64, Ordering::SeqCst);

    let mut link = media.url.clone();
    let mut refreshed = false;
    let mut stalls = 0u32;
    loop {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        if total > 0 && offset >= total as u64 {
            break;
        }
        let before = offset;
        let mut resp = c
            .get(&link)
            .header("User-Agent", UA)
            .header("Range", format!("bytes={offset}-"))
            .send()
            .map_err(|e| e.to_string())?;
        let code = resp.status().as_u16();
        if (code == 403 || code == 410) && !refreshed {
            // Presigned URL expired mid-transfer — mint a fresh one and retry.
            let fresh = resolve_media(c, share_id, session, asset_id, quality)?;
            link = fresh.url;
            refreshed = true;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("frame.io download {}", resp.status()));
        }
        // If we asked to resume but the server sent the whole file (200, not 206),
        // it ignored Range — restart from the top so bytes don't get duplicated.
        if offset > 0 && code == 200 {
            file.set_len(0).map_err(|e| e.to_string())?;
            h.transferred.fetch_add(-(offset as i64), Ordering::SeqCst);
            offset = 0;
        }
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if h.cancelled.load(Ordering::SeqCst) {
                return Err("paused".into());
            }
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            offset += n as u64;
            h.transferred.fetch_add(n as i64, Ordering::SeqCst);
        }
        if total <= 0 || offset >= total as u64 {
            break; // unknown size (trust EOF) or complete
        }
        if offset == before {
            stalls += 1;
            if stalls >= 5 {
                return Err("frame.io download stalled".into());
            }
            std::thread::sleep(Duration::from_millis(500));
        } else {
            stalls = 0;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, &dest_file).map_err(|e| e.to_string())
}

/// Download an entire Frame.io share into `dest_dir` at the requested quality,
/// updating `h`. `quality_hint` is the raw `x-fdm-frameio-quality` header value.
pub fn download_share(url: &str, dest_dir: &Path, quality_hint: &str, h: &NativeHandles) -> Result<(), String> {
    let c = client();
    let quality = Quality::parse(quality_hint);
    let share_id = resolve_share_id(&c, url).ok_or("not a recognizable Frame.io share link")?;
    let session = session_id();

    // Enumerate the whole share (files + nested folders) up front.
    let mut plan = Vec::new();
    walk(&c, &share_id, &session, None, Path::new(""), &mut plan, h)?;
    if plan.is_empty() {
        return Err("this Frame.io share has no downloadable files".into());
    }

    // Publish the true total so the progress bar/ETA are accurate, not
    // total==downloaded. Originals have an instant, exact share aggregate. Proxy
    // renditions have no aggregate — their sizes only come from per-asset
    // resolves — so a background thread pre-sizes each chosen rendition and fills
    // `h.total` as it goes, letting the download start immediately while the
    // total fills in over the next few seconds.
    if quality == Quality::Original {
        if let Ok(v) = gql(&c, &share_id, &session, "ShareAggregate", Q_AGG, json!({ "shareId": share_id })) {
            if let Some(total) = v.pointer("/data/share/aggregateData/totalFileSize").and_then(|x| x.as_i64()) {
                if total > 0 {
                    h.total.store(total, Ordering::SeqCst);
                }
            }
        }
    } else {
        let ids: Vec<String> = plan.iter().map(|p| p.asset_id.clone()).collect();
        let (share, session, h2) = (share_id.clone(), session.clone(), h.clone());
        std::thread::spawn(move || {
            let c = client();
            let mut sum: i64 = 0;
            for id in ids {
                if h2.cancelled.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(m) = resolve_media(&c, &share, &session, &id, quality) {
                    if m.size > 0 {
                        sum += m.size;
                        h2.total.store(sum, Ordering::SeqCst);
                    }
                }
            }
        });
    }

    for item in plan {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        let media = resolve_media(&c, &share_id, &session, &item.asset_id, quality)?;
        let dir = dest_dir.join(&item.dir);
        stream_file(&c, &share_id, &session, &item.asset_id, quality, &media, &dir, h)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_share_id() {
        assert_eq!(
            parse_share_id("https://next.frame.io/share/ff7cb5d4-0d65-4bff-ba92-ec22466c7ec3/").as_deref(),
            Some("ff7cb5d4-0d65-4bff-ba92-ec22466c7ec3")
        );
        assert_eq!(
            parse_share_id("https://next.frame.io/share/06c38ba7-a5ae-4629-bc4c-d337d8d1315a/view/42321f00-4835-49e7-8d1c-5c63230ac1b7").as_deref(),
            Some("06c38ba7-a5ae-4629-bc4c-d337d8d1315a")
        );
        assert_eq!(parse_share_id("https://next.frame.io/share/not-a-uuid/"), None);
        assert_eq!(parse_share_id("https://example.com/foo"), None);
    }

    #[test]
    fn quality_parse_defaults_to_original() {
        assert_eq!(Quality::parse("original"), Quality::Original);
        assert_eq!(Quality::parse(""), Quality::Original);
        assert_eq!(Quality::parse("garbage"), Quality::Original);
        assert_eq!(Quality::parse("proxy"), Quality::ProxyHighest);
        assert_eq!(Quality::parse("proxy-highest"), Quality::ProxyHighest);
        assert_eq!(Quality::parse("proxy-1080"), Quality::Proxy1080);
        assert_eq!(Quality::parse("proxy-720"), Quality::Proxy720);
        assert_eq!(Quality::parse("proxy-smallest"), Quality::ProxySmallest);
    }

    #[test]
    fn is_uuid_validates_shape() {
        assert!(is_uuid("ff7cb5d4-0d65-4bff-ba92-ec22466c7ec3"));
        assert!(!is_uuid("ff7cb5d4-0d65-4bff-ba92-ec22466c7ec"));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid("gg7cb5d4-0d65-4bff-ba92-ec22466c7ec3"));
    }

    #[test]
    fn safe_seg_strips_traversal_and_separators() {
        assert_eq!(safe_seg("Card 1"), "Card 1");
        assert_eq!(safe_seg(".."), "_");
        assert_eq!(safe_seg("a/b:c"), "a_b_c");
        assert_eq!(safe_seg("  "), "_");
    }

    #[test]
    fn pick_proxy_selects_by_target() {
        let media = json!({
            "videoTranscodes": [
                { "key": "h264_2160", "width": 3840, "height": 2160, "filesizeInBytes": 55, "downloadUrl": "u2160", "encodeStatus": "SUCCESS" },
                { "key": "h264_1080_best", "width": 1920, "height": 1080, "filesizeInBytes": 16, "downloadUrl": "u1080", "encodeStatus": "SUCCESS" },
                { "key": "h264_720", "width": 1280, "height": 720, "filesizeInBytes": 8, "downloadUrl": "u720", "encodeStatus": "SUCCESS" },
                { "key": "h264_360", "width": 640, "height": 360, "filesizeInBytes": 2, "downloadUrl": "u360", "encodeStatus": "SUCCESS" },
                { "key": "original", "width": null, "height": null, "filesizeInBytes": null, "downloadUrl": "uorig", "encodeStatus": "SUCCESS" }
            ]
        });
        assert_eq!(pick_proxy(&media, Quality::ProxyHighest).unwrap().0, "u2160");
        assert_eq!(pick_proxy(&media, Quality::Proxy1080).unwrap().0, "u1080");
        assert_eq!(pick_proxy(&media, Quality::Proxy720).unwrap().0, "u720");
        assert_eq!(pick_proxy(&media, Quality::ProxySmallest).unwrap().0, "u360");
    }

    #[test]
    fn pick_proxy_none_when_no_transcodes() {
        assert!(pick_proxy(&json!({}), Quality::ProxyHighest).is_none());
        assert!(pick_proxy(&json!({ "videoTranscodes": [] }), Quality::ProxyHighest).is_none());
    }
}

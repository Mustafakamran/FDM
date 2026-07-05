//! Native Filemail downloader (public transfer links, no creds).
//!
//! Reverse-engineered public web API — the same call the `filemail.com/t/<id>`
//! recipient page makes to list files:
//!   GET https://www.filemail.com/api/transfer/get?trackid=<trackid>
//!     -> { "transfer": { "passwordprotected": bool, "status": "...",
//!            "files": [ { "filename": "VIDEO/clip.mp4", "filesize": 123,
//!                         "downloadurl": "https://NNNN.filemail.com/api/file/get?filekey=..&track=..",
//!                         "fileid": ".." } ] } }
//! Each `downloadurl` is a direct file URL that honors HTTP Range (206), so we
//! Range-stream to disk and resume from any `.fdmpart`. `filename` may embed a
//! relative folder path (the sender's structure); we preserve it under `dest`.

use crate::download::NativeHandles;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(None)
        .connect_timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// The tracking id from a Filemail link. Accepts the recipient link
/// (`.../t/<trackid>`), an already-built api url (`...?trackid=<id>`), or a bare
/// token.
fn parse_trackid(url: &str) -> Option<String> {
    let s = url.trim();
    if let Some(i) = s.find("trackid=") {
        let rest = &s[i + "trackid=".len()..];
        let seg = rest.split(['&', '#']).next().unwrap_or(rest);
        if !seg.is_empty() {
            return Some(seg.to_string());
        }
    }
    if let Some(i) = s.find("/t/") {
        let rest = &s[i + "/t/".len()..];
        if let Some(seg) = rest.split(['/', '?', '#']).find(|x| !x.is_empty()) {
            return Some(seg.to_string());
        }
    }
    // A bare token (no path separators) is treated as the trackid.
    if !s.is_empty() && !s.contains('/') {
        return Some(s.to_string());
    }
    None
}

struct Entry {
    id: String,
    name: String,
    size: i64,
    url: String,
}

/// Fetch the transfer manifest for a trackid. Errors on a bad/expired link or a
/// password-protected transfer (which this anonymous path can't unlock).
fn fetch_files(c: &reqwest::blocking::Client, trackid: &str) -> Result<Vec<Entry>, String> {
    let api = format!("https://www.filemail.com/api/transfer/get?trackid={trackid}");
    let resp = c
        .get(&api)
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("filemail {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if let Some(err) = v.get("errormessage").and_then(|x| x.as_str()) {
        return Err(format!("filemail: {err}"));
    }
    let t = v
        .get("transfer")
        .ok_or("filemail: link not found (wrong or expired?)")?;
    if t.get("passwordprotected").and_then(|x| x.as_bool()).unwrap_or(false) {
        return Err("this Filemail transfer is password-protected (not supported)".into());
    }
    let files = t.get("files").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for f in &files {
        let url = f.get("downloadurl").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if url.is_empty() {
            continue;
        }
        out.push(Entry {
            id: f.get("fileid").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            name: f.get("filename").and_then(|x| x.as_str()).unwrap_or("file").to_string(),
            size: f.get("filesize").and_then(|x| x.as_i64()).unwrap_or(0),
            url,
        });
    }
    if out.is_empty() {
        return Err("Filemail transfer has no downloadable files (expired?)".into());
    }
    Ok(out)
}

/// Turn a transfer-relative name (possibly `VIDEO/clip.mp4`) into a path safely
/// contained under dest: sanitize each segment and drop `.`/`..`/empty and any
/// root/drive component so nothing escapes the destination folder.
fn safe_relpath(name: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for raw in name.split(['/', '\\']) {
        let seg = raw.trim();
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        let clean: String = seg.chars().map(|c| if ":*?\"<>|".contains(c) { '_' } else { c }).collect();
        out.push(clean);
    }
    out
}

/// Range-stream one file to dest, resuming from any `.fdmpart`. On a 403/410
/// (a stale link) it re-fetches the manifest once to get a fresh URL for this
/// file id. Resumes mid-file if the stream is truncated early.
fn stream_file(c: &reqwest::blocking::Client, trackid: &str, entry: &Entry, dest_dir: &Path, h: &NativeHandles) -> Result<(), String> {
    let rel = {
        let p = safe_relpath(&entry.name);
        if p.as_os_str().is_empty() {
            PathBuf::from("file")
        } else {
            p
        }
    };
    let dest_file = dest_dir.join(rel);
    if let Some(p) = dest_file.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let total = entry.size;
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

    let mut link = entry.url.clone();
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
        if (code == 403 || code == 410) && !refreshed && !entry.id.is_empty() {
            let files = fetch_files(c, trackid)?;
            if let Some(f) = files.into_iter().find(|f| f.id == entry.id) {
                link = f.url;
                refreshed = true;
                continue;
            }
            return Err(format!("filemail download {code} (link expired)"));
        }
        if !resp.status().is_success() {
            return Err(format!("filemail download {}", resp.status()));
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
            // No progress this pass — back off, then give up after a few tries.
            stalls += 1;
            if stalls >= 5 {
                return Err("filemail download stalled".into());
            }
            std::thread::sleep(Duration::from_millis(500));
        } else {
            stalls = 0;
        }
        // else: server closed early; loop resumes with Range from the new offset.
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, &dest_file).map_err(|e| e.to_string())
}

/// Download an entire Filemail transfer into `dest_dir`, updating `h`.
pub fn download_share(url: &str, dest_dir: &Path, h: &NativeHandles) -> Result<(), String> {
    let c = client();
    let trackid = parse_trackid(url).ok_or("not a recognizable Filemail link")?;
    let files = fetch_files(&c, &trackid)?;
    // Now the real transfer size is known — publish it so the UI shows true
    // progress across all files instead of an unknown (0) total.
    let total: i64 = files.iter().map(|f| f.size.max(0)).sum();
    if total > 0 {
        h.total.store(total, Ordering::SeqCst);
    }
    for entry in files {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        stream_file(&c, &trackid, &entry, dest_dir, h)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trackid() {
        assert_eq!(parse_trackid("https://www.filemail.com/t/Trp4EdH3").as_deref(), Some("Trp4EdH3"));
        assert_eq!(parse_trackid("https://filemail.com/t/abc123?x=1").as_deref(), Some("abc123"));
        assert_eq!(
            parse_trackid("https://www.filemail.com/api/transfer/get?trackid=ZZZ&y=2").as_deref(),
            Some("ZZZ")
        );
        assert_eq!(parse_trackid("Trp4EdH3").as_deref(), Some("Trp4EdH3"));
        assert_eq!(parse_trackid("https://example.com/foo"), None);
        assert_eq!(parse_trackid("https://www.filemail.com/t/"), None);
    }

    #[test]
    fn safe_relpath_keeps_folders_strips_traversal() {
        assert_eq!(safe_relpath("VIDEO/C3658.MP4"), PathBuf::from("VIDEO").join("C3658.MP4"));
        assert_eq!(safe_relpath("../../etc/passwd"), PathBuf::from("etc").join("passwd"));
        assert_eq!(safe_relpath("a:b/c?d.mp4"), PathBuf::from("a_b").join("c_d.mp4"));
        assert_eq!(safe_relpath("clip.mp4"), PathBuf::from("clip.mp4"));
    }
}

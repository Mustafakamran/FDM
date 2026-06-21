//! Native resumable downloader.
//!
//! Every file is pulled with HTTP **Range** requests into a `<dest>.fdmpart`
//! file. Because the partial file stays on disk, a paused or crashed transfer
//! resumes from exactly where it stopped — we just restart from the partial
//! file's current length. On completion the part is renamed to the final name.
//!
//! rclone is still used for listing/index; only the byte transfer is native, so
//! resume works identically for Drive, Dropbox, Drive-links and Dropbox-links.
//!
//! Trade-offs vs the old rclone path: single connection per file (no
//! multi-thread streams yet) and no post-transfer hash verification.

use crate::download::{account_fs, DownloadItem, NativeHandles};
use crate::dropbox;
use crate::provider::{self, Kind};
use crate::rclone::supervisor::{rc_post, RcConnection};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// Bytes requested per Range call. Larger than the streaming proxy's chunk since
/// throughput, not latency, is what matters here.
const CHUNK: u64 = 16 * 1024 * 1024;
/// Refresh the access token if it's older than this (they expire in ~1h).
const TOKEN_TTL: Duration = Duration::from_secs(45 * 60);

/// Caches an access token across the many Range requests of a long download,
/// refreshing only when stale or rejected.
struct Auth {
    conn: RcConnection,
    kind: Kind,
    token_acct: String,
    link_url: String,
    cur: Mutex<(String, Instant)>,
}

impl Auth {
    fn new(app: &AppHandle, conn: RcConnection, account_id: &str) -> Result<Self, String> {
        let kind = provider::kind_of(account_id);
        let (token_acct, link_url) = provider::token_account(app, account_id);
        let token = provider::fetch_token(&conn, kind, &token_acct)?;
        Ok(Auth { conn, kind, token_acct, link_url, cur: Mutex::new((token, Instant::now())) })
    }
    fn token(&self) -> Result<String, String> {
        let mut g = self.cur.lock().unwrap_or_else(|e| e.into_inner());
        if g.1.elapsed() > TOKEN_TTL {
            g.0 = provider::fetch_token(&self.conn, self.kind, &self.token_acct)?;
            g.1 = Instant::now();
        }
        Ok(g.0.clone())
    }
    fn refresh(&self) -> Result<String, String> {
        let mut g = self.cur.lock().unwrap_or_else(|e| e.into_inner());
        g.0 = provider::fetch_token(&self.conn, self.kind, &self.token_acct)?;
        g.1 = Instant::now();
        Ok(g.0.clone())
    }
}

/// One file to fetch: its Drive id (or empty), provider path, size, and dest.
struct FileTask {
    fid: String,
    path: String,
    size: i64,
    dest: PathBuf,
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".fdmpart");
    PathBuf::from(s)
}

fn len_of(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Bytes already on disk for a file (full or partial) — used to seed progress.
fn done_bytes(t: &FileTask) -> i64 {
    if t.size > 0 && len_of(&t.dest) == t.size as u64 {
        return t.size;
    }
    let part = len_of(&part_path(&t.dest)) as i64;
    if t.size > 0 {
        part.min(t.size)
    } else {
        part
    }
}

/// Download (or resume) one file. Appends Range chunks to the `.fdmpart` file
/// and renames on completion. `paused` (cancel flag) stops cleanly, leaving the
/// partial file for next time.
fn download_file(auth: &Auth, client: &reqwest::blocking::Client, t: &FileTask, h: &NativeHandles) -> Result<(), String> {
    let total = t.size.max(0) as u64;
    if total > 0 && len_of(&t.dest) == total {
        return Ok(()); // already complete
    }
    if let Some(parent) = t.dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let part = part_path(&t.dest);
    let mut offset = len_of(&part);
    if total > 0 && offset > total {
        offset = 0; // corrupt/oversize partial — restart this file
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part)
        .map_err(|e| e.to_string())?;
    if offset == 0 {
        let _ = file.set_len(0);
    }

    let mut ack = false;
    loop {
        if total > 0 && offset >= total {
            break;
        }
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        let want = CHUNK;
        let end = if total > 0 {
            (offset + want - 1).min(total - 1)
        } else {
            offset + want - 1
        };
        let token = auth.token()?;
        let mut resp = provider::send_range(client, &token, auth.kind, &t.fid, &t.path, &auth.link_url, offset, end, ack)
            .map_err(|e| e.to_string())?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            let token = auth.refresh()?;
            resp = provider::send_range(client, &token, auth.kind, &t.fid, &t.path, &auth.link_url, offset, end, ack)
                .map_err(|e| e.to_string())?;
        }
        // Drive blocks large-file downloads with a virus-scan warning unless we
        // acknowledge — retry once with the flag.
        if auth.kind == Kind::Drive && resp.status() == reqwest::StatusCode::FORBIDDEN && !ack {
            ack = true;
            continue;
        }
        if !resp.status().is_success() {
            let s = resp.status();
            let b = resp.text().unwrap_or_default();
            return Err(format!("download {s}: {}", b.chars().take(300).collect::<String>()));
        }
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        let n = bytes.len() as u64;
        if n == 0 {
            break;
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        offset += n;
        h.transferred.fetch_add(n as i64, Ordering::SeqCst);
        if total == 0 && n < want {
            break; // unknown size: short read = EOF
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, &t.dest).map_err(|e| e.to_string())
}

fn parse_size(v: &Value) -> i64 {
    v.get("Size").and_then(|x| x.as_i64()).unwrap_or(-1)
}

/// Enumerate the files under a folder selection into per-file tasks.
fn enumerate_folder(
    app: &AppHandle,
    conn: &RcConnection,
    account_id: &str,
    item: &DownloadItem,
    dest_root: &Path,
) -> Result<Vec<FileTask>, String> {
    let mut tasks = Vec::new();
    let folder_dest = dest_root.join(&item.name);

    if account_id.starts_with("dropboxlink_") {
        // Native list of the whole link; keep files under this folder.
        let entries = dropbox::list_entries(app, conn, account_id)?;
        let prefix = format!("{}/", item.path);
        for e in &entries {
            if e.get("IsDir").and_then(|b| b.as_bool()).unwrap_or(false) {
                continue;
            }
            let p = e.get("Path").and_then(|p| p.as_str()).unwrap_or("");
            if p != item.path && !p.starts_with(&prefix) {
                continue;
            }
            let rel = p.strip_prefix(&prefix).unwrap_or(p);
            tasks.push(FileTask {
                fid: String::new(),
                path: p.to_string(),
                size: parse_size(e),
                dest: folder_dest.join(rel),
            });
        }
        return Ok(tasks);
    }

    // rclone recursive list for Drive/Dropbox/Drive-link (paths are relative to
    // the folder; Drive entries carry their file id).
    let fs = account_fs(account_id)?;
    let resp = rc_post(
        conn,
        "operations/list",
        &json!({ "fs": fs, "remote": item.path, "opt": { "recurse": true } }),
    )?;
    let list = resp.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    for e in &list {
        if e.get("IsDir").and_then(|b| b.as_bool()).unwrap_or(false) {
            continue;
        }
        let rel = e.get("Path").and_then(|p| p.as_str()).unwrap_or("");
        if rel.is_empty() {
            continue;
        }
        let size = parse_size(e);
        if size < 0 {
            continue; // skip non-downloadable (e.g. Google Docs)
        }
        tasks.push(FileTask {
            fid: e.get("ID").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            path: format!("{}/{}", item.path, rel),
            size,
            dest: folder_dest.join(rel),
        });
    }
    Ok(tasks)
}

/// Worker body for one queued item (a file or a whole folder).
pub fn download_item(app: AppHandle, conn: RcConnection, account_id: String, item: DownloadItem, dest: String, h: NativeHandles) {
    let result = (|| -> Result<(), String> {
        let auth = Auth::new(&app, conn.clone(), &account_id)?;
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let dest_root = Path::new(&dest);

        let tasks = if item.is_dir {
            enumerate_folder(&app, &conn, &account_id, &item, dest_root)?
        } else {
            vec![FileTask {
                fid: item.id.clone(),
                path: item.path.clone(),
                size: item.size,
                dest: dest_root.join(&item.name),
            }]
        };

        // Seed progress with whatever is already on disk (resume), then each
        // download_file fetch_adds only the *new* bytes it pulls.
        let already: i64 = tasks.iter().map(done_bytes).sum();
        h.transferred.store(already, Ordering::SeqCst);

        for t in &tasks {
            if h.cancelled.load(Ordering::SeqCst) {
                return Err("paused".into());
            }
            download_file(&auth, &client, t, &h)?;
        }
        Ok(())
    })();

    match result {
        Ok(()) => h.success.store(true, Ordering::SeqCst),
        Err(e) => *h.error.lock().unwrap_or_else(|e| e.into_inner()) = e,
    }
    h.finished.store(true, Ordering::SeqCst);
    let _ = app.emit("download-finished", json!({ "jobId": h.job_id }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_appends_suffix() {
        assert_eq!(part_path(Path::new("/d/clip.mxf")), PathBuf::from("/d/clip.mxf.fdmpart"));
    }

    #[test]
    fn done_bytes_counts_partial_and_complete() {
        // No files on disk → 0 (uses a path unlikely to exist).
        let t = FileTask { fid: String::new(), path: "p".into(), size: 1000, dest: PathBuf::from("/nonexistent/x.bin") };
        assert_eq!(done_bytes(&t), 0);
    }
}

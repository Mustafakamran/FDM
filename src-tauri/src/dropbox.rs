//! Native Dropbox shared-link engine.
//!
//! rclone can't browse an arbitrary Dropbox *shared link* (there's no
//! `root_folder_id` equivalent the way Google Drive has), so links are handled
//! with the native Dropbox API instead:
//!   - listing: `files/list_folder` with `shared_link` (recursive, paginated),
//!   - download: `sharing/get_shared_link_file` streamed to disk.
//!
//! A link account has NO rclone remote. Its id is `dropboxlink_<slug>` and its
//! metadata (the share URL + which connected Dropbox account's token to borrow)
//! lives in `dropbox_links.json` in the app data dir. Everything else — the
//! index, the browser, the download queue — treats it like any other account.

use crate::accounts::{parse_remote, remote_name, Account};
use crate::download::{DownloadItem, JobStatus, NativeHandles, NativeJobsState};
use crate::rclone::supervisor::{RcConnection, RcloneState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

const LIST_FOLDER: &str = "https://api.dropboxapi.com/2/files/list_folder";
const LIST_FOLDER_CONTINUE: &str = "https://api.dropboxapi.com/2/files/list_folder/continue";
const GET_METADATA: &str = "https://api.dropboxapi.com/2/sharing/get_shared_link_metadata";
const GET_FILE: &str = "https://content.dropboxapi.com/2/sharing/get_shared_link_file";

/// Stored metadata for one Dropbox shared-link account.
#[derive(Clone, Serialize, Deserialize)]
pub struct LinkInfo {
    /// The Dropbox share URL (e.g. https://www.dropbox.com/scl/fo/…?rlkey=…).
    pub url: String,
    /// A connected Dropbox account id whose OAuth token authorizes the API calls.
    pub base: String,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join("dropbox_links.json"))
}

fn load_store(app: &AppHandle) -> HashMap<String, LinkInfo> {
    store_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_store(app: &AppHandle, store: &HashMap<String, LinkInfo>) -> Result<(), String> {
    let p = store_path(app)?;
    let data = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(p, data).map_err(|e| e.to_string())
}

/// The link metadata for an account id, if it's a stored Dropbox link.
pub fn link_info(app: &AppHandle, account_id: &str) -> Option<LinkInfo> {
    load_store(app).get(account_id).cloned()
}

/// All Dropbox-link accounts (so `list_accounts` can surface them alongside the
/// rclone remotes — they have no remote of their own).
pub fn link_accounts(app: &AppHandle) -> Vec<Account> {
    load_store(app).keys().filter_map(|id| parse_remote(id)).collect()
}

/// Forget a Dropbox link (on account removal).
pub fn remove_link(app: &AppHandle, account_id: &str) {
    let mut s = load_store(app);
    if s.remove(account_id).is_some() {
        let _ = save_store(app, &s);
    }
}

/// POST a JSON body to a Dropbox RPC endpoint with bearer auth; return parsed JSON.
fn api_post(token: &str, url: &str, body: &Value) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(body).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("dropbox {url} {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Map a Dropbox list_folder entry to an rclone-shaped list item (so the indexer
/// can reuse its existing `parse_entry`). Paths are made root-relative (the
/// shared link root is "", nested files are "Sub/clip.mxf").
fn map_entry(e: &Value) -> Option<Value> {
    let tag = e.get(".tag").and_then(|t| t.as_str())?;
    let name = e.get("name").and_then(|n| n.as_str())?;
    // path_display is relative to the shared link, with a leading '/'.
    let raw = e.get("path_display").and_then(|p| p.as_str()).unwrap_or("");
    let path = raw.trim_start_matches('/').to_string();
    if path.is_empty() {
        return None;
    }
    match tag {
        "folder" => Some(json!({
            "Name": name, "Path": path, "Size": -1, "IsDir": true, "ModTime": "", "MimeType": ""
        })),
        "file" => {
            let size = e.get("size").and_then(|s| s.as_i64()).unwrap_or(0);
            let mod_time = e.get("server_modified").and_then(|m| m.as_str()).unwrap_or("");
            Some(json!({
                "Name": name, "Path": path, "Size": size, "IsDir": false,
                "ModTime": mod_time, "MimeType": ""
            }))
        }
        _ => None,
    }
}

/// Recursively list a shared link, returning rclone-shaped entries. One
/// `list_folder` call with `recursive:true`, paginated via `/continue`.
pub fn list_entries(app: &AppHandle, conn: &RcConnection, account_id: &str) -> Result<Vec<Value>, String> {
    let info = link_info(app, account_id).ok_or_else(|| "no Dropbox link info".to_string())?;
    let token = crate::drive::dropbox_access_token(conn, &info.base)?;

    let mut out = Vec::new();
    let mut resp = api_post(
        &token,
        LIST_FOLDER,
        &json!({
            "path": "",
            "shared_link": { "url": info.url },
            "recursive": true,
            "include_deleted": false,
            "include_mounted_folders": true,
            "include_non_downloadable_files": true
        }),
    )?;
    loop {
        if let Some(entries) = resp.get("entries").and_then(|e| e.as_array()) {
            for e in entries {
                if let Some(v) = map_entry(e) {
                    out.push(v);
                }
            }
        }
        if !resp.get("has_more").and_then(|h| h.as_bool()).unwrap_or(false) {
            break;
        }
        let cursor = resp
            .get("cursor")
            .and_then(|c| c.as_str())
            .ok_or_else(|| "list_folder: missing cursor".to_string())?
            .to_string();
        resp = api_post(&token, LIST_FOLDER_CONTINUE, &json!({ "cursor": cursor }))?;
    }
    Ok(out)
}

/// Stream one file from the shared link to `dest_file`, updating `transferred`
/// and honoring `cancelled`. Writes to a `.fdmpart` temp then renames on success.
/// If a fully-downloaded file already exists (size matches `expected`), it's
/// skipped — this is what makes a resumed folder download continue where it left
/// off instead of re-pulling completed files.
fn download_one(token: &str, url: &str, sub_path: &str, dest_file: &Path, expected: i64, h: &NativeHandles) -> Result<(), String> {
    if expected > 0 {
        if let Ok(meta) = std::fs::metadata(dest_file) {
            if meta.len() == expected as u64 {
                h.transferred.fetch_add(expected, Ordering::SeqCst);
                return Ok(());
            }
        }
    }
    if let Some(parent) = dest_file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // For a file that IS the link, omit path; for a file inside a shared folder,
    // pass its path within the folder (leading '/').
    let arg = if sub_path.is_empty() {
        json!({ "url": url })
    } else {
        json!({ "url": url, "path": format!("/{}", sub_path.trim_start_matches('/')) })
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(None) // large footage files take a long time
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .post(GET_FILE)
        .bearer_auth(token)
        .header("Dropbox-API-Arg", serde_json::to_string(&arg).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("get_shared_link_file {status}: {body}"));
    }

    let mut tmp = dest_file.as_os_str().to_owned();
    tmp.push(".fdmpart");
    let tmp = PathBuf::from(tmp);
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20]; // 1 MiB
    loop {
        if h.cancelled.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return Err("cancelled".into());
        }
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        h.transferred.fetch_add(n as i64, Ordering::SeqCst);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, dest_file).map_err(|e| e.to_string())
}

/// Worker body for one queued item (a file or a whole folder).
fn run_job(app: AppHandle, conn: RcConnection, account_id: String, item: DownloadItem, dest: String, h: NativeHandles) {
    let result = (|| -> Result<(), String> {
        let info = link_info(&app, &account_id).ok_or_else(|| "no Dropbox link info".to_string())?;
        let token = crate::drive::dropbox_access_token(&conn, &info.base)?;
        let dest_root = Path::new(&dest);

        if item.is_dir {
            // Enumerate every file under the selected folder and pull each one,
            // preserving the directory structure beneath dest/<folder name>/.
            let entries = list_entries(&app, &conn, &account_id)?;
            let prefix = format!("{}/", item.path);
            for e in &entries {
                if h.cancelled.load(Ordering::SeqCst) {
                    return Err("cancelled".into());
                }
                if e.get("IsDir").and_then(|b| b.as_bool()).unwrap_or(false) {
                    continue;
                }
                let p = e.get("Path").and_then(|p| p.as_str()).unwrap_or("");
                if p != item.path && !p.starts_with(&prefix) {
                    continue;
                }
                let esize = e.get("Size").and_then(|s| s.as_i64()).unwrap_or(0);
                let rel = p.strip_prefix(&prefix).unwrap_or(p);
                let dest_file = dest_root.join(&item.name).join(rel);
                download_one(&token, &info.url, p, &dest_file, esize, &h)?;
            }
        } else {
            let dest_file = dest_root.join(&item.name);
            download_one(&token, &info.url, &item.path, &dest_file, item.size, &h)?;
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

/// Queue native downloads for a Dropbox link; returns the created job statuses.
/// Each item runs on its own thread (the frontend queue controls concurrency by
/// only calling this for as many items as it wants running at once).
pub fn start_link_download(
    app: AppHandle,
    conn: RcConnection,
    native: &NativeJobsState,
    account_id: String,
    items: Vec<DownloadItem>,
    dest: String,
) -> Result<Vec<JobStatus>, String> {
    let mut created = Vec::with_capacity(items.len());
    for item in items {
        let total = item.size.max(0);
        let handles = native.create(&account_id, &item.name, &dest, total);
        created.push(JobStatus {
            job_id: handles.job_id,
            account_id: account_id.clone(),
            name: item.name.clone(),
            dest: dest.clone(),
            total_bytes: total,
            bytes: 0,
            speed: 0.0,
            eta: None,
            finished: false,
            success: false,
            cancelled: false,
            error: String::new(),
        });
        let app = app.clone();
        let conn = conn.clone();
        let account_id = account_id.clone();
        let dest = dest.clone();
        std::thread::spawn(move || run_job(app, conn, account_id, item, dest, handles));
    }
    Ok(created)
}

/// Add a Dropbox shared-folder link as a browseable account. Reuses a connected
/// Dropbox account's token (no extra sign-in, nothing copied into your Dropbox).
#[tauri::command]
pub fn add_dropbox_link(
    app: AppHandle,
    rclone: tauri::State<RcloneState>,
    base_account_id: String,
    label: String,
    url: String,
) -> Result<Account, String> {
    if parse_remote(&base_account_id).map(|a| a.provider) != Some("dropbox".to_string()) {
        return Err("base account must be a Dropbox account".into());
    }
    let url = url.trim().to_string();
    if !url.contains("dropbox.com") {
        return Err("not a Dropbox share link".into());
    }
    let conn = rclone
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;

    // Fail fast: verify the borrowed token can actually resolve the link.
    let token = crate::drive::dropbox_access_token(&conn, &base_account_id)?;
    api_post(&token, GET_METADATA, &json!({ "url": url }))
        .map_err(|e| format!("couldn't open that link: {e}"))?;

    let remote = remote_name("dropboxlink", &label);
    let mut store = load_store(&app);
    store.insert(remote.clone(), LinkInfo { url, base: base_account_id });
    save_store(&app, &store)?;
    parse_remote(&remote).ok_or_else(|| format!("bad remote name: {remote}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_file_and_folder_entries_root_relative() {
        let folder = json!({ ".tag": "folder", "name": "Sub", "path_display": "/Sub" });
        let v = map_entry(&folder).unwrap();
        assert_eq!(v["Path"], "Sub");
        assert_eq!(v["IsDir"], true);
        assert_eq!(v["Size"], -1);

        let file = json!({
            ".tag": "file", "name": "clip.mxf", "path_display": "/Sub/clip.mxf",
            "size": 1234, "server_modified": "2026-01-02T03:04:05Z"
        });
        let v = map_entry(&file).unwrap();
        assert_eq!(v["Path"], "Sub/clip.mxf");
        assert_eq!(v["IsDir"], false);
        assert_eq!(v["Size"], 1234);
        assert_eq!(v["ModTime"], "2026-01-02T03:04:05Z");
    }

    #[test]
    fn skips_root_and_unknown_tags() {
        // Root itself (empty path) is dropped.
        assert!(map_entry(&json!({ ".tag": "folder", "name": "", "path_display": "/" })).is_none());
        // Deleted/other tags are dropped.
        assert!(map_entry(&json!({ ".tag": "deleted", "name": "x", "path_display": "/x" })).is_none());
    }
}

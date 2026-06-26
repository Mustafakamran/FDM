//! Live, server-side Search + Recent — the "like the web" path.
//!
//! Instead of crawling an entire (multi-TB, shared-with-me) account into a local
//! index, ask the provider directly, exactly like the Drive/Dropbox web UI does:
//!   • Drive  — `files.list(q="name contains '<q>'")` for search; `orderBy=
//!     modifiedTime desc` for Recent.
//!   • Dropbox — `files/search_v2` for search.
//! Results come back in the same PascalCase shape as `operations/list` (RcItem),
//! so the frontend renders them with zero special-casing, and they're returned in
//! a blink regardless of account size — no indexing.

use crate::accounts::parse_remote;
use crate::rclone::supervisor::{RcConnection, RcloneState};
use serde_json::{json, Value};
use tauri::Manager;

const DRIVE_FILES: &str = "https://www.googleapis.com/drive/v3/files";
const DROPBOX_SEARCH: &str = "https://api.dropboxapi.com/2/files/search_v2";

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// Percent-encode a URL query component.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn drive_q_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Map a Drive file resource → the RcItem shape the frontend expects.
fn drive_item(f: &Value) -> Option<Value> {
    let name = f.get("name").and_then(|x| x.as_str())?.to_string();
    let id = f.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let is_dir = f.get("mimeType").and_then(|x| x.as_str()) == Some("application/vnd.google-apps.folder");
    let size = f.get("size").and_then(|x| x.as_str()).and_then(|s| s.parse::<i64>().ok()).unwrap_or(-1);
    let modified = f.get("modifiedTime").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mime = f.get("mimeType").and_then(|x| x.as_str()).unwrap_or("").to_string();
    // Path isn't returned by name-search; the name is what the row shows. Drive is
    // id-addressed, so navigation/download keys off ID, not a reconstructed path.
    Some(json!({ "Name": name, "Path": name, "Size": size, "IsDir": is_dir, "ModTime": modified, "MimeType": mime, "ID": id }))
}

/// Run a Drive `files.list` and return RcItems. `extra` is appended to the query
/// string (e.g. an `orderBy`); `q` is the Drive query expression (may be empty).
fn drive_list(c: &reqwest::blocking::Client, token: &str, q: &str, extra: &str) -> Result<Vec<Value>, String> {
    let mut url = format!(
        "{DRIVE_FILES}?corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true\
         &pageSize=100&fields=files(id,name,mimeType,size,modifiedTime)"
    );
    if !q.is_empty() {
        url.push_str(&format!("&q={}", enc(q)));
    }
    url.push_str(extra);
    let resp = c.get(&url).bearer_auth(token).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let s = resp.status();
        return Err(format!("drive files.list {s}: {}", resp.text().unwrap_or_default().chars().take(200).collect::<String>()));
    }
    let v: Value = resp.json().map_err(|e| e.to_string())?;
    Ok(v.get("files").and_then(|f| f.as_array()).map(|a| a.iter().filter_map(drive_item).collect()).unwrap_or_default())
}

/// Map a Dropbox search match → RcItem.
fn dropbox_item(m: &Value) -> Option<Value> {
    let md = m.get("metadata").and_then(|x| x.get("metadata"))?;
    let tag = md.get(".tag").and_then(|t| t.as_str()).unwrap_or("");
    let is_dir = tag == "folder";
    let name = md.get("name").and_then(|x| x.as_str())?.to_string();
    let path = md
        .get("path_display")
        .and_then(|x| x.as_str())
        .or_else(|| md.get("path_lower").and_then(|x| x.as_str()))
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string();
    let size = md.get("size").and_then(|x| x.as_i64()).unwrap_or(-1);
    let modified = md.get("server_modified").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let id = md.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(json!({ "Name": name, "Path": path, "Size": size, "IsDir": is_dir, "ModTime": modified, "MimeType": "", "ID": id }))
}

fn dropbox_search(c: &reqwest::blocking::Client, token: &str, query: &str) -> Result<Vec<Value>, String> {
    let body = json!({ "query": query, "options": { "file_status": "active", "filename_only": true, "max_results": 100 } });
    let resp = c
        .post(DROPBOX_SEARCH)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let s = resp.status();
        return Err(format!("dropbox search_v2 {s}: {}", resp.text().unwrap_or_default().chars().take(200).collect::<String>()));
    }
    let v: Value = resp.json().map_err(|e| e.to_string())?;
    Ok(v.get("matches").and_then(|m| m.as_array()).map(|a| a.iter().filter_map(dropbox_item).collect()).unwrap_or_default())
}

fn conn(app: &tauri::AppHandle) -> Result<RcConnection, String> {
    app.state::<RcloneState>()
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())
}

/// Live search of one account by name. Drive: name-contains across all corpora;
/// Dropbox: filename search_v2. Returns RcItems (files + folders).
#[tauri::command]
pub fn account_search(app: tauri::AppHandle, account_id: String, query: String) -> Result<Vec<Value>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let conn = conn(&app)?;
    let provider = parse_remote(&account_id).map(|a| a.provider).unwrap_or_default();
    let c = client();
    match provider.as_str() {
        "drive" => {
            let token = crate::drive::drive_access_token(&conn, &account_id)?;
            let dq = format!("name contains '{}' and trashed = false", drive_q_escape(q));
            drive_list(&c, &token, &dq, "")
        }
        "dropbox" => {
            let token = crate::drive::dropbox_access_token(&conn, &account_id)?;
            dropbox_search(&c, &token, q)
        }
        _ => Ok(vec![]),
    }
}

/// Recent files for one account, newest first — server-side, no crawl. Drive uses
/// `orderBy=modifiedTime desc`. Dropbox has no cheap "recent" endpoint, so it
/// returns empty (the UI falls back to a hint).
#[tauri::command]
pub fn account_recent(app: tauri::AppHandle, account_id: String) -> Result<Vec<Value>, String> {
    let conn = conn(&app)?;
    let provider = parse_remote(&account_id).map(|a| a.provider).unwrap_or_default();
    let c = client();
    match provider.as_str() {
        "drive" => {
            let token = crate::drive::drive_access_token(&conn, &account_id)?;
            drive_list(&c, &token, "trashed = false and mimeType != 'application/vnd.google-apps.folder'", "&orderBy=modifiedTime%20desc")
        }
        _ => Ok(vec![]),
    }
}

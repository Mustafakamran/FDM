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
pub async fn account_search(app: tauri::AppHandle, account_id: String, query: String) -> Result<Vec<Value>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let conn = conn(&app)?;
    // The provider HTTP call blocks up to 30s; run it on the blocking-thread
    // pool so typing a search never freezes the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let provider = parse_remote(&account_id).map(|a| a.provider).unwrap_or_default();
        let c = client();
        match provider.as_str() {
            "drive" => {
                let token = crate::drive::drive_access_token(&conn, &account_id)?;
                let dq = format!("name contains '{}' and trashed = false", drive_q_escape(&q));
                drive_list(&c, &token, &dq, "")
            }
            "dropbox" => {
                let token = crate::drive::dropbox_access_token(&conn, &account_id)?;
                dropbox_search(&c, &token, &q)
            }
            _ => Ok(vec![]),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Recent files for one account, newest first — server-side, no crawl. Drive uses
/// `orderBy=modifiedTime desc`. Dropbox has no cheap "recent" endpoint, so it
/// returns empty (the UI falls back to a hint).
#[tauri::command]
pub async fn account_recent(app: tauri::AppHandle, account_id: String) -> Result<Vec<Value>, String> {
    let conn = conn(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let provider = parse_remote(&account_id).map(|a| a.provider).unwrap_or_default();
        let c = client();
        match provider.as_str() {
            "drive" => {
                let token = crate::drive::drive_access_token(&conn, &account_id)?;
                drive_list(&c, &token, "trashed = false and mimeType != 'application/vnd.google-apps.folder'", "&orderBy=modifiedTime%20desc")
            }
            _ => Ok(vec![]),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Enumerate every connected account (rclone remotes + Dropbox shared-links),
/// mirroring `accounts::list_accounts` so all-drives search sees the same set.
fn all_accounts(conn: &RcConnection, app: &tauri::AppHandle) -> Vec<crate::accounts::Account> {
    let mut accounts: Vec<crate::accounts::Account> = Vec::new();
    if let Ok(resp) = crate::rclone::supervisor::rc_post(conn, "config/listremotes", &json!({})) {
        if let Some(arr) = resp.get("remotes").and_then(|v| v.as_array()) {
            for name in arr.iter().filter_map(|v| v.as_str()) {
                if let Some(a) = parse_remote(name) {
                    accounts.push(a);
                }
            }
        }
    }
    accounts.extend(crate::dropbox::link_accounts(app));
    accounts
}

/// Search a single account and tag each result with its origin account so the
/// UI can show a drive badge and navigate cross-account. Errors are the
/// caller's to isolate (one dead account must not blank the whole result).
fn search_one(conn: &RcConnection, account_id: &str, provider: &str, q: &str) -> Result<Vec<Value>, String> {
    let c = client();
    let mut items = match provider {
        "drive" => {
            let token = crate::drive::drive_access_token(conn, account_id)?;
            let dq = format!("name contains '{}' and trashed = false", drive_q_escape(q));
            drive_list(&c, &token, &dq, "")?
        }
        "dropbox" => {
            let token = crate::drive::dropbox_access_token(conn, account_id)?;
            dropbox_search(&c, &token, q)?
        }
        _ => Vec::new(),
    };
    for it in items.iter_mut() {
        if let Some(obj) = it.as_object_mut() {
            obj.insert("AccountId".to_string(), json!(account_id));
            obj.insert("Provider".to_string(), json!(provider));
        }
    }
    Ok(items)
}

/// Live search across ALL connected drives at once. Fans out one blocking
/// provider search per account onto its own thread and merges the tagged
/// results — so it's as fast as the slowest single drive, not their sum, and a
/// failing drive is skipped rather than failing the whole query.
#[tauri::command]
pub async fn search_all_accounts(app: tauri::AppHandle, query: String) -> Result<Vec<Value>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let conn = conn(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Cap concurrent OS threads so a user with very many accounts can't hit
        // the thread limit; fan out in chunks and merge each chunk's results.
        const MAX_SEARCH_THREADS: usize = 12;
        let accounts = all_accounts(&conn, &app);
        let mut out: Vec<Value> = Vec::new();
        for chunk in accounts.chunks(MAX_SEARCH_THREADS) {
            let mut handles = Vec::with_capacity(chunk.len());
            for acct in chunk {
                let conn = conn.clone();
                let q = q.clone();
                let id = acct.id.clone();
                let provider = acct.provider.clone();
                handles.push(std::thread::spawn(move || {
                    search_one(&conn, &id, &provider, &q).unwrap_or_default()
                }));
            }
            for h in handles {
                if let Ok(items) = h.join() {
                    out.extend(items);
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

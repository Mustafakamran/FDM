//! BDM "locate" command — read-only.
//!
//! Given a project's client/couple name, find where it ALREADY lives across
//! FDM's *own* connected accounts (the real `drive_*` / `dropbox_*` remotes the
//! user signed into), matched by folder name. No download, no account selection —
//! purely informational so the BDM project card can show "this already lives
//! here + here". On-demand only (driven by a `locate` command), so we never crawl.
//!
//! Drive: `files.list(q="name contains '<term>' and mimeType=folder", allDrives)`.
//! Dropbox: `files/search_v2` (folders). Matches couple OR client, normalized
//! (case / spaces / `&`↔`and`). Results POST back to `/api/project-locations`.

use crate::accounts::parse_remote;
use crate::rclone::supervisor::{rc_post, RcConnection};
use serde_json::{json, Value};
use std::collections::HashMap;

const DRIVE_FILES: &str = "https://www.googleapis.com/drive/v3/files";
const DROPBOX_SEARCH: &str = "https://api.dropboxapi.com/2/files/search_v2";
/// Cap the Drive parent-walk so a deeply nested folder can't spin forever.
const MAX_PATH_DEPTH: usize = 12;

/// Collapse a name to a match key: lowercase, `&`→`and`, keep `[a-z0-9]` only
/// (drops spaces/punctuation). So "Tom & Jerry" and "Tom and Jerry" both →
/// "tomandjerry", making the comparison robust to case / spacing / `&`.
pub fn match_key(s: &str) -> String {
    s.to_lowercase()
        .replace('&', " and ")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

/// Does `name` contain the search `term` after normalization? Empty term → false.
fn name_matches(name: &str, term: &str) -> bool {
    let t = match_key(term);
    !t.is_empty() && match_key(name).contains(&t)
}

/// Which of (couple, client) a folder name matched, as a label for the card.
/// `couple` wins when both match (it's the more specific leaf name).
fn matched_on(name: &str, couple: &str, client: &str) -> Option<&'static str> {
    if name_matches(name, couple) {
        Some("couple_name")
    } else if name_matches(name, client) {
        Some("client_name")
    } else {
        None
    }
}

// ─── Google Drive ────────────────────────────────────────────────────────────

/// Escape a value for use inside a Drive `q` single-quoted string literal.
fn drive_q_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Percent-encode for a URL query component.
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

/// Build the Drive `q` for "any of `terms` as a folder, not trashed".
fn drive_query(terms: &[&str]) -> String {
    let ors: Vec<String> = terms
        .iter()
        .filter(|t| !t.trim().is_empty())
        .map(|t| format!("name contains '{}'", drive_q_escape(t)))
        .collect();
    format!(
        "({}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        ors.join(" or ")
    )
}

/// One folder hit from a Drive name search.
struct DriveHit {
    id: String,
    name: String,
    parents: Vec<String>,
}

fn drive_search(c: &reqwest::blocking::Client, token: &str, terms: &[&str]) -> Result<Vec<DriveHit>, String> {
    let q = drive_query(terms);
    let url = format!(
        "{DRIVE_FILES}?corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true\
         &pageSize=100&fields=files(id,name,parents)&q={}",
        enc(&q)
    );
    let resp = c.get(&url).bearer_auth(token).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("drive files.list {status}: {}", resp.text().unwrap_or_default().chars().take(200).collect::<String>()));
    }
    let v: Value = resp.json().map_err(|e| e.to_string())?;
    let files = v.get("files").and_then(|f| f.as_array()).cloned().unwrap_or_default();
    Ok(files
        .iter()
        .filter_map(|f| {
            let id = f.get("id").and_then(|x| x.as_str())?.to_string();
            let name = f.get("name").and_then(|x| x.as_str())?.to_string();
            let parents = f
                .get("parents")
                .and_then(|p| p.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            Some(DriveHit { id, name, parents })
        })
        .collect())
}

/// Best-effort absolute-ish path for a Drive folder by walking parents upward.
/// Falls back to `/<name>` if a lookup fails. `cache` maps id → (name, parent).
fn drive_path(
    c: &reqwest::blocking::Client,
    token: &str,
    name: &str,
    first_parent: Option<&str>,
    cache: &mut HashMap<String, (String, Option<String>)>,
) -> String {
    let mut segs = vec![name.to_string()];
    let mut cur = first_parent.map(String::from);
    let mut depth = 0;
    while let Some(id) = cur {
        if depth >= MAX_PATH_DEPTH {
            break;
        }
        depth += 1;
        let (pname, pparent) = match cache.get(&id) {
            Some(hit) => hit.clone(),
            None => {
                let url = format!("{DRIVE_FILES}/{id}?fields=name,parents&supportsAllDrives=true");
                let fetched = c
                    .get(&url)
                    .bearer_auth(token)
                    .send()
                    .ok()
                    .filter(|r| r.status().is_success())
                    .and_then(|r| r.json::<Value>().ok());
                let Some(v) = fetched else { break };
                let pname = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let pparent = v
                    .get("parents")
                    .and_then(|p| p.as_array())
                    .and_then(|a| a.first())
                    .and_then(|x| x.as_str())
                    .map(String::from);
                cache.insert(id.clone(), (pname.clone(), pparent.clone()));
                (pname, pparent)
            }
        };
        // The Drive root reports a synthetic parent (the drive id) with an empty
        // name; stop there rather than prepending a blank segment.
        if pname.is_empty() {
            break;
        }
        segs.push(pname);
        cur = pparent;
    }
    segs.reverse();
    format!("/{}", segs.join("/"))
}

// ─── Dropbox ─────────────────────────────────────────────────────────────────

/// One folder hit from a Dropbox name search.
struct DropboxHit {
    id: String,
    name: String,
    path: String,
}

fn dropbox_search(c: &reqwest::blocking::Client, token: &str, term: &str) -> Result<Vec<DropboxHit>, String> {
    let body = json!({
        "query": term,
        "options": { "file_status": "active", "filename_only": true, "max_results": 100 }
    });
    let resp = c
        .post(DROPBOX_SEARCH)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("dropbox search_v2 {status}: {}", resp.text().unwrap_or_default().chars().take(200).collect::<String>()));
    }
    let v: Value = resp.json().map_err(|e| e.to_string())?;
    let matches = v.get("matches").and_then(|m| m.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for m in &matches {
        // matches[].metadata.metadata = the actual entry (FileMetadata/FolderMetadata).
        let md = m.get("metadata").and_then(|x| x.get("metadata"));
        let Some(md) = md else { continue };
        if md.get(".tag").and_then(|t| t.as_str()) != Some("folder") {
            continue; // folders only — that's where a project lives
        }
        let id = md.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let name = md.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let path = md
            .get("path_display")
            .and_then(|x| x.as_str())
            .or_else(|| md.get("path_lower").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        if !name.is_empty() {
            out.push(DropboxHit { id, name, path });
        }
    }
    Ok(out)
}

// ─── orchestration ───────────────────────────────────────────────────────────

/// Search every connected account for folders matching the couple/client name.
/// Returns location records ready to POST to `/api/project-locations`. Per-account
/// failures (token refresh, API error) are swallowed so one bad account doesn't
/// sink the rest; only a failure to enumerate accounts is fatal.
pub fn find_locations(
    conn: &RcConnection,
    c: &reqwest::blocking::Client,
    project_id: &str,
    client_name: &str,
    couple_name: &str,
) -> Result<Vec<Value>, String> {
    let terms: Vec<&str> = [couple_name, client_name]
        .into_iter()
        .filter(|t| !t.trim().is_empty())
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }

    let remotes = rc_post(conn, "config/listremotes", &json!({}))?;
    let ids: Vec<String> = remotes
        .get("remotes")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut records = Vec::new();
    for id in ids {
        // Only the user's real signed-in accounts — not transient `*link_*` roots.
        let Some(acct) = parse_remote(&id) else { continue };
        let is_real = id.starts_with("drive_") || id.starts_with("dropbox_");
        if !is_real {
            continue;
        }
        match acct.provider.as_str() {
            "drive" => {
                let Ok(token) = crate::drive::drive_access_token(conn, &id) else { continue };
                let email = crate::drive::drive_email(conn, &id).ok().flatten();
                let hits = match drive_search(c, &token, &terms) {
                    Ok(h) => h,
                    Err(e) => {
                        eprintln!("locate: drive search {id} failed: {e}");
                        continue;
                    }
                };
                let mut cache = HashMap::new();
                for h in hits {
                    let Some(m) = matched_on(&h.name, couple_name, client_name) else { continue };
                    let path = drive_path(c, &token, &h.name, h.parents.first().map(String::as_str), &mut cache);
                    records.push(json!({
                        "project_id": project_id,
                        "provider": "google_drive",
                        "account_email": email,
                        "account_label": acct.label,
                        "path": path,
                        "item_id": h.id,
                        "matched_on": m,
                    }));
                }
            }
            "dropbox" => {
                let Ok(token) = crate::drive::dropbox_access_token(conn, &id) else { continue };
                let email = crate::drive::dropbox_email(conn, &id).ok().flatten();
                // search_v2 takes one query string; search each term, dedupe by id.
                let mut seen = std::collections::HashSet::new();
                for term in &terms {
                    let hits = match dropbox_search(c, &token, term) {
                        Ok(h) => h,
                        Err(e) => {
                            eprintln!("locate: dropbox search {id} failed: {e}");
                            continue;
                        }
                    };
                    for h in hits {
                        let Some(m) = matched_on(&h.name, couple_name, client_name) else { continue };
                        if !seen.insert(h.id.clone()) {
                            continue;
                        }
                        records.push(json!({
                            "project_id": project_id,
                            "provider": "dropbox",
                            "account_email": email,
                            "account_label": acct.label,
                            "path": h.path,
                            "item_id": h.id,
                            "matched_on": m,
                        }));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_key_normalizes_case_space_amp() {
        assert_eq!(match_key("Tom & Jerry"), "tomandjerry");
        assert_eq!(match_key("Tom and Jerry"), "tomandjerry");
        assert_eq!(match_key("  Couple A 2026 "), "couplea2026");
        assert_eq!(match_key("!!!"), "");
    }

    #[test]
    fn name_matches_is_normalized_substring() {
        assert!(name_matches("Smith & Jones Wedding", "smith and jones"));
        assert!(name_matches("CoupleA-Final", "Couple A"));
        assert!(!name_matches("Unrelated", "Couple A"));
        assert!(!name_matches("anything", "")); // empty term never matches
    }

    #[test]
    fn matched_on_prefers_couple() {
        // Couple name is the more specific leaf, so it wins when both are present.
        assert_eq!(matched_on("Tom & Jerry (ACME)", "Tom & Jerry", "ACME"), Some("couple_name"));
        assert_eq!(matched_on("ACME Weddings", "Tom & Jerry", "ACME"), Some("client_name"));
        assert_eq!(matched_on("Random", "Tom & Jerry", "ACME"), None);
    }

    #[test]
    fn drive_query_builds_or_folder_filter() {
        let q = drive_query(&["Tom's Wedding", "ACME"]);
        assert!(q.contains("name contains 'Tom\\'s Wedding'"));
        assert!(q.contains("name contains 'ACME'"));
        assert!(q.contains("mimeType = 'application/vnd.google-apps.folder'"));
        assert!(q.contains("trashed = false"));
    }
}

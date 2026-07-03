//! Native Google Drive API helpers — used only to resolve an uploader's display
//! name, which rclone does not expose. Reads the account's OAuth token + client
//! credentials from rclone's config (`config/dump`), refreshes the access token,
//! and queries the Drive `files.get` endpoint. Best-effort: any failure yields
//! `None` so notifications still work without the name.

use crate::rclone::supervisor::{rc_post, RcConnection, RcloneState};
use serde_json::Value;

/// Pull `token`, `client_id`, `client_secret` for a remote out of `config/dump`.
pub(crate) fn remote_creds(dump: &Value, remote: &str) -> Option<(String, String, String)> {
    let cfg = dump.get(remote)?;
    let token = cfg.get("token").and_then(|v| v.as_str())?.to_string();
    let client_id = cfg.get("client_id").and_then(|v| v.as_str())?.to_string();
    let client_secret = cfg.get("client_secret").and_then(|v| v.as_str())?.to_string();
    Some((token, client_id, client_secret))
}

/// rclone stores the OAuth token as a JSON string; pull the refresh token out.
fn refresh_token_from(token_json: &str) -> Option<String> {
    let v: Value = serde_json::from_str(token_json).ok()?;
    v.get("refresh_token").and_then(|t| t.as_str()).map(|s| s.to_string())
}

/// Prefer the last modifier's name, else the first owner's name.
fn name_from_drive_file(v: &Value) -> Option<String> {
    let last = v
        .get("lastModifyingUser")
        .and_then(|u| u.get("displayName"))
        .and_then(|d| d.as_str());
    let owner = v
        .get("owners")
        .and_then(|o| o.as_array())
        .and_then(|a| a.first())
        .and_then(|o| o.get("displayName"))
        .and_then(|d| d.as_str());
    last.or(owner).map(|s| s.to_string())
}

/// Percent-encode a value for an x-www-form-urlencoded body.
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

/// Exchange a refresh token for a fresh access token at the given OAuth endpoint.
fn refresh_at(endpoint: &str, client_id: &str, client_secret: &str, refresh_token: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let body = format!(
        "client_id={}&client_secret={}&refresh_token={}&grant_type=refresh_token",
        enc(client_id),
        enc(client_secret),
        enc(refresh_token),
    );
    let resp = client
        .post(endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|e| e.to_string())?;
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v.get("access_token")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("no access_token in refresh response: {text}"))
}

/// Exchange a Google Drive account's stored refresh token for a fresh access
/// token. Works for `drive_*` and `drivelink_*` (both have rclone config creds).
/// Reused by the streaming proxy.
pub(crate) fn drive_access_token(conn: &RcConnection, account_id: &str) -> Result<String, String> {
    let dump = rc_post(conn, "config/dump", &serde_json::json!({}))?;
    let (token_json, client_id, client_secret) =
        remote_creds(&dump, account_id).ok_or_else(|| format!(
            "This account isn't fully authorized (no saved sign-in for {account_id}). \
             Reconnect it: remove the account and add it again, finish the sign-in in the \
             browser, and make sure your OAuth client ID + secret are set in Settings."
        ))?;
    let refresh = refresh_token_from(&token_json).ok_or_else(|| "no refresh token".to_string())?;
    refresh_at("https://oauth2.googleapis.com/token", &client_id, &client_secret, &refresh)
}

/// Resolve a Drive file/folder id to the SAME path rclone would list it at, by
/// walking `parents` up from the item.
///
/// Live Drive search (`files.list name contains`) returns no path — a hit only
/// carries its id + bare name — so opening or downloading a non-root FOLDER hit
/// needs the real path reconstructed. Drive itself has no path (a node can have
/// several parents), but rclone picks the first-parent chain, and so do we:
///   • My Drive owned folders → walk until a parent has no parents (the root),
///     which we stop before adding → e.g. "Projects/Client/Renders".
///   • Shared-with-me folders → the walk hits the share boundary when
///     `files.get` on the owner's ancestor above the shared root returns 403/404;
///     we stop there, which yields exactly rclone's shared_with_me mount path
///     (the shared folder sits at the root by its name) → e.g. "Footage/RAW".
/// Returns the account-root-relative path (no leading slash).
#[tauri::command]
pub async fn drive_folder_path(
    rclone: tauri::State<'_, RcloneState>,
    account_id: String,
    file_id: String,
) -> Result<String, String> {
    let conn: RcConnection = rclone
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let access = drive_access_token(&conn, &account_id)?;
        let client = reqwest::blocking::Client::new();
        // Walk first-parent chain, newest (deepest) first; bounded so a pathological
        // parent cycle can't loop forever.
        let mut names: Vec<String> = Vec::new();
        let mut cur = file_id;
        for _ in 0..64 {
            let url = format!(
                "https://www.googleapis.com/drive/v3/files/{cur}?fields=name,parents&supportsAllDrives=true"
            );
            let resp = client.get(&url).bearer_auth(&access).send().map_err(|e| e.to_string())?;
            // A non-success (typically 404/403 on an owner's ancestor above a
            // shared root) is the natural stop signal — we've walked as high as
            // this account can see, which is where rclone roots the path.
            if !resp.status().is_success() {
                break;
            }
            let v: Value = resp.json().map_err(|e| e.to_string())?;
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let parents = v.get("parents").and_then(|p| p.as_array());
            match parents.and_then(|a| a.first()).and_then(|x| x.as_str()) {
                // Has a parent → this node is a real path segment; record it and climb.
                Some(parent) => {
                    if !name.is_empty() {
                        names.push(name);
                    }
                    cur = parent.to_string();
                }
                // No parents → `cur` is My Drive's root; don't add "My Drive".
                None => break,
            }
        }
        names.reverse();
        Ok(names.join("/"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Query Drive for a file's uploader/owner display name. Returns Ok(None) when
/// unavailable (e.g. no name on the record); Err only on hard failures.
#[tauri::command]
pub async fn drive_uploader(
    rclone: tauri::State<'_, RcloneState>,
    account_id: String,
    file_id: String,
) -> Result<Option<String>, String> {
    let conn: RcConnection = rclone
        .connection
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "rclone not started".to_string())?;

    // Token refresh + Drive files.get are all blocking HTTP — run off the main
    // thread so opening a download's detail never stalls the UI.
    tauri::async_runtime::spawn_blocking(move || {
        let dump = rc_post(&conn, "config/dump", &serde_json::json!({}))?;
        let (token_json, client_id, client_secret) =
            remote_creds(&dump, &account_id).ok_or_else(|| format!(
                "This account isn't fully authorized (no saved sign-in for {account_id}). \
                 Reconnect it: remove the account and add it again, finish the sign-in in the \
                 browser, and make sure your OAuth client ID + secret are set in Settings."
            ))?;
        let refresh = refresh_token_from(&token_json).ok_or_else(|| "no refresh token".to_string())?;
        let access = refresh_at("https://oauth2.googleapis.com/token", &client_id, &client_secret, &refresh)?;

        let client = reqwest::blocking::Client::new();
        let url = format!(
            "https://www.googleapis.com/drive/v3/files/{file_id}?fields=owners(displayName),lastModifyingUser(displayName)&supportsAllDrives=true"
        );
        let resp = client
            .get(&url)
            .bearer_auth(&access)
            .send()
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().unwrap_or_default();
            return Err(format!("drive files.get {status}: {body}"));
        }
        let text = resp.text().map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(name_from_drive_file(&v))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The Drive account's email via the native about endpoint (rclone doesn't
/// expose it). Best-effort: Err/None when unavailable.
pub fn drive_email(conn: &RcConnection, account_id: &str) -> Result<Option<String>, String> {
    let dump = rc_post(conn, "config/dump", &serde_json::json!({}))?;
    let (token_json, client_id, client_secret) =
        remote_creds(&dump, account_id).ok_or_else(|| format!(
            "This account isn't fully authorized (no saved sign-in for {account_id}). \
             Reconnect it: remove the account and add it again, finish the sign-in in the \
             browser, and make sure your OAuth client ID + secret are set in Settings."
        ))?;
    let refresh = refresh_token_from(&token_json).ok_or_else(|| "no refresh token".to_string())?;
    let access = refresh_at("https://oauth2.googleapis.com/token", &client_id, &client_secret, &refresh)?;

    let client = reqwest::blocking::Client::new();
    let resp = client
        .get("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)")
        .bearer_auth(&access)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("drive about {status}: {body}"));
    }
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("user")
        .and_then(|u| u.get("emailAddress"))
        .and_then(|e| e.as_str())
        .map(|s| s.to_string()))
}

/// Exchange a Dropbox account's stored refresh token for a fresh access token.
/// Reused by the native Dropbox shared-link engine (which has no rclone remote of
/// its own and borrows a connected account's token).
pub(crate) fn dropbox_access_token(conn: &RcConnection, account_id: &str) -> Result<String, String> {
    let dump = rc_post(conn, "config/dump", &serde_json::json!({}))?;
    let (token_json, client_id, client_secret) =
        remote_creds(&dump, account_id).ok_or_else(|| format!(
            "This account isn't fully authorized (no saved sign-in for {account_id}). \
             Reconnect it: remove the account and add it again, finish the sign-in in the \
             browser, and make sure your OAuth client ID + secret are set in Settings."
        ))?;
    let refresh = refresh_token_from(&token_json).ok_or_else(|| "no refresh token".to_string())?;
    refresh_at("https://api.dropboxapi.com/oauth2/token", &client_id, &client_secret, &refresh)
}

/// The Dropbox account's email via the native users/get_current_account endpoint
/// (rclone's `config userinfo` reports "doesn't support UserInfo" for some remotes).
pub fn dropbox_email(conn: &RcConnection, account_id: &str) -> Result<Option<String>, String> {
    let access = dropbox_access_token(conn, account_id)?;

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post("https://api.dropboxapi.com/2/users/get_current_account")
        .bearer_auth(&access)
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!("dropbox get_current_account {status}: {body}"));
    }
    let text = resp.text().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(v.get("email").and_then(|e| e.as_str()).map(|s| s.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_creds_from_dump() {
        let dump = json!({
            "drive_x": { "type": "drive", "token": "{\"refresh_token\":\"R\"}", "client_id": "cid", "client_secret": "csec" }
        });
        let (t, id, sec) = remote_creds(&dump, "drive_x").unwrap();
        assert_eq!(id, "cid");
        assert_eq!(sec, "csec");
        assert_eq!(refresh_token_from(&t).unwrap(), "R");
        assert!(remote_creds(&dump, "missing").is_none());
    }

    #[test]
    fn picks_last_modifier_then_owner() {
        let v = json!({
            "lastModifyingUser": { "displayName": "Alex Editor" },
            "owners": [{ "displayName": "Owner One" }]
        });
        assert_eq!(name_from_drive_file(&v).unwrap(), "Alex Editor");

        let owner_only = json!({ "owners": [{ "displayName": "Owner One" }] });
        assert_eq!(name_from_drive_file(&owner_only).unwrap(), "Owner One");

        assert!(name_from_drive_file(&json!({})).is_none());
    }
}

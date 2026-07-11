//! Provider-agnostic ranged file fetch, shared by the streaming proxy and the
//! resumable downloader. Given an account + a file locator (Drive file id, or a
//! root-relative Dropbox path, or a Dropbox-link sub-path), it issues an HTTP
//! Range request to the right endpoint with a bearer token.

use crate::dropbox;
use crate::rclone::supervisor::RcConnection;
use serde_json::json;
use tauri::AppHandle;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Drive,
    Dropbox,
    DropboxLink,
    /// Generic HTTP(S) URL — no provider, no auth; the `fid` carries the URL.
    Http,
    /// Social/video URL handled by the bundled yt-dlp sidecar; `fid` carries the URL.
    Ytdlp,
    /// WeTransfer share link — the whole transfer is fetched by `wetransfer.rs`;
    /// the account is synthetic and the URL rides in the item's `id`.
    Wetransfer,
    /// Filemail share link — the whole transfer is fetched by `filemail.rs`;
    /// synthetic account, URL in the item's `id`.
    Filemail,
    /// Frame.io public share link — the whole share is fetched by `frameio.rs`
    /// over its GraphQL API; synthetic account, URL in the item's `id`.
    Frameio,
    /// BitTorrent magnet / .torrent, downloaded by the bundled rqbit engine
    /// (`torrent.rs`); synthetic account, the magnet or file path in `id`.
    Torrent,
}

/// Which provider/transport an account id uses.
pub fn kind_of(account_id: &str) -> Kind {
    // The synthetic "ytdlp" / "http" accounts route URL downloads through the
    // engine — check them first so nothing else can claim them. "ytdlp" is tested
    // before "http" because neither prefixes the other, but order keeps intent clear.
    if account_id.starts_with("ytdlp") {
        Kind::Ytdlp
    } else if account_id.starts_with("http") {
        Kind::Http
    } else if account_id.starts_with("wetransfer") {
        Kind::Wetransfer
    } else if account_id.starts_with("filemail") {
        Kind::Filemail
    } else if account_id.starts_with("frameio") {
        Kind::Frameio
    } else if account_id.starts_with("torrent") {
        Kind::Torrent
    } else if account_id.starts_with("dropboxlink_") {
        Kind::DropboxLink
    } else if account_id.starts_with("dropbox_") {
        Kind::Dropbox
    } else {
        // drive_ and drivelink_ both stream from Drive (by file id).
        Kind::Drive
    }
}

/// The account whose OAuth token authorizes this account's fetches, plus the
/// shared-link URL when relevant. Dropbox links borrow their base account's token.
pub fn token_account(app: &AppHandle, account_id: &str) -> (String, String) {
    // Http / ytdlp / transfer shares carry no token-owning account and no
    // shared-link URL.
    if account_id.starts_with("http")
        || account_id.starts_with("ytdlp")
        || account_id.starts_with("wetransfer")
        || account_id.starts_with("filemail")
        || account_id.starts_with("frameio")
        || account_id.starts_with("torrent")
    {
        return (account_id.to_string(), String::new());
    }
    if account_id.starts_with("dropboxlink_") {
        if let Some(info) = dropbox::link_info(app, account_id) {
            return (info.base, info.url);
        }
    }
    (account_id.to_string(), String::new())
}

/// Fetch a fresh access token for the given kind + token-owning account.
pub fn fetch_token(conn: &RcConnection, kind: Kind, token_acct: &str) -> Result<String, String> {
    match kind {
        // Http / ytdlp / transfer shares / torrents need no auth — never rclone.
        Kind::Http | Kind::Ytdlp | Kind::Wetransfer | Kind::Filemail | Kind::Frameio | Kind::Torrent => Ok(String::new()),
        Kind::Drive => crate::drive::drive_access_token(conn, token_acct),
        _ => crate::drive::dropbox_access_token(conn, token_acct),
    }
}

/// Issue a ranged request for one file. `fid` is used for Drive; `path`
/// (root-relative, no leading slash) for Dropbox; `link_url` + `path` for a
/// Dropbox shared link. Inclusive byte range [start, end].
#[allow(clippy::too_many_arguments)]
pub fn send_range(
    client: &reqwest::blocking::Client,
    token: &str,
    kind: Kind,
    fid: &str,
    path: &str,
    link_url: &str,
    start: u64,
    end: u64,
    acknowledge_abuse: bool,
) -> reqwest::Result<reqwest::blocking::Response> {
    let range = format!("bytes={start}-{end}");
    match kind {
        Kind::Drive => {
            let mut url =
                format!("https://www.googleapis.com/drive/v3/files/{fid}?alt=media&supportsAllDrives=true");
            if acknowledge_abuse {
                url.push_str("&acknowledgeAbuse=true");
            }
            client.get(url).bearer_auth(token).header("Range", range).send()
        }
        Kind::Dropbox => client
            .post("https://content.dropboxapi.com/2/files/download")
            .bearer_auth(token)
            .header(
                "Dropbox-API-Arg",
                json!({ "path": format!("/{}", path.trim_start_matches('/')) }).to_string(),
            )
            .header("Range", range)
            .send(),
        Kind::DropboxLink => {
            let arg = if path.is_empty() {
                json!({ "url": link_url })
            } else {
                json!({ "url": link_url, "path": format!("/{}", path.trim_start_matches('/')) })
            };
            client
                .post("https://content.dropboxapi.com/2/sharing/get_shared_link_file")
                .bearer_auth(token)
                .header("Dropbox-API-Arg", arg.to_string())
                .header("Range", range)
                .send()
        }
        // Generic URL: `fid` is the URL. Plain ranged GET, no bearer, no params.
        // Ytdlp and the transfer-share kinds run their own downloaders (never
        // byte-range fetch here); they only reach this arm as a defensive plain
        // GET so the match stays exhaustive.
        Kind::Http | Kind::Ytdlp | Kind::Wetransfer | Kind::Filemail | Kind::Frameio | Kind::Torrent => {
            client.get(fid).header("Range", range).send()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_account_ids() {
        assert_eq!(kind_of("drive_x"), Kind::Drive);
        assert_eq!(kind_of("drivelink_a"), Kind::Drive);
        assert_eq!(kind_of("dropbox_y"), Kind::Dropbox);
        assert_eq!(kind_of("dropboxlink_b"), Kind::DropboxLink);
        assert_eq!(kind_of("http"), Kind::Http);
        assert_eq!(kind_of("ytdlp"), Kind::Ytdlp);
        assert_eq!(kind_of("wetransfer"), Kind::Wetransfer);
        assert_eq!(kind_of("filemail"), Kind::Filemail);
        assert_eq!(kind_of("frameio"), Kind::Frameio);
        assert_eq!(kind_of("torrent"), Kind::Torrent);
    }
}

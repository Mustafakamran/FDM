//! Native MEGA (mega.nz) public-folder downloader.
//!
//! MEGA folders are end-to-end encrypted, so a plain HTTP GET of a share link
//! returns only the web app's HTML (the "2 KB file" users saw). We instead talk
//! MEGA's API: list the folder's node tree, decrypt each node's key + name with
//! the 128-bit folder key carried in the link's `#` fragment, then stream every
//! file and AES-CTR-decrypt it to disk - exactly how the MEGA web client does it,
//! anonymously (no account). rclone's mega backend needs account login and can't
//! open an anonymous folder link, hence this native path (same shape as the
//! WeTransfer / Filemail / Frame.io share downloaders).
//!
//! Crypto, all AES-128 keyed by material derived from the link:
//!   - node keys: AES-ECB(folderKey) of the per-node encrypted key,
//!   - file key:  a32[0..4] XOR a32[4..8] (the 16-byte AES key), nonce = a32[4..6],
//!   - attributes: AES-CBC (zero IV), payload is `MEGA` + JSON `{"n": name}`,
//!   - file data: AES-CTR, counter = nonce(8) || blockIndex(8, big-endian).
//! MAC verification is skipped (it only detects corruption; the plaintext is
//! correct regardless), keeping ranged resume simple.

use crate::download::NativeHandles;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 FDM";
const API: &str = "https://g.api.mega.co.nz/cs";

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// MEGA base64: URL-safe (`-_`), unpadded. Tolerates the standard `+/` too.
fn b64(s: &str) -> Result<Vec<u8>, String> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let norm: String = s.trim().replace('+', "-").replace('/', "_").trim_end_matches('=').to_string();
    URL_SAFE_NO_PAD.decode(norm).map_err(|e| format!("bad mega base64: {e}"))
}

/// Which part of a shared folder the link addresses.
enum Scope {
    All,
    Sub(String),
    File(String),
}

/// Parse `https://mega.nz/folder/<id>#<key>[/folder/<sub>|/file/<fh>]` (and the
/// legacy `#F!<id>!<key>` form) into the folder id, 16-byte folder key, and scope.
fn parse_link(url: &str) -> Result<(String, Vec<u8>, Scope), String> {
    let err = || "Not a MEGA folder link. Expected https://mega.nz/folder/<id>#<key>".to_string();
    // Legacy: https://mega.nz/#F!<id>!<key>
    if let Some(rest) = url.split("#F!").nth(1) {
        let mut it = rest.split('!');
        let id = it.next().ok_or_else(err)?.to_string();
        let key = it.next().ok_or_else(err)?;
        return Ok((id, folder_key(key)?, Scope::All));
    }
    // Modern: .../folder/<id>#<fragment> (note: a sub-link has a 2nd "/folder/"
    // INSIDE the fragment, so split on the FIRST occurrence only).
    let after = url.split_once("/folder/").ok_or_else(err)?.1;
    let (id, frag) = after.split_once('#').ok_or_else(err)?;
    let id = id.trim_matches('/').to_string();
    let parts: Vec<&str> = frag.split('/').collect();
    let key = folder_key(parts[0])?;
    let scope = match (parts.get(1), parts.get(2)) {
        (Some(&"folder"), Some(sub)) => Scope::Sub((*sub).to_string()),
        (Some(&"file"), Some(fh)) => Scope::File((*fh).to_string()),
        _ => Scope::All,
    };
    Ok((id, key, scope))
}

fn folder_key(s: &str) -> Result<Vec<u8>, String> {
    let k = b64(s)?;
    if k.len() < 16 {
        return Err("MEGA folder key is too short (link missing its #key?)".into());
    }
    Ok(k[..16].to_vec())
}

/// AES-ECB decrypt (block-aligned) with a 16-byte key - used to unwrap node keys.
fn aes_ecb_decrypt(key16: &[u8], data: &[u8]) -> Vec<u8> {
    let cipher = Aes128::new(GenericArray::from_slice(key16));
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(16) {
        if chunk.len() < 16 {
            break;
        }
        let mut b = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut b);
        out.extend_from_slice(&b);
    }
    out
}

/// AES-CBC decrypt with a zero IV (MEGA attribute blob), returning the decrypted
/// node name from the `MEGA{...}` payload, if present.
fn decrypt_name(key16: &[u8], attr_b64: &str) -> Option<String> {
    let enc = b64(attr_b64).ok()?;
    let cipher = Aes128::new(GenericArray::from_slice(key16));
    let mut out = Vec::with_capacity(enc.len());
    let mut prev = [0u8; 16];
    for chunk in enc.chunks(16) {
        if chunk.len() < 16 {
            break;
        }
        let mut b = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut b);
        for j in 0..16 {
            out.push(b[j] ^ prev[j]);
        }
        prev.copy_from_slice(chunk);
    }
    if out.get(0..4)? != b"MEGA" {
        return None;
    }
    let end = out.iter().skip(4).position(|&c| c == 0).map(|p| p + 4).unwrap_or(out.len());
    let json: Value = serde_json::from_slice(&out[4..end]).ok()?;
    json.get("n").and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Pick this node's own `handle:key` pair from a (possibly multi-pair) `k` field.
fn node_key_b64<'a>(k: &'a str, handle: &str) -> Option<&'a str> {
    let mut first = None;
    for pair in k.split('/') {
        if let Some((h, key)) = pair.split_once(':') {
            if first.is_none() {
                first = Some(key);
            }
            if h == handle {
                return Some(key);
            }
        }
    }
    first
}

/// Decrypt a file node's key into (16-byte AES key, 8-byte CTR nonce).
fn file_key(dec32: &[u8]) -> ([u8; 16], [u8; 8]) {
    let mut key = [0u8; 16];
    for i in 0..16 {
        key[i] = dec32[i] ^ dec32[i + 16];
    }
    let mut nonce = [0u8; 8];
    nonce.copy_from_slice(&dec32[16..24]);
    (key, nonce)
}

/// POST one command to the MEGA API, retrying the transient EAGAIN (-3) error.
fn api_req(c: &reqwest::blocking::Client, folder_id: &str, cmd: Value, h: &NativeHandles) -> Result<Value, String> {
    for attempt in 0..6 {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        let url = format!("{API}?id=0&n={folder_id}");
        let resp = c
            .post(&url)
            .header("User-Agent", UA)
            .json(&vec![cmd.clone()])
            .send()
            .map_err(|e| e.to_string())?;
        let v: Value = resp.json().map_err(|e| e.to_string())?;
        // A bare number (or a one-element array of a number) is an error code.
        let code = v.as_i64().or_else(|| v.get(0).and_then(|x| x.as_i64()));
        if let Some(n) = code {
            if n == -3 {
                std::thread::sleep(std::time::Duration::from_millis(500 * (attempt + 1)));
                continue;
            }
            return Err(format!("MEGA API error {n}"));
        }
        return v.get(0).cloned().ok_or_else(|| "empty MEGA API response".into());
    }
    Err("MEGA API kept returning EAGAIN".into())
}

/// A decrypted file node ready to download.
struct FileNode {
    handle: String,
    rel_path: PathBuf, // folders + filename, relative to the share/sub root
    size: u64,
    key: [u8; 16],
    nonce: [u8; 8],
}

/// Decrypt the node tree and flatten it to the downloadable files (under `scope`).
fn collect_files(nodes: &[Value], folder_key: &[u8], scope: &Scope) -> Result<Vec<FileNode>, String> {
    // handle -> (name, parent, is_dir)
    let mut meta: HashMap<String, (String, String, bool)> = HashMap::new();
    let mut files: Vec<(String, String, u64, [u8; 16], [u8; 8])> = Vec::new(); // handle,parent,size,key,nonce
    for n in nodes {
        let handle = n.get("h").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let parent = n.get("p").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let t = n.get("t").and_then(|x| x.as_i64()).unwrap_or(-1);
        if handle.is_empty() {
            continue;
        }
        let name = (|| {
            let k = n.get("k").and_then(|x| x.as_str())?;
            let kb = node_key_b64(k, &handle)?;
            let need = if t == 0 { 32 } else { 16 };
            let enc = b64(kb).ok()?;
            if enc.len() < need {
                return None;
            }
            let dec = aes_ecb_decrypt(folder_key, &enc[..need]);
            let name_key: Vec<u8> = if t == 0 { file_key(&dec).0.to_vec() } else { dec[..16].to_vec() };
            let attr = n.get("a").and_then(|x| x.as_str())?;
            decrypt_name(&name_key, attr)
        })()
        .unwrap_or_else(|| handle.clone());

        if t == 0 {
            // File: stash its crypto for download.
            if let Some(k) = n.get("k").and_then(|x| x.as_str()).and_then(|k| node_key_b64(k, &handle)) {
                if let Ok(enc) = b64(k) {
                    if enc.len() >= 32 {
                        let dec = aes_ecb_decrypt(folder_key, &enc[..32]);
                        let (key, nonce) = file_key(&dec);
                        let size = n.get("s").and_then(|x| x.as_u64()).unwrap_or(0);
                        files.push((handle.clone(), parent.clone(), size, key, nonce));
                    }
                }
            }
            meta.insert(handle, (name, parent, false));
        } else {
            meta.insert(handle, (name, parent, true));
        }
    }

    // Resolve each file's path by walking parents, honouring the scope's root.
    let root = match scope {
        Scope::Sub(h) => Some(h.clone()),
        _ => None,
    };
    let mut out = Vec::new();
    for (handle, parent, size, key, nonce) in files {
        if let Scope::File(fh) = scope {
            if &handle != fh {
                continue;
            }
        }
        let name = meta.get(&handle).map(|m| m.0.clone()).unwrap_or_else(|| handle.clone());
        let mut parts: Vec<String> = Vec::new();
        let mut cur = parent.clone();
        let mut under_root = root.is_none();
        let mut guard = 0;
        while let Some((pname, pparent, _)) = meta.get(&cur) {
            if let Some(r) = &root {
                if &cur == r {
                    under_root = true;
                    break; // stop at the sub-root; don't include its name
                }
            }
            parts.push(sanitize(pname));
            cur = pparent.clone();
            guard += 1;
            if guard > 128 || cur.is_empty() {
                break;
            }
        }
        if !under_root {
            continue; // not inside the requested sub-folder
        }
        parts.reverse();
        let mut rel = PathBuf::new();
        for p in parts {
            rel.push(p);
        }
        rel.push(sanitize(&name));
        out.push(FileNode { handle, rel_path: rel, size, key, nonce });
    }
    Ok(out)
}

/// Strip path separators / illegal characters from a single path component.
fn sanitize(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() {
        "_".to_string()
    } else {
        t
    }
}

/// Streaming AES-CTR (MEGA layout: counter = nonce(8) || blockIndex(8, BE)).
struct Ctr {
    cipher: Aes128,
    nonce: [u8; 8],
    counter: u64,
    ks: [u8; 16],
    pos: usize,
}
impl Ctr {
    fn new(key: &[u8; 16], nonce: [u8; 8]) -> Self {
        Ctr { cipher: Aes128::new(GenericArray::from_slice(key)), nonce, counter: 0, ks: [0; 16], pos: 16 }
    }
    /// Seek to a byte offset that MUST be a multiple of 16 (block boundary).
    fn seek_block(&mut self, byte_offset: u64) {
        self.counter = byte_offset / 16;
        self.pos = 16; // force a fresh keystream block on the next byte
    }
    fn refill(&mut self) {
        let mut blk = [0u8; 16];
        blk[..8].copy_from_slice(&self.nonce);
        blk[8..].copy_from_slice(&self.counter.to_be_bytes());
        let mut g = GenericArray::clone_from_slice(&blk);
        self.cipher.encrypt_block(&mut g);
        self.ks.copy_from_slice(&g);
        self.counter += 1;
        self.pos = 0;
    }
    fn apply(&mut self, buf: &mut [u8]) {
        for b in buf.iter_mut() {
            if self.pos == 16 {
                self.refill();
            }
            *b ^= self.ks[self.pos];
            self.pos += 1;
        }
    }
}

/// Download one file node: resolve its temp URL, stream + CTR-decrypt to disk,
/// resuming from any `.megapart` at a 16-byte boundary.
fn download_file(c: &reqwest::blocking::Client, folder_id: &str, f: &FileNode, dest_dir: &Path, h: &NativeHandles) -> Result<(), String> {
    let dest_file = dest_dir.join(&f.rel_path);
    if let Some(p) = dest_file.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    // Already complete?
    if f.size > 0 && std::fs::metadata(&dest_file).map(|m| m.len()).unwrap_or(0) == f.size {
        h.transferred.fetch_add(f.size as i64, Ordering::SeqCst);
        return Ok(());
    }

    let g = api_req(c, folder_id, json!({ "a": "g", "g": 1, "n": f.handle }), h)?;
    let url = g.get("g").and_then(|x| x.as_str()).ok_or("MEGA: no download URL for file")?.to_string();

    let mut part = dest_file.as_os_str().to_owned();
    part.push(".megapart");
    let part = PathBuf::from(part);
    // Resume from a block-aligned offset.
    let mut offset = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    offset -= offset % 16;
    if f.size > 0 && offset > f.size {
        offset = 0;
    }
    let mut file = std::fs::OpenOptions::new().create(true).write(true).truncate(false).open(&part).map_err(|e| e.to_string())?;
    use std::io::Seek;
    file.seek(std::io::SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    file.set_len(offset).map_err(|e| e.to_string())?;
    h.transferred.fetch_add(offset as i64, Ordering::SeqCst);

    let mut ctr = Ctr::new(&f.key, f.nonce);
    ctr.seek_block(offset);

    let mut resp = c
        .get(&url)
        .header("User-Agent", UA)
        .header("Range", format!("bytes={offset}-"))
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() && resp.status().as_u16() != 206 {
        return Err(format!("MEGA download {}", resp.status()));
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
        ctr.apply(&mut buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        h.transferred.fetch_add(n as i64, Ordering::SeqCst);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&part, &dest_file).map_err(|e| e.to_string())
}

/// Download an entire MEGA public folder (or sub-folder / single file) into
/// `dest_dir`, decrypting as it goes and updating `h`.
pub fn download_share(url: &str, dest_dir: &Path, h: &NativeHandles) -> Result<(), String> {
    let (folder_id, key, scope) = parse_link(url)?;
    let c = client();
    let res = api_req(&c, &folder_id, json!({ "a": "f", "c": 1, "ca": 1, "r": 1 }), h)?;
    let nodes = res.get("f").and_then(|f| f.as_array()).ok_or("MEGA: folder has no file list (link expired or wrong key?)")?;
    let files = collect_files(nodes, &key, &scope)?;
    if files.is_empty() {
        return Err("MEGA: no files found in this folder link".into());
    }
    let total: i64 = files.iter().map(|f| f.size as i64).sum();
    if total > 0 {
        h.total.store(total, Ordering::SeqCst);
    }
    for f in &files {
        if h.cancelled.load(Ordering::SeqCst) {
            return Err("paused".into());
        }
        download_file(&c, &folder_id, f, dest_dir, h)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_and_legacy_links() {
        let k = "or7suGmdxptroVUZyQuJ7Q";
        let (id, key, scope) = parse_link(&format!("https://mega.nz/folder/ovtzCLaQ#{k}")).unwrap();
        assert_eq!(id, "ovtzCLaQ");
        assert_eq!(key.len(), 16);
        assert!(matches!(scope, Scope::All));

        let (_, _, scope) = parse_link(&format!("https://mega.nz/folder/ovtzCLaQ#{k}/folder/AbC123")).unwrap();
        assert!(matches!(scope, Scope::Sub(ref s) if s == "AbC123"));

        let (id2, _, _) = parse_link(&format!("https://mega.nz/#F!ovtzCLaQ!{k}")).unwrap();
        assert_eq!(id2, "ovtzCLaQ");

        assert!(parse_link("https://example.com/x").is_err());
    }

    #[test]
    fn ctr_seek_matches_sequential() {
        let key = [7u8; 16];
        let nonce = [1u8; 8];
        let data: Vec<u8> = (0..100u16).map(|i| i as u8).collect();
        // Full sequential.
        let mut a = Ctr::new(&key, nonce);
        let mut full = data.clone();
        a.apply(&mut full);
        // Resume at block boundary 32.
        let mut b = Ctr::new(&key, nonce);
        b.seek_block(32);
        let mut tail = data[32..].to_vec();
        b.apply(&mut tail);
        assert_eq!(&full[32..], &tail[..]);
    }

    #[test]
    fn sanitize_strips_separators() {
        assert_eq!(sanitize("a/b:c"), "a_b_c");
        assert_eq!(sanitize("  ..  "), "_");
    }
}

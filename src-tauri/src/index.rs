//! Background account indexer.
//!
//! The crawl, tree/aggregate build, and disk persistence all run on Rust
//! background threads so the UI never freezes. The crawl is breadth-first and
//! NON-recursive: a small worker pool pops one folder at a time, lists only its
//! direct children (no `recurse`), and enqueues discovered subfolders. This keeps
//! progress granular, makes a single huge folder cheap to list, and lets the crawl
//! be cancelled between folders. Progress is emitted as throttled Tauri events;
//! the finished index ({tree, agg}) is handed to the frontend once via `index_get`.

use crate::download::account_fs;
use crate::rclone::supervisor::{rc_post, RcConnection, RcloneState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const INDEX_VERSION: u32 = 3;

/// Auto-index worker pool size. Kept small (BFS, non-recursive) so a crawl never
/// saturates the shared rclone daemon and freezes the rest of the app.
const CRAWL_WORKERS: usize = 4;

/// Progress is emitted at most this often (or every `PROGRESS_EVERY` folders),
/// whichever comes first — flooding the event channel itself causes UI lag.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const PROGRESS_EVERY: usize = 25;

/// A file/folder entry, serialized with rclone's PascalCase field names so the
/// frontend's RcItem shape matches directly.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Entry {
    name: String,
    path: String,
    size: i64,
    is_dir: bool,
    mod_time: String,
    mime_type: String,
    #[serde(rename = "ID", default, skip_serializing_if = "String::is_empty")]
    id: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Agg {
    size: i64,
    latest: String,
    file_count: i64,
}

#[derive(Clone, Serialize)]
pub struct AccountIndex {
    tree: HashMap<String, Vec<Entry>>,
    agg: HashMap<String, Agg>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    status: String, // idle | loading | crawling | ready | cancelled | error
    done: usize,    // folders processed
    total: usize,   // folders discovered so far
    files: usize,   // running file count
    bytes: i64,     // cumulative size of all files
    date_min: String, // earliest modTime (ISO) or ""
    date_max: String, // latest modTime (ISO) or ""
    error: String,
}

#[derive(Default)]
pub struct IndexState {
    indexes: Mutex<HashMap<String, AccountIndex>>,
    status: Mutex<HashMap<String, IndexStatus>>,
    /// Per-account cancel flags; the BFS workers check theirs between folder pops.
    cancel: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Get-or-create the cancel flag for an account, resetting it to `false`.
/// Returns a clone the caller hands to the worker pool.
fn reset_cancel(app: &AppHandle, account_id: &str) -> Arc<AtomicBool> {
    let state = app.state::<IndexState>();
    let mut map = lock(&state.cancel);
    let flag = map.entry(account_id.to_string()).or_insert_with(|| Arc::new(AtomicBool::new(false))).clone();
    flag.store(false, Ordering::SeqCst);
    flag
}

fn parse_entry(v: &Value) -> Option<Entry> {
    Some(Entry {
        name: v.get("Name")?.as_str()?.to_string(),
        path: v.get("Path")?.as_str()?.to_string(),
        size: v.get("Size").and_then(|x| x.as_i64()).unwrap_or(-1),
        is_dir: v.get("IsDir").and_then(|x| x.as_bool()).unwrap_or(false),
        mod_time: v.get("ModTime").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        mime_type: v.get("MimeType").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        id: v.get("ID").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    })
}

fn list_op(conn: &RcConnection, fs: &str, path: &str, recurse: bool) -> Result<Vec<Entry>, String> {
    let resp = rc_post(
        conn,
        "operations/list",
        &json!({ "fs": fs, "remote": path, "opt": { "recurse": recurse } }),
    )?;
    let list = resp.get("list").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    Ok(list.iter().filter_map(parse_entry).collect())
}

/// Normalize a child entry's path so it is account-root-relative.
///
/// rclone's `operations/list` returns `Path` relative to the fs root (so it
/// already includes the listed folder). Be defensive in case a provider returns
/// it relative to the listed remote instead: if `raw` isn't the folder itself and
/// isn't already under `folder/`, prefix it with the folder path. Mirrors the
/// normalization in `transfer.rs::enumerate_folder`. `folder` is "" for the root.
fn normalize_path(folder: &str, raw: &str) -> String {
    if folder.is_empty() {
        return raw.to_string();
    }
    let prefix = format!("{folder}/");
    if raw == folder || raw.starts_with(&prefix) {
        raw.to_string()
    } else {
        format!("{prefix}{raw}")
    }
}

/// Civil (year, month, day) from days since the Unix epoch — Howard Hinnant's
/// algorithm, dep-free. Used to turn "now" into a YYYY-MM-DD ceiling.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Today's date + 2 days as "YYYY-MM-DD" — the ceiling for a plausible file date.
/// (2-day grace absorbs timezone skew; anything past it is a wrong-clock artifact.)
fn future_date_ceiling() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(i64::MAX / 2);
    let (y, m, d) = civil_from_days(secs / 86_400 + 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Whether an ISO modified-time is plausible (not stamped in the future). Some
/// devices with a wrong clock write file dates ahead of today (seen: 2027, 2049),
/// which would otherwise become the crawl's `date_max` and show a nonsense
/// "latest" date. Compares the YYYY-MM-DD prefix against today+2d.
fn date_plausible(mod_time: &str) -> bool {
    mod_time.len() >= 10 && mod_time[..10] <= *future_date_ceiling()
}

/// Running file/size/date totals, folded over file entries during a crawl.
#[derive(Clone, Default)]
struct CrawlStats {
    files: usize,
    bytes: i64,
    date_min: String,
    date_max: String,
}

impl CrawlStats {
    /// Fold one entry into the totals (no-op for directories). Pure.
    fn fold(&mut self, e: &Entry) {
        if e.is_dir {
            return;
        }
        self.files += 1;
        self.bytes += e.size.max(0);
        if !e.mod_time.is_empty() && date_plausible(&e.mod_time) {
            if self.date_min.is_empty() || e.mod_time < self.date_min {
                self.date_min = e.mod_time.clone();
            }
            if e.mod_time > self.date_max {
                self.date_max = e.mod_time.clone();
            }
        }
    }

    /// Merge another stats accumulator into this one. Pure.
    fn merge(&mut self, other: &CrawlStats) {
        self.files += other.files;
        self.bytes += other.bytes;
        if !other.date_min.is_empty() && (self.date_min.is_empty() || other.date_min < self.date_min) {
            self.date_min = other.date_min.clone();
        }
        if other.date_max > self.date_max {
            self.date_max = other.date_max.clone();
        }
    }
}

fn build_index(entries: &[Entry]) -> AccountIndex {
    let mut tree: HashMap<String, Vec<Entry>> = HashMap::new();
    let mut agg: HashMap<String, Agg> = HashMap::new();
    for e in entries {
        let parent = match e.path.rfind('/') {
            Some(i) => e.path[..i].to_string(),
            None => String::new(),
        };
        tree.entry(parent).or_default().push(e.clone());
        if e.is_dir {
            agg.entry(e.path.clone()).or_default();
        } else {
            let mut p = e.path.clone();
            while let Some(i) = p.rfind('/') {
                p.truncate(i);
                let a = agg.entry(p.clone()).or_default();
                a.size += e.size.max(0);
                a.file_count += 1;
                if e.mod_time > a.latest {
                    a.latest = e.mod_time.clone();
                }
            }
        }
    }
    for v in tree.values_mut() {
        v.sort_by(|a, b| {
            if a.is_dir != b.is_dir {
                return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
            }
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        });
    }
    AccountIndex { tree, agg }
}

#[allow(clippy::too_many_arguments)]
fn set_status(
    app: &AppHandle,
    account_id: &str,
    status: &str,
    done: usize,
    total: usize,
    stats: &CrawlStats,
    error: &str,
) {
    let state = app.state::<IndexState>();
    lock(&state.status).insert(
        account_id.to_string(),
        IndexStatus {
            status: status.into(),
            done,
            total,
            files: stats.files,
            bytes: stats.bytes,
            date_min: stats.date_min.clone(),
            date_max: stats.date_max.clone(),
            error: error.into(),
        },
    );
}

/// Emit the EXTENDED index-progress payload (always; callers throttle).
fn emit_progress(app: &AppHandle, account_id: &str, done: usize, total: usize, stats: &CrawlStats) {
    let _ = app.emit(
        "index-progress",
        json!({
            "accountId": account_id,
            "done": done,
            "total": total,
            "files": stats.files,
            "bytes": stats.bytes,
            "dateMin": stats.date_min,
            "dateMax": stats.date_max,
        }),
    );
}

fn index_path(app: &AppHandle, account_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    Ok(dir.join(format!("index_{account_id}.json")))
}

fn load_from_disk(app: &AppHandle, account_id: &str) -> Option<Vec<Entry>> {
    let path = index_path(app, account_id).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    if v.get("version").and_then(|x| x.as_u64()) != Some(INDEX_VERSION as u64) {
        return None;
    }
    serde_json::from_value(v.get("entries")?.clone()).ok()
}

fn save_to_disk(app: &AppHandle, account_id: &str, entries: &[Entry]) {
    if let Ok(path) = index_path(app, account_id) {
        if let Ok(data) = serde_json::to_string(&json!({ "version": INDEX_VERSION, "entries": entries })) {
            let _ = std::fs::write(path, data);
        }
    }
}

/// Sentinel returned by a BFS crawl that was cancelled mid-flight; the caller must
/// NOT overwrite the existing index with the partial result.
struct Cancelled;

/// From a batch of just-discovered subfolders, keep only those not seen before —
/// deduping by Drive **ID** so a folder reachable via multiple shortcuts (or the
/// `shared_with_me` graph) is crawled ONCE, not once per path. Without this, the
/// same shared subtree is re-listed and its bytes re-counted per shortcut, which
/// inflates the reported account size (e.g. a few TB shown as tens of TB). Entries
/// with no ID (providers that don't expose one, e.g. Dropbox) are always kept —
/// their paths are already unique, so there's nothing to dedupe. Records new IDs.
fn retain_unseen(subdirs: Vec<Entry>, seen: &mut HashSet<String>) -> Vec<Entry> {
    subdirs
        .into_iter()
        .filter(|d| d.id.is_empty() || seen.insert(d.id.clone()))
        .collect()
}

/// Shared coordination for one BFS crawl.
struct Crawl {
    queue: Mutex<VecDeque<Entry>>,
    out: Mutex<Vec<Entry>>,
    stats: Mutex<CrawlStats>,
    /// IDs already accounted for: folder IDs (deduped at enqueue so the
    /// shortcut/shared_with_me graph is crawled once, not re-counted) AND file IDs
    /// (a file reached via multiple shortcuts is counted once, not per reference).
    seen: Mutex<HashSet<String>>,
    done: AtomicUsize,  // folders processed
    total: AtomicUsize, // folders discovered so far
    last_emit: Mutex<Instant>,
}

/// Breadth-first, NON-recursive crawl of `seeds` (folders) with a small worker
/// pool. Each worker pops a folder, lists only its direct children, normalizes
/// paths, collects file entries (folding stats), and enqueues subfolders. Returns
/// the collected subtree entries (root-relative), or `Cancelled` if the account's
/// cancel flag was set before completion. `base_stats` seeds the running totals
/// (kept entries from an incremental refresh). Progress is emitted throttled.
fn bfs_crawl(
    app: &AppHandle,
    account_id: &str,
    conn: &RcConnection,
    fs: &str,
    seeds: Vec<Entry>,
    base_stats: CrawlStats,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<Entry>, Cancelled> {
    let total = seeds.len();
    set_status(app, account_id, "crawling", 0, total, &base_stats, "");
    emit_progress(app, account_id, 0, total, &base_stats);
    if total == 0 {
        return Ok(Vec::new());
    }

    let seen_ids: HashSet<String> = seeds.iter().filter(|e| !e.id.is_empty()).map(|e| e.id.clone()).collect();
    let crawl = Arc::new(Crawl {
        queue: Mutex::new(seeds.into_iter().collect::<VecDeque<Entry>>()),
        out: Mutex::new(Vec::new()),
        stats: Mutex::new(base_stats),
        seen: Mutex::new(seen_ids),
        done: AtomicUsize::new(0),
        total: AtomicUsize::new(total),
        last_emit: Mutex::new(Instant::now()),
    });

    let workers = std::cmp::min(CRAWL_WORKERS, total);
    let mut handles = Vec::new();
    for _ in 0..workers {
        let conn = conn.clone();
        let fs = fs.to_string();
        let app = app.clone();
        let account_id = account_id.to_string();
        let crawl = crawl.clone();
        let cancel = cancel.clone();
        handles.push(std::thread::spawn(move || loop {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let dir = { lock(&crawl.queue).pop_front() };
            let dir = match dir {
                Some(d) => d,
                None => break,
            };

            // List only the direct children (no recurse). Retry a flaky list once.
            let mut children: Vec<Entry> = Vec::new();
            for attempt in 0..2 {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                match list_op(&conn, &fs, &dir.path, false) {
                    Ok(c) => {
                        children = c;
                        break;
                    }
                    Err(_) if attempt < 1 => continue,
                    Err(_) => break,
                }
            }

            let mut local = CrawlStats::default();
            let mut subdirs: Vec<Entry> = Vec::new();
            let mut keep: Vec<Entry> = Vec::with_capacity(children.len());
            {
                // Count each FILE once by Drive ID: a file reached from several
                // folders (Drive shortcuts / multi-parent) would otherwise have its
                // bytes counted per reference — this is what the folder-only dedup
                // missed (105TB → 45TB but still ~8x). Folder traversal is deduped at
                // enqueue (retain_unseen); folder entries are kept as-is here (size 0,
                // so a repeat is harmless). ID-less entries (no-ID providers, e.g.
                // Dropbox) are always kept — their paths are already unique.
                let mut seen = lock(&crawl.seen);
                for mut it in children {
                    it.path = normalize_path(&dir.path, &it.path);
                    if it.is_dir {
                        subdirs.push(it.clone());
                        keep.push(it);
                    } else if it.id.is_empty() || seen.insert(it.id.clone()) {
                        local.fold(&it);
                        keep.push(it);
                    }
                }
            }
            lock(&crawl.out).extend(keep);
            // Enqueue discovered subfolders, skipping any folder id already seen
            // (reached via another shortcut / shared_with_me path) so its subtree
            // isn't re-crawled and re-counted. Grow the discovered-total by the
            // deduped count so progress stays honest.
            if !subdirs.is_empty() {
                let fresh = {
                    let mut seen = lock(&crawl.seen);
                    retain_unseen(subdirs, &mut seen)
                };
                if !fresh.is_empty() {
                    crawl.total.fetch_add(fresh.len(), Ordering::SeqCst);
                    lock(&crawl.queue).extend(fresh);
                }
            }
            lock(&crawl.stats).merge(&local);

            let d = crawl.done.fetch_add(1, Ordering::SeqCst) + 1;
            let t = crawl.total.load(Ordering::SeqCst);
            let snapshot = lock(&crawl.stats).clone();
            set_status(&app, &account_id, "crawling", d, t, &snapshot, "");

            // Throttle emits: at most every PROGRESS_INTERVAL or every PROGRESS_EVERY folders.
            let should_emit = {
                let mut last = lock(&crawl.last_emit);
                if d.is_multiple_of(PROGRESS_EVERY) || last.elapsed() >= PROGRESS_INTERVAL {
                    *last = Instant::now();
                    true
                } else {
                    false
                }
            };
            if should_emit {
                emit_progress(&app, &account_id, d, t, &snapshot);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    if cancel.load(Ordering::SeqCst) {
        return Err(Cancelled);
    }

    let done = crawl.done.load(Ordering::SeqCst);
    let total = crawl.total.load(Ordering::SeqCst);
    let snapshot = lock(&crawl.stats).clone();
    // Final, always-emitted progress tick.
    set_status(app, account_id, "crawling", done, total, &snapshot, "");
    emit_progress(app, account_id, done, total, &snapshot);

    let out = Arc::try_unwrap(crawl)
        .map(|c| c.out.into_inner().unwrap_or_else(|e| e.into_inner()))
        .unwrap_or_else(|arc| lock(&arc.out).clone());
    Ok(out)
}

/// Compute the running stats over a slice of already-collected entries (seeds an
/// incremental crawl so progress totals include kept entries). Pure.
fn stats_of(entries: &[Entry]) -> CrawlStats {
    let mut s = CrawlStats::default();
    for e in entries {
        s.fold(e);
    }
    s
}

/// Crawl a Dropbox shared-link via the native API — one recursive `list_folder`
/// returns the whole tree, so there's no worker-pool crawl.
fn crawl_dropbox_link(app: &AppHandle, account_id: &str) -> Result<Vec<Entry>, String> {
    let conn = lock(&app.state::<RcloneState>().connection).clone().ok_or_else(|| "rclone not started".to_string())?;
    let empty = CrawlStats::default();
    set_status(app, account_id, "crawling", 0, 1, &empty, "");
    emit_progress(app, account_id, 0, 1, &empty);
    let raw = crate::dropbox::list_entries(app, &conn, account_id)?;
    let entries: Vec<Entry> = raw.iter().filter_map(parse_entry).collect();
    let stats = stats_of(&entries);
    set_status(app, account_id, "crawling", 1, 1, &stats, "");
    emit_progress(app, account_id, 1, 1, &stats);
    Ok(entries)
}

/// Result of a crawl: either the entries, or a cancellation (don't overwrite).
enum CrawlOutcome {
    Done(Vec<Entry>),
    Cancelled,
}

/// Full crawl of an account (BFS, cancellable).
fn do_crawl(app: &AppHandle, account_id: &str, cancel: &Arc<AtomicBool>) -> Result<CrawlOutcome, String> {
    if account_id.starts_with("dropboxlink_") {
        return Ok(CrawlOutcome::Done(crawl_dropbox_link(app, account_id)?));
    }
    let conn = lock(&app.state::<RcloneState>().connection).clone().ok_or_else(|| "rclone not started".to_string())?;
    let fs = account_fs(account_id)?;
    let root = list_op(&conn, &fs, "", false)?;
    let root_dirs: Vec<Entry> = root.iter().filter(|e| e.is_dir).cloned().collect();
    let base_stats = stats_of(&root);
    match bfs_crawl(app, account_id, &conn, &fs, root_dirs, base_stats, cancel) {
        Ok(sub) => {
            let mut merged = root;
            merged.extend(sub);
            Ok(CrawlOutcome::Done(merged))
        }
        Err(Cancelled) => Ok(CrawlOutcome::Cancelled),
    }
}

/// Re-index ("Refresh"): a FULL fresh crawl, so newly added / changed / removed
/// files are all reflected. An earlier version kept already-indexed top-level
/// folders for speed, but that made a file added INSIDE an existing folder
/// invisible until a full re-crawl — a correctness bug. The BFS crawl is cheap,
/// cancellable, and shows progress, so Refresh now always re-lists from scratch.
/// (For a single folder, the per-folder `index_folder` is the fast targeted path.)
fn do_refresh(app: &AppHandle, account_id: &str, cancel: &Arc<AtomicBool>) -> Result<CrawlOutcome, String> {
    do_crawl(app, account_id, cancel)
}

/// On a cancelled crawl: mark status cancelled (keep any prior totals) and leave
/// the existing index untouched.
fn finish_cancelled(app: &AppHandle, account_id: &str) {
    let state = app.state::<IndexState>();
    let prior = lock(&state.status).get(account_id).cloned().unwrap_or_default();
    lock(&state.status).insert(
        account_id.to_string(),
        IndexStatus { status: "cancelled".into(), ..prior },
    );
    let _ = app.emit("index-cancelled", json!({ "accountId": account_id }));
}

/// Ensure an account's index exists: serve from memory, else load from disk, else
/// crawl — all on a background thread. Emits index-progress / index-ready / index-error.
#[tauri::command]
pub fn index_start(app: AppHandle, account_id: String) {
    {
        let state = app.state::<IndexState>();
        if lock(&state.indexes).contains_key(&account_id) {
            let _ = app.emit("index-ready", json!({ "accountId": account_id }));
            return;
        }
        let mut st = lock(&state.status);
        if matches!(st.get(&account_id).map(|s| s.status.as_str()), Some("crawling") | Some("loading")) {
            return;
        }
        st.insert(account_id.clone(), IndexStatus { status: "loading".into(), ..Default::default() });
    }
    emit_progress(&app, &account_id, 0, 0, &CrawlStats::default());

    std::thread::spawn(move || {
        let cancel = reset_cancel(&app, &account_id);
        let entries = match load_from_disk(&app, &account_id) {
            Some(e) => e,
            None => match do_crawl(&app, &account_id, &cancel) {
                Ok(CrawlOutcome::Done(e)) => {
                    save_to_disk(&app, &account_id, &e);
                    e
                }
                Ok(CrawlOutcome::Cancelled) => {
                    finish_cancelled(&app, &account_id);
                    return;
                }
                Err(err) => {
                    set_status(&app, &account_id, "error", 0, 0, &CrawlStats::default(), &err);
                    let _ = app.emit("index-error", json!({ "accountId": account_id, "error": err }));
                    return;
                }
            },
        };
        let index = build_index(&entries);
        lock(&app.state::<IndexState>().indexes).insert(account_id.clone(), index);
        set_status(&app, &account_id, "ready", 0, 0, &stats_of(&entries), "");
        let _ = app.emit("index-ready", json!({ "accountId": account_id }));
    });
}

/// Incremental refresh: keep already-indexed folders, only crawl missing/new ones.
#[tauri::command]
pub fn index_recrawl(app: AppHandle, account_id: String) {
    {
        let state = app.state::<IndexState>();
        let mut st = lock(&state.status);
        if matches!(st.get(&account_id).map(|s| s.status.as_str()), Some("crawling") | Some("loading")) {
            return;
        }
        st.insert(account_id.clone(), IndexStatus { status: "loading".into(), ..Default::default() });
    }
    emit_progress(&app, &account_id, 0, 0, &CrawlStats::default());
    std::thread::spawn(move || {
        let cancel = reset_cancel(&app, &account_id);
        match do_refresh(&app, &account_id, &cancel) {
            Ok(CrawlOutcome::Done(entries)) => {
                save_to_disk(&app, &account_id, &entries);
                let index = build_index(&entries);
                lock(&app.state::<IndexState>().indexes).insert(account_id.clone(), index);
                set_status(&app, &account_id, "ready", 0, 0, &stats_of(&entries), "");
                let _ = app.emit("index-ready", json!({ "accountId": account_id }));
            }
            Ok(CrawlOutcome::Cancelled) => finish_cancelled(&app, &account_id),
            Err(err) => {
                set_status(&app, &account_id, "error", 0, 0, &CrawlStats::default(), &err);
                let _ = app.emit("index-error", json!({ "accountId": account_id, "error": err }));
            }
        }
    });
}

/// Manually (re)index just one subtree: BFS-crawl `folder_path`, then replace the
/// entries under it in the on-disk index (keeping everything else), rebuild and
/// store. Emits index-progress / index-ready / index-error. Cancellable.
#[tauri::command]
pub fn index_folder(app: AppHandle, account_id: String, folder_path: String) {
    {
        let state = app.state::<IndexState>();
        let mut st = lock(&state.status);
        if matches!(st.get(&account_id).map(|s| s.status.as_str()), Some("crawling") | Some("loading")) {
            return;
        }
        st.insert(account_id.clone(), IndexStatus { status: "loading".into(), ..Default::default() });
    }
    emit_progress(&app, &account_id, 0, 0, &CrawlStats::default());

    std::thread::spawn(move || {
        let cancel = reset_cancel(&app, &account_id);
        let result = (|| -> Result<CrawlOutcome, String> {
            // Dropbox links can't index a single subtree — there's no folder list
            // op; fall back to a full re-list.
            if account_id.starts_with("dropboxlink_") {
                return Ok(CrawlOutcome::Done(crawl_dropbox_link(&app, &account_id)?));
            }
            let conn = lock(&app.state::<RcloneState>().connection).clone().ok_or_else(|| "rclone not started".to_string())?;
            let fs = account_fs(&account_id)?;
            // List the folder itself to get its direct children, then BFS its subdirs.
            let direct = list_op(&conn, &fs, &folder_path, false)?;
            let direct: Vec<Entry> = direct.into_iter().map(|mut it| {
                it.path = normalize_path(&folder_path, &it.path);
                it
            }).collect();
            let subdirs: Vec<Entry> = direct.iter().filter(|e| e.is_dir).cloned().collect();
            let base_stats = stats_of(&direct);
            match bfs_crawl(&app, &account_id, &conn, &fs, subdirs, base_stats, &cancel) {
                Ok(sub) => {
                    let mut fresh = direct;
                    fresh.extend(sub);
                    Ok(CrawlOutcome::Done(fresh))
                }
                Err(Cancelled) => Ok(CrawlOutcome::Cancelled),
            }
        })();

        match result {
            Ok(CrawlOutcome::Done(fresh)) => {
                // Replace entries under folder_path with the freshly crawled ones,
                // keeping everything outside the subtree.
                let prefix = format!("{folder_path}/");
                let mut merged: Vec<Entry> = load_from_disk(&app, &account_id)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|e| e.path != folder_path && !e.path.starts_with(&prefix))
                    .collect();
                merged.extend(fresh);
                save_to_disk(&app, &account_id, &merged);
                let index = build_index(&merged);
                lock(&app.state::<IndexState>().indexes).insert(account_id.clone(), index);
                set_status(&app, &account_id, "ready", 0, 0, &stats_of(&merged), "");
                let _ = app.emit("index-ready", json!({ "accountId": account_id }));
            }
            Ok(CrawlOutcome::Cancelled) => finish_cancelled(&app, &account_id),
            Err(err) => {
                set_status(&app, &account_id, "error", 0, 0, &CrawlStats::default(), &err);
                let _ = app.emit("index-error", json!({ "accountId": account_id, "error": err }));
            }
        }
    });
}

/// Request that an in-progress crawl for `account_id` stop promptly. The BFS
/// workers check the flag between folder pops and bail; the partial result is
/// discarded (the existing index is left untouched).
#[tauri::command]
pub fn index_cancel(app: AppHandle, account_id: String) {
    let state = app.state::<IndexState>();
    let flag = lock(&state.cancel).get(&account_id).cloned();
    if let Some(flag) = flag {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Return the built index ({tree, agg}) once ready, else None.
#[tauri::command]
pub fn index_get(app: AppHandle, account_id: String) -> Option<AccountIndex> {
    lock(&app.state::<IndexState>().indexes).get(&account_id).cloned()
}

/// Current crawl status/progress for an account.
#[tauri::command]
pub fn index_status(app: AppHandle, account_id: String) -> IndexStatus {
    lock(&app.state::<IndexState>().status).get(&account_id).cloned().unwrap_or_default()
}

/// Drop an account's index (on removal).
#[tauri::command]
pub fn index_remove(app: AppHandle, account_id: String) {
    lock(&app.state::<IndexState>().indexes).remove(&account_id);
    lock(&app.state::<IndexState>().status).remove(&account_id);
    lock(&app.state::<IndexState>().cancel).remove(&account_id);
    if let Ok(path) = index_path(&app, &account_id) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, size: i64, mod_time: &str) -> Entry {
        Entry {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.into(),
            size,
            is_dir: false,
            mod_time: mod_time.into(),
            mime_type: String::new(),
            id: String::new(),
        }
    }
    fn d(path: &str) -> Entry {
        Entry {
            name: path.rsplit('/').next().unwrap().to_string(),
            path: path.into(),
            size: -1,
            is_dir: true,
            mod_time: String::new(),
            mime_type: String::new(),
            id: String::new(),
        }
    }
    fn d_id(path: &str, id: &str) -> Entry {
        Entry { id: id.into(), ..d(path) }
    }

    #[test]
    fn retain_unseen_dedupes_by_id_and_keeps_idless() {
        let mut seen = HashSet::new();
        // First sight of two distinct folders → both kept and recorded.
        let keep = retain_unseen(vec![d_id("A", "id1"), d_id("B", "id2")], &mut seen);
        assert_eq!(keep.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["A", "B"]);
        // The same ids reached again via other shortcut paths → dropped; a new id survives.
        let keep = retain_unseen(vec![d_id("A-shortcut", "id1"), d_id("C", "id3")], &mut seen);
        assert_eq!(keep.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["C"]);
        // ID-less entries (providers without IDs, e.g. Dropbox) are always kept.
        let keep = retain_unseen(vec![d_id("D", ""), d_id("D", "")], &mut seen);
        assert_eq!(keep.len(), 2);
    }

    #[test]
    fn builds_tree_and_recursive_aggregates() {
        let entries = vec![
            d("A"),
            d("A/sub"),
            f("A/sub/clip1.mxf", 1000, "2026-01-02T00:00:00Z"),
            f("A/clip2.mxf", 500, "2026-03-01T00:00:00Z"),
            f("root.mxf", 10, "2026-01-01T00:00:00Z"),
        ];
        let idx = build_index(&entries);
        assert_eq!(idx.tree[""].iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["A", "root.mxf"]);
        assert_eq!(idx.tree["A"].iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["sub", "clip2.mxf"]);
        assert_eq!(idx.agg["A"].size, 1500);
        assert_eq!(idx.agg["A"].latest, "2026-03-01T00:00:00Z");
        assert_eq!(idx.agg["A"].file_count, 2);
        assert_eq!(idx.agg["A/sub"].size, 1000);
    }

    #[test]
    fn normalize_path_prefixes_folder_relative_entries() {
        // Root listing: paths are returned as-is.
        assert_eq!(normalize_path("", "A"), "A");
        assert_eq!(normalize_path("", "A/clip.mxf"), "A/clip.mxf");
        // Already root-relative (includes the folder) — left untouched.
        assert_eq!(normalize_path("A", "A/clip.mxf"), "A/clip.mxf");
        assert_eq!(normalize_path("A/sub", "A/sub"), "A/sub");
        assert_eq!(normalize_path("A/sub", "A/sub/clip.mxf"), "A/sub/clip.mxf");
        // Folder-relative (provider returned path under the listed remote) — prefixed.
        assert_eq!(normalize_path("A", "clip.mxf"), "A/clip.mxf");
        assert_eq!(normalize_path("A/sub", "deep/clip.mxf"), "A/sub/deep/clip.mxf");
    }

    #[test]
    fn crawl_stats_fold_aggregates_files_only() {
        let mut s = CrawlStats::default();
        s.fold(&d("A")); // dir — ignored
        s.fold(&f("A/clip1.mxf", 1000, "2026-03-01T00:00:00Z"));
        s.fold(&f("A/clip2.mxf", 500, "2026-01-02T00:00:00Z"));
        s.fold(&f("A/clip3.mxf", -1, "2026-02-01T00:00:00Z")); // size<0 (Google Doc) counts as 0
        s.fold(&f("A/noDate.mxf", 7, "")); // empty modTime ignored for date bounds
        assert_eq!(s.files, 4);
        assert_eq!(s.bytes, 1507);
        assert_eq!(s.date_min, "2026-01-02T00:00:00Z");
        assert_eq!(s.date_max, "2026-03-01T00:00:00Z");
    }

    #[test]
    fn fold_ignores_implausible_future_dates() {
        let mut s = CrawlStats::default();
        s.fold(&f("A/real.mxf", 100, "2026-03-01T00:00:00Z"));
        s.fold(&f("A/badclock.wav", 100, "2049-01-09T00:00:00Z")); // recorder clock set wrong
        // The future date is ignored for the date range, but the file still counts.
        assert_eq!(s.date_max, "2026-03-01T00:00:00Z");
        assert_eq!(s.files, 2);
        assert_eq!(s.bytes, 200);
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1)); // unix epoch
        assert_eq!(civil_from_days(18262), (2020, 1, 1)); // 1577836800 / 86400
        assert_eq!(civil_from_days(19723), (2024, 1, 1)); // 1704067200 / 86400
        assert_eq!(civil_from_days(20544), (2026, 4, 1)); // 1775001600 / 86400
    }

    #[test]
    fn crawl_stats_merge_combines_bounds() {
        let mut a = CrawlStats { files: 2, bytes: 100, date_min: "2026-02-01T00:00:00Z".into(), date_max: "2026-05-01T00:00:00Z".into() };
        let b = CrawlStats { files: 3, bytes: 50, date_min: "2026-01-01T00:00:00Z".into(), date_max: "2026-03-01T00:00:00Z".into() };
        a.merge(&b);
        assert_eq!(a.files, 5);
        assert_eq!(a.bytes, 150);
        assert_eq!(a.date_min, "2026-01-01T00:00:00Z"); // earlier wins
        assert_eq!(a.date_max, "2026-05-01T00:00:00Z"); // later wins
    }

    #[test]
    fn crawl_stats_merge_into_empty() {
        let mut empty = CrawlStats::default();
        let b = CrawlStats { files: 1, bytes: 9, date_min: "2026-01-01T00:00:00Z".into(), date_max: "2026-01-01T00:00:00Z".into() };
        empty.merge(&b);
        assert_eq!(empty.date_min, "2026-01-01T00:00:00Z");
        assert_eq!(empty.date_max, "2026-01-01T00:00:00Z");
    }
}

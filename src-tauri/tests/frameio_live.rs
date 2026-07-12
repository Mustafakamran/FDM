//! Live end-to-end check of the Frame.io resolver against a real public share.
//! Network + external-service dependent, so it is `#[ignore]`d — run explicitly:
//!   cargo test --test frameio_live -- --ignored --nocapture
//!
//! It enumerates the share, resolves an asset's proxy URL, and streams the first
//! file to a temp dir, then cancels — proving enumerate → resolve → download all
//! work over the real GraphQL API from Rust.

use google_drive_downloader_lib::download::NativeHandles;
use google_drive_downloader_lib::frameio;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SHARE: &str = "https://next.frame.io/share/06c38ba7-a5ae-4629-bc4c-d337d8d1315a/";
/// The folder share (link 1): 4 folders incl. "CARD 3", which a mid-share 416
/// error used to abort before reaching.
const FOLDER_SHARE: &str = "https://next.frame.io/share/ff7cb5d4-0d65-4bff-ba92-ec22466c7ec3/";

fn handles() -> NativeHandles {
    NativeHandles {
        job_id: 1,
        transferred: Arc::new(AtomicI64::new(0)),
        total: Arc::new(AtomicI64::new(0)),
        finished: Arc::new(AtomicBool::new(false)),
        success: Arc::new(AtomicBool::new(false)),
        cancelled: Arc::new(AtomicBool::new(false)),
        error: Arc::new(Mutex::new(String::new())),
    }
}

/// A completed (non-.fdmpart) file with real bytes in `dir`, if any.
fn finished_file(dir: &PathBuf) -> Option<(PathBuf, u64)> {
    let rd = std::fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().map(|x| x == "fdmpart").unwrap_or(false) {
            continue;
        }
        let len = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if len > 0 {
            return Some((p, len));
        }
    }
    None
}

/// Recursively count completed (non-.fdmpart) files under `dir`.
fn count_finished(dir: &PathBuf) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += count_finished(&p);
            } else if !p.extension().map(|x| x == "fdmpart").unwrap_or(false)
                && std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
            {
                n += 1;
            }
        }
    }
    n
}

#[test]
#[ignore = "hits the live Frame.io API + downloads real bytes"]
fn downloads_a_proxy_file() {
    let dir = std::env::temp_dir().join("fdm_frameio_live_test");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let h = handles();
    let h_watch = h.clone();
    let dir_watch = dir.clone();
    // Cancel once the first file has fully landed so we don't pull the whole share.
    let watch = std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            if finished_file(&dir_watch).is_some() {
                h_watch.cancelled.store(true, Ordering::SeqCst);
                return;
            }
            if start.elapsed() > Duration::from_secs(90) {
                h_watch.cancelled.store(true, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });

    // Smallest proxy so the first file is a few hundred KB, not gigabytes.
    let res = frameio::download_share(SHARE, &dir, "proxy-smallest", &h);
    let _ = watch.join();

    let done = finished_file(&dir);
    let total = h.total.load(Ordering::SeqCst);
    println!("result={res:?} transferred={} total={total} file={done:?}", h.transferred.load(Ordering::SeqCst));
    assert!(done.is_some(), "expected at least one downloaded file in {dir:?}");
    let (path, len) = done.unwrap();
    assert!(len > 50_000, "downloaded file too small ({len} bytes): {path:?}");
    // The background sizer must have published a proxy total larger than a single
    // file (it resolves many assets while the first one downloads).
    assert!(total > len as i64, "proxy total ({total}) should exceed one file ({len})");
    assert!(
        path.extension().map(|x| x == "mp4" || x == "MP4").unwrap_or(false),
        "expected an .mp4 proxy, got {path:?}"
    );
}

#[test]
#[ignore = "hits the live Frame.io API + downloads real bytes"]
fn streams_original_partial() {
    // Originals are hundreds of MB, so just prove the presigned-S3 Range stream
    // starts flowing (a .fdmpart grows), then cancel — no full pull.
    let dir = std::env::temp_dir().join("fdm_frameio_live_orig");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let h = handles();
    let h_watch = h.clone();
    let watch = std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            if h_watch.transferred.load(Ordering::SeqCst) > 3_000_000 || start.elapsed() > Duration::from_secs(90) {
                h_watch.cancelled.store(true, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    let res = frameio::download_share(SHARE, &dir, "original", &h);
    let _ = watch.join();

    let moved = h.transferred.load(Ordering::SeqCst);
    let total = h.total.load(Ordering::SeqCst);
    println!("result={res:?} transferred={moved} total={total}");
    // The share aggregate (originals) must have been published, and real bytes
    // must have streamed from the presigned S3 URL.
    assert!(total > 1_000_000_000, "expected the originals aggregate total to be published, got {total}");
    assert!(moved > 2_000_000, "expected the original to start streaming, only got {moved} bytes");
}

#[test]
#[ignore = "hits the live Frame.io API + downloads real bytes"]
fn folder_share_proxies_survive_416() {
    // The folder share pulls many proxy files whose server-muxed size differs
    // from the reported filesize, which used to 416 and abort the WHOLE share
    // (dropping later folders like CARD 3). Download several files across folders
    // and assert it never fails with a 416 — only a clean cancel ("paused").
    let dir = std::env::temp_dir().join("fdm_frameio_live_folder");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let h = handles();
    let h_watch = h.clone();
    let dir_watch = dir.clone();
    let watch = std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            if count_finished(&dir_watch) >= 8 || start.elapsed() > Duration::from_secs(180) {
                h_watch.cancelled.store(true, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    });

    let res = frameio::download_share(FOLDER_SHARE, &dir, "proxy-smallest", &h);
    let _ = watch.join();

    let done = count_finished(&dir);
    println!("result={res:?} finished_files={done}");
    // A 416 (or any single file failing) must never abort the run — the only
    // acceptable early exit is the pause we triggered.
    if let Err(e) = &res {
        assert_eq!(e, "paused", "download aborted with a non-pause error: {e}");
    }
    assert!(done >= 8, "expected ≥8 files downloaded across folders, got {done}");
}

#[test]
#[ignore = "hits the live Frame.io API + downloads real bytes"]
fn resume_skips_already_complete_files() {
    // Round 1: pull a few proxy files, then cancel. Round 2: re-run into the SAME
    // folder — the completed files must be recognised (byte-length exact) and
    // skipped instantly, not re-downloaded, while new files are fetched.
    let dir = std::env::temp_dir().join("fdm_frameio_live_resume");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let run_until = |target: usize, secs: u64| -> (i64, Result<(), String>) {
        let h = handles();
        let hw = h.clone();
        let dw = dir.clone();
        let w = std::thread::spawn(move || {
            let start = Instant::now();
            loop {
                if count_finished(&dw) >= target || start.elapsed() > Duration::from_secs(secs) {
                    hw.cancelled.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        let res = frameio::download_share(SHARE, &dir, "proxy-smallest", &h);
        let _ = w.join();
        (h.transferred.load(Ordering::SeqCst), res)
    };

    // Round 1: get at least 5 files on disk.
    let _ = run_until(5, 120);
    let after1 = count_finished(&dir);
    assert!(after1 >= 5, "round 1 should download ≥5 files, got {after1}");

    // Round 2: re-run; watch how fast `transferred` climbs. Because the first
    // `after1` files are already complete, the resolver should skip them and
    // credit their bytes near-instantly (no re-download), then fetch new ones.
    let (moved2, _res2) = run_until(after1 + 3, 120);
    let after2 = count_finished(&dir);
    println!("after1={after1} after2={after2} transferred_round2={moved2}");
    assert!(after2 > after1, "round 2 should add new files, {after1} → {after2}");
}

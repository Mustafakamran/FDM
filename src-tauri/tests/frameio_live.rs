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

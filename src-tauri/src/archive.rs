//! Local archive listing + extraction for the file preview and the Transfers
//! screen. ZIP is handled by the pure-Rust `zip` crate; RAR by `unrar` (which
//! compiles the upstream unrar C source). Extraction always lands in a fresh
//! sibling folder named after the archive, so re-extracting never clobbers and
//! multiple archives never collide.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// One entry in an archive's listing.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// Path within the archive (forward slashes).
    pub name: String,
    /// Uncompressed size in bytes (0 for directories / when unknown).
    pub size: u64,
    pub is_dir: bool,
}

fn ext_lower(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase()
}

/// A non-colliding output directory: `<parent>/<stem>`, then `<stem> 2`, etc.
fn unique_dir(parent: &Path, stem: &str) -> PathBuf {
    let base = parent.join(stem);
    if !base.exists() {
        return base;
    }
    for n in 2..1000 {
        let cand = parent.join(format!("{stem} {n}"));
        if !cand.exists() {
            return cand;
        }
    }
    base
}

/// List an archive's entries without extracting. ZIP + RAR.
#[tauri::command]
pub fn list_archive(path: String) -> Result<Vec<ArchiveEntry>, String> {
    let p = PathBuf::from(&path);
    match ext_lower(&p).as_str() {
        "zip" => list_zip(&p),
        "rar" => list_rar(&p),
        other => Err(format!("Can’t list .{other} archives (ZIP and RAR supported).")),
    }
}

/// Extract an archive into a fresh folder. `dest` is the parent folder to extract
/// into (defaults to the archive's own folder). Returns the created output folder.
#[tauri::command]
pub fn extract_archive(path: String, dest: Option<String>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Archive not found: {}", p.display()));
    }
    let parent = dest
        .map(PathBuf::from)
        .unwrap_or_else(|| p.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(".")));
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("extracted");
    let out = unique_dir(&parent, stem);
    std::fs::create_dir_all(&out).map_err(|e| format!("create {}: {e}", out.display()))?;

    let res = match ext_lower(&p).as_str() {
        "zip" => extract_zip(&p, &out),
        "rar" => extract_rar(&p, &out),
        other => Err(format!("Can’t extract .{other} archives (ZIP and RAR supported).")),
    };
    match res {
        Ok(()) => Ok(out.to_string_lossy().into_owned()),
        Err(e) => {
            // Don't leave a half-written folder behind on failure.
            let _ = std::fs::remove_dir_all(&out);
            Err(e)
        }
    }
}

// ---- ZIP --------------------------------------------------------------------

fn list_zip(p: &Path) -> Result<Vec<ArchiveEntry>, String> {
    let file = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("open zip: {e}"))?;
    let mut out = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        out.push(ArchiveEntry {
            name: f.name().to_string(),
            size: f.size(),
            is_dir: f.is_dir(),
        });
    }
    Ok(out)
}

fn extract_zip(p: &Path, out: &Path) -> Result<(), String> {
    let file = std::fs::File::open(p).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("open zip: {e}"))?;
    // `extract` guards against zip-slip (it uses each entry's enclosed_name).
    zip.extract(out).map_err(|e| format!("extract zip: {e}"))
}

// ---- RAR --------------------------------------------------------------------

fn list_rar(p: &Path) -> Result<Vec<ArchiveEntry>, String> {
    let archive = unrar::Archive::new(p)
        .open_for_listing()
        .map_err(|e| format!("open rar: {e}"))?;
    let mut out = Vec::new();
    for header in archive {
        let entry = header.map_err(|e| format!("read rar header: {e}"))?;
        out.push(ArchiveEntry {
            name: entry.filename.to_string_lossy().replace('\\', "/"),
            size: entry.unpacked_size,
            is_dir: entry.is_directory(),
        });
    }
    Ok(out)
}

fn extract_rar(p: &Path, out: &Path) -> Result<(), String> {
    let mut archive = unrar::Archive::new(p)
        .open_for_processing()
        .map_err(|e| format!("open rar: {e}"))?;
    while let Some(header) = archive.read_header().map_err(|e| format!("read rar header: {e}"))? {
        archive = if header.entry().is_file() {
            header
                .extract_with_base(out)
                .map_err(|e| format!("extract rar: {e}"))?
        } else {
            header.skip().map_err(|e| format!("skip rar entry: {e}"))?
        };
    }
    Ok(())
}

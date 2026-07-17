//! OS-keychain-backed storage for the user's OAuth app credentials
//! (Google client_id/secret, Dropbox app key/secret) and per-account tokens.
//!
//! ## Why one keychain item, not many
//! macOS prompts ("allow / always allow") are per keychain ITEM. Storing each
//! secret as its own item meant opening Settings fired 5-6 separate prompts, and
//! because the app isn't signed with a stable Apple Developer ID, "Always Allow"
//! never persisted across updates. We now keep ALL secrets inside a SINGLE
//! keychain item (a JSON blob) and cache it in memory, so a whole session costs
//! at most ONE prompt instead of one-per-secret. (The per-UPDATE re-prompt is a
//! code-signing issue and needs Developer ID signing — out of scope here.)
//!
//! Legacy per-key items are migrated lazily: the first time a key is requested
//! and isn't in the vault yet, we read its old item once, fold it into the vault,
//! and delete the legacy item. After that first pass everything lives in the vault.

use keyring::{Entry, Error as KeyringError};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Service name under which secrets are namespaced in the OS keychain.
const SERVICE: &str = "google-drive-downloader";
/// The single keychain item ("account") that holds the JSON vault of all secrets.
const VAULT_KEY: &str = "__vault_v1__";

/// In-memory copy of the vault, loaded from the keychain on first access so the
/// rest of the session never touches the keychain again (no repeat prompts).
fn cache() -> &'static Mutex<Option<HashMap<String, String>>> {
    static CACHE: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn vault_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, VAULT_KEY).map_err(|e| e.to_string())
}

/// Read the vault blob from the keychain (one prompt), or an empty map if it
/// doesn't exist yet.
fn load_vault() -> Result<HashMap<String, String>, String> {
    match vault_entry()?.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        Err(KeyringError::NoEntry) => Ok(HashMap::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Persist the whole vault back to its single keychain item.
fn save_vault(map: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    vault_entry()?.set_password(&json).map_err(|e| e.to_string())
}

/// Run `f` with the (lazily-loaded) in-memory vault locked.
fn with_vault<T>(f: impl FnOnce(&mut HashMap<String, String>) -> T) -> Result<T, String> {
    let mut guard = cache().lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(load_vault()?);
    }
    Ok(f(guard.as_mut().unwrap()))
}

/// Migrate a single legacy per-key keychain item into the vault, if present.
/// Returns its value so the first post-update read still succeeds. Best-effort:
/// keychain hiccups just yield `None` rather than failing the caller.
fn migrate_legacy(key: &str) -> Option<String> {
    let entry = Entry::new(SERVICE, key).ok()?;
    let val = match entry.get_password() {
        Ok(v) => v,
        _ => return None,
    };
    let _ = entry.delete_credential(); // fold into the vault; drop the old item
    Some(val)
}

/// Store (or overwrite) a secret value under `key`.
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    with_vault(|m| {
        m.insert(key.to_string(), value.to_string());
        save_vault(m)
    })?
}

/// Fetch a secret value. Returns `Ok(None)` when no entry exists. Transparently
/// migrates a legacy per-key item into the vault on first hit.
pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    with_vault(|m| {
        if let Some(v) = m.get(key) {
            return Ok(Some(v.clone()));
        }
        match migrate_legacy(key) {
            Some(v) => {
                m.insert(key.to_string(), v.clone());
                let _ = save_vault(m);
                Ok(Some(v))
            }
            None => Ok(None),
        }
    })?
}

/// Delete a secret. A missing entry is treated as success (idempotent).
pub fn delete_secret(key: &str) -> Result<(), String> {
    with_vault(|m| {
        m.remove(key);
        let _ = save_vault(m);
    })?;
    // Also drop any lingering legacy item for this key.
    if let Ok(entry) = Entry::new(SERVICE, key) {
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

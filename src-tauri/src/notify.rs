//! Native desktop notifications that work in `tauri dev` too.
//!
//! The `@tauri-apps/plugin-notification` webview API posts through the OS
//! notification centre, but on macOS that silently drops notifications from an
//! UNSIGNED, un-bundled binary - which is exactly what `tauri dev` runs - so the
//! "transfer complete" toast never appeared during development. We instead post
//! from the Rust side per-OS: `osascript` on macOS (works signed or not), and the
//! notification plugin elsewhere (fine in dev on Windows/Linux).

#[cfg(target_os = "macos")]
fn as_applescript_string(s: &str) -> String {
    // Escape for an AppleScript double-quoted literal.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Post a desktop notification. Best-effort: never errors into the caller.
#[tauri::command]
pub fn notify_desktop(app: tauri::AppHandle, title: String, body: String) {
    let _ = app; // used only on non-macOS
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\" sound name \"Glass\"",
            as_applescript_string(&body),
            as_applescript_string(&title),
        );
        // Fire and forget; a failure to spawn osascript must not affect downloads.
        let _ = std::process::Command::new("osascript").arg("-e").arg(script).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

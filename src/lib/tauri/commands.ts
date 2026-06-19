import { invoke } from "@tauri-apps/api/core";

export type Provider = "drive" | "dropbox";

export interface Account {
  /** rclone remote name; stable account id. */
  id: string;
  provider: Provider;
  /** Sanitized slug reconstructed from the remote name. */
  label: string;
}

/** List all configured accounts (rclone remotes). */
export function listAccounts(): Promise<Account[]> {
  return invoke<Account[]>("list_accounts");
}

/**
 * Add an account via the rclone OAuth flow. Long-running: opens a browser for
 * consent and may take minutes. Tauri maps these camelCase keys to the Rust
 * snake_case params (client_id / client_secret).
 */
export function addAccount(
  provider: Provider,
  label: string,
  clientId: string,
  clientSecret: string,
): Promise<Account> {
  return invoke<Account>("add_account", { provider, label, clientId, clientSecret });
}

/** Remove an account (deletes its rclone remote). */
export function removeAccount(id: string): Promise<void> {
  return invoke("remove_account", { id });
}

/** Store an OAuth app credential in the OS keychain. */
export function setSecret(key: string, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

/** Read an OAuth app credential from the OS keychain (null if absent). */
export function getSecret(key: string): Promise<string | null> {
  return invoke<string | null>("get_secret", { key });
}

/** Delete an OAuth app credential from the OS keychain. */
export function deleteSecret(key: string): Promise<void> {
  return invoke("delete_secret", { key });
}

/** Keychain key names for the per-provider OAuth app credentials. */
export const SECRET_KEYS = {
  drive: { id: "google_client_id", secret: "google_client_secret" },
  dropbox: { id: "dropbox_app_key", secret: "dropbox_app_secret" },
} as const;

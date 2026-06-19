import { invoke } from "@tauri-apps/api/core";
import type { RcConnection } from "../rc/types";

/** Fetch rc connection details (base_url, user, pass) from the Rust core. */
export function getRcConnection(): Promise<RcConnection> {
  return invoke<RcConnection>("get_rc_connection");
}

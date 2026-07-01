/**
 * "Ask where to save (browser downloads)" setting.
 *
 * When on, an ingested browser capture pops a native save dialog seeded with the
 * suggested filename instead of dropping straight into the default download
 * folder. Persisted in localStorage to match the rest of the settings (FOLDER_KEY,
 * dl-settings, concurrency). Default ON.
 */
import { loadRaw, saveRaw } from "./persisted";

const ASK_WHERE_KEY = "ask_where_to_save";

/** Whether to prompt for a save location on browser ingests (default true). */
export function getAskWhereToSave(): boolean {
  // Default true: only an explicit "false" turns it off.
  return loadRaw(ASK_WHERE_KEY, "true") !== "false";
}

/** Persist the "ask where to save" toggle. */
export function setAskWhereToSave(on: boolean): void {
  saveRaw(ASK_WHERE_KEY, on ? "true" : "false");
}

/**
 * Scheduling lane classification.
 *
 * Every download belongs to exactly one lane, decided purely by its source
 * account id — never by user choice:
 *
 * - PRIMARY   — Google Drive, Dropbox, their share-links, and BDM-dispatched
 *               jobs. Account ids beginning `drive`, `drivelink`, `dropbox`,
 *               or `dropboxlink`.
 * - SECONDARY — everything else (e.g. generic HTTP URL downloads, whose
 *               account id is `http`). Later: browser captures, torrents.
 *
 * The priority gate keeps secondary downloads from ever disturbing primary
 * footage work; see `src/store/transfers.ts`.
 */
export type Lane = "primary" | "secondary";

const PRIMARY_PREFIXES = ["drivelink", "drive", "dropboxlink", "dropbox"] as const;

/** Classify a download by its account id. Pure; no dependencies. */
export function laneOf(accountId: string): Lane {
  for (const prefix of PRIMARY_PREFIXES) {
    if (accountId.startsWith(prefix)) return "primary";
  }
  return "secondary";
}

import { loadRaw, saveRaw } from "./persisted";

/** Native-downloader settings: parallel connections per file + bandwidth cap. */
export interface DlSettings {
  /** Parallel connections per file (1–16). */
  connections: number;
  /** Bandwidth cap in MB/s across all downloads; 0 = unlimited. */
  bwLimitMbps: number;
}

const C = "download_connections";
const B = "download_bwlimit_mbps";

const clampConn = (n: number) => Math.min(16, Math.max(1, Math.floor(n) || 1));

export function loadDlSettings(): DlSettings {
  const c = parseInt(loadRaw(C, "4"), 10);
  const b = parseFloat(loadRaw(B, "0"));
  return {
    connections: Number.isFinite(c) ? clampConn(c) : 4,
    bwLimitMbps: Number.isFinite(b) && b > 0 ? b : 0,
  };
}

export function saveDlSettings(s: DlSettings) {
  saveRaw(C, String(clampConn(s.connections)));
  saveRaw(B, String(Math.max(0, s.bwLimitMbps) || 0));
}

/** Shape the Rust `start_download` config expects. */
export function toDownloadConfig(s: DlSettings) {
  return { connections: clampConn(s.connections), bwLimitBytes: Math.round(Math.max(0, s.bwLimitMbps) * 1024 * 1024) };
}

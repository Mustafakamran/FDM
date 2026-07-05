import { FOLDER_STATUS_META } from "../../store/folder-status";
import type { DlState, DlStatus } from "../../lib/download-status";

// Reuse the folder-status green for downloading/downloaded so the badge matches
// the Transfers pill; define the rest here.
const META: Record<DlState, { label: string; color: string; bg: string }> = {
  downloading: FOLDER_STATUS_META.downloading,
  completed: FOLDER_STATUS_META.downloaded,
  queued: { label: "Queued", color: "var(--faint)", bg: "var(--soft)" },
  paused: { label: "Paused", color: "var(--faint)", bg: "var(--soft)" },
  failed: { label: "Failed", color: "var(--err)", bg: "var(--errw)" },
  cancelled: { label: "Cancelled", color: "var(--faint)", bg: "var(--soft)" },
};

/** Live transfer status pill shown on a browse row's source file/folder. */
export function DownloadBadge({ status }: { status: DlStatus }) {
  const m = META[status.state];
  const label = status.state === "downloading" && status.pct != null ? `${m.label} ${status.pct}%` : m.label;
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-semibold leading-[15px]"
      style={{ color: m.color, background: m.bg }}
    >
      {label}
    </span>
  );
}

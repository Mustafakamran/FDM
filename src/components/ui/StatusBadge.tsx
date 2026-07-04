import { FOLDER_STATUS_META, type FolderStatus } from "../../store/folder-status";

/** Small pill showing a folder's manually-set workflow status. */
export function StatusBadge({ status }: { status: FolderStatus }) {
  const m = FOLDER_STATUS_META[status];
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-semibold leading-[15px]"
      style={{ color: m.color, background: m.bg }}
    >
      {m.label}
    </span>
  );
}

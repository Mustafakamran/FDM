import { useState } from "react";
import { ChevronRight, ChevronDown, Folder, Home } from "lucide-react";
import { useBrowse, browseKey } from "../store/browse";
import type { Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";

const EMPTY: RcItem[] = [];

interface NodeProps {
  account: Account;
  dir: RcItem;
  depth: number;
  currentPath: string;
  onNavigate: (path: string) => void;
}

function TreeNode({ account, dir, depth, currentPath, onNavigate }: NodeProps) {
  const [open, setOpen] = useState(false);
  const children = useBrowse((s) => s.listings[browseKey(account.id, dir.Path)]) ?? EMPTY;
  const childDirs = children.filter((c) => c.IsDir);
  const active = currentPath === dir.Path;

  function toggleExpand() {
    const next = !open;
    setOpen(next);
    if (next) void useBrowse.getState().ensure(account, dir.Path);
  }

  return (
    <div>
      <div
        className={`flex items-center gap-0.5 rounded-[7px] pr-2 ${
          active ? "bg-[var(--accent-weak)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--hover)]"
        }`}
        style={{ paddingLeft: depth * 12 + 2 }}
      >
        <button onClick={toggleExpand} className="p-1 text-[var(--text-3)] hover:text-[var(--text)]" aria-label="Expand">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button
          onClick={() => onNavigate(dir.Path)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm"
        >
          <Folder size={15} className="shrink-0 text-[var(--accent)]" />
          <span className="truncate">{dir.Name}</span>
        </button>
      </div>
      {open &&
        childDirs.map((c) => (
          <TreeNode
            key={c.Path}
            account={account}
            dir={c}
            depth={depth + 1}
            currentPath={currentPath}
            onNavigate={onNavigate}
          />
        ))}
    </div>
  );
}

export function SidebarTree({
  account,
  currentPath,
  onNavigate,
}: {
  account: Account;
  currentPath: string;
  onNavigate: (path: string) => void;
}) {
  const roots = useBrowse((s) => s.listings[browseKey(account.id, "")]) ?? EMPTY;
  const rootDirs = roots.filter((d) => d.IsDir);
  const homeLabel = account.provider === "drive" ? "Shared with me" : "Home";

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-auto border-r border-[var(--border)] bg-[var(--surface)] p-2">
      <div className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-[var(--text-3)]">FOLDERS</div>
      <button
        onClick={() => onNavigate("")}
        className={`mb-1 flex items-center gap-2 rounded-[7px] px-2 py-1.5 text-sm ${
          currentPath === "" ? "bg-[var(--accent-weak)] text-[var(--text)]" : "text-[var(--text-2)] hover:bg-[var(--hover)]"
        }`}
      >
        <Home size={14} className="text-[var(--accent)]" /> {homeLabel}
      </button>
      {rootDirs.map((d) => (
        <TreeNode key={d.Path} account={account} dir={d} depth={0} currentPath={currentPath} onNavigate={onNavigate} />
      ))}
    </aside>
  );
}

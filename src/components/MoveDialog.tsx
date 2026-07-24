import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, FolderInput, Home, Loader2 } from "lucide-react";
import { useBrowse, browseKey } from "../store/browse";
import { useSelection } from "../store/selection";
import { useIndex } from "../store/index-store";
import { useToasts } from "../store/toast";
import { moveItem } from "../lib/tauri/commands";
import type { Account } from "../lib/tauri/commands";
import type { RcItem } from "../lib/rc/browse";
import { Button } from "./ui";

/**
 * "Move to…" — a Google-Drive-style folder picker. Shows the account's folder
 * tree (folders only, lazily listed on expand); pick a destination and move
 * every selected item there. Moves are server-side (no re-download). Items whose
 * destination would be a no-op or invalid (a folder into itself/its descendant)
 * are skipped and reported.
 */
export function MoveDialog({ account, items, onClose, onMoved }: {
  account: Account;
  items: RcItem[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const listings = useBrowse((s) => s.listings);
  const loading = useBrowse((s) => s.loading);
  const [target, setTarget] = useState<string>(""); // "" = account root
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [busy, setBusy] = useState(false);

  useEffect(() => { void useBrowse.getState().ensure(account, ""); }, [account]);

  // Paths being moved — a folder can't be dropped into itself or a descendant.
  const moving = useMemo(() => items.map((i) => i.Path), [items]);
  const isInsideMoved = (p: string) => moving.some((m) => p === m || p.startsWith(`${m}/`));

  const expand = (p: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(p)) n.delete(p); else { n.add(p); if (!listings[browseKey(account.id, p)]) void useBrowse.getState().ensure(account, p); }
      return n;
    });
  };

  const targetName = target === "" ? "the drive root" : target.split("/").pop();

  async function confirm() {
    setBusy(true);
    let ok = 0;
    const fails: string[] = [];
    for (const it of items) {
      const parent = it.Path.includes("/") ? it.Path.slice(0, it.Path.lastIndexOf("/")) : "";
      if (parent === target) continue; // already there — silent skip
      if (it.IsDir && (target === it.Path || target.startsWith(`${it.Path}/`))) { fails.push(`${it.Name}: can't move into itself`); continue; }
      try {
        await moveItem(account.id, it.Path, target, it.IsDir, false);
        useIndex.getState().dropPath(account.id, it.Path);
        ok++;
      } catch (e) {
        fails.push(`${it.Name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Refresh affected folders + the destination.
    const parents = new Set(items.map((i) => (i.Path.includes("/") ? i.Path.slice(0, i.Path.lastIndexOf("/")) : "")));
    parents.add(target);
    for (const p of parents) void useBrowse.getState().ensure(account, p);
    useSelection.getState().clearAccount(account.id);
    if (ok) useToasts.getState().push(`Moved ${ok} item${ok > 1 ? "s" : ""} → ${targetName}`, "success");
    if (fails.length) useToasts.getState().push(`Move failed: ${fails[0]}${fails.length > 1 ? ` (+${fails.length - 1} more)` : ""}`, "error");
    setBusy(false);
    onMoved();
    onClose();
  }

  const Row = ({ path, name, depth }: { path: string; name: string; depth: number }) => {
    const kids = (listings[browseKey(account.id, path)] ?? []).filter((i) => i.IsDir);
    const isOpen = expanded.has(path);
    const isLoading = loading[browseKey(account.id, path)] && !listings[browseKey(account.id, path)];
    const selected = target === path;
    const disabled = isInsideMoved(path); // can't move a folder into itself/descendant
    return (
      <>
        <div
          className={`flex items-center gap-1 rounded-[8px] pr-2 ${selected ? "bg-[var(--accw)]" : "hover:bg-[var(--hover)]"} ${disabled ? "opacity-40" : ""}`}
          style={{ paddingLeft: depth * 16 + 4 }}
        >
          <button
            onClick={() => expand(path)}
            aria-label={isOpen ? "Collapse" : "Expand"}
            className="flex h-6 w-5 shrink-0 items-center justify-center text-[var(--faint)] hover:text-[var(--ink)]"
          >
            <ChevronRight size={13} className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
          </button>
          <button
            disabled={disabled}
            onClick={() => !disabled && setTarget(path)}
            onDoubleClick={() => !disabled && expand(path)}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left disabled:cursor-not-allowed"
          >
            {depth === 0 ? <Home size={14} className="shrink-0 text-[var(--acc)]" /> : <Folder size={14} className="shrink-0 text-[var(--acc)]" />}
            <span className={`truncate text-[13px] ${selected ? "font-semibold text-[var(--ink)]" : "text-[var(--text)]"}`}>{name}</span>
          </button>
        </div>
        {isOpen && (
          <div>
            {isLoading ? (
              <div className="flex items-center gap-2 py-1.5 text-[11px] text-[var(--faint)]" style={{ paddingLeft: (depth + 1) * 16 + 10 }}>
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : kids.length === 0 ? (
              <div className="py-1 text-[11px] text-[var(--faint)]" style={{ paddingLeft: (depth + 1) * 16 + 10 }}>No subfolders</div>
            ) : (
              kids.map((k) => <Row key={k.ID ?? k.Path} path={k.Path} name={k.Name} depth={depth + 1} />)
            )}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/25 p-6" onClick={() => !busy && onClose()}>
      <div className="animate-pop flex max-h-[75vh] w-full max-w-md flex-col rounded-[14px] border border-[var(--border-strong)] bg-[var(--card)] shadow-[var(--shadow-lg)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-5 py-3.5">
          <FolderInput size={18} className="text-[var(--acc)]" />
          <h2 className="text-base font-semibold text-[var(--text)]">Move {items.length === 1 ? items[0].Name : `${items.length} items`}</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          <Row path="" name={account.label} depth={0} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] px-5 py-3">
          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--faint)]">→ {targetName}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button variant="download" onClick={confirm} disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <FolderInput size={16} />} Move here
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

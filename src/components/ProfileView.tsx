import { useEffect, useMemo, useState } from "react";
import {
  Folder,
  File as FileIcon,
  Download,
  Loader2,
  AlertCircle,
  Search,
  List as ListIcon,
  LayoutGrid,
  RefreshCw,
  Calculator,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "../store/app";
import { useBrowse, browseKey, type SizeValue } from "../store/browse";
import { useTransfers } from "../store/transfers";
import { useToasts } from "../store/toast";
import { SidebarTree } from "./SidebarTree";
import { Button } from "./ui";
import { type RcItem } from "../lib/rc/browse";
import { formatBytes, formatDate } from "../lib/format";
import type { DownloadItem } from "../lib/tauri/commands";

const FOLDER_KEY = "default_download_folder";
const EMPTY: RcItem[] = [];

export function ProfileView({ id }: { id: string }) {
  const account = useApp((s) => s.accounts.find((a) => a.id === id));
  const startTransfer = useTransfers((s) => s.start);
  const toast = useToasts((s) => s.push);

  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [grid, setGrid] = useState(false);

  const k = account ? browseKey(account.id, path) : "";
  const items = useBrowse((s) => s.listings[k]) ?? EMPTY;
  const loading = useBrowse((s) => s.loading[k]) ?? false;
  const error = useBrowse((s) => s.errors[k]);
  const sizes = useBrowse((s) => s.sizes);

  useEffect(() => {
    if (!account) return;
    setSelected(new Set());
    void useBrowse.getState().ensure(account, path);
  }, [account, path]);

  const filtered = useMemo(
    () => (query ? items.filter((i) => i.Name.toLowerCase().includes(query.toLowerCase())) : items),
    [items, query],
  );

  const sizeOf = (p: string): SizeValue | undefined =>
    account ? sizes[browseKey(account.id, p)] : undefined;
  const calc = (p: string) => account && useBrowse.getState().computeSize(account, p);

  const totalSelected = useMemo(
    () =>
      items
        .filter((i) => selected.has(i.Path))
        .reduce((sum, i) => {
          if (!i.IsDir) return sum + Math.max(0, i.Size);
          const v = sizeOf(i.Path);
          return sum + (typeof v === "number" && v > 0 ? v : 0);
        }, 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, selected, sizes],
  );

  const allSelected = filtered.length > 0 && filtered.every((i) => selected.has(i.Path));

  function toggle(item: RcItem) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.Path)) next.delete(item.Path);
      else {
        next.add(item.Path);
        if (item.IsDir && sizeOf(item.Path) === undefined) calc(item.Path); // need size for the total
      }
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(filtered.map((i) => i.Path)));
  }

  async function download() {
    if (!account || selected.size === 0) return;
    let dest = localStorage.getItem(FOLDER_KEY) ?? "";
    if (!dest) {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      dest = picked;
    }
    const chosen: DownloadItem[] = items
      .filter((i) => selected.has(i.Path))
      .map((i) => {
        const v = sizeOf(i.Path);
        const size = i.IsDir ? (typeof v === "number" ? v : 0) : Math.max(0, i.Size);
        return { path: i.Path, name: i.Name, isDir: i.IsDir, size };
      });
    try {
      await startTransfer(account.id, chosen, dest);
      toast(`Started ${chosen.length} download${chosen.length === 1 ? "" : "s"}`, "success");
      setSelected(new Set());
    } catch (e) {
      toast(String(e), "error");
    }
  }

  if (!account) return <div className="p-8 text-sm text-[var(--text-2)]">Account not found.</div>;

  const rootLabel = account.provider === "drive" ? "Shared with me" : "Home";
  const segments = path ? path.split("/") : [];

  function SizeCell({ item }: { item: RcItem }) {
    if (!item.IsDir) return <span className="tnum text-[var(--text-2)]">{formatBytes(item.Size)}</span>;
    const v = sizeOf(item.Path);
    if (v === "loading")
      return (
        <span className="inline-flex items-center gap-1.5 text-[var(--text-3)]">
          <Loader2 size={12} className="animate-spin" /> calc…
        </span>
      );
    if (typeof v === "number") return <span className="tnum text-[var(--text-2)]">{formatBytes(v)}</span>;
    // undefined or "error" → click to calculate
    return (
      <button
        onClick={() => calc(item.Path)}
        className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-3)] hover:border-[var(--border-strong)] hover:text-[var(--text-2)]"
      >
        <Calculator size={12} /> {v === "error" ? "retry" : "Calc"}
      </button>
    );
  }

  function NameCell({ item, big }: { item: RcItem; big?: boolean }) {
    const icon = item.IsDir ? (
      <Folder size={big ? 30 : 18} className="shrink-0 text-[var(--accent)]" />
    ) : (
      <FileIcon size={big ? 28 : 16} className="shrink-0 text-[var(--text-3)]" />
    );
    if (item.IsDir)
      return (
        <button
          className={`flex min-w-0 items-center gap-3 text-left text-[var(--text)] hover:text-[var(--accent)] ${big ? "flex-col gap-2 text-center" : ""}`}
          onClick={() => setPath(item.Path)}
        >
          {icon}
          <span className="truncate">{item.Name}</span>
        </button>
      );
    return (
      <span className={`flex min-w-0 items-center gap-3 text-[var(--text)] ${big ? "flex-col gap-2 text-center" : ""}`}>
        {icon}
        <span className="truncate">{item.Name}</span>
      </span>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <SidebarTree account={account} currentPath={path} onNavigate={setPath} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-5 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
            <button
              className="rounded px-1.5 py-0.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              onClick={() => setPath("")}
            >
              {rootLabel}
            </button>
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-[var(--text-3)]">/</span>
                <button
                  className="rounded px-1.5 py-0.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  onClick={() => setPath(segments.slice(0, i + 1).join("/"))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>

          <div className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm">
            <Search size={14} className="text-[var(--text-3)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-36 bg-transparent text-[var(--text)] placeholder:text-[var(--text-3)] focus:outline-none"
            />
          </div>
          <div className="flex overflow-hidden rounded-[8px] border border-[var(--border)]">
            <button
              className={`px-2 py-1.5 ${!grid ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-3)]"}`}
              onClick={() => setGrid(false)}
              aria-label="List view"
            >
              <ListIcon size={15} />
            </button>
            <button
              className={`px-2 py-1.5 ${grid ? "bg-[var(--hover)] text-[var(--text)]" : "text-[var(--text-3)]"}`}
              onClick={() => setGrid(true)}
              aria-label="Grid view"
            >
              <LayoutGrid size={15} />
            </button>
          </div>
          <button
            className="rounded-[8px] border border-[var(--border)] p-1.5 text-[var(--text-3)] hover:text-[var(--text)]"
            onClick={() => account && useBrowse.getState().ensure(account, path, true)}
            aria-label="Refresh"
          >
            <RefreshCw size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-2" data-testid="file-list">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--error)]">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          {loading && items.length === 0 ? (
            <div className="flex items-center gap-2 py-12 text-sm text-[var(--text-2)]">
              <Loader2 className="animate-spin" size={16} /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-sm text-[var(--text-2)]">{query ? "No matches." : "This folder is empty."}</div>
          ) : grid ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3 py-2">
              {filtered.map((item) => (
                <div
                  key={item.Path}
                  className={`relative flex flex-col items-center gap-3 rounded-[11px] border p-5 ${
                    selected.has(item.Path)
                      ? "border-[var(--accent)] bg-[var(--card)]"
                      : "border-[var(--border)] hover:bg-[var(--hover)]"
                  }`}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.Name}`}
                    checked={selected.has(item.Path)}
                    onChange={() => toggle(item)}
                    className="absolute left-3 top-3"
                  />
                  <NameCell item={item} big />
                  <div className="text-xs text-[var(--text-3)]">
                    <SizeCell item={item} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 z-10 bg-[var(--bg)] text-left text-xs text-[var(--text-3)]">
                  <th className="w-9 py-2">
                    <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={toggleAll} />
                  </th>
                  <th className="py-2 font-medium">Name</th>
                  <th className="w-36 py-2 pl-4 font-medium">Modified</th>
                  <th className="w-36 py-2 pl-4 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr
                    key={item.Path}
                    className={`border-b border-[var(--border)]/60 ${
                      selected.has(item.Path) ? "bg-[var(--card)]" : "hover:bg-[var(--hover)]"
                    }`}
                  >
                    <td className="py-2.5 pl-1">
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.Name}`}
                        checked={selected.has(item.Path)}
                        onChange={() => toggle(item)}
                      />
                    </td>
                    <td className="min-w-0 py-2.5 pr-3">
                      <NameCell item={item} />
                    </td>
                    <td className="py-2.5 pl-4 text-xs text-[var(--text-3)]">{formatDate(item.ModTime)}</td>
                    <td className="py-2.5 pl-4 text-right">
                      <SizeCell item={item} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Selection bar */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between gap-4 border-t border-[var(--border)] bg-[var(--surface)] px-5 py-3">
            <span className="text-sm text-[var(--text-2)]">
              Selected: <span className="tnum text-[var(--text)]">{selected.size}</span> items ·{" "}
              <span className="tnum text-[var(--text)]">{formatBytes(totalSelected)}</span>
            </span>
            <Button variant="primary" onClick={download}>
              <Download size={16} /> Download
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

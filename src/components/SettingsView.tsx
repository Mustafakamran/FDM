import { useEffect, useState } from "react";
import { FolderOpen, Check, Zap, RefreshCw, Download, Loader2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { getSecret, setSecret, SECRET_KEYS } from "../lib/tauri/commands";
import { Button, TextField, Card } from "./ui";
import { loadPerf, savePerf, PRESETS, type PerfSettings } from "../lib/perf";
import { useToasts } from "../store/toast";
import { useTransfers } from "../store/transfers";
import { useUpdater } from "../store/updater";

const FOLDER_KEY = "default_download_folder";

export function SettingsView() {
  const [googleId, setGoogleId] = useState("");
  const [googleSecret, setGoogleSecret] = useState("");
  const [dropboxKey, setDropboxKey] = useState("");
  const [dropboxSecret, setDropboxSecret] = useState("");
  const [folder, setFolder] = useState<string>(() => localStorage.getItem(FOLDER_KEY) ?? "");
  const [perf, setPerf] = useState<PerfSettings>(() => loadPerf());
  const [saved, setSaved] = useState<string | null>(null);
  const toast = useToasts((s) => s.push);
  const concurrency = useTransfers((s) => s.concurrency);
  const setConcurrency = useTransfers((s) => s.setConcurrency);
  const updater = useUpdater();
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      const [gi, gs, dk, ds] = await Promise.all([
        getSecret(SECRET_KEYS.drive.id),
        getSecret(SECRET_KEYS.drive.secret),
        getSecret(SECRET_KEYS.dropbox.id),
        getSecret(SECRET_KEYS.dropbox.secret),
      ]);
      if (gi) setGoogleId(gi);
      if (gs) setGoogleSecret(gs);
      if (dk) setDropboxKey(dk);
      if (ds) setDropboxSecret(ds);
    })();
  }, []);

  function markSaved(key: string, msg: string) {
    toast(msg, "success");
    setSaved(key);
    setTimeout(() => setSaved((s) => (s === key ? null : s)), 2200);
  }

  async function saveGoogle() {
    await Promise.all([
      setSecret(SECRET_KEYS.drive.id, googleId),
      setSecret(SECRET_KEYS.drive.secret, googleSecret),
    ]);
    markSaved("google", "Google credentials saved");
  }

  async function saveDropbox() {
    await Promise.all([
      setSecret(SECRET_KEYS.dropbox.id, dropboxKey),
      setSecret(SECRET_KEYS.dropbox.secret, dropboxSecret),
    ]);
    markSaved("dropbox", "Dropbox credentials saved");
  }

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setFolder(picked);
      localStorage.setItem(FOLDER_KEY, picked);
      markSaved("folder", "Default folder set");
    }
  }

  function setPerfField(k: keyof PerfSettings, v: number) {
    const next = { ...perf, [k]: Number.isFinite(v) && v >= 0 ? v : 0 };
    setPerf(next);
    savePerf(next);
  }

  function applyPreset(name: string) {
    const next = PRESETS[name];
    setPerf(next);
    savePerf(next);
    toast(`${name} preset applied`, "success");
  }

  const tick = (key: string) =>
    saved === key ? (
      <span className="flex items-center gap-1 text-sm text-[var(--success)]">
        <Check size={15} /> Saved
      </span>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-2xl p-8">
      <h1 className="mb-6 text-lg font-semibold text-[var(--text)]">Settings</h1>

      <Card className="mb-4 p-5">
        <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Google Drive API</h2>
        <p className="mb-4 text-xs text-[var(--text-3)]">
          Your OAuth Desktop client (scope: drive.readonly). Entered once — reused for
          <span className="text-[var(--text-2)]"> all </span>your Google accounts. Add the
          individual accounts in the <span className="text-[var(--text-2)]">Accounts</span> tab.
        </p>
        <div className="flex flex-col gap-3">
          <TextField label="Client ID" value={googleId} onChange={(e) => setGoogleId(e.target.value)} />
          <TextField
            label="Client Secret"
            type="password"
            value={googleSecret}
            onChange={(e) => setGoogleSecret(e.target.value)}
          />
          <div className="flex items-center justify-end gap-3">
            {tick("google")}
            <Button variant="primary" onClick={saveGoogle}>
              Save Google credentials
            </Button>
          </div>
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Dropbox API</h2>
        <p className="mb-4 text-xs text-[var(--text-3)]">
          Your Dropbox app key + secret. Entered once — reused for
          <span className="text-[var(--text-2)]"> all </span>your Dropbox accounts. Add the
          individual accounts in the <span className="text-[var(--text-2)]">Accounts</span> tab.
        </p>
        <div className="flex flex-col gap-3">
          <TextField label="App key" value={dropboxKey} onChange={(e) => setDropboxKey(e.target.value)} />
          <TextField
            label="App secret"
            type="password"
            value={dropboxSecret}
            onChange={(e) => setDropboxSecret(e.target.value)}
          />
          <div className="flex items-center justify-end gap-3">
            {tick("dropbox")}
            <Button variant="primary" onClick={saveDropbox}>
              Save Dropbox credentials
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Default download folder</h2>
        <p className="mb-4 text-xs text-[var(--text-3)]">Where downloads land unless overridden per job.</p>
        <div className="flex items-center gap-3">
          <div className="tnum min-w-0 flex-1 truncate rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-2)]">
            {folder || "Not set"}
          </div>
          {tick("folder")}
          <Button variant="primary" onClick={chooseFolder}>
            <FolderOpen size={16} /> Choose…
          </Button>
        </div>
      </Card>

      <Card className="mt-4 p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Zap size={16} /> Performance
        </h2>
        <p className="mb-4 text-xs text-[var(--text-3)]">
          Tuning for large RAW files. Turbo for a fast line; Gentle to share the pipe.
        </p>
        <div className="mb-4 flex gap-2">
          {Object.keys(PRESETS).map((name) => (
            <Button key={name} variant="ghost" onClick={() => applyPreset(name)}>
              {name}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label="Parallel files"
            type="number"
            value={perf.transfers}
            onChange={(e) => setPerfField("transfers", Number(e.target.value))}
          />
          <TextField
            label="Streams per file"
            type="number"
            value={perf.multiThreadStreams}
            onChange={(e) => setPerfField("multiThreadStreams", Number(e.target.value))}
          />
          <TextField
            label="Stream cutoff (MiB)"
            type="number"
            value={perf.multiThreadCutoffMB}
            onChange={(e) => setPerfField("multiThreadCutoffMB", Number(e.target.value))}
          />
          <TextField
            label="Bandwidth cap (MB/s, 0 = off)"
            type="number"
            value={perf.bwLimitMB}
            onChange={(e) => setPerfField("bwLimitMB", Number(e.target.value))}
          />
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-4">
          <div>
            <div className="text-xs font-medium text-[var(--text-2)]">Simultaneous downloads</div>
            <div className="text-[11px] text-[var(--text-3)]">Queue projects; 1 = strictly one at a time.</div>
          </div>
          <input
            type="number"
            min={1}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="focus-accent w-20 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
          />
        </div>
      </Card>

      <Card className="mt-4 p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <RefreshCw size={16} /> Updates
        </h2>
        <p className="mb-4 text-xs text-[var(--text-3)]">
          {appVersion ? (
            <>
              You're on version <span className="text-[var(--text-2)]">{appVersion}</span>. The app also checks
              automatically on launch.
            </>
          ) : (
            "The app checks for updates automatically on launch."
          )}
        </p>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-sm">
            {updater.phase === "checking" && (
              <span className="flex items-center gap-1.5 text-[var(--text-2)]">
                <Loader2 size={14} className="animate-spin" /> Checking…
              </span>
            )}
            {updater.phase === "uptodate" && (
              <span className="flex items-center gap-1.5 text-[var(--success)]">
                <Check size={15} /> You're on the latest version.
              </span>
            )}
            {updater.phase === "available" && (
              <span className="text-[var(--text)]">
                Version <span className="font-semibold">{updater.version}</span> is available.
              </span>
            )}
            {updater.phase === "downloading" && <span className="text-[var(--text-2)]">Downloading update…</span>}
            {updater.phase === "error" && <span className="text-[var(--error)]">{updater.error}</span>}
          </div>
          {updater.phase === "available" ? (
            <Button variant="primary" onClick={() => void updater.install()}>
              <Download size={16} /> Install &amp; restart
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void updater.check(true)}
              disabled={updater.phase === "checking" || updater.phase === "downloading"}
            >
              <RefreshCw size={16} /> Check for updates
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

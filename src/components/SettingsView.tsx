import { useEffect, useState } from "react";
import { FolderOpen, Check } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { getSecret, setSecret, SECRET_KEYS } from "../lib/tauri/commands";
import { Button, TextField, Card } from "./ui";

const FOLDER_KEY = "default_download_folder";

export function SettingsView() {
  const [googleId, setGoogleId] = useState("");
  const [googleSecret, setGoogleSecret] = useState("");
  const [dropboxKey, setDropboxKey] = useState("");
  const [dropboxSecret, setDropboxSecret] = useState("");
  const [folder, setFolder] = useState<string>(() => localStorage.getItem(FOLDER_KEY) ?? "");
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

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

  function flash(msg: string) {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 2000);
  }

  async function saveGoogle() {
    await Promise.all([
      setSecret(SECRET_KEYS.drive.id, googleId),
      setSecret(SECRET_KEYS.drive.secret, googleSecret),
    ]);
    flash("Google credentials saved");
  }

  async function saveDropbox() {
    await Promise.all([
      setSecret(SECRET_KEYS.dropbox.id, dropboxKey),
      setSecret(SECRET_KEYS.dropbox.secret, dropboxSecret),
    ]);
    flash("Dropbox credentials saved");
  }

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setFolder(picked);
      localStorage.setItem(FOLDER_KEY, picked);
      flash("Default folder set");
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-8">
      <h1 className="mb-6 text-lg font-semibold text-[var(--text)]">Settings</h1>

      <Card className="mb-4 p-5">
        <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Google Drive API</h2>
        <p className="mb-4 text-xs text-[var(--text-3)]">
          Use your own OAuth Desktop client (Production). Scope: drive.readonly.
        </p>
        <div className="flex flex-col gap-3">
          <TextField label="Client ID" value={googleId} onChange={(e) => setGoogleId(e.target.value)} />
          <TextField
            label="Client Secret"
            type="password"
            value={googleSecret}
            onChange={(e) => setGoogleSecret(e.target.value)}
          />
          <div className="flex justify-end">
            <Button variant="primary" onClick={saveGoogle}>
              Save Google credentials
            </Button>
          </div>
        </div>
      </Card>

      <Card className="mb-4 p-5">
        <h2 className="mb-1 text-sm font-semibold text-[var(--text)]">Dropbox API</h2>
        <p className="mb-4 text-xs text-[var(--text-3)]">
          Use your own Dropbox app (Production). App key + secret.
        </p>
        <div className="flex flex-col gap-3">
          <TextField label="App key" value={dropboxKey} onChange={(e) => setDropboxKey(e.target.value)} />
          <TextField
            label="App secret"
            type="password"
            value={dropboxSecret}
            onChange={(e) => setDropboxSecret(e.target.value)}
          />
          <div className="flex justify-end">
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
          <Button variant="primary" onClick={chooseFolder}>
            <FolderOpen size={16} /> Choose…
          </Button>
        </div>
      </Card>

      {savedFlash && (
        <div className="mt-4 flex items-center gap-2 text-sm text-[var(--success)]">
          <Check size={16} /> {savedFlash}
        </div>
      )}
    </div>
  );
}

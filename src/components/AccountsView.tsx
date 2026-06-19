import { useState } from "react";
import { HardDrive, Box, Plus, Trash2, ChevronRight } from "lucide-react";
import { useApp } from "../store/app";
import { ProviderIcon, providerName } from "./icons";
import { Button, Card } from "./ui";
import { AddAccountDialog } from "./AddAccountDialog";
import type { Provider } from "../lib/tauri/commands";

export function AccountsView() {
  const { accounts, openProfile, removeAccount } = useApp();
  const [dialog, setDialog] = useState<Provider | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <div className="mx-auto w-full max-w-3xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-[var(--text)]">Accounts</h1>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setDialog("drive")}>
            <Plus size={16} /> <HardDrive size={16} /> Add Google Drive
          </Button>
          <Button variant="primary" onClick={() => setDialog("dropbox")}>
            <Plus size={16} /> <Box size={16} /> Add Dropbox
          </Button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <p className="text-sm font-medium text-[var(--text)]">No accounts connected</p>
          <p className="max-w-sm text-sm text-[var(--text-2)]">
            Connect a Google Drive or Dropbox account to browse and download footage shared with you.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {accounts.map((a) => (
            <Card key={a.id} className="flex items-center gap-3 px-4 py-3">
              <span className="text-[var(--text-2)]">
                <ProviderIcon provider={a.provider} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--text)]">{a.label}</div>
                <div className="text-xs text-[var(--text-3)]">{providerName(a.provider)}</div>
              </div>

              {confirmId === a.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-2)]">Remove?</span>
                  <Button variant="danger" onClick={() => removeAccount(a.id)}>
                    Confirm
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmId(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => openProfile(a.id)}>
                    Open <ChevronRight size={14} />
                  </Button>
                  <Button variant="danger" onClick={() => setConfirmId(a.id)} aria-label={`Remove ${a.label}`}>
                    <Trash2 size={16} />
                  </Button>
                </>
              )}
            </Card>
          ))}
        </div>
      )}

      {dialog && <AddAccountDialog provider={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

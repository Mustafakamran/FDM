import { useState } from "react";
import { HardDrive, Box, Plus } from "lucide-react";
import { AddAccountDialog } from "./AddAccountDialog";
import { Card, Button } from "./ui";
import type { Provider } from "../lib/tauri/commands";

export function ConnectView() {
  const [provider, setProvider] = useState<Provider | null>(null);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <Card className="flex max-w-md flex-col items-center gap-4 px-8 py-14 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent-weak)] text-[var(--accent)] shadow-[0_0_44px_var(--accent-glow)]">
          <HardDrive size={24} />
        </div>
        <div>
          <p className="text-sm font-medium text-[var(--text)]">Connect an account</p>
          <p className="mt-1 max-w-sm text-sm text-[var(--text-2)]">
            Add a Google Drive or Dropbox account to browse and download footage shared with you.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setProvider("drive")}>
            <Plus size={16} /> <HardDrive size={16} /> Google Drive
          </Button>
          <Button variant="primary" onClick={() => setProvider("dropbox")}>
            <Plus size={16} /> <Box size={16} /> Dropbox
          </Button>
        </div>
      </Card>
      {provider && <AddAccountDialog provider={provider} onClose={() => setProvider(null)} />}
    </div>
  );
}

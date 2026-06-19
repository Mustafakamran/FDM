import { HardDrive, Box } from "lucide-react";
import type { Provider } from "../lib/tauri/commands";

/** Provider glyph — Drive vs Dropbox. Line icons only, no emoji. */
export function ProviderIcon({ provider, size = 16 }: { provider: Provider; size?: number }) {
  return provider === "drive" ? <HardDrive size={size} /> : <Box size={size} />;
}

export function providerName(provider: Provider): string {
  return provider === "drive" ? "Google Drive" : "Dropbox";
}

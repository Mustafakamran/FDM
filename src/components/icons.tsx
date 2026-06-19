import { GoogleDriveLogo, DropboxLogo } from "./brand";
import type { Provider } from "../lib/tauri/commands";

/** Provider brand logo — real Google Drive / Dropbox marks. */
export function ProviderIcon({ provider, size = 16 }: { provider: Provider; size?: number }) {
  return provider === "drive" ? <GoogleDriveLogo size={size} /> : <DropboxLogo size={size} />;
}

export function providerName(provider: Provider): string {
  return provider === "drive" ? "Google Drive" : "Dropbox";
}

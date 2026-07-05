// Fetch the rqbit BitTorrent engine sidecar for the current Rust target triple
// into src-tauri/binaries, named rqbit-<triple>(.exe) so Tauri bundles it as an
// externalBin sidecar. rqbit is a self-contained single-file torrent client with
// an HTTP API; FDM spawns it as a localhost server (see src-tauri/src/torrent.rs).
import { execSync } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// Pin a stable rqbit release (v9 line is beta as of this writing).
const VERSION = "v8.1.1";

const triple = execSync("rustc -vV")
  .toString()
  .split("\n")
  .find((l) => l.startsWith("host:"))
  .replace("host:", "")
  .trim();

const map = {
  // rqbit ships a universal macOS binary (x86_64 + arm64) — the arm64-static gap
  // that rules out aria2 doesn't exist here.
  "aarch64-apple-darwin": { asset: "rqbit-osx-universal", ext: "" },
  "x86_64-apple-darwin": { asset: "rqbit-osx-universal", ext: "" },
  "x86_64-pc-windows-msvc": { asset: "rqbit.exe", ext: ".exe" },
};
const target = map[triple];
if (!target) throw new Error(`Unsupported triple: ${triple}`);

const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const finalPath = join(outDir, `rqbit-${triple}${target.ext}`);
if (existsSync(finalPath)) {
  console.log(`rqbit sidecar already present: ${finalPath}`);
  process.exit(0);
}

const url = `https://github.com/ikatson/rqbit/releases/download/${VERSION}/${target.asset}`;
console.log(`Downloading ${url}`);
const res = await fetch(url); // follows redirects
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(finalPath));
if (process.platform !== "win32") execSync(`chmod +x '${finalPath}'`);
console.log(`Sidecar ready: ${finalPath}`);

// Fetch the yt-dlp sidecar (social-media video extractor/downloader) for the
// current Rust target triple into src-tauri/binaries, named yt-dlp-<triple>(.exe)
// so Tauri bundles it as an externalBin sidecar. yt-dlp ships self-contained
// single-file binaries (no Python needed); it uses the bundled ffmpeg for merge.
import { execSync } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const triple = execSync("rustc -vV")
  .toString()
  .split("\n")
  .find((l) => l.startsWith("host:"))
  .replace("host:", "")
  .trim();

const map = {
  "x86_64-pc-windows-msvc": { asset: "yt-dlp.exe", ext: ".exe" },
  "aarch64-apple-darwin": { asset: "yt-dlp_macos", ext: "" },
  "x86_64-apple-darwin": { asset: "yt-dlp_macos", ext: "" },
};
const target = map[triple];
if (!target) throw new Error(`Unsupported triple: ${triple}`);

const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const finalPath = join(outDir, `yt-dlp-${triple}${target.ext}`);
if (existsSync(finalPath)) {
  console.log(`yt-dlp sidecar already present: ${finalPath}`);
  process.exit(0);
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${target.asset}`;
console.log(`Downloading ${url}`);
const res = await fetch(url); // follows redirects
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(finalPath));
if (process.platform !== "win32") execSync(`chmod +x '${finalPath}'`);
console.log(`Sidecar ready: ${finalPath}`);

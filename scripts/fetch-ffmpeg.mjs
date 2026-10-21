// Fetch static ffmpeg + ffprobe sidecars for the current Rust target triple and
// place them in src-tauri/binaries named `<tool>-<triple>(.exe)` so Tauri bundles
// them as externalBin sidecars (same pattern as fetch-rclone.mjs).
//
// Sources differ per platform (each provides reliable STATIC builds):
//   - macOS (arm64/amd64): ffmpeg.martin-riedl.de — one zip per tool.
//   - Windows (amd64):      BtbN/FFmpeg-Builds — ONE zip with bin/ffmpeg.exe + ffprobe.exe.
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const triple = execSync("rustc -vV")
  .toString()
  .split("\n")
  .find((l) => l.startsWith("host:"))
  .replace("host:", "")
  .trim();

const map = {
  "x86_64-pc-windows-msvc": { source: "btbn", ext: ".exe" },
  "aarch64-apple-darwin": { source: "martin", platform: "macos", arch: "arm64", ext: "" },
  "x86_64-apple-darwin": { source: "martin", platform: "macos", arch: "amd64", ext: "" },
};
const target = map[triple];
if (!target) throw new Error(`Unsupported triple: ${triple}`);

const TOOLS = ["ffmpeg", "ffprobe"];
const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const finalPath = (tool) => join(outDir, `${tool}-${triple}${target.ext}`);

if (TOOLS.every((t) => existsSync(finalPath(t)))) {
  console.log("ffmpeg/ffprobe sidecars already present");
  process.exit(0);
}

/** Recursively find the first file whose basename is `name` (or `name.exe`). */
function findBinary(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const found = findBinary(p, name);
      if (found) return found;
    } else if (entry === name || entry === `${name}.exe`) {
      return p;
    }
  }
  return null;
}

async function downloadZip(url, zipPath) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url); // follows redirects
  if (!res.ok) throw new Error(`Download failed: ${res.status} (${url})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
}

/** Download `url`, retrying transient failures (e.g. a mirror's 5xx) with backoff. */
async function downloadWithRetry(url, zipPath, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await downloadZip(url, zipPath);
      return;
    } catch (e) {
      lastErr = e;
      const wait = Math.min(30000, 2000 * 2 ** i);
      console.log(`  retry ${i + 1}/${attempts} in ${wait}ms: ${e.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/** Try each candidate URL (with retries) until one downloads - so one mirror
 *  being down (martin-riedl has returned 521 for hours at a time) doesn't fail
 *  the whole release build. */
async function downloadFirst(urls, zipPath) {
  let lastErr;
  for (const url of urls) {
    try {
      await downloadWithRetry(url, zipPath, 3);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`  source unavailable, trying next: ${url}`);
    }
  }
  throw lastErr ?? new Error("no download sources");
}

function extractZip(zipPath, dir) {
  if (process.platform === "win32") {
    spawnSync("powershell", ["-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${dir}' -Force`], { stdio: "inherit" });
  } else {
    spawnSync("unzip", ["-o", zipPath, "-d", dir], { stdio: "inherit" });
  }
}

function place(srcBin, tool) {
  // copy (not rename) — temp dir and repo can be on different drives on CI.
  copyFileSync(srcBin, finalPath(tool));
  if (process.platform !== "win32") execSync(`chmod +x '${finalPath(tool)}'`);
  console.log(`Sidecar ready: ${finalPath(tool)}`);
}

const work = join(tmpdir(), `ffmpeg-dl-${process.pid}`);
mkdirSync(work, { recursive: true });

if (target.source === "btbn") {
  // One combined GPL static zip containing bin/ffmpeg.exe + bin/ffprobe.exe.
  const url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
  const zipPath = join(work, "ffmpeg-win64.zip");
  await downloadWithRetry(url, zipPath);
  extractZip(zipPath, work);
  for (const tool of TOOLS) {
    const bin = findBinary(work, tool);
    if (!bin) throw new Error(`${tool} binary not found in archive`);
    place(bin, tool);
  }
} else {
  // macOS: one zip per tool. Primary mirror is martin-riedl; osxexperts is a
  // fallback for arm64 when the primary is down (seen returning 521 for hours).
  const osxExperts = {
    arm64: { ffmpeg: "https://www.osxexperts.net/ffmpeg711arm.zip", ffprobe: "https://www.osxexperts.net/ffprobe711arm.zip" },
  };
  for (const tool of TOOLS) {
    if (existsSync(finalPath(tool))) {
      console.log(`${tool} sidecar already present`);
      continue;
    }
    const urls = [
      `https://ffmpeg.martin-riedl.de/redirect/latest/${target.platform}/${target.arch}/release/${tool}.zip`,
      osxExperts[target.arch]?.[tool],
    ].filter(Boolean);
    const zipPath = join(work, `${tool}.zip`);
    await downloadFirst(urls, zipPath);
    extractZip(zipPath, work);
    const bin = findBinary(work, tool);
    if (!bin) throw new Error(`${tool} binary not found in archive`);
    place(bin, tool);
  }
}

rmSync(work, { recursive: true, force: true });

// Fetch static ffmpeg + ffprobe sidecars for the current Rust target triple and
// place them in src-tauri/binaries named `<tool>-<triple>(.exe)` so Tauri bundles
// them as externalBin sidecars (same pattern as fetch-rclone.mjs).
//
// Source: ffmpeg.martin-riedl.de — static builds for macOS (arm64/amd64) and
// Windows (amd64), uniform redirect URLs that resolve to a versioned zip
// containing a single binary.
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
  "x86_64-pc-windows-msvc": { platform: "windows", arch: "amd64", ext: ".exe" },
  "aarch64-apple-darwin": { platform: "macos", arch: "arm64", ext: "" },
  "x86_64-apple-darwin": { platform: "macos", arch: "amd64", ext: "" },
};
const target = map[triple];
if (!target) throw new Error(`Unsupported triple: ${triple}`);

const outDir = join("src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });

/** Recursively find the first file whose basename is `name` (or `name.exe`). */
function findBinary(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      const found = findBinary(p, name);
      if (found) return found;
    } else if (entry === name || entry === `${name}.exe`) {
      return p;
    }
  }
  return null;
}

for (const tool of ["ffmpeg", "ffprobe"]) {
  const finalPath = join(outDir, `${tool}-${triple}${target.ext}`);
  if (existsSync(finalPath)) {
    console.log(`${tool} sidecar already present: ${finalPath}`);
    continue;
  }

  const url = `https://ffmpeg.martin-riedl.de/redirect/latest/${target.platform}/${target.arch}/release/${tool}.zip`;
  const work = join(tmpdir(), `${tool}-dl-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const zipPath = join(work, `${tool}.zip`);

  console.log(`Downloading ${url}`);
  const res = await fetch(url); // fetch follows the 307 redirect to the versioned zip
  if (!res.ok) throw new Error(`Download failed for ${tool}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));

  if (process.platform === "win32") {
    spawnSync("powershell", ["-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${work}' -Force`], { stdio: "inherit" });
  } else {
    spawnSync("unzip", ["-o", zipPath, "-d", work], { stdio: "inherit" });
  }

  const bin = findBinary(work, tool);
  if (!bin) throw new Error(`${tool} binary not found in archive`);
  // copy (not rename) — temp dir and repo can be on different drives on CI.
  copyFileSync(bin, finalPath);
  if (process.platform !== "win32") execSync(`chmod +x '${finalPath}'`);
  rmSync(work, { recursive: true, force: true });
  console.log(`Sidecar ready: ${finalPath}`);
}

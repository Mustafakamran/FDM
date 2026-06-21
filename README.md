# Footage Download Manager (FDM)

A desktop app for downloading large RAW video assets (SLOG/CLOG, 300–500 GB+)
that clients share with you on **Google Drive** ("Shared with me") and **Dropbox**,
straight to a connected external drive — with multi-account profiles, live progress,
tuned throughput, and hash-verified transfers.

Built with **Tauri 2** (Rust core) + **React/TypeScript/Tailwind**, using **rclone**
as the download engine (bundled). Runs on **Windows** (primary) and **macOS**.

---

## How it works

- The app starts the bundled `rclone` as a local remote-control daemon. All cloud
  access goes through it (proper Drive/Dropbox APIs, ranged multi-thread streams for
  big single files, parallel file transfers, hash verification).
- Each connected account = one rclone remote = one **profile tab**.
- Downloads run in the daemon, independent of which tab you're viewing; the global
  **Transfers** dock shows every job's progress, speed, and ETA.
- Your OAuth credentials live in the OS keychain (Windows Credential Manager / macOS
  Keychain). Account tokens live in rclone's config in the app data dir.

---

## Prerequisites (dev / building)

- **Node.js 18+** and **Rust** (stable, via [rustup](https://rustup.rs)).
- **Windows:** WebView2 (preinstalled on Win 10/11) + **Visual Studio C++ Build Tools**
  (for the Rust MSVC toolchain).
- **macOS:** Xcode Command Line Tools.

## Setup & run

```bash
npm install
npm run fetch:rclone      # downloads the rclone binary for your OS into src-tauri/binaries
npm run tauri dev         # launches the app
```

## Building installers (macOS + Windows)

Tauri builds for the OS you run it on (you can't cross-compile Win↔Mac), so build each on its own machine — or use the included CI to build both at once.

**On a Mac** (produces `.app` + `.dmg` in `src-tauri/target/release/bundle/`):

```bash
npm install
npm run fetch:rclone
npm run tauri build            # add: -- --target aarch64-apple-darwin  (Apple Silicon)
```

**On the Windows PC** (produces an NSIS `.exe` + `.msi` installer under `src-tauri/target/release/bundle/`):

```bash
npm install
npm run fetch:rclone           # downloads the Windows rclone sidecar
npm run tauri build
```
Windows prerequisites: the MSVC C++ Build Tools (for Rust) and WebView2 (preinstalled on Win 10/11).

**Both at once via CI (recommended for Windows):** push to GitHub and run the `build` workflow (`.github/workflows/build.yml`) — it builds macOS + Windows installers on GitHub's runners and **publishes** them to a release (with a signed `latest.json` so installed apps can self-update). Trigger it manually (Actions → build → Run) or by pushing a `vX.Y.Z` tag. See **Auto-update** below for the one-time signing-secret setup.

> Notes: the rclone binary is fetched per-OS (not committed), so run `npm run fetch:rclone` before building on each machine. The window uses transparency/rounded corners (macOS private API) — fine for local/self distribution; for the Mac App Store you'd disable `macOSPrivateApi`.

---

## One-time: create your own OAuth credentials

The app uses **your own** OAuth app credentials (your dedicated API quota = consistent
speed, no shared-client rate limits). You enter them once in **Settings**.

### Google Drive

1. Open the [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **OAuth consent screen:** User type **External**. Add yourself as a **Test user**
   (Testing mode), or **Publish** to Production. Scope needed: `.../auth/drive.readonly`.
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app.**
5. Copy the **Client ID** and **Client secret**.
6. In the app: **Settings → Google Drive API →** paste both → **Save**.

> Note: `drive.readonly` is a "restricted" scope. For personal/own-account use, Testing
> mode (with yourself as a test user) or unverified Production works fine — you'll click
> through a one-time "unverified app" screen on first sign-in; tokens then persist.

### Dropbox

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**.
2. **Scoped access**, access type **Full Dropbox** (or App folder if that fits).
3. Under **Permissions**, enable the read scopes rclone needs:
   `account_info.read`, `files.metadata.read`, `files.content.read`, `sharing.read`.
4. On the **Settings** tab, copy the **App key** and **App secret**.
5. In the app: **Settings → Dropbox API →** paste both → **Save**.

---

## Using it

1. **Settings:** set a **default download folder** (your external drive, e.g. `E:\Footage`)
   and pick a **Performance** preset (**Turbo** for a fast line; **Gentle** to share the
   pipe). Tune parallel files / streams-per-file / cutoff / bandwidth if you like.
2. **Accounts → Add Google Drive / Add Dropbox →** name the account (e.g. "Client A") →
   a browser opens for sign-in/consent → the account appears as a profile tab.
3. **Open a profile tab →** browse "Shared with me" (Drive) or your Dropbox; sizes show
   per file; multi-select files/folders; the bar shows the total selected size.
4. **Download** → goes to your default folder (or pick one). Watch the **Transfers** dock;
   downloads keep running while you browse other profiles.

### Downloading from a shared link (no storage of your own used)

If a client sends a **share link** instead of sharing into your account — or your own
Drive/Dropbox is full — add the link directly. **Nothing is copied into your cloud**;
files stream straight from the link to your disk, and the link browses/queues/downloads
exactly like a normal account.

- **Accounts → `+` → Shared link →** paste the URL + a name.
- **Google Drive** links use one of your connected Google logins to open the folder
  (rooted at the folder id). Requires a connected Drive account; the folder must be
  "anyone with the link" or shared to that account.
- **Dropbox** links use the native Dropbox API (rclone can't browse a bare share link),
  borrowing a connected Dropbox login's token to list + stream the files. Requires a
  connected Dropbox account.

---

## Auto-update (OTA)

The app checks for updates on launch (and via **Settings → Updates → Check for updates**).
When a newer release is published, a banner offers **Install & restart** — it downloads the
signed update and relaunches. Updates are verified against a bundled public key, so only
releases signed with **your** private key are accepted.

**One-time CI setup** (so the published `latest.json` is signed and the OTA endpoint works):

1. The signing keypair was generated locally. The **public** key is committed in
   `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`); the **private** key is in
   `.tauri/signing.key` and is **git-ignored — never commit it**.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `.tauri/signing.key`.
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — leave empty (the key has no password).
3. Push a `vX.Y.Z` tag (matching `version` in `tauri.conf.json`). CI builds, signs, and
   publishes the release with installers + `latest.json`. Installed apps pick it up from
   `releases/latest/download/latest.json`.

> If you lose `.tauri/signing.key`, generate a new pair (`npx tauri signer generate -w
> .tauri/signing.key`), replace the pubkey in `tauri.conf.json`, and ship one update built
> with the new key before older installs can update again.

---

## Performance notes

- The lever for a single 300 GB+ file is **streams per file** (multi-thread streams);
  parallel-files helps batches of many files.
- True ceiling is the smallest of: your internet line, the provider's per-account
  throttle, and your **external-drive write speed**. The status bar shows live throughput.
- Every transfer is hash-verified by rclone (Drive MD5 / Dropbox content-hash).

## Project layout

- `src/` — React UI (components, Zustand stores, rc client, tauri command wrappers).
- `src-tauri/src/` — Rust: `rclone/` (supervisor + rc client), `accounts.rs`, `download.rs`,
  `secrets.rs` (keychain).
- `docs/superpowers/` — design spec and implementation plan.

## Tests

```bash
npm test                                              # frontend (Vitest)
cargo test --manifest-path src-tauri/Cargo.toml       # Rust (incl. real local-copy integration test)
```

# Drive + Dropbox Downloader — Design Spec

**Date:** 2026-06-19
**Status:** Approved (design phase)
**Owner:** user

---

## 1. Purpose

A polished desktop application for downloading large RAW video assets (SLOG/CLOG,
300–500 GB+ per job, sometimes more) delivered by clients via Google Drive
("Shared with me") and Dropbox. Optimized for **consistent high throughput** on a
fast internet line, writing directly to a connected external drive, with live
visibility into progress, file sizes, speed, ETA, and the real bottleneck.

### Primary user & context
- Single owner; the owner and a small team all use the **owner's accounts**.
- Owner connects **2–3 Google accounts and 2–3 Dropbox accounts**.
- Primary machine: a dedicated **Windows** download PC. Also runs on **macOS**.
- Destination: a connected external drive, with a user-selectable folder per job.

### Success criteria
- Connect multiple Google + Dropbox accounts with a near one-click flow.
- Browse each account's files/folders with sizes visible before downloading.
- Saturate the available pipeline for large single files and many-file batches.
- Downloads keep running independently while the user browses other accounts.
- Every completed file is hash-verified (no silent corruption of footage).
- Interrupted transfers resume; queue survives app restart.

### Non-goals (YAGNI)
- No uploading.
- No public-link / anyone-with-link downloads in v1 (auth'd accounts only).
- No team SSO / multi-tenant auth (all accounts belong to the owner).
- No cloud sync of app state between machines.
- No video preview/playback or transcoding.

---

## 2. Stack

- **Shell:** Tauri (Rust core + web frontend). Small binary, native webview, low RAM.
- **Frontend:** React + TypeScript + Tailwind CSS. Icon set: **Lucide** (SVG line icons).
  State: lightweight store (Zustand). Data fetching/polling: TanStack Query.
- **Engine:** **rclone**, bundled as a Tauri **sidecar** binary (`rclone.exe` / `rclone`),
  run in daemon mode (`rclone rcd`) exposing its remote-control (rc) HTTP API on
  `127.0.0.1:<random port>` secured with a per-session auth token.
- **Auth/secrets:** OAuth tokens + rclone config stored in the app data dir; secrets
  encrypted via OS keychain (Windows Credential Manager / macOS Keychain).
- **Packaging:** Windows installer built on the Windows PC (or CI); macOS build on Mac.

### Why this stack
- rclone is purpose-built for Drive + Dropbox: proper API auth, ranged multi-thread
  streams for big single files, parallel file transfers, and built-in hash verify.
- The rc API gives browse, async download jobs, and live stats through one interface —
  no fragile log scraping, no separate Google/Dropbox SDKs.
- Tauri delivers a native, lightweight, professional app and can bundle/supervise the
  rclone process cleanly.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Tauri App                                                 │
│  ┌──────────────────┐        ┌───────────────────────────┐│
│  │ React UI         │◄─IPC──►│ Rust core                 ││
│  │ (tabs, browse,   │        │ - spawn/supervise rclone  ││
│  │  transfers dock) │        │ - native folder picker    ││
│  └────────┬─────────┘        │ - keychain secret store   ││
│           │ HTTP (rc + token)│ - disk free / write stats ││
│           └──────────────────┤ - queue persistence       ││
│                       ┌───────▼───────────┐               ││
│                       │ rclone daemon     │               ││
│                       │ rcd --rc          │               ││
│                       └───────┬───────────┘               ││
└────────────────────────────────┼─────────────────────────┘
                     ┌────────────┴───────────┐
                Google Drive               Dropbox
              (per-account remote)     (per-account remote)
```

### Core units (each independently understandable/testable)
1. **rclone supervisor (Rust):** locate/launch sidecar, health-check, restart on crash,
   own the rc port + token, shut down cleanly on app exit.
2. **rc client (TS):** typed wrapper over rclone rc calls (`operations/list`,
   `sync/copy` async, `job/status`, `job/stop`, `core/stats`, `config/create`,
   `config/delete`). Single source of truth for engine interaction.
3. **Account manager:** add/remove accounts → create/delete rclone remotes; persist
   account metadata (provider, email, default folder); store tokens in keychain.
4. **Job manager:** create download jobs, map jobs↔accounts, persist queue to disk,
   restore on launch, expose unified job state to the UI.
5. **Arg/preset builder (Rust + TS):** translate user settings + presets into rclone
   flags (transfers, multi-thread streams, chunk sizes, scope). Pure, unit-testable.
6. **Native bridge (Rust):** folder picker dialog, destination free-space + live disk
   write-rate sampling, keychain read/write.
7. **UI layer:** tabs, browse view, global transfers dock, settings, history, accounts.

### Account = rclone remote mapping
- "Add Google" → OAuth → remote `gdrive_<sanitized-email>` with `scope = drive.readonly`
  and `--drive-shared-with-me` applied on list/copy.
- "Add Dropbox" → OAuth → remote `dropbox_<sanitized-email>`.
- A **profile/tab** is exactly one remote (`Provider · email`).

---

## 4. Authentication

- **One owner-registered OAuth client per provider**, shipped with the app:
  - Google: a Desktop OAuth client set to **Production (unverified)**. Each account
    consents once (one-time "unverified app → Advanced → Proceed"); refresh tokens
    persist — **no weekly re-login**. Scope: `drive.readonly`.
  - Dropbox: one app key with **Production** status (free, lightweight approval).
- Flow: user clicks **Add Google / Add Dropbox** → system browser opens consent →
  rclone captures the token (`config/create` with OAuth) → remote created → tab opens.
- All tokens encrypted at rest in the OS keychain. Remove account → delete remote +
  purge token.
- Rationale recorded: owner controls all accounts, so a single owner-registered client
  gives best/most consistent API quota with no per-user key setup and no Google CASA
  verification cost.

---

## 5. Performance / speed tuning

Tuned defaults for large RAW media; all overridable in Settings:
- `--transfers N` — parallel **files** (default 4).
- `--multi-thread-streams S` with `--multi-thread-cutoff 250M` — split one large file
  into ranged streams (the lever that helps 300 GB+ single files).
- `--drive-chunk-size 256M`; large Dropbox upload/download chunk — fewer round-trips.
- `--drive-shared-with-me` on Drive remotes.
- `--checksum`-based verification after transfer.
- **"Turbo" preset** for a high-speed line (raises transfers/streams/chunk); **"Gentle"**
  preset to cap concurrency when the disk or network is shared.
- **Cross-profile parallelism:** jobs from different profiles run concurrently in the
  daemon; total concurrency capped to protect the destination disk.
- **Honest ceiling:** throughput is bounded by the smallest of {internet line,
  provider per-account throttle, **external-drive write speed**}. The UI surfaces live
  disk write speed + free space so the bottleneck is always visible.

---

## 6. Reliability

- **Resume / retry:** rclone auto-retries with backoff; partial data never overwrites a
  good final file (atomic finalize). Interrupted jobs resume rather than restart whole.
- **Verification:** post-transfer hash check (Drive MD5 / Dropbox content-hash). History
  records verified ✓ / failed state per file.
- **Network drops:** job enters "retrying" state, not "failed"; auto-recovers.
- **Quota / throttle:** detected from rclone errors → job auto-pauses with a clear
  message instead of silently stalling.
- **Crash recovery:** job queue + open tabs persisted to disk; on relaunch the app
  restores tabs and offers to resume unfinished jobs.
- **rclone crash:** supervisor restarts the daemon and reattaches tracked jobs.

---

## 7. UX & screens

Browser-style, tab-driven. Each open profile is a persistent tab; downloads are global
and decoupled from the active tab.

### Layout
```
┌──────────────────────────────────────────────────────────────────┐
│ [Drive·E1@..] [Dropbox·E2@..] [Drive·E3@..] [ + ]                 │ profile tabs
├────────────────────────────────────────────┬─────────────────────┤
│  ACTIVE TAB — browse this profile            │  TRANSFERS  ◀ / ▶   │ global dock
│  folder tree │ file list (name, size, modif) │  grouped by profile │
│  selection summary  [ Download ▾ ]           │  job cards: % / MB/s│
│                                              │  / ETA / pause-cancel│
├──────────────────────────────────────────────┴─────────────────────┤
│ status bar: total throughput · active count · disk write · free space│
└──────────────────────────────────────────────────────────────────────┘
```

### Screens
1. **Tabs (profiles):** persistent, restored on launch. `+` opens Accounts to connect or
   reopen a profile. Each tab scoped to one account's remote.
2. **Browse (per tab):** folder tree (Drive defaults to "Shared with me"); file list with
   name, **size**, type, modified; multi-select files/folders; running **"Selected: NNN GB"**
   total; **Download** (uses account default folder or per-job override via native picker).
3. **Transfers dock (global):** always visible, collapsible to a thin strip showing total
   speed + active count. Job cards grouped by profile, each: file/job name, progress, live
   speed, ETA, per-job pause/resume/cancel. Survives tab switches and app restart.
4. **History:** completed jobs — size, duration, average speed, verify status, destination.
5. **Settings:** default download folder, per-account default folders, auto-subfolder rule
   (by client/date), max parallel transfers, multi-thread streams, chunk size, bandwidth
   cap (optional), presets (Turbo/Gentle), connected accounts.
6. **Accounts:** connected accounts grouped by provider (email + status); Add Google,
   Add Dropbox, Remove. Drives which profiles are available as tabs.

### Destination control
- Global default folder set in Settings (e.g. `E:\Footage`).
- Optional per-account default folder.
- Per-job override via native Windows/macOS folder picker.
- Optional auto-subfolder by client name or date.

---

## 8. Visual design language

Professional, dark, dense-but-calm. Reference quality: Linear, Vercel, Raycast, Arc.
**No emoji anywhere** — all iconography is Lucide SVG line icons at consistent stroke.

### Theme
- **Dark-first** (primary and only theme for v1).
- Layered elevation, not borders-everywhere:
  - Base background: near-black, slightly cool (e.g. `#0A0B0D`).
  - Panels/surfaces: `#121419`. Cards/rows: `#191C22`. Hover: `#1F232A`.
  - Hairline borders: `#262A31` used sparingly for structural separation only.
- **Text:** primary `#E6E8EB`, secondary `#9BA1A8`, muted `#6B7178`. WCAG AA minimum.
- **Single restrained accent** (cool signal blue, e.g. `#4C8DFF`) used only for: primary
  actions, active tab, progress fill, selection. Never decorative.
- **Semantic colors:** success/verified, warning/throttled, error/failed — desaturated to
  fit the dark palette, never neon.

### Typography
- UI font: Inter (or Geist). Tight, modern, legible at small sizes.
- **Monospace with tabular numbers** (JetBrains Mono / Geist Mono) for all metrics —
  sizes, speeds, ETAs, percentages — so digits don't jitter as they update.
- Clear type scale; restrained weights (regular / medium / semibold).

### Layout & motion
- 8px spacing grid; generous-but-efficient density (data tool, not a marketing page).
- Smooth, subtle progress and state transitions (no bouncy/“fun” animation).
- Skeleton loaders for browse fetches; optimistic, quiet UI.
- Empty states are designed (e.g. "No accounts connected — Add Google / Add Dropbox").

### Components (custom, themed)
- Tab bar with active indicator (accent underline/fill).
- File table: dense rows, right-aligned tabular sizes, sortable columns.
- Progress card: thin progress bar, mono speed/ETA, compact controls.
- Status bar: live throughput, active count, disk write rate, free space.
- Buttons/inputs/selects: consistent radius (small, ~6–8px), focus rings on accent.

> The frontend-design skill will be invoked during implementation to execute this
> language to a high standard; this section defines the target.

---

## 9. Testing strategy

- **Rust:** unit tests for arg/preset builder; supervisor lifecycle; queue persistence.
- **rc client (TS):** unit tests against a mocked rc API; contract tests for each call.
- **Integration:** drive a real rclone daemon against a small real test remote
  (Drive + Dropbox) — list, copy, stats, stop, verify.
- **Frontend:** component tests for tabs, browse table, transfers dock, settings.
- **Manual E2E:** real "Shared with me" Drive folder + Dropbox folder → external drive;
  validate sizes, parallel cross-profile downloads, pause/resume, restart recovery,
  hash verification, bottleneck readout.

---

## 10. Open items / future (post-v1)
- Optional public-link (anyone-with-link) downloads.
- Optional light theme.
- Bandwidth scheduling (time-of-day caps).
- Notifications on job completion.
- Optional checksum report export per delivery (client handoff).

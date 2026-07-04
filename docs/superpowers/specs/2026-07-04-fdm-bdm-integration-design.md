# FDM ⇄ BDM Integration — Design Spec

**Date:** 2026-07-04
**Status:** Draft for review
**Repos:** FDM (this repo, Tauri desktop, ships via OTA) · BDM (`zainansari81-art/bilal-drive-man`, Next.js+Supabase, ships via Vercel; Zain's production — branch + PR only, never push `main`)

## 1. Goal

Make an FDM install act as a first-class **download machine** in the BDM fleet: BDM assigns a project to the FDM PC, FDM downloads it (through the operator's chosen connected account) to a local folder, reports status, and BDM's copy-to-drive moves it onto a USB. Plus the discovery/inventory features that let FDM feed BDM and dedupe against it.

## 2. Hard constraint: nothing breaks FDM or BDM

FDM (OTA) and BDM (Vercel) deploy independently, so **every change must tolerate the other side being an old version**, and BDM's native Python scanners (AAHIL, DOWNLOADINGPC2) must see **zero** behavior change.

Invariants:
1. **Opt-in & isolated.** The BDM agent stays off by default (enabled in Settings). FDM changes are confined to `bdm.rs` + new focused modules; manual download / review / search are untouched.
2. **Version-skew safe** — all four combos work: old/old (today), new-FDM/old-BDM (safety whitelist works standalone; account dropdown simply not offered), new/new (full pipeline), old-FDM/new-BDM (BDM additions are optional fields old FDM ignores).
3. **Additive-only on BDM.** New *optional* columns/payload fields. The account dropdown renders only for FDM-class machines. `cloud_account_id` is already a field native scanners ignore.
4. **Process.** Branch + PR to Zain for every BDM change. Both CIs green + full test suites before merge. FDM window/capability changes live-tested on the Mac (see project memory `launch-path-verification`).

## 3. The pipeline

FDM is a **standalone BDM machine** (name e.g. `FDM-PC1`). No native Python scanner on the FDM PC — FDM replaces it there; native scanners keep running on their own PCs. BDM assigns each project to exactly one machine.

Flow for an FDM-assigned project:
1. Operator picks the project + `FDM-PC1` in BDM, picks a **connected account** from a provider-filtered dropdown (Dropbox link → only FDM's Dropbox accounts, etc.), hits Download.
2. BDM enqueues its commands attributing the download to `{cloud_account_id, download_link}`.
3. FDM agent polls, detects the provider from the link (`link_type()` — already exists), and **downloads through the chosen account's credentials/access** using FDM's parallel resumable engine, into `dest_root/client/couple` on the FDM PC.
4. FDM reports progress + local path (`cloud_folder_path`) + `completed`.
5. BDM sends `copy_to_drive` → FDM copies local → the plugged-in USB (fast local copy) and reports which USBs it sees via heartbeat.

Provider notes: the download goes through the account the operator would normally browse to (respects multi-account, e.g. `filmsbyrafay`), NOT blind-link download. Optional auto-detect pre-selects the account via the existing `locate` feature; blind-link (BDM app creds / anonymous link) is the fallback when the project isn't in any connected account.

## 4. Command mapping (the correctness core)

FDM stops doing "everything = download" and dispatches each BDM command explicitly:

| BDM command | FDM behavior | Bug it kills |
|---|---|---|
| `add_to_cloud` | **Ack, no-op** (FDM downloads directly; nothing to mount) | — |
| `start_download` | **The one download.** Fetch project → detect provider → download via selected account → report path/progress/completed. If `target_drive` set, auto-chain the copy. | **2× download** |
| `copy_to_drive` | Copy local `client/couple` → resolved USB, report copying progress | — |
| `cancel_download` | **Cancel** the in-flight job | **cancel→download** |
| `delete_data` | Ack no-op initially (implement later; never auto-delete) | delete→download |
| `locate` | Existing read-only account search (unchanged) | — |
| *anything else* | **Ack, no side effect** (safety whitelist) | future drift |

Keying the real download on `start_download` (always emitted by BDM) while `add_to_cloud` is a benign ack structurally prevents the double-download with no state-tracking.

## 5. Account selection reuses BDM's own half-built mechanism

BDM already carries `cloud_account_id` in `download_now` and has an unused `cloud_accounts` table designed for multi-account routing. We finish it: FDM reports its connected accounts in the heartbeat → BDM populates `cloud_accounts` for that machine → the wizard shows a provider-filtered dropdown → the chosen `cloud_account_id` travels with the command → FDM downloads via that account.

## 6. Phases (sequenced; each independently safe to ship)

**Prerequisite fixes (DONE this session, verified):**
- Drive folder duplication → unique React key (`item.ID ?? item.Path`).
- 50TB crawl inflation → `retain_unseen` ID-dedup in the BFS crawl.

**A. Worker download pipeline**
- **A1 (FDM-only):** command safety whitelist in `bdm.rs`. Kills 2×/cancel bugs. Ship + live-test alone.
- **A2 (FDM-only):** report connected accounts in heartbeat (additive; BDM ignores until updated).
- **A3 (FDM-only):** copy-to-drive handler + USB enumeration + volume-label→path resolver.
- **A4 (BDM PR):** finish `cloud_accounts` + provider-filtered account dropdown for FDM machines + pass `cloud_account_id`.
- **A5 (FDM):** download through the selected account (consume `cloud_account_id`; blind-link fallback).

**B. Dropbox shared-link downloads in FDM** — native `sharing/get_shared_link_file` via `scanner-credentials?provider=dropbox`; removes the AAHIL dependency. Own spec.

**C. Per-file failure manifest** — FDM reports file list + failed files → fixes BDM's "partial-failure shows green." BDM additive endpoint/field.

**D. New-folders discovery feeder** — FDM's new-folders → BDM candidate projects (x-api-key endpoint on BDM).

**E. Drive-inventory cross-check** — FDM reads BDM `/api/drives` + `/api/devices` (needs x-api-key access to those reads) to dedupe before downloading.

**F. Drive listing correctness + type labels** — ID-as-identity for navigate/download/select (disambiguate same-named Drive folders); Owned / Shared-with-me(by whom) / Shortcut→target badges via the Drive API. Extends the two fixes already landed.

## 7. Testing

- FDM: unit tests for command dispatch (whitelist), volume-label resolver, account-report shape; existing suites stay green; live-test the agent on the Mac against a BDM test project (WeTransfer first).
- BDM: additive-column migration + endpoint tests; verify native-scanner path unchanged; branch + PR + CI.

## 8. Open items / dependencies

- BDM PRs (A4, C, D, E) need Zain's review + merge; live E2E needs a BDM test project assigned to `FDM-PC1`.
- `dest_root` default = a local folder on the FDM PC (e.g. under Desktop), operator-configurable.

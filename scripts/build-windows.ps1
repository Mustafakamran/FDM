# Footage Download Manager — one-shot Windows build.
# Installs prerequisites (Git, Node LTS, Rust MSVC, VS C++ Build Tools) via winget,
# then installs deps, fetches the rclone sidecar, and builds the installers.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
# (or just double-click scripts\build-windows.bat)

$ErrorActionPreference = "Stop"

# --- Re-launch elevated (VS Build Tools needs admin) -------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host "Requesting administrator rights..." -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

# Start in the repo root (whether run from repo\scripts or standalone).
if (Test-Path "$PSScriptRoot\..\package.json") { Set-Location (Resolve-Path "$PSScriptRoot\..") }
else { Set-Location $PSScriptRoot }

function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user;$env:USERPROFILE\.cargo\bin"
}

Write-Host "`n== Footage Download Manager :: Windows build ==`n" -ForegroundColor Cyan

if (-not (Have winget)) {
  throw "winget not found. Install 'App Installer' from the Microsoft Store (Windows 10 21H1+/11), then re-run."
}

function Ensure-Tool($id, $cmd) {
  if (Have $cmd) { Write-Host "  [ok] $cmd" -ForegroundColor DarkGray; return }
  Write-Host "  [install] $id" -ForegroundColor Yellow
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
}

# 1) Prerequisites
Ensure-Tool "Git.Git" "git"
Ensure-Tool "OpenJS.NodeJS.LTS" "node"
Ensure-Tool "Rustlang.Rustup" "rustc"

# Visual Studio C++ Build Tools (Rust's MSVC linker)
$vsRoots = @(
  "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",
  "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools",
  "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community"
)
if (-not ($vsRoots | Where-Object { Test-Path $_ })) {
  Write-Host "  [install] Visual Studio C++ Build Tools (large, a few minutes)" -ForegroundColor Yellow
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --silent `
    --accept-source-agreements --accept-package-agreements `
    --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
}
Refresh-Path

if (Have rustup) { rustup default stable-x86_64-pc-windows-msvc 2>$null | Out-Null }
Refresh-Path

# 2) Source (clone if the script was run on its own)
if (-not (Test-Path ".\package.json")) {
  Write-Host "  [clone] Mustafakamran/footage-download-manager" -ForegroundColor Yellow
  if (Have gh) { gh repo clone Mustafakamran/footage-download-manager }
  else { git clone https://github.com/Mustafakamran/footage-download-manager.git }
  Set-Location footage-download-manager
}

# 3) Build
Write-Host "`n  [npm] installing dependencies..." -ForegroundColor Yellow
npm install
Write-Host "  [rclone] fetching sidecar binary..." -ForegroundColor Yellow
npm run fetch:rclone
Write-Host "  [tauri] building app (this takes a few minutes)...`n" -ForegroundColor Yellow
npm run tauri build

Write-Host "`nBuild complete. Installers:" -ForegroundColor Green
Get-ChildItem -Recurse -ErrorAction SilentlyContinue `
  "src-tauri\target\release\bundle\nsis\*.exe", `
  "src-tauri\target\release\bundle\msi\*.msi" |
  ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Green }

Write-Host "`nPress Enter to close..."
[void][System.Console]::ReadLine()

@echo off
REM Double-click to build Footage Download Manager on Windows.
REM Runs the PowerShell installer/build script (which self-elevates).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1"

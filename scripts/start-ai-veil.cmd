@echo off
rem AI-Veil one-click launcher (Windows). Double-click this file.
rem All the hard-won environment handling lives in scripts/launch.js:
rem   - removes ELECTRON_RUN_AS_NODE (presence-only variable that forces node mode)
rem   - prefers an Electron runtime on an ASCII-only path (Chinese paths crash with 0xc0000005)
rem   - adds --no-sandbox --disable-gpu for restricted environments
rem   - launches detached, so this window closes immediately
setlocal
cd /d "%~dp0.."
if not exist "scripts\launch.js" (
  echo [AI-Veil] scripts\launch.js not found
  pause
  exit /b 1
)
node scripts\launch.js --adapter file %*
if errorlevel 1 pause

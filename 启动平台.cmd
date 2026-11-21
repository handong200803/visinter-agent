@echo off
REM VisInter-Agent launcher shell (ASCII only: cmd renders before chcp 65001)
REM All logic lives in tools/launch.mjs (port discovery, health gate, single instance).
setlocal
title VisInter-Agent

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js 22 or newer is required. Download: https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 22 (
  echo [X] Node.js 22 or newer is required. Found major version !NODE_MAJOR!.
  pause
  exit /b 1
)

node "%~dp0tools\launch.mjs" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo [!] Launcher exited with code %RC%. See messages above.
  pause
)
exit /b %RC%

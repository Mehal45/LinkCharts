@echo off
rem Double-click to start LinkCharts on Windows. Keep this window open while you use it.
title LinkCharts
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Opening https://nodejs.org - install the "LTS" version, then double-click this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node server.mjs --open
pause

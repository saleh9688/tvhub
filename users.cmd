@echo off
title TV Hub - accounts
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but not installed.
  echo   Get it from: https://nodejs.org
  echo.
  pause
  exit /b 1
)

node tools\users.cjs %*
echo.
pause

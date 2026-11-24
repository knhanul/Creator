@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12+ is required. Install from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\electron" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Install failed. Check your internet connection and Node.js version.
    pause
    exit /b 1
  )
)
call npm run dev
pause

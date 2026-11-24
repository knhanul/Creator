@echo off
cd /d "%~dp0"
if not exist "node_modules\electron" (
  call npm install
  if errorlevel 1 exit /b 1
)
call npm run check
if errorlevel 1 (
  echo Quality checks failed. Please fix errors before packaging.
  pause
  exit /b 1
)
call npm run dist:win
pause

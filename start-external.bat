@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Install Node.js, then try again.
    pause
    exit /b 1
)

where cloudflared >nul 2>nul
if errorlevel 1 (
    echo cloudflared was not found.
    echo Install it with: winget install --id Cloudflare.cloudflared
    echo Then close and reopen this window and run this file again.
    pause
    exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found. Install Python 3, then try again.
    pause
    exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
    echo Installing project dependencies...
    call npm install
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

echo Checking Excel processing dependencies...
python scripts\ensure-python-deps.py
if errorlevel 1 (
    echo Python dependency setup failed.
    pause
    exit /b 1
)

echo Starting production app and temporary public HTTPS tunnel...
echo Press Ctrl+C to stop.
call npm run external
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo The external server stopped with an error.
    pause
)

exit /b %EXIT_CODE%

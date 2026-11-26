@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Install Node.js, then try again.
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

echo.
echo On a phone connected to the same Wi-Fi, open:
echo Example: http://192.168.1.25:4173
echo Find the computer IP address with: ipconfig
echo Allow Node.js through the firewall on private networks if needed.
echo On this computer, open http://localhost:4173 to set the owner password or sign in.
echo This command builds the frontend and starts the frontend and API together.
echo Access is limited to devices on the same private IPv4 network.
echo Press Ctrl+C to stop the server.
echo.

set "BINKSALAD_HOST=0.0.0.0"
set "BINKSALAD_PORT=4173"
set "BINKSALAD_NETWORK_ONLY=1"
call npm start
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%

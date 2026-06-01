@echo off
title RideComm - Helmet Intercom Server
color 0A
chcp 65001 >nul

echo.
echo  ================================================
echo    RIDECOMM - Helmet Intercom  (Windows)
echo  ================================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo  [ERROR] Node.js not found!
    echo  Download from https://nodejs.org  (LTS version)
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)
for /f %%v in ('node --version') do echo  [OK] Node.js %%v

:: Install deps first time
if not exist "node_modules" (
    echo.
    echo  [SETUP] Installing packages (first time, ~30 seconds)...
    call npm install
    if %errorlevel% neq 0 ( echo [ERROR] npm install failed & pause & exit /b 1 )
    echo  [OK] Packages installed!
)

:: Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4 Address"') do (
    set RAW=%%a
    goto :got_ip
)
:got_ip
set LOCAL_IP=%RAW: =%

:: Always regenerate cert so it matches current IP
echo.
echo  [SETUP] Generating SSL certificate for %LOCAL_IP%...
node generate_cert.js %LOCAL_IP%
if %errorlevel% neq 0 (
    color 0E
    echo  [WARN] Cert generation failed - mic may not work on iPhone
) else (
    echo  [OK] Certificate ready!
)

echo.
echo  ================================================
echo   SERVER STARTING...
echo  ================================================
echo.
echo   Riders open this in Safari on iPhone:
echo.
echo   STEP 1 (first time only - trust cert):
echo   https://%LOCAL_IP%:9443/trust.html
echo.
echo   STEP 2 (open app):
echo   https://%LOCAL_IP%:9443
echo.
echo   All phones must be on the SAME WiFi/Hotspot!
echo   Press Ctrl+C to stop.
echo  ================================================
echo.

node server.js

pause

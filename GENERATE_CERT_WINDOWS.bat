@echo off
title RideComm - Generate SSL Certificate
color 0B

echo.
echo  ================================================
echo    🔐 RideComm - SSL Certificate Generator
echo  ================================================
echo.
echo  This generates the HTTPS certificate needed
echo  for iPhone microphone access.
echo.

:: Check for openssl
where openssl >nul 2>&1
if %errorlevel% neq 0 (
    color 0E
    echo  [WARN] OpenSSL not found in PATH.
    echo.
    echo  Option 1: Install Git for Windows (includes OpenSSL)
    echo    https://git-scm.com/download/win
    echo.
    echo  Option 2: Use Node.js to generate cert (auto fallback)
    echo.
    echo  Trying Node.js fallback...
    node generate_cert.js
    goto :done
)

:: Get local IP
echo  Detecting your local IP address...
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    set RAW_IP=%%a
    goto :found_ip
)
:found_ip
:: Trim leading space
set LOCAL_IP=%RAW_IP: =%
echo  Found IP: %LOCAL_IP%
echo.

if not exist "certs" mkdir certs

echo  Generating certificate for IP: %LOCAL_IP%
openssl req -x509 -newkey rsa:2048 ^
    -keyout certs\key.pem ^
    -out certs\cert.pem ^
    -days 3650 -nodes ^
    -subj "/CN=RideComm" ^
    -addext "subjectAltName=IP:%LOCAL_IP%,IP:127.0.0.1,DNS:localhost"

if %errorlevel% equ 0 (
    color 0A
    echo.
    echo  ================================================
    echo   [OK] Certificate generated successfully!
    echo  ================================================
    echo.
    echo  Your IP: %LOCAL_IP%
    echo  App URL: https://%LOCAL_IP%:9443
    echo  Cert:    https://%LOCAL_IP%:9443/cert
    echo.
    echo  Now run START_WINDOWS.bat to start the server.
) else (
    color 0C
    echo  [ERROR] Certificate generation failed!
)

:done
echo.
pause

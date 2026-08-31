@echo off
setlocal

cd /d "%~dp0"

echo ==========================================
echo Study Assistant Bridge
echo ==========================================

for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
  for /f "tokens=* delims= " %%B in ("%%A") do (
    set LAN_IP=%%B
    goto :ip_found
  )
)

:ip_found
if defined LAN_IP (
  echo LAN IPv4: %LAN_IP%
  echo Mac URL:  http://%LAN_IP%:8788
) else (
  echo LAN IPv4: not detected automatically
  echo Mac URL:  http://YOUR-PC-IP:8788
)

echo.
echo Starting server on port 8788...
echo Keep this window open while using the bridge.
echo.

npm.cmd start

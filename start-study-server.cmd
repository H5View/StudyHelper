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
echo Starting the bridge in a dedicated window...
echo The Windows answer viewer will open automatically.
echo Keep the bridge and viewer windows open while using the bridge.
echo.

start "StudyHelper Bridge" cmd /k "cd /d ""%~dp0"" ^&^& npm.cmd start"

timeout /t 2 /nobreak >nul
start "StudyHelper Viewer" "http://127.0.0.1:8788/viewer"

echo.
echo Bridge started. The viewer shows every answer sent in Windows PC or Both mode.
pause

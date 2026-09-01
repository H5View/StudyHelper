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
echo The Windows answer popup will start automatically.
echo Keep the bridge window open while using the bridge.
echo.

start "StudyHelper Bridge" cmd /k "cd /d ""%~dp0"" ^&^& npm.cmd start"

timeout /t 2 /nobreak >nul
start "StudyHelper Popup" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0windows-answer-popup.ps1"

echo.
echo Bridge started. Windows PC and Both mode answers will appear in a popup.
pause

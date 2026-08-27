@echo off
chcp 65001 >nul
echo 正在停止 背他喵的 服务...

REM 1) 先停看门狗（run-service.ps1），否则它会立刻把子进程拉起来
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*run-service.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

REM 2) 双保险：写停止标志（若看门狗仍在轮询会自行退出）
if not exist store mkdir store
echo stop > store\.stop
timeout /t 2 /nobreak >nul

REM 3) 停隧道与服务器
powershell -NoProfile -Command "Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force; $p = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { Stop-Process -Id $p.OwningProcess -Force }"

if exist store\public-url.txt del store\public-url.txt
if exist store\.stop del store\.stop
if exist store\.watchdog.pid del store\.watchdog.pid

echo 已停止。
pause

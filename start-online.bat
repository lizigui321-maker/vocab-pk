@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   单词 PK · 联网版启动中...
echo ============================================
echo.

echo [1/3] 启动本地服务器...
start "vocab-pk-server" /MIN "C:\Users\Rick_Lei\.workbuddy\binaries\node\versions\22.22.2\node.exe" server.js
timeout /t 2 /nobreak >nul

echo [2/3] 建立公网隧道（Cloudflare 免费通道）...
if not exist "bin\cloudflared.exe" (
  echo 正在下载 cloudflared，首次需要约 1 分钟...
  curl -sL -o bin\cloudflared.exe "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
)

echo [3/3] 获取公网地址...
del "%TEMP%\vpk-tunnel.log" >nul 2>&1
start "vocab-pk-tunnel" /MIN bin\cloudflared.exe tunnel --url http://localhost:3000 --no-autoupdate > "%TEMP%\vpk-tunnel.log" 2>&1

set PUBURL=
for /l %%i in (1,1,30) do (
  if not defined PUBURL (
    timeout /t 2 /nobreak >nul
    for /f "tokens=*" %%u in ('powershell -NoProfile -Command "Select-String -Path $env:TEMP\vpk-tunnel.log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | ForEach-Object { $_.Matches[0].Value } | Select-Object -First 1"') do set PUBURL=%%u
  )
)

echo.
echo ============================================
if defined PUBURL (
  echo   联网版已就绪！把下面这个地址发给朋友：
  echo.
  echo   %PUBURL%
  echo.
  echo   任何网络都能访问，无需同一 WiFi。
  echo   （本机请用 http://localhost:3000 打开，昵称才能稳定记住）
  echo %PUBURL% > store\public-url.txt
  start "" "http://localhost:3000"
) else (
  echo   隧道建立较慢，请稍后查看 %TEMP%\vpk-tunnel.log
  echo   或直接使用局域网地址：http://localhost:3000
  if exist store\public-url.txt del store\public-url.txt
)
echo ============================================
echo.
echo 提示：关掉本窗口不会停止服务；要停止请在任务管理器
echo 结束 node.exe 和 cloudflared.exe，或运行 stop-server.bat
echo.
pause

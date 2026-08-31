@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   胖虎单词PK  本地启动
echo   启动后请用浏览器打开： http://localhost:3000
echo   按 Ctrl+C 可停止服务
echo ============================================
set PORT=3000
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装： https://nodejs.org （LTS 版）
  pause
  exit /b 1
)
node server.js
pause

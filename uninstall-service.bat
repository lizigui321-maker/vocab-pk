@echo off
chcp 65001 >nul
set TASK=VocabPK-Service
echo 正在移除开机自启任务：%TASK%
schtasks /Delete /TN "%TASK%" /F
echo.
echo 已移除。服务将不再随登录自动启动（已在运行的仍会停止，请用 stop-server.bat）。
echo.
pause

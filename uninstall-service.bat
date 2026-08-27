@echo off
chcp 65001 >nul
set DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\单词PK-自启.vbs
if exist "%DEST%" del "%DEST%"
echo 已移除开机自启（启动文件夹中的快捷方式已删除）。
echo.
echo 如需停止当前正在运行的服务，请运行 stop-server.bat。
echo 如需重新开启自启，请运行 install-service.bat。
echo.
pause

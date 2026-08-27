@echo off
chcp 65001 >nul
cd /d %~dp0
set DEST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\单词PK-自启.vbs

echo 正在设置开机自启（无需管理员权限）...
copy /Y "%~dp0autostart.vbs" "%DEST%" >nul
echo   已放入启动文件夹：%DEST%

echo.
echo 正在启动服务（后台隐藏运行）...
call "%~dp0service.bat"

echo.
echo 完成！本次已启动，且下次登录 Windows 会自动启动。
echo 查看状态：桌面「单词PK 状态」或 http://localhost:3000/status.html
echo.
pause

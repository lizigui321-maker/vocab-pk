@echo off
chcp 65001 >nul
cd /d %~dp0
set ROOT=%~dp0
set TASK=VocabPK-Service

echo 正在注册开机自启任务：%TASK%
schtasks /Create /TN "%TASK%" ^
  /TR "powershell.exe -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File \"%ROOT%run-service.ps1\"" ^
  /SC ONLOGON /F

if "%ERRORLEVEL%"=="0" (
  echo.
  echo 注册成功！以后你登录 Windows 会自动启动单词PK 服务。
  echo 现在立即启动一次服务...
  schtasks /Run /TN "%TASK%"
  timeout /t 3 /nobreak >nul
  echo.
  echo 已启动。查看状态请用桌面「单词PK 状态」或 status.html。
) else (
  echo 注册失败，请以管理员身份运行本脚本重试。
)
echo.
pause

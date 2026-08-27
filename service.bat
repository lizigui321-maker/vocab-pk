@echo off
chcp 65001 >nul
cd /d %~dp0
REM 直接拉起看门狗（无界面）。计划任务一般用 install-service.bat 直接调用 powershell。
powershell -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "%~dp0run-service.ps1"

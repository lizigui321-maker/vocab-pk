@echo off
chcp 65001 >nul
REM ============================================================
REM  胖虎单词PK · 一键编译 APK（调试版，可直接装到手机测试）
REM  前提：已安装 Android SDK 命令行工具（或 Android Studio），
REM        且 gradle 在 PATH 中。首次会自动下载 Gradle 8.5。
REM  若没有 gradle，请先执行：gradle wrapper --gradle-version 8.5
REM ============================================================
cd /d %~dp0

where gradle >nul 2>nul
if %errorlevel% neq 0 (
  echo [错误] 未找到 gradle。请先安装 Android SDK 命令行工具并把它加入 PATH，
  echo        或使用 Android Studio 打开本目录后点击 Build ^> Build Bundle(s) / APK(s)。
  echo        详见 apk\README.md
  pause
  exit /b 1
)

echo [1/2] 生成 Gradle Wrapper（如已存在则跳过）...
if not exist gradlew (
  gradle wrapper --gradle-version 8.5
)

echo [2/2] 编译 debug APK...
call gradlew.bat assembleDebug
if %errorlevel% neq 0 (
  echo [失败] 编译出错，请检查上方日志。
  pause
  exit /b 1
)

echo.
echo [完成] APK 已生成：
echo   app\build\outputs\apk\debug\app-debug.apk
echo 把这个文件传到手机安装即可（需开启“允许未知来源应用”）。
echo 正式发布请用：gradlew assembleRelease（需配置签名）
pause

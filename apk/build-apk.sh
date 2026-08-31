#!/usr/bin/env bash
# 胖虎单词PK · 一键编译 APK（macOS / Linux）
set -e
cd "$(dirname "$0")"

if ! command -v gradle >/dev/null 2>&1; then
  echo "[错误] 未找到 gradle。请先安装 Android SDK 命令行工具并加入 PATH，"
  echo "        或执行：gradle wrapper --gradle-version 8.5"
  exit 1
fi

echo "[1/2] 生成 Gradle Wrapper（如已存在则跳过）..."
[ -f gradlew ] || gradle wrapper --gradle-version 8.5

echo "[2/2] 编译 debug APK..."
./gradlew assembleDebug

echo
echo "[完成] APK 已生成："
echo "  app/build/outputs/apk/debug/app-debug.apk"
echo "传到手机安装即可（需开启“允许未知来源应用”）。"

# 背他喵的 · 安卓 APK 工程

这是一个 **WebView 壳 App**：它用系统浏览器内核加载你部署好的背他喵的 服务器网页。
所有游戏逻辑、账号、生词本、排行都在**服务器端**，App 只负责打开那个网址并全屏显示，
因此无需在 App 里写任何游戏代码，更新服务器即可更新所有人。

## 一、前提（一次性安装，免费）
- 安装 **Android SDK 命令行工具** 或 **Android Studio**（https://developer.android.com/studio）
- 确保 `gradle` 或 `sdkmanager` 可在命令行调用；并设置环境变量 `ANDROID_HOME` 指向 SDK 目录
- 至少安装一个 **SDK Platform 34**（`sdkmanager "platforms;android-34"`）

## 二、把 App 指向你的服务器
打开 `app/src/main/res/values/strings.xml`，把：
```
<string name="server_url">https://YOUR_DEPLOYED_URL</string>
```
改成你部署后的真实地址，例如：
```
<string name="server_url">https://vocabpk.onrender.com</string>
```
> 必须是 **https**（手机对 http 有限制）。本地用 `start-online.bat` 的 Cloudflare 隧道地址也是 https，可以临时填来测试。

## 三、编译 APK
Windows：
```
双击 build-apk.bat
```
macOS / Linux：
```
bash build-apk.sh
```
首次会自动下载 Gradle 8.5（约几十 MB）。编译成功后：
- 调试版：`app/build/outputs/apk/debug/app-debug.apk`（可直接装手机测试）
- 正式发布：`gradlew assembleRelease`（需自行配置签名 keystore）

## 四、安装到手机
把 `app-debug.apk` 传到安卓手机，点击安装；若提示“禁止安装未知来源应用”，
到系统设置里允许该来源即可。打开后即为全屏的背他喵的，可登录、对战、查生词本。

## 五、发布到应用商店（可选）
`assembleRelease` 产出 signed APK / AAB 后，可上传 Google Play 或国内应用市场。
由于本 App 仅是网页壳，商店审核通常重点关注隐私政策与网络内容，请按需补充。

---
> 不想走应用商店？**PWA 是更轻的“手机 App”**：用手机浏览器打开你的部署地址，
> 点“添加到主屏幕”，即可得到和原生 App 一样的全屏图标入口，无需安装 APK。

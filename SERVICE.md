# 本地常驻服务（无需云，电脑开着即在线）

把单词PK 做成开机自启、崩溃自拉起、隧道断开自动重连的常驻服务。

## 一键安装（只需一次，无需管理员）

双击 `install-service.bat`：

- 把自启脚本放进你的「启动」文件夹（路径：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\单词PK-自启.vbs`），**每次登录 Windows 自动启动**；
- 立即启动一次服务。

> 说明：原计划用 Windows 计划任务（schtasks）实现自启，但创建计划任务需要管理员权限，本机默认被 UAC 拦截。改用「启动文件夹」方案同样能达到开机自启效果，且不需要管理员。

## 日常使用

- 不用再手动双击启动脚本，登录即在线。
- 查看状态：桌面「单词PK 状态」或浏览器打开 `http://localhost:3000/status.html`。
- 停止服务：双击 `stop-server.bat`（会先停看门狗再停进程，避免被立刻拉起）。
- 卸载自启：双击 `uninstall-service.bat`。

## 文件说明

- `run-service.ps1` — 看门狗本体：每 30 秒体检，node 崩了重启、cloudflared 死了或连续不可达 3 次就重连，并把新公网地址写入 `store/public-url.txt`。
- `service.bat` — 手动拉起看门狗（无界面）。
- `store/service.log` — 运行/重启记录，排查问题看这里。

## 约束

- 需要**电脑开机且已登录**（计划任务 ONLOGON 触发）。休眠/关机则离线。
- 公网地址是 Cloudflare 免费临时通道，**cloudflared 重连后会变**，把新地址（状态页上有）重新发给朋友即可。
- 想要真正的 7×24 无人值守，请见 `DEPLOY.md` 部署到云。


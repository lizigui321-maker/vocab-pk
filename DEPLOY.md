# 部署 背他喵的 到云端（让所有人随时能玩）

本地运行（`start-online.bat`）只在你电脑开机时可用。要让**任何人、任何时间**都能打开网址、  
安装 PWA、或用 APK 联网对战，需要把 `server.js` 部署到一个常驻的云服务器。

本项目是**零 npm 依赖**的纯 Node 程序，部署极其简单。

## 方式一：Render（最省事，免费）

1. 把本目录推送到 GitHub 仓库。
2. 打开 <https://render.com> → New → Blueprint → 连接仓库 → 选中 `render.yaml`。
3. 部署完成后会得到一个 `https://xxxx.onrender.com` 地址。
4. 把该地址填进：
   - `apk/app/src/main/res/values/strings.xml` 的 `server_url`（用于编译 APK）
   - 或直接分享给朋友（手机浏览器打开即玩，可“添加到主屏幕”当 App）

> 免费版注意两点：① 一段时间无访问会休眠，首次访问需等几秒唤醒；  
> ② 文件系统临时，重新部署会清空本地账号数据——正式用请在 Render 挂载 Persistent Disk（见 render.yaml 注释）。

方式二：Railway / Fly.io / Koyeb白嫖的即可。  
构建命令留空或 `true`，启动命令 `node server.js`。
-------------------------------------

## 方式三：自己的服务器 / 树莓派

`git clone` 后 `node server.js`（或 `npm start`），用 Nginx 反代并配置 HTTPS 域名即可。

## 持久化账号数据（可选但推荐）

账号、生词本、排行存在 `store/*.json`。在云上若想不丢数据：

- **推荐：Upstash Redis 云端持久化**（跨部署不丢，免费额度足够个人使用）
  1. 到 <https://console.upstash.com> 建一个 Redis（免费版即可），拿到
     `UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN`；
  2. 在 Render 控制台给服务添加这两个环境变量（Blueprint 里已预留 `sync: false` 的占位）；
  3. 重启后服务自动进入「云端持久化」模式，账号/生词本跨部署、跨重启保留。
- Render：挂载 Persistent Disk 到 `store` 目录；
- 或把存储改成数据库（如 SQLite / Redis），改 `server.js` 顶部几个 `loadJSON/saveJSON` 即可。

### 版本更新不丢数据（内置三重保险）

1. **原子写 + 备份**：所有数据文件先写临时文件再改名落盘，每次保存自动保留上一份 `.bak`；
   即使进程在写一半时被杀，下次启动也会自动回退 `.bak`，损坏文件会改名留档而不是静默清空。
2. **每日快照**：每 6 小时把账号/小组/排行存成 `store/snapshot-日期.json`（保留最近 7 份），
   服务正常退出时也会刷新。若主数据文件因故丢失，启动时会自动用最近的快照恢复。
3. **云端全量快照**：启用 Upstash 后，每次启动都会写入一份 `__full__` 全量备份，
   单条 key 意外丢失/误删时会自动用这份全量数据自愈。
4. **安全降级**：云端拉取失败（网络/DNS/5xx）时，服务**不会**用本地旧数据回灌覆盖云端，
   而是降级为本地文件模式，避免「部署窗口」互相覆盖把新数据抹掉。

---

部署成功后，三种“手机端”任选其一：

1. **手机浏览器**直接打开网址（最简单）；
2. **PWA**：浏览器里“添加到主屏幕”，得到全屏 App 图标；
3. **APK**：见 `apk/README.md`，编译安装原生安卓 App。

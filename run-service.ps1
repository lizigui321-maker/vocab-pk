# run-service.ps1
# 胖虎单词PK 常驻看门狗：开机自启 + 服务器崩溃自动重启 + 公网隧道断开自动重连
# 由计划任务（install-service.bat）或 service.bat 调用，无界面后台运行。
$ErrorActionPreference = 'SilentlyContinue'

$root         = $PSScriptRoot
$NODE         = "C:\Users\Rick_Lei\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if (-not (Test-Path $NODE)) { $NODE = "node" }
$CF           = Join-Path $root "bin\cloudflared.exe"
$TUNNEL_LOG   = Join-Path $env:TEMP "vpk-tunnel.log"
$PUBURL_FILE  = Join-Path $root "store\public-url.txt"
$SERVICE_LOG  = Join-Path $root "store\service.log"
$STOP_FLAG    = Join-Path $root "store\.stop"
$PID_FILE     = Join-Path $root "store\.watchdog.pid"

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
  Add-Content -Path $SERVICE_LOG -Value $line
}

# 单实例锁：避免重复看门狗互相拉起
if (Test-Path $PID_FILE) {
  $old = (Get-Content $PID_FILE -ErrorAction SilentlyContinue)
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    Log "看门狗已在运行 (PID $old)，退出。"
    exit 0
  }
}
Set-Content -Path $PID_FILE -Value $PID

function Test-Port($port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Ensure-CF() {
  if (-not (Test-Path $CF)) {
    Log "下载 cloudflared..."
    & curl.exe -sL -o $CF "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  }
}

function Start-Node() {
  Log "启动 node 服务器..."
  Start-Process -FilePath $NODE -ArgumentList "server.js" -WorkingDirectory $root -WindowStyle Hidden
}

function Start-Tunnel() {
  Ensure-CF
  Log "建立公网隧道..."
  if (Test-Path $TUNNEL_LOG) { Remove-Item $TUNNEL_LOG -Force }
  Start-Process -FilePath $CF -ArgumentList "tunnel","--url","http://localhost:3000","--no-autoupdate" `
    -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $TUNNEL_LOG -RedirectStandardError $TUNNEL_LOG
}

function Parse-Url() {
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $TUNNEL_LOG) {
      $u = (Select-String -Path $TUNNEL_LOG -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches `
            | ForEach-Object { $_.Matches[0].Value } | Select-Object -Last 1)
      if ($u) {
        Set-Content -Path $PUBURL_FILE -Value $u -NoNewline
        Log "公网地址: $u"
        return $u
      }
    }
  }
  Log "隧道地址获取超时"
  if (Test-Path $PUBURL_FILE) { Remove-Item $PUBURL_FILE -Force }
  return $null
}

Log "==== 胖虎单词PK 看门狗启动 (PID $PID) ===="

# 首次拉起（若已存在则不重复启动）
if (-not (Test-Port 3000)) { Start-Node }
Start-Sleep -Seconds 3
if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) { Start-Tunnel; Parse-Url }

$cfFail = 0
# 主循环：每 30 秒体检一次
while ($true) {
  if (Test-Path $STOP_FLAG) {
    Log "收到停止标志，正在关闭..."
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    $np = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($np) { Stop-Process -Id $np.OwningProcess -Force }
    Remove-Item $PID_FILE -Force -ErrorAction SilentlyContinue
    Remove-Item $STOP_FLAG -Force -ErrorAction SilentlyContinue
    Log "已停止。"
    exit 0
  }

  # 服务器健康检查
  if (-not (Test-Port 3000)) {
    Log "检测到服务器停止，重启 node..."
    Start-Node
    Start-Sleep -Seconds 3
  }

  # 隧道健康检查（进程活着 but 连续不可达也视为失效）
  $cf = Get-Process cloudflared -ErrorAction SilentlyContinue
  if (-not $cf) {
    Log "检测到隧道停止，重连..."
    Start-Tunnel; Parse-Url; $cfFail = 0
  } else {
    $url = $null
    if (Test-Path $PUBURL_FILE) { $url = (Get-Content $PUBURL_FILE -Raw).Trim() }
    if ($url) {
      $ok = $false
      try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri ($url + "/api/info") -TimeoutSec 8 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ok = $true }
      } catch {}
      if ($ok) { $cfFail = 0 } else { $cfFail++ }
      if ($cfFail -ge 3) {
        Log "隧道连续不可达 x3，强制重连..."
        $cf | Stop-Process -Force
        Start-Sleep -Seconds 2
        Start-Tunnel; Parse-Url; $cfFail = 0
      }
    }
  }

  Start-Sleep -Seconds 27
}

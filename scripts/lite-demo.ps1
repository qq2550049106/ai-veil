# lite-demo.ps1 —— 用 PowerShell 回退渲染器演示一遍完整接管流程，并把四个状态截图存档
#
# 用法（不需要 Electron）：
#   powershell -STA -NoProfile -ExecutionPolicy Bypass -File scripts\lite-demo.ps1
#   powershell -STA -File scripts\lite-demo.ps1 -OutDir D:\shots -GapMs 800
#
# 它会：确保 veil-lite.ps1 在跑 → 依次写入 session.start / action.before / need_human / session.end
#        → 每步截一张图（含分层置顶窗口）→ 结束后渲染器继续常驻，托盘可退出。

param(
  [string]$OutDir = (Join-Path $env:TEMP 'ai-veil-demo'),
  [int]$GapMs = 1400
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$inbox = Join-Path $env:USERPROFILE '.ai-veil\events.jsonl'
$lite = Join-Path $root 'veil-lite.ps1'
$shot = Join-Path $root 'capture-screen.ps1'
$psExe = (Get-Process -Id $PID).Path
$session = 'demo-' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
if (-not (Test-Path $inbox)) {
  $inboxDir = Split-Path -Parent $inbox
  if (-not (Test-Path $inboxDir)) { New-Item -ItemType Directory -Path $inboxDir -Force | Out-Null }
  New-Item -ItemType File -Path $inbox -Force | Out-Null
}

# 1) 确保回退渲染器在跑（按命令行精确匹配，避免误杀本进程）
$running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*-File*veil-lite.ps1*' }
if (-not $running) {
  # 必须让渲染器完全脱离本进程的 stdio：否则它会继承 npm/powershell 的管道，
  # `npm run lite:demo` 会一直挂到它退出。WMI 创建进程不继承任何句柄。
  $rendererLog = Join-Path $OutDir 'renderer.log'
  $cmdLine = '"' + $psExe + '" -STA -NoProfile -ExecutionPolicy Bypass -File "' + $lite + '"'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $cmdLine
    CurrentDirectory = $root
  }
  if ($created.ReturnValue -ne 0) {
    throw ('failed to start renderer, Win32_Process.Create returned ' + $created.ReturnValue)
  }
  Start-Sleep -Seconds 3
  Write-Host ('renderer started (pid ' + $created.ProcessId + ', log via tray)')
} else {
  Write-Host ('renderer already running (pid ' + $running[0].ProcessId + ')')
}

function Send-Event([hashtable]$payload) {
  $payload.ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $payload.session_id = $session
  $payload.agent = @{ name = 'deepseek-harness'; version = '0.1.0' }
  $payload.mode = 'takeover'
  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::AppendAllText($inbox, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ('  -> ' + $payload.event)
}

function Grab([string]$name) {
  & $psExe -STA -NoProfile -ExecutionPolicy Bypass -File $shot -Out (Join-Path $OutDir $name) | Out-Null
  Write-Host ('  [shot] ' + (Join-Path $OutDir $name))
}

Send-Event @{
  event = 'session.start'
  scope = @{ type = 'fullscreen'; display_id = 1 }
  action = @{ type = 'launch'; target = '打开 Edge 浏览器 · 登录 DeepSeek' }
  ttl_ms = 60000
  cancel = @{ enabled = $true; hotkey = 'Ctrl+Alt+Esc' }
}
Start-Sleep -Milliseconds $GapMs
Grab 'demo-1-start.png'

Send-Event @{
  event = 'action.before'
  scope = @{ type = 'region'; bounds = @{ x = 400; y = 120; w = 1100; h = 640 }; display_id = 1 }
  action = @{ type = 'click'; target = '点击「保存」按钮' }
}
Start-Sleep -Milliseconds $GapMs
Grab 'demo-2-action.png'

Send-Event @{
  event = 'need_human'
  scope = @{ type = 'fullscreen'; display_id = 1 }
  action = @{ type = 'other'; target = '需要你确认：是否覆盖 ~/.ai-veil/config.toml？' }
}
Start-Sleep -Milliseconds $GapMs
Grab 'demo-3-need-human.png'

Send-Event @{
  event = 'session.end'
  scope = @{ type = 'fullscreen'; display_id = 1 }
  action = @{ type = 'other'; target = '任务完成' }
}
Start-Sleep -Milliseconds 900
Grab 'demo-4-end.png'

Write-Host ''
Write-Host ('demo done. session=' + $session)
Write-Host ('screenshots: ' + $OutDir)
Write-Host 'renderer keeps running; tray icon -> Exit AI-Veil to stop it'

# AI-Veil Lite (PowerShell 5.1 compatible)
# Consumes ~/.ai-veil/events.jsonl and draws: fullscreen topmost border + top banner
# + abort button + sound + balloon notification + tray icon. No compilation needed.
# This is the stand-in renderer while Electron is unavailable; the real app is main.js.

param()
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace Veil -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@

$WS_EX_TOPMOST     = 0x00000008
$WS_EX_TRANSPARENT = 0x00000020
$WS_EX_TOOLWINDOW  = 0x00000080

function Set-WindowStyle([System.Windows.Forms.Form]$form, [bool]$clickThrough) {
  $handle = $form.Handle
  $ex = [Veil.Native]::GetWindowLong($handle, -20)
  $ex = $ex -bor $WS_EX_TOOLWINDOW -bor $WS_EX_TOPMOST
  if ($clickThrough) { $ex = $ex -bor $WS_EX_TRANSPARENT }
  [void][Veil.Native]::SetWindowLong($handle, -20, $ex)
}

function Show-NoActivate([System.Windows.Forms.Form]$form) {
  [void][Veil.Native]::ShowWindow($form.Handle, 4)  # SW_SHOWNOACTIVATE
}

$inbox = $env:AI_VEIL_INBOX
if ([string]::IsNullOrWhiteSpace($inbox)) { $inbox = Join-Path $env:USERPROFILE '.ai-veil\events.jsonl' }
$cancelDir = Join-Path $env:USERPROFILE '.ai-veil\cancel'
$inboxDir = Split-Path -Parent $inbox
if (-not (Test-Path $inboxDir)) { New-Item -ItemType Directory -Path $inboxDir -Force | Out-Null }
if (-not (Test-Path $cancelDir)) { New-Item -ItemType Directory -Path $cancelDir -Force | Out-Null }
if (-not (Test-Path $inbox)) { New-Item -ItemType File -Path $inbox -Force | Out-Null }

$orange = [System.Drawing.Color]::FromArgb(255, 122, 24)
$red    = [System.Drawing.Color]::FromArgb(255, 59, 48)
$redDim = [System.Drawing.Color]::FromArgb(120, 30, 26)
$ink    = [System.Drawing.Color]::FromArgb(20, 22, 28)
$thickness = 4
$ttlMs = 30000

# ---------- border layer (click-through) ----------
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$primary = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

$borderForm = New-Object System.Windows.Forms.Form
$borderForm.FormBorderStyle = 'None'
$borderForm.ShowInTaskbar = $false
$borderForm.StartPosition = 'Manual'
$borderForm.BackColor = [System.Drawing.Color]::Magenta
$borderForm.TransparencyKey = [System.Drawing.Color]::Magenta
$borderForm.Bounds = $vs
$borderForm.TopMost = $true

$panels = @{}
foreach ($side in @('Top', 'Bottom', 'Left', 'Right')) {
  $panel = New-Object System.Windows.Forms.Panel
  $panel.BackColor = $orange
  [void]$borderForm.Controls.Add($panel)
  $panels[$side] = $panel
}

function Update-BorderLayout {
  $w = $borderForm.Width
  $h = $borderForm.Height
  $panels['Top'].SetBounds(0, 0, $w, $thickness)
  $panels['Bottom'].SetBounds(0, $h - $thickness, $w, $thickness)
  $panels['Left'].SetBounds(0, 0, $thickness, $h)
  $panels['Right'].SetBounds($w - $thickness, 0, $thickness, $h)
}
Update-BorderLayout

function Set-BorderVisible([bool]$visible) {
  foreach ($key in $panels.Keys) { $panels[$key].Visible = $visible }
}

function Set-BorderColor([System.Drawing.Color]$color) {
  foreach ($key in $panels.Keys) { $panels[$key].BackColor = $color }
}

# ---------- banner layer (clickable, no focus steal on show) ----------
$banner = New-Object System.Windows.Forms.Form
$banner.FormBorderStyle = 'None'
$banner.ShowInTaskbar = $false
$banner.StartPosition = 'Manual'
$banner.BackColor = $ink
$banner.Size = New-Object System.Drawing.Size(660, 76)
$banner.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.SetBounds(18, 0, 470, 76)
$label.ForeColor = [System.Drawing.Color]::White
$label.BackColor = [System.Drawing.Color]::Transparent
$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5)
$label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$label.AutoEllipsis = $true
[void]$banner.Controls.Add($label)

$abortBtn = New-Object System.Windows.Forms.Button
$abortBtn.Text = [char]0x4E2D + [char]0x6B62
$abortBtn.SetBounds(524, 21, 110, 34)
$abortBtn.BackColor = $orange
$abortBtn.ForeColor = [System.Drawing.Color]::White
$abortBtn.FlatStyle = 'Flat'
$abortBtn.FlatAppearance.BorderSize = 0
$abortBtn.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
[void]$banner.Controls.Add($abortBtn)

$banner.Location = New-Object System.Drawing.Point(
  [int]($primary.Left + ($primary.Width - $banner.Width) / 2),
  [int]($primary.Top + 24)
)

# ---------- tray ----------
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.Text = 'AI-Veil'
$ni.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$exitItem = $menu.Items.Add('Exit AI-Veil')
$exitItem.add_Click({ [System.Windows.Forms.Application]::Exit() })
$ni.ContextMenuStrip = $menu

function Show-Balloon([string]$message, [System.Windows.Forms.ToolTipIcon]$icon) {
  $ni.BalloonTipTitle = 'AI-Veil'
  $ni.BalloonTipText = $message
  $ni.BalloonTipIcon = $icon
  $ni.ShowBalloonTip(4000)
}

# ---------- state ----------
$script:agent = 'Agent'
$script:visible = $false
$script:blink = $false
$script:hideAt = $null
$script:lastEvent = [DateTime]::UtcNow
$script:sessionActive = $false

function Hide-Visuals {
  $borderForm.Hide()
  $banner.Hide()
  $script:visible = $false
  $script:blink = $false
  Set-BorderVisible $true
}

function Show-Visuals([string]$text, [System.Drawing.Color]$color, [bool]$blink) {
  $label.Text = $text
  Set-BorderColor $color
  Set-BorderVisible $true
  Update-BorderLayout
  if (-not $script:visible) {
    Show-NoActivate $borderForm
    Show-NoActivate $banner
  }
  $script:visible = $true
  $script:blink = $blink
}

$abortBtn.add_Click({
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $path = Join-Path $cancelDir ("cancel-lite-" + $stamp + ".json")
  $payload = '{"session_id":"lite","reason":"user clicked abort banner","ts":' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + '}'
  [System.IO.File]::WriteAllText($path, $payload, (New-Object System.Text.UTF8Encoding($false)))
  Hide-Visuals
  $script:sessionActive = $false
  Show-Balloon 'Stopped by user (record written to ~/.ai-veil/cancel/)' 'Warning'
})

function Handle-Event($ev) {
  $name = [string]$ev.event
  if ([string]::IsNullOrWhiteSpace($name)) { return }
  if ($ev.agent -and $ev.agent.name) { $script:agent = [string]$ev.agent.name }
  $target = ''
  if ($ev.action -and $ev.action.target) { $target = [string]$ev.action.target }
  $script:lastEvent = [DateTime]::UtcNow

  if ($name -eq 'session.start') {
    $script:sessionActive = $true
    $script:hideAt = $null
    Show-Visuals ($script:agent + ' 正在接管你的电脑') $orange $false
    [System.Media.SystemSounds]::Asterisk.Play()
    Show-Balloon ($script:agent + ' 正在接管你的电脑') 'Info'
  }
  elseif ($name -eq 'action.before' -or $name -eq 'action.after') {
    if ($script:sessionActive) {
      Show-Visuals ($script:agent + ' 正在操控 · ' + $target) $orange $false
    }
  }
  elseif ($name -eq 'need_human') {
    Show-Visuals ('需要你介入 · ' + $target) $red $true
    [System.Media.SystemSounds]::Exclamation.Play()
    Show-Balloon ('需要你介入 · ' + $target) 'Warning'
  }
  elseif ($name -eq 'error') {
    Show-Visuals ('操控异常中断 · ' + $target) $red $false
    [System.Media.SystemSounds]::Hand.Play()
    Show-Balloon ('操控异常中断 · ' + $target) 'Error'
  }
  elseif ($name -eq 'session.end') {
    $script:sessionActive = $false
    $script:blink = $false
    Show-Visuals '操控已结束' $orange $false
    [System.Media.SystemSounds]::Beep.Play()
    $script:hideAt = [DateTime]::UtcNow.AddSeconds(2.5)
  }
}

# ---------- poll inbox ----------
$script:offset = (Get-Item $inbox).Length
$script:pending = ''

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.add_Tick({
  try {
    $len = (Get-Item $inbox).Length
    if ($len -lt $script:offset) { $script:offset = 0; $script:pending = '' }
    if ($len -gt $script:offset) {
      $fs = [System.IO.File]::Open($inbox, 'Open', 'Read', 'ReadWrite')
      try {
        [void]$fs.Seek($script:offset, 'Begin')
        $toRead = [int]($len - $script:offset)
        $buffer = New-Object byte[] $toRead
        $read = $fs.Read($buffer, 0, $toRead)
        $script:offset = $script:offset + $read
        $script:pending = $script:pending + [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
      } finally { $fs.Dispose() }
      if ($script:pending.Length -gt 1048576) {
        $script:pending = $script:pending.Substring($script:pending.Length - 524288)
      }
      while ($true) {
        $idx = $script:pending.IndexOf([char]10)
        if ($idx -lt 0) { break }
        $line = $script:pending.Substring(0, $idx).Trim()
        $script:pending = $script:pending.Substring($idx + 1)
        if ($line.Length -gt 0 -and -not $line.StartsWith('#')) {
          try {
            $ev = ConvertFrom-Json $line
            Handle-Event $ev
          } catch { }
        }
      }
    }
    # need_human: 边框常亮 + 在亮红/暗红之间呼吸（不是整块闪没，避免看起来像故障）
    if ($script:blink -and $script:visible) {
      $on = (([long]([DateTime]::UtcNow.Ticks / 4500000)) % 2) -eq 0
      if ($on) { Set-BorderColor $red } else { Set-BorderColor $redDim }
    }
    if ($script:hideAt -ne $null -and [DateTime]::UtcNow -gt $script:hideAt) {
      Hide-Visuals
      $script:hideAt = $null
    }
    if ($script:visible -and $script:hideAt -eq $null) {
      if ((([DateTime]::UtcNow) - $script:lastEvent).TotalMilliseconds -gt $ttlMs) {
        Hide-Visuals
        $script:sessionActive = $false
      }
    }
  } catch { }
})
$timer.Start()

Show-Balloon 'AI-Veil overlay is running (tray icon to exit)' 'Info'
Write-Host ('AI-Veil overlay running. inbox=' + $inbox + ' offset=' + $script:offset)

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $ni.Visible = $false
  $ni.Dispose()
  $borderForm.Dispose()
  $banner.Dispose()
}
Write-Host 'AI-Veil overlay exited.'

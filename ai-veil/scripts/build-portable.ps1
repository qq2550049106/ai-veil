# build-portable.ps1 —— 把项目打成「解压即用」的便携版（自带 Electron 运行时）
#
# 用法（需要先有一份 Electron 运行时）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-portable.ps1 -ElectronDist D:\electron44 -Version 1.0.0
#
# 产物：
#   dist\AI-Veil-<version>-win32-x64\        可直接双击 AI-Veil.exe
#   dist\AI-Veil-<version>-win32-x64.zip     发布用压缩包
#
# 注意：Electron 的 electron.exe 必须位于纯 ASCII 路径，否则运行时会 0xc0000005。
#       下载官方 zip 解压即可（https://github.com/electron/electron/releases）。

param(
  [string]$ElectronDist = "$env:USERPROFILE\.ai-veil\electron-dist",
  [string]$Version = "1.0.0",
  [string]$OutDir = (Join-Path $PSScriptRoot "..\dist"),
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$name = "AI-Veil-$Version-win32-x64"
$pkg = Join-Path $OutDir $name

Write-Host "[1/5] 检查 Electron 运行时：$ElectronDist"
if (-not (Test-Path (Join-Path $ElectronDist 'electron.exe'))) {
  throw "找不到 $ElectronDist\electron.exe。请设置 -ElectronDist 指向解压好的 Electron 目录。"
}
if ($ElectronDist -notmatch '^[\x20-\x7E]+$') {
  throw "Electron 运行时路径含非 ASCII 字符（$ElectronDist），运行时会崩溃。请换到纯英文路径。"
}

Write-Host "[2/5] 复制运行时到 $pkg"
if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory $pkg -Force | Out-Null
$null = robocopy $ElectronDist $pkg /E /NFL /NDL /NJH /NJS /NP
Rename-Item (Join-Path $pkg 'electron.exe') 'AI-Veil.exe'
Remove-Item (Join-Path $pkg 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

Write-Host "[3/5] 复制应用代码到 resources\app"
$app = Join-Path $pkg 'resources\app'
New-Item -ItemType Directory $app -Force | Out-Null
$null = robocopy $root $app /E /XD node_modules dist .git vendor .runtime release evidence tools /XF *.zip /NFL /NDL /NJH /NJS /NP
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $pkg 'LICENSE.txt') -Force
if (Test-Path (Join-Path $root 'scripts\QUICKSTART.txt')) {
  Copy-Item (Join-Path $root 'scripts\QUICKSTART.txt') (Join-Path $pkg 'QUICKSTART.txt') -Force
}

Write-Host "[4/5] 自检：关键文件是否齐全"
$required = @('AI-Veil.exe', 'resources\app\main.js', 'resources\app\preload.js', 'resources\app\src\overlay.html', 'resources\app\lib\config.js')
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $pkg $_)) })
if ($missing.Count) { throw ("缺少关键文件：" + ($missing -join ', ')) }
Write-Host ("      文件数=" + (Get-ChildItem $pkg -Recurse -File).Count)

if ($NoZip) {
  Write-Host "[5/5] 跳过压缩（-NoZip）。产物：$pkg"
  exit 0
}

Write-Host "[5/5] 压缩"
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $pkg -DestinationPath $zip -CompressionLevel Optimal
$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "完成：$zip ($size MB)"
Write-Host "提醒：解压后请放在纯英文路径下再运行（中文路径会让 Electron 崩溃）。"

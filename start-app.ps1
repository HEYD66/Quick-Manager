# start-app.ps1 — 启动「Quick 多账号管理器」桌面应用（Electron 外壳）
# 用法：powershell -ExecutionPolicy Bypass -File start-app.ps1

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = Join-Path $Here 'electron'

function Find-Electron {
  $cands = @()
  if ($env:QWM_ELECTRON) { $cands += $env:QWM_ELECTRON }
  $localCfg = Join-Path $Here 'data\local-paths.json'
  if (Test-Path $localCfg) {
    try {
      $j = Get-Content $localCfg -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.electronExe) { $cands += $j.electronExe }
    } catch {}
  }
  $cands += (Join-Path $Here 'node_modules\electron\dist\electron.exe')
  $cands += (Join-Path $Here 'electron-runtime\electron.exe')
  $cands += (Join-Path $env:LOCALAPPDATA 'electron\dist\electron.exe')
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command electron -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$exe = Find-Electron
if (-not $exe) {
  Write-Host '找不到 Electron 运行时。' -ForegroundColor Red
  Write-Host '  方案一：设置环境变量 QWM_ELECTRON 指向 electron.exe'
  Write-Host '  方案二：跑一次 make-portable.ps1 把运行时复制到 electron-runtime\'
  exit 1
}

if (-not (Test-Path $AppDir)) { Write-Host "缺少应用目录: $AppDir" -ForegroundColor Red; exit 1 }

# 清掉会干扰的环境变量（拿掉后子进程会继承干净的环境）
foreach ($k in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING')) {
  if (Test-Path ("Env:" + $k)) { Remove-Item ("Env:" + $k) -ErrorAction SilentlyContinue }
}

# 用 WScript.Shell 分离启动：不等子进程、不占用控制台
$cmdLine = '"' + $exe + '" "' + $AppDir + '"'
try {
  $sh = New-Object -ComObject WScript.Shell
  [void]$sh.Run($cmdLine, 1, $false)
  Write-Host "已启动：$exe" -ForegroundColor Green
  Write-Host "  应用目录: $AppDir"
  Write-Host '  关窗会最小化到托盘，托盘右键可退出。'
} catch {
  Write-Host ("启动失败: " + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
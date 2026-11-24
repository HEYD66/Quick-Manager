# make-portable.ps1 — 生成独立便携版（自带 Electron 运行时，约 360MB）
# 产物: qwmgr\portable\Quick多账号管理器\  —— 整个文件夹可拷到别的 Windows 机器直接用
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out  = Join-Path $Here 'portable\Quick多账号管理器'

function Find-ElectronDist {
  $cands = @()
  if ($env:QWM_ELECTRON) { $cands += (Split-Path $env:QWM_ELECTRON -Parent) }
  $localCfg = Join-Path $Here 'data\local-paths.json'
  if (Test-Path $localCfg) {
    try {
      $j = Get-Content $localCfg -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($j.electronExe) { $cands += (Split-Path $j.electronExe -Parent) }
    } catch {}
  }
  $cands += (Join-Path $Here 'node_modules\electron\dist')
  $cands += (Join-Path $Here 'electron-runtime')
  $cands += (Join-Path $env:LOCALAPPDATA 'electron\dist')
  foreach ($c in $cands) { if ($c -and (Test-Path (Join-Path $c 'electron.exe'))) { return $c } }
  return $null
}

$dist = Find-ElectronDist
if (-not $dist) { Write-Host '找不到 Electron 运行时目录，请设置 QWM_ELECTRON 指向 electron.exe' -ForegroundColor Red; exit 1 }

Write-Host "Electron 运行时: $dist" -ForegroundColor Cyan
Write-Host "输出目录: $Out" -ForegroundColor Cyan
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }

# 1) 复制运行时
robocopy $dist $Out /E /NFL /NDL /NJH /NJS /NP | Out-Null
$exe = Join-Path $Out 'electron.exe'
$appExe = Join-Path $Out 'Quick多账号管理器.exe'
if (Test-Path $exe) { Rename-Item $exe 'Quick多账号管理器.exe' -Force }

# 2) 放应用（resources\app）+ 服务端（resources\app\server）
$resApp = Join-Path $Out 'resources\app'
New-Item -ItemType Directory -Force $resApp | Out-Null
Copy-Item (Join-Path $Here 'electron\main.js') $resApp -Force
Copy-Item (Join-Path $Here 'electron\package.json') $resApp -Force
Copy-Item (Join-Path $Here 'electron\icon.png') $resApp -Force
Copy-Item (Join-Path $Here 'electron\icon.ico') $resApp -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Here 'electron\tray.png') $resApp -Force

$resServer = Join-Path $resApp 'server'
New-Item -ItemType Directory -Force $resServer | Out-Null
foreach ($item in @('server.js','package.json','lib','web')) {
  $src = Join-Path $Here $item
  if (Test-Path $src) { Copy-Item $src (Join-Path $resServer $item) -Recurse -Force }
}
$toolsDst = Join-Path $resServer 'tools'
New-Item -ItemType Directory -Force $toolsDst | Out-Null
$localMcp = Join-Path $Here 'tools\local-tools-mcp.js'
if (Test-Path $localMcp) { Copy-Item $localMcp $toolsDst -Force }

# 3) 便携版需要 Node.js（拉起本地服务）：找不到就把提示写进说明
$nodeOk = $false
try { $nodeOk = [bool](Get-Command node -ErrorAction SilentlyContinue) } catch {}
$readme = @(
  'Quick 多账号管理器 — 便携版',
  '',
  '双击 Quick多账号管理器.exe 启动。',
  '',
  '依赖：目标机器需要安装 Node.js（用来跑本地数据服务）。',
  ('本机检测 Node.js: ' + $(if ($nodeOk) { '已安装' } else { '未安装（请先装 Node.js LTS）' })),
  '',
  '数据目录：resources\app\server\data',
  '端口：9600（管理面板）',
  ''
)
[IO.File]::WriteAllLines((Join-Path $Out '使用说明.txt'), $readme, (New-Object Text.UTF8Encoding($true)))

$sz = [math]::Round(((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 0)
Write-Host "完成：$Out  (约 $sz MB)" -ForegroundColor Green
Write-Host "  启动文件: $appExe" -ForegroundColor Green

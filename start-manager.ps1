# start-manager.ps1 — 一键启动 Quick 多账号管理器
# 用法：
#   powershell -ExecutionPolicy Bypass -File .re\qwmgr\start-manager.ps1
#   powershell -ExecutionPolicy Bypass -File .re\qwmgr\start-manager.ps1 -NoBrowser
param(
    [switch]$NoBrowser,
    [int]$Port = 9600
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Here 'server.js'
$Url = "http://127.0.0.1:$Port/"

function Test-Port([int]$p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $p)
        $c.Close()
        return $true
    } catch { return $false }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 node，请先安装 Node.js 20+' -ForegroundColor Red
    exit 1
}

$running = Test-Port $Port
if ($running) {
    Write-Host "管理器已在运行：$Url" -ForegroundColor Green
} else {
    Write-Host "启动管理器（端口 $Port）…" -ForegroundColor Cyan
    $env:QWM_PORT = "$Port"
    $log = Join-Path $Here 'data\server.log'
    New-Item -ItemType Directory -Force (Join-Path $Here 'data') | Out-Null
    Start-Process -FilePath 'node' -ArgumentList "`"$Server`"" -WorkingDirectory $Here `
        -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError (Join-Path $Here 'data\server.err.log')

    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-Port $Port) { $ok = $true; break }
    }
    if (-not $ok) {
        Write-Host '启动失败，检查 data\server.err.log' -ForegroundColor Red
        exit 1
    }
    Write-Host "已启动：$Url" -ForegroundColor Green
}

$tokenFile = Join-Path $Here 'data\mgr-token.txt'
if (Test-Path $tokenFile) {
    Write-Host ("本地访问令牌：" + (Get-Content $tokenFile -Raw).Trim()) -ForegroundColor DarkGray
}

if (-not $NoBrowser) { Start-Process $Url }
Write-Host ''
Write-Host '提示：' -ForegroundColor DarkGray
Write-Host '  · 额度实时值只有「当前登录账号」能查，其它账号显示上次缓存' -ForegroundColor DarkGray
Write-Host '  · 切号会自动重启客户端后端，请先保存手上的工作' -ForegroundColor DarkGray
Write-Host '  · 关闭管理器：Get-Process node | Where-Object { $_.Path -like "*node*" } | Stop-Process（或重启电脑）' -ForegroundColor DarkGray

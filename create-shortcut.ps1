# create-shortcut.ps1 — 在桌面（和开始菜单）创建「Quick 多账号管理器」快捷方式
# 目标: wscript.exe + start-app.vbs（静默无控制台），图标用 electron\icon.png 编译的 ico
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$vbs = Join-Path $Here 'start-app.vbs'
if (-not (Test-Path $vbs)) { throw "缺少 $vbs" }

# 生成 .ico（Electron 的 icon.png 转 ico：多尺寸打包为 PNG-in-ICO）
$png = Join-Path $Here 'electron\icon.png'
$ico = Join-Path $Here 'electron\icon.ico'
if ((Test-Path $png) -and -not (Test-Path $ico)) {
  try {
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile($png)
    $sizes = @(16, 32, 48, 64, 128, 256)
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
    $images = @()
    foreach ($s in $sizes) {
      $bmp = New-Object System.Drawing.Bitmap($s, $s)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = 'HighQualityBicubic'
      $g.DrawImage($src, 0, 0, $s, $s)
      $g.Dispose()
      $pms = New-Object System.IO.MemoryStream
      $bmp.Save($pms, [System.Drawing.Imaging.ImageFormat]::Png)
      $images += ,$pms.ToArray()
      $bmp.Dispose()
    }
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
      $s = $sizes[$i]; $len = $images[$i].Length
      $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
      $bw.Write([Byte]$(if ($s -ge 256) { 0 } else { $s }))
      $bw.Write([Byte]0); $bw.Write([Byte]0)
      $bw.Write([UInt16]1); $bw.Write([UInt16]32)
      $bw.Write([UInt32]$len); $bw.Write([UInt32]$offset)
      $offset += $len
    }
    foreach ($img in $images) { $bw.Write($img) }
    $bw.Flush()
    [IO.File]::WriteAllBytes($ico, $ms.ToArray())
    $bw.Dispose(); $ms.Dispose(); $src.Dispose()
    Write-Host "已生成图标: $ico" -ForegroundColor Green
  } catch {
    Write-Host ("图标生成失败（不影响快捷方式）: " + $_.Exception.Message) -ForegroundColor DarkYellow
    $ico = $null
  }
}

$targets = @()
$targets += [Environment]::GetFolderPath('Desktop')
$targets += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
$targets += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup')  # 开机自启（可选，默认不加）
$targets = $targets[0..1]

$wsh = New-Object -ComObject WScript.Shell
foreach ($dir in $targets) {
  if (-not (Test-Path $dir)) { continue }
  $lnk = Join-Path $dir 'Quick 多账号管理器.lnk'
  $sc = $wsh.CreateShortcut($lnk)
  $sc.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $sc.Arguments = '"' + $vbs + '"'
  $sc.WorkingDirectory = $Here
  if ($ico -and (Test-Path $ico)) { $sc.IconLocation = $ico }
  $sc.Description = 'Quick 多账号管理器（账号 / 额度 / 配置 / 运维）'
  $sc.WindowStyle = 1
  $sc.Save()
  Write-Host "已创建: $lnk" -ForegroundColor Green
}
Write-Host '完成。双击桌面图标即可启动（无控制台窗口）。'

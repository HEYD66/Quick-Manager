@echo off
setlocal
chcp 65001 >nul
title 启动 Quick 账号切换助手

cd /d "%~dp0"
echo 正在启动 Quick 账号切换助手...

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-app.ps1"
if errorlevel 1 (
  echo.
  echo [启动失败] 请检查上面的错误信息，或确认 Electron / Node.js 环境正常。
  pause
  exit /b 1
)

exit /b 0

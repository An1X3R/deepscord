@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Deepscord — 语音频道服务器（关闭窗口即停止）

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [错误] 未找到 Node.js，请先安装： https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo  正在启动 Deepscord，稍后会自动打开浏览器…
echo.

start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:3000"
node server.js

echo.
echo  服务已停止。
pause

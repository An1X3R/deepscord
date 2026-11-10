@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Deepscord — 局域网 HTTPS 模式（关闭窗口即停止）

where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未找到 Node.js，请先安装： https://nodejs.org
  pause
  exit /b 1
)

set "OPENSSL=C:\Program Files\Git\usr\bin\openssl.exe"
if not exist "%OPENSSL%" set "OPENSSL=openssl"
"%OPENSSL%" version >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [提示] 未找到 openssl，无法生成 HTTPS 证书。
  echo  可以安装 Git for Windows（自带 openssl），或用手机浏览器测试时使用 localhost。
  echo.
  pause
  exit /b 1
)

rem ---- 取一个局域网 IPv4 地址，写入证书 SAN ----
set "LANIP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } ^| Select-Object -First 1 -ExpandProperty IPAddress)"`) do set "LANIP=%%i"
if not defined LANIP set "LANIP=192.168.1.2"

if not exist certs mkdir certs

echo.
echo  正在生成自签名证书（局域网 IP: %LANIP%）…
"%OPENSSL%" req -x509 -newkey rsa:2048 -nodes ^
  -keyout certs\server.key -out certs\server.crt -days 825 ^
  -subj "/CN=deepscord-local" ^
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:%LANIP%" >nul 2>nul
if errorlevel 1 (
  echo  [错误] 证书生成失败。
  pause
  exit /b 1
)
echo  已生成： certs\server.crt / certs\server.key

echo.
set /p TRUST=  是否将证书加入「当前用户受信任根证书」，让浏览器不再报警告？(Y/N):
if /i "%TRUST%"=="Y" (
  certutil -addstore -user Root certs\server.crt >nul 2>nul
  if errorlevel 1 (
    echo  [提示] 自动信任失败，请手动双击 certs\server.crt 并选择“安装证书”。
  ) else (
    echo  已加入受信任根证书（仅当前用户）。
  )
)

echo.
echo  正在启动 HTTPS 服务，稍后打开 https://localhost:3443 …
echo  局域网设备请访问： https://%LANIP%:3443
echo  首次打开若仍提示“不安全”，点「高级」→「继续前往」即可。
echo.

start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start https://localhost:3443"
node server.js

echo.
echo  服务已停止。
pause

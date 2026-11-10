@echo off
setlocal
title Deepscord Server
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
set "SERVER_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVER_EXIT_CODE%"=="0" (
  echo Server stopped with an error. Check the message above.
  pause
)
exit /b %SERVER_EXIT_CODE%

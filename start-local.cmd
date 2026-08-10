@echo off
setlocal
title DEAR-OWL local launcher
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve-local.ps1" %*
if errorlevel 1 (
  echo.
  echo DEAR-OWL could not start. Review the message above.
  pause
)

@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_airchina_ui.ps1"
if errorlevel 1 pause

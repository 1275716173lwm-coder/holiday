@echo off
chcp 65001 >nul
cd /d "%~dp0"
"%~dp0runtime\node.exe" airchina_web.js --login --keep-browser-open
pause

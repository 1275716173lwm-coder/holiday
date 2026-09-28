@echo off
chcp 65001 >nul
cd /d "%~dp0"
node airchina_web.js --login --keep-browser-open
pause

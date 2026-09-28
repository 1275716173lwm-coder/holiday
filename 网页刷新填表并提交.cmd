@echo off
chcp 65001 >nul
cd /d "%~dp0"
node airchina_web.js --wait-open --allow-submit --keep-browser-open
pause

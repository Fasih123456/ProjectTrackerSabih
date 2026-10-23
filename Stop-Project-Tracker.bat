@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\stop.ps1"
timeout /t 3 >nul

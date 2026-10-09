@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-stock-app.ps1" %*
if errorlevel 1 (
    echo.
    echo Avvio non riuscito. Leggi il messaggio qui sopra.
    pause
)


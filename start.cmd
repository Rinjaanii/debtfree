@echo off
rem Запуск DebtFree на своём компьютере (Windows).
rem Сервер сам находит свои файлы, поэтому рабочая папка не важна.
chcp 65001 >nul
title DebtFree - сервер
echo Запускаем DebtFree...
echo.
echo   Приложение на этом компьютере: http://localhost:8080
echo   Для Telegram: запустите в другом окне start-tunnel.cmd
echo.
echo Оставьте это окно открытым. Остановить: Ctrl+C
echo.
node "%~dp0src\server.js"
echo.
echo Сервер остановлен.
pause

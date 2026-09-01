@echo off
rem arb-bot baslatici.
rem
rem Neden PowerShell degil de .cmd: "npm" yazildiginda PowerShell,
rem C:\Program Files\nodejs\npm.cmd yerine npm.ps1 dosyasini secer ve
rem Windows'un varsayilan ExecutionPolicy'si (Restricted) script calismasini
rem engelledigi icin "npm.ps1 cannot be loaded" hatasi verir. cmd.exe bu
rem kisitlamaya tabi degil, dolayisiyla sistem ayarini degistirmeye gerek kalmaz.
rem
rem PATH satiri, Node kurulmadan once acilmis oturumlarin eski PATH'iyle
rem baslatilma ihtimaline karsi var.

set "PATH=%PATH%;C:\Program Files\nodejs\"
cd /d "%~dp0"

echo arb-bot baslatiliyor... (cikmak icin Ctrl+C)
echo.
call npm run dev

echo.
echo Bot durdu. Pencereyi kapatmak icin bir tusa bas.
pause >nul

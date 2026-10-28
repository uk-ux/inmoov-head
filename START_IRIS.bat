@echo off
rem IRIS — one double-click: servers start hidden, IRIS opens as an app window.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start_iris.ps1"

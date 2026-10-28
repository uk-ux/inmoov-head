@echo off
title InMoov head UI server
cd /d U:\inmoov
echo Starting InMoov head UI at http://127.0.0.1:8765/ ...
echo Keep this window OPEN while you use the pages.
echo Close this window (or press Ctrl+C) to stop the server.
start "" http://127.0.0.1:8765/fastcal.html
py -m http.server 8765 --bind 127.0.0.1 --directory control_ui
pause

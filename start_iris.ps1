# IRIS launcher — starts everything hidden, then opens IRIS as her own app
# window (no browser chrome). With -Autostart (the login shortcut) nothing
# pops up: servers + tray assistant only; open the window from the tray icon.
param([switch]$Autostart)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# 1. static UI server (orb page, calibrator)
if (-not (Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -WindowStyle Hidden py -ArgumentList '-m','http.server','8765','--bind','127.0.0.1','--directory',"$root\control_ui" -WorkingDirectory $root
}

# 2. Ollama (local fallback brain). Prefer the desktop app; plain serve otherwise.
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) {
    $app = "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
    if (Test-Path $app) { Start-Process $app }
    else { Start-Process -WindowStyle Hidden ollama -ArgumentList 'serve' }
}

# 3. voice backend (whisper + kokoro/piper + mms + gemini/qwen).
#    Logs land in %TEMP%\iris-server.log — read that when something breaks.
if (-not (Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -WindowStyle Hidden "$root\voice\venv\Scripts\python.exe" `
        -ArgumentList "$root\voice\server.py" -WorkingDirectory "$root\voice" `
        -RedirectStandardOutput "$env:TEMP\iris-server.log" `
        -RedirectStandardError "$env:TEMP\iris-server-err.log"
}

# 4. tray assistant (always-on microphone, 'Iris' wake word, speaker replies)
$asst = Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
        Where-Object { $_.CommandLine -match 'assistant\.py' }
if (-not $asst) {
    Start-Process -WindowStyle Hidden "$root\voice\venv\Scripts\pythonw.exe" `
        -ArgumentList "$root\voice\assistant.py" -WorkingDirectory "$root\voice"
}

# 5. IRIS window (skipped at login — use the tray icon's 'Open IRIS window')
if (-not $Autostart) {
    for ($i = 0; $i -lt 90; $i++) {
        if (Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue) { break }
        Start-Sleep 1
    }
    Start-Process $edge -ArgumentList "--app=http://127.0.0.1:8765/jarvis.html"
}

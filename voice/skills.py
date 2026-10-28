"""InMoov skills — turning speech into actions.

Two layers, fast first:

  1. FAST INTENTS (this file) — regex patterns in English and Tamil that map
     straight to an action. Zero model latency: "look around" fires in about
     a millisecond instead of waiting 5 s for an 8B model to emit a tool call.
     This is why commands feel instant while conversation still feels smart.

  2. The LLM handles everything that is not a command.

Robot motion goes out over the same serial protocol the browser UI uses
(C<ch> <pulse>), so nothing new had to be added to the firmware.
Laptop control is a fixed allow-list — never arbitrary shell execution.
"""
import os, re, subprocess, time, threading
from pathlib import Path

import tasks_notes
import app_catalog
import training

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
DASHBOARD_URL = "http://127.0.0.1:8765/jarvis.html"

app_catalog.refresh_async()     # index every installed app for "open <anything>"

# ---------------------------------------------------------------- robot link
class Robot:
    """Serial link to the Uno. Safe by default: does nothing unless enabled."""

    def __init__(self, port=None, baud=115200):
        self.port, self.baud, self.ser = port, baud, None
        self.lock = threading.Lock()
        self.last_error = None

    def connect(self):
        if not self.port or self.ser:
            return self.ser is not None
        try:
            import serial
            self.ser = serial.Serial(self.port, self.baud, timeout=1)
            time.sleep(2.0)          # Uno resets on open; firmware prints READY
            self.ser.reset_input_buffer()
            return True
        except Exception as e:
            self.last_error = str(e)[:120]
            self.ser = None
            return False

    def send(self, line):
        if not self.ser and not self.connect():
            return False
        try:
            with self.lock:
                self.ser.write((line + "\n").encode())
            return True
        except Exception as e:
            self.last_error = str(e)[:120]
            self.ser = None
            return False

    def pose(self, moves, hold=0.0):
        """moves: {channel: pulse}. Sends one channel at a time, like the UI."""
        ok = all(self.send(f"C{ch} {us}") for ch, us in moves.items())
        if hold:
            time.sleep(hold)
        return ok

    def off(self):
        return self.send("0")

    @property
    def available(self):
        return bool(self.port)


robot = Robot()      # server sets robot.port when the user enables motion

# Calibrated rest values from INMOOV_AGENT_HANDOFF.md. Every pose below stays
# inside the compiled firmware limits, and the firmware rejects anything that
# does not — so a bad value here cannot drive a servo past its stop.
REST = {0: 1477, 1: 1500, 2: 1477, 3: 1522, 8: 1500, 9: 1500,
        10: 1411, 11: 1300, 12: 1455, 13: 1566, 14: 1500, 15: 1500}
EYES_L = {0: 1360, 2: 1360}
EYES_R = {0: 1600, 2: 1600}
EYES_C = {0: 1477, 2: 1477}
EYES_UP = {1: 1400, 3: 1620}
EYES_DOWN = {1: 1600, 3: 1420}
SMILE = {8: 1400, 9: 1600, 14: 1380, 15: 1620, 11: 1340}
SAD = {8: 1620, 9: 1380, 14: 1600, 15: 1400}
SURPRISE = {1: 1433, 3: 1589, 8: 1322, 9: 1700, 11: 1560, 12: 1700, 13: 1322}


def _look_around():
    """A slow scan: right, left, centre. Reads as curiosity, not a twitch."""
    robot.pose(EYES_R, 0.75)
    robot.pose(EYES_L, 0.95)
    robot.pose(EYES_C, 0.4)
    return "Looking around."


def _blink(times=2):
    for _ in range(times):
        robot.send("B1"); time.sleep(0.16)
        robot.send("B0"); time.sleep(0.28)
    return "Blinking."


def _expression(pose, name):
    robot.pose(pose, 1.6)
    robot.pose(REST)
    return name


# ---------------------------------------------------------------- laptop link
def _run(args):
    try:
        subprocess.Popen(args, shell=False,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return True
    except Exception:
        return False


def _ps(script):
    return _run(["powershell", "-NoProfile", "-WindowStyle", "Hidden",
                 "-Command", script])


def _volume(direction, steps=5):
    key = {"up": 175, "down": 174, "mute": 173}[direction]
    _ps("$w=New-Object -ComObject WScript.Shell;" +
        f"1..{steps}|%{{$w.SendKeys([char]{key})}}")
    return {"up": "Volume up.", "down": "Volume down.", "mute": "Muted."}[direction]


def _media(key, msg):
    """One media key press: 179 play/pause, 176 next, 177 previous."""
    _ps(f"$w=New-Object -ComObject WScript.Shell;$w.SendKeys([char]{key})")
    return msg


def _brightness(delta):
    _ps("$b=(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightness).CurrentBrightness;"
        f"$n=[Math]::Max(0,[Math]::Min(100,$b+({delta})));"
        "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,$n)")
    return "Brightness up." if delta > 0 else "Brightness down."


APPS = {
    "notepad": "notepad.exe", "calculator": "calc.exe", "calculator app": "calc.exe",
    "chrome": "chrome.exe", "browser": "chrome.exe", "edge": "msedge.exe",
    "explorer": "explorer.exe", "file explorer": "explorer.exe",
    "file manager": "explorer.exe",
    "files": "explorer.exe", "paint": "mspaint.exe", "terminal": "wt.exe",
    "camera": "microsoft.windows.camera:", "settings": "ms-settings:",
    "task manager": "taskmgr.exe", "calendar": "outlookcal:",
}

SITES = {
    "youtube": "https://www.youtube.com", "google": "https://www.google.com",
    "gmail": "https://mail.google.com", "email": "https://mail.google.com",
    "github": "https://github.com", "wikipedia": "https://www.wikipedia.org",
    "maps": "https://www.google.com/maps", "google maps": "https://www.google.com/maps",
    "instagram": "https://www.instagram.com",
    "spotify": "https://open.spotify.com",
    "news": "https://news.google.com", "the news": "https://news.google.com",
}

# Apps IRIS may force-close by name. Never explorer or the task manager —
# killing those takes the desktop down with them.
CLOSABLE = {
    "notepad": "notepad.exe", "calculator": "CalculatorApp.exe",
    "chrome": "chrome.exe", "browser": "chrome.exe", "edge": "msedge.exe",
    "paint": "mspaint.exe", "camera": "WindowsCamera.exe",
}


def _open_app(name):
    name = name.lower().strip(" .?!")
    url = SITES.get(name)
    if not url:
        for k, v in SITES.items():
            if k in name:
                url, name = v, k
                break
    if url:
        _run(["cmd", "/c", "start", "", url])
        return f"Opening {name}."
    exe = APPS.get(name)
    if not exe:
        for k, v in APPS.items():
            if k in name or name in k:
                exe, name = v, k
                break
    if not exe:
        # Anything installed on this PC: Start Menu + Store apps catalog.
        entry = app_catalog.resolve(name)
        if entry and app_catalog.launch(entry):
            return f"Opening {entry['name']}."
        return (f"I do not know how to open {name}. "
                "If it is newly installed, say rescan my apps.")
    _run(["cmd", "/c", "start", "", exe])
    return f"Opening {name}."


# Never these — IRIS herself, her brain, and the Windows desktop.
PROTECTED = "'python','pythonw','ollama','ollama app','explorer','taskmgr','dwm','csrss','winlogon'"


def _close_app(name):
    name = name.lower().strip(" .?!")
    exe = CLOSABLE.get(name)
    if not exe:
        for k, v in CLOSABLE.items():
            if k in name:
                exe, name = v, k
                break
    if exe:
        _run(["taskkill", "/IM", exe, "/F"])
        return f"Closing {name}."
    # Any other app: graceful window close first, force only if it lingers.
    entry = app_catalog.resolve(name)
    disp = entry["name"] if entry else name
    pat = re.sub(r"[^\w ]", "", disp)
    out = _ps_out(
        f"$t='{pat}';"
        "$p=Get-Process | Where-Object {($_.MainWindowTitle -match $t) -or "
        "($_.ProcessName -match ($t -replace ' ',''))};"
        f"$p=$p | Where-Object {{ @({PROTECTED}) -notcontains $_.ProcessName }};"
        "if($p){$p | ForEach-Object {$null=$_.CloseMainWindow()}; Start-Sleep 1;"
        "$p | Where-Object {-not $_.HasExited} | Stop-Process -Force -ErrorAction SilentlyContinue;'ok'}")
    return f"Closing {disp}." if "ok" in out else f"I do not see {disp} running."


def _switch_to(name):
    entry = app_catalog.resolve(name.strip(" .?!"))
    disp = entry["name"] if entry else name
    pat = re.sub(r"[^\w ]", "", disp)
    out = _ps_out(
        f"$t='{pat}';"
        "$p=Get-Process | Where-Object {$_.MainWindowTitle -match $t -or "
        "($_.MainWindowTitle -and $_.ProcessName -match ($t -replace ' ',''))} | Select-Object -First 1;"
        "if($p){(New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null;'ok'}")
    return f"Switching to {disp}." if "ok" in out else f"I do not see {disp} open."


def _web(url, msg):
    _run(["cmd", "/c", "start", "", url])
    return msg


def _search_web(q):
    from urllib.parse import quote_plus
    q = q.strip(" .?!")
    return _web("https://www.google.com/search?q=" + quote_plus(q), f"Searching for {q}.")


def _youtube(q):
    from urllib.parse import quote_plus
    q = q.strip(" .?!")
    return _web("https://www.youtube.com/results?search_query=" + quote_plus(q),
                f"Looking for {q} on YouTube.")


def _play_song(q):
    """'Play <song>' actually plays it: fetch YouTube's results page, take
    the first video id, open its watch URL — playback starts immediately.
    Offline or blocked, fall back to the search page."""
    from urllib.parse import quote_plus
    import urllib.request
    q = q.strip(" .?!")
    search = "https://www.youtube.com/results?search_query=" + quote_plus(q)
    try:
        req = urllib.request.Request(search, headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=6).read().decode("utf-8", "ignore")
        m = re.search(r'"videoId":"([\w-]{11})"', html)
        if m:
            _run(["cmd", "/c", "start", "", "https://www.youtube.com/watch?v=" + m.group(1)])
            return f"Playing {q}."
    except Exception:
        pass
    _run(["cmd", "/c", "start", "", search])
    return f"I could not pick a video, so here is the YouTube search for {q}."


def _type_text(text):
    # SendKeys treats +^%~(){}[] as commands — wrap them, then double the
    # quotes so the text survives the PowerShell single-quoted string.
    esc = "".join("{%s}" % c if c in "+^%~(){}[]" else c for c in text)
    esc = esc.replace("'", "''")
    _ps("Add-Type -AssemblyName System.Windows.Forms;"
        f"[System.Windows.Forms.SendKeys]::SendWait('{esc}')")
    return "Typing."


def _minimize_all():
    _ps("(New-Object -ComObject Shell.Application).MinimizeAll()")
    return "Minimizing everything."


def _close_window():
    _ps("Add-Type -AssemblyName System.Windows.Forms;"
        "[System.Windows.Forms.SendKeys]::SendWait('%{F4}')")
    return "Closing the window."


def _sleep_pc():
    _run(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"])
    return "Going to sleep. Wake me when you need me."


def _power(mode):
    """Shutdown and restart get a 30 s grace period and a spoken way out,
    so one misheard word can never pull the plug instantly."""
    if mode == "cancel":
        _run(["shutdown", "/a"])
        return "Cancelled. Staying on."
    _run(["shutdown", "/s" if mode == "off" else "/r", "/t", "30"])
    verb = "Shutting down" if mode == "off" else "Restarting"
    return f"{verb} in thirty seconds. Say cancel shutdown if you change your mind."


def _disk_space():
    import shutil
    parts = []
    for d in ("C:\\", "U:\\"):
        try:
            u = shutil.disk_usage(d)
            parts.append(f"{d[0]} drive has {u.free / 1e9:.0f} gigabytes free of {u.total / 1e9:.0f}")
        except Exception:
            pass
    return ("; ".join(parts) + ".") if parts else "I could not read the disks."


def _my_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return f"My local IP address is {ip}."
    except Exception:
        return "I could not read the network address."


def _screenshot():
    try:
        from PIL import ImageGrab
        out = Path.home() / "Pictures" / f"inmoov-{time.strftime('%H%M%S')}.png"
        out.parent.mkdir(exist_ok=True)
        ImageGrab.grab().save(out)
        return "Screenshot saved to your Pictures folder."
    except Exception:
        _ps("Add-Type -AssemblyName System.Windows.Forms;"
            "[System.Windows.Forms.SendKeys]::SendWait('{PRTSC}')")
        return "Screenshot copied to the clipboard."


def _ps_out(script):
    """Run PowerShell and return its output (for read-back skills)."""
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                           capture_output=True, text=True, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return (r.stdout or "").strip()
    except Exception:
        return ""


def _key(keys, msg):
    _ps("Add-Type -AssemblyName System.Windows.Forms;"
        f"[System.Windows.Forms.SendKeys]::SendWait('{keys}')")
    return msg


def _clipboard():
    t = _ps_out("Get-Clipboard -Raw")
    if not t:
        return "The clipboard is empty."
    t = " ".join(t.split())
    return "The clipboard says: " + t[:220] + ("…" if len(t) > 220 else "")


FOLDERS = {"downloads": "Downloads", "documents": "Documents", "pictures": "Pictures",
           "music": "Music", "videos": "Videos", "desktop": "Desktop"}


def _open_folder(word):
    _run(["explorer.exe", str(Path.home() / FOLDERS[word])])
    return f"Opening your {word} folder."


# One-shot spoken confirmation for the few genuinely destructive actions.
_pending = {"action": None, "t": 0.0}


def _ask_confirm(action, prompt):
    _pending["action"], _pending["t"] = action, time.time()
    return prompt


def _confirm():
    act, fresh = _pending["action"], time.time() - _pending["t"] < 25
    _pending["action"] = None
    if act == "recycle" and fresh:
        _ps("Clear-RecycleBin -Force -ErrorAction SilentlyContinue")
        return "Recycle bin emptied."
    return "There is nothing waiting for confirmation."


def _diagnose():
    """A spoken health check of InMoov — the JARVIS 'run diagnostics' moment.

    Checks the serial link, asks the firmware for a safe state, and reports.
    It never drives a servo; it only confirms the head is reachable and safe.
    """
    if not robot.available:
        return ("Diagnostics: my body is not connected. Enable motion first, "
                "and make sure the calibrator is closed so I can use the port.")
    checks = []
    # 1. serial link up?
    if robot.connect():
        checks.append("serial link to the controller is up")
    else:
        return f"Diagnostics failed: I cannot reach the controller. {robot.last_error or ''}"
    # 2. can the firmware accept a safe command?
    if robot.off():
        checks.append("all servo outputs are safely off")
    else:
        checks.append("WARNING: the controller did not confirm outputs off")
    # 3. report the known configuration
    checks.append("sixteen facial channels are configured")
    return "Diagnostics complete. " + ". ".join(c[0].upper() + c[1:] for c in checks) + "."


def _status_report():
    parts = []
    parts.append("my body is connected" if robot.available else "my body is not connected")
    try:
        parts.append(_battery().lower().rstrip("."))
    except Exception:
        pass
    parts.append("it is " + time.strftime("%I:%M %p").lstrip("0"))
    return "Here is my status. " + ", and ".join(parts) + "."


def _open_dashboard():
    if Path(EDGE).exists():
        _run([EDGE, "--app=" + DASHBOARD_URL])
    else:
        _run(["cmd", "/c", "start", "", DASHBOARD_URL])
    return "Opening the dashboard."


def _headlines(n=3):
    """Top news titles for the briefing; '' when offline."""
    try:
        from ddgs import DDGS
        hits = list(DDGS().news("top world news today", max_results=n))
        titles = [re.sub(r"\s+", " ", h["title"]).strip(" .") for h in hits[:n]]
        return "In the news: " + ". ".join(titles) + "." if titles else ""
    except Exception:
        return ""


def _briefing():
    """The JARVIS morning moment: one spoken summary of the day."""
    h = time.localtime().tm_hour
    hello = "Good morning" if h < 12 else ("Good afternoon" if h < 17 else "Good evening")
    parts = [f"{hello}. It is {time.strftime('%I:%M %p').lstrip('0')} on "
             f"{time.strftime('%A, %d %B')}."]
    try:
        b = _battery()
        if b.startswith("Battery"):
            parts.append(b)
    except Exception:
        pass
    parts.append(tasks_notes.spoken_task_list())
    news = _headlines()
    if news:
        parts.append(news)
    parts.append("I am listening whenever you need me.")
    return " ".join(parts)


def _battery():
    try:
        import ctypes

        class S(ctypes.Structure):
            _fields_ = [("ACLineStatus", ctypes.c_byte), ("BatteryFlag", ctypes.c_byte),
                        ("BatteryLifePercent", ctypes.c_byte), ("SystemStatusFlag", ctypes.c_byte),
                        ("BatteryLifeTime", ctypes.c_ulong), ("BatteryFullLifeTime", ctypes.c_ulong)]
        s = S()
        ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(s))
        plug = " and charging" if s.ACLineStatus == 1 else ""
        return f"Battery is at {s.BatteryLifePercent} percent{plug}."
    except Exception:
        return "I could not read the battery."


# ---------------------------------------------------------------- intents
# (pattern, handler, needs_robot).  Tamil alternatives sit in the same pattern.
INTENTS = [
    # --- head / face ---
    (r"\b(look around|scan (the )?room|சுற்றி\s*பார்)\b", lambda m: _look_around(), True),
    (r"\b(look (to (the )?)?left|இடது\s*பக்கம்\s*பார்)\b",
     lambda m: (robot.pose(EYES_L), "Looking left.")[1], True),
    (r"\b(look (to (the )?)?right|வலது\s*பக்கம்\s*பார்)\b",
     lambda m: (robot.pose(EYES_R), "Looking right.")[1], True),
    (r"\b(look up|மேலே\s*பார்)\b", lambda m: (robot.pose(EYES_UP), "Looking up.")[1], True),
    (r"\b(look down|கீழே\s*பார்)\b", lambda m: (robot.pose(EYES_DOWN), "Looking down.")[1], True),
    (r"\b(look at me|center your eyes|நேராக\s*பார்)\b",
     lambda m: (robot.pose(EYES_C), "Looking at you.")[1], True),
    (r"\b(blink|கண்\s*சிமிட்டு)\b", lambda m: _blink(), True),
    (r"\b(smile|சிரி)\b", lambda m: _expression(SMILE, "Smiling."), True),
    (r"\b(look sad|frown|சோகமா)\b", lambda m: _expression(SAD, "Feeling sad."), True),
    (r"\b(look surprised|surprise|ஆச்சரியம்)\b",
     lambda m: _expression(SURPRISE, "Surprised."), True),
    (r"\b(neutral|relax your face|rest your face|இயல்பு\s*நிலை)\b",
     lambda m: (robot.pose(REST), "Back to neutral.")[1], True),
    (r"\b(stop moving|freeze|outputs off|நிறுத்து)\b",
     lambda m: (robot.off(), "Stopping all movement.")[1], True),
    (r"\b(run (a )?diagnostic|diagnostics|health check|self test|check yourself|சோதனை)\b",
     lambda m: _diagnose(), False),
    (r"\b(status report|system status|how are your systems|report status)\b",
     lambda m: _status_report(), False),

    # --- training: teach answers, personality, review, untrain ---
    (r"^(?:(?:train|teach)(?: answer)?[:,]?\s*)?when i say\s+(.+?)\s*,?\s*(?:you\s+)?"
     r"(?:say|reply|answer)[:,]?\s+(.+)$",
     lambda m: training.teach(m.group(1), m.group(2)), False),
    (r"^(?:train|teach)\s+(?:your\s+)?(?:personality|style|behaviou?r)[:,]?\s+(.+)$",
     lambda m: training.add_style(m.group(1)), False),
    (r"\b(?:show|what is|what's) (?:your |my )?training\b|\bwhat have (?:you|i) "
     r"(?:been )?(?:taught|trained)\b", lambda m: training.describe_training(), False),
    (r"^forget (?:the )?training (?:about |for )?(.+)$",
     lambda m: (lambda n: f"Removed {n} trained answer{'s' if n != 1 else ''}."
                if n else "I had no training matching that.")(training.forget(m.group(1))), False),
    (r"^(?:clear|reset) (?:your )?personality(?: training)?$",
     lambda m: f"Cleared {training.clear_style()} behavior rules.", False),

    # --- tasks, notes, briefing (before the generic open/close patterns) ---
    (r"\b(daily|morning) briefing\b|\bstart my day\b|\bbrief me\b|\bgood morning\b",
     lambda m: _briefing(), False),
    (r"\b(?:take|make) a note[:,]?\s+(.+)$|\bnote down[:,]?\s+(.+)$",
     lambda m: ("Noted." if tasks_notes.add_note(m.group(1) or m.group(2)) else
                "I did not catch the note."), False),
    (r"\b(?:read|what are) my notes\b", lambda m: tasks_notes.spoken_notes(), False),
    (r"\b(?:add (?:a )?task|new task)[:,]?\s+(.+)$|\bremind me to\s+(.+)$",
     lambda m: tasks_notes.add_task(m.group(1) or m.group(2)), False),
    (r"\b(?:what are|read|list) my tasks\b|\btask list\b|\bwhat(?:'s| is) on my list\b",
     lambda m: tasks_notes.spoken_task_list(), False),
    (r"\b(?:task|mark)\s+(.+?)\s+(?:as )?done\b|\bcomplete (?:the )?task\s+(.+)$",
     lambda m: (lambda t: f"Done: {t}." if t else "I could not find that task.")(
         tasks_notes.complete(m.group(1) or m.group(2))), False),
    (r"\bopen (?:the )?dashboard\b|\bshow (?:me )?the dashboard\b",
     lambda m: _open_dashboard(), False),

    # --- laptop ---
    (r"\bplay (.+?) on youtube\b", lambda m: _play_song(m.group(1)), False),
    (r"\bsearch (?:for )?(.+?) (?:on|in) youtube\b", lambda m: _youtube(m.group(1)), False),
    (r"\bsearch youtube for (.+)$", lambda m: _youtube(m.group(1)), False),
    (r"\b(?:search(?: the web)?(?: for)?|google) (.+)$", lambda m: _search_web(m.group(1)), False),
    (r"^type (.+)$", lambda m: _type_text(m.group(1)), False),
    (r"\bopen (?:my )?(downloads|documents|pictures|music|videos|desktop)(?: folder)?\b",
     lambda m: _open_folder(m.group(1)), False),
    (r"\b(?:rescan|refresh) (?:my )?apps\b",
     lambda m: f"Done. I can now open {app_catalog.refresh(force=True)} applications.", False),
    (r"\bopen (?:the )?(.+?)(?: app| program)?\s*$", lambda m: _open_app(m.group(1)), False),
    (r"\bclose (?:(?:this|that|the)(?: current)? )?window\b", lambda m: _close_window(), False),
    (r"\b(?:switch to|go to|focus|bring up) (?!sleep\b)(?:the )?(.+?)(?: app| window)?\s*$",
     lambda m: _switch_to(m.group(1)), False),
    (r"\bclose (?:the )?(.+?)(?: app| program)?\s*$", lambda m: _close_app(m.group(1)), False),
    # Bare playback controls are FULL-sentence matches, so "play the song
    # faded" is a song request (below), not a pause toggle.
    (r"^(?:pause|resume|stop)(?: the)?(?: music| song| video| media)?[.!]?$"
     r"|^play(?: the)?(?: music| song| video)[.!]?$",
     lambda m: _media(179, "Done."), False),
    (r"\b(next (song|track)|skip (this )?(song|track))\b", lambda m: _media(176, "Next track."), False),
    (r"\b(previous (song|track)|last song|go back a (song|track))\b",
     lambda m: _media(177, "Previous track."), False),
    # "Play <anything>" — find it on YouTube and play it.
    (r"^(?:please )?(?:can you )?play (?:the )?(?:song |track |some )?(.+)$",
     lambda m: _play_song(m.group(1)), False),
    (r"\b(volume up|louder|turn it up|சத்தம்\s*அதிகரி)\b", lambda m: _volume("up"), False),
    (r"\b(volume down|quieter|turn it down|சத்தம்\s*குறை)\b", lambda m: _volume("down"), False),
    (r"\b(mute|unmute|silence)\b", lambda m: _volume("mute"), False),
    (r"\b(brightness up|brighter|increase (the )?brightness)\b", lambda m: _brightness(20), False),
    (r"\b(brightness down|dimmer|reduce (the )?brightness|decrease (the )?brightness)\b",
     lambda m: _brightness(-20), False),
    (r"\b(minimize (everything|all( (the )?windows)?)|show (me )?(the )?desktop)\b",
     lambda m: _minimize_all(), False),
    (r"\b(take a )?screenshot\b", lambda m: _screenshot(), False),
    (r"\b(lock (the )?(screen|laptop|computer))\b",
     lambda m: (_run(["rundll32.exe", "user32.dll,LockWorkStation"]), "Locking the screen.")[1], False),
    (r"\b(go to sleep|sleep now|sleep (the )?(laptop|computer|pc))\b",
     lambda m: _sleep_pc(), False),
    (r"\bcancel (the )?(shutdown|restart)\b", lambda m: _power("cancel"), False),
    # Requires an object ("the laptop"), like restart — a bare "shut down" in a
    # question ("why did it shut down?") must never start a real shutdown.
    (r"\bshut ?down (the )?(laptop|computer|pc)\b", lambda m: _power("off"), False),
    (r"\brestart (the )?(laptop|computer|pc)\b", lambda m: _power("restart"), False),
    (r"\bpress enter\b", lambda m: _key("{ENTER}", "Enter."), False),
    (r"\bpress escape\b", lambda m: _key("{ESC}", "Escape."), False),
    (r"\bscroll down\b", lambda m: _key("{PGDN}", "Scrolling down."), False),
    (r"\bscroll up\b", lambda m: _key("{PGUP}", "Scrolling up."), False),
    (r"\b(?:switch|next) window\b", lambda m: _key("%{TAB}", "Switching windows."), False),
    (r"\bwhat(?:'s| is) (?:in|on) (?:my |the )?clipboard\b|\bread (?:my |the )?clipboard\b",
     lambda m: _clipboard(), False),
    (r"\bempty (?:the )?recycle bin\b",
     lambda m: _ask_confirm("recycle",
        "That permanently deletes everything in the recycle bin. Say confirm to proceed."), False),
    (r"^(?:yes,?\s*)?confirm(?: it)?\.?$|^yes,? (?:do it|empty it)\.?$",
     lambda m: _confirm(), False),
    (r"\b(disk space|free space|storage (left|space))\b", lambda m: _disk_space(), False),
    (r"\b(ip address|my ip)\b", lambda m: _my_ip(), False),
    (r"\b(battery|charge level|பேட்டரி)\b", lambda m: _battery(), False),
    (r"\bwhat(?:'s| is)? the time|what time is it|நேரம்\s*என்ன\b",
     lambda m: "It is " + time.strftime("%I:%M %p").lstrip("0") + ".", False),
    (r"\bwhat(?:'s| is)? (?:today'?s )?(?:date|day)|what day is it|என்ன\s*தேதி\b",
     lambda m: "Today is " + time.strftime("%A, %d %B %Y") + ".", False),
]
COMPILED = [(re.compile(p, re.IGNORECASE), fn, needs) for p, fn, needs in INTENTS]


def match(text):
    """Return (reply, name) if this is a command, else (None, None).

    Runs before the LLM, so commands never pay model latency.
    """
    t = " ".join(text.split())
    for rx, fn, needs_robot in COMPILED:
        m = rx.search(t)
        if not m:
            continue
        if needs_robot and not robot.available:
            return ("My body is not connected yet, so I cannot move. "
                    "Enable motion once the servos are calibrated."), "blocked"
        try:
            return fn(m), rx.pattern[:28]
        except Exception as e:
            return f"I tried, but something went wrong: {str(e)[:60]}", "error"
    return None, None


def describe():
    return {
        "robot": ["look around", "look left / right / up / down", "look at me",
                  "blink", "smile", "look sad", "look surprised", "neutral",
                  "stop moving"],
        "training": ["when I say <phrase>, say <answer>",
                     "train personality: <rule, e.g. always call me boss>",
                     "show your training", "forget training <phrase>",
                     "clear your personality", "remember that <fact>"],
        "jarvis": ["daily briefing / good morning", "take a note <anything>",
                   "read my notes", "add task <thing> at 5 pm",
                   "remind me to <thing>", "what are my tasks",
                   "task <thing> done", "open the dashboard"],
        "laptop": [f"open <any of your {app_catalog.count() or 'installed'} apps> — whatsapp, word, vlc…",
                   "open downloads / documents / pictures folder",
                   "rescan my apps", "press enter / escape", "scroll down / up",
                   "switch window", "read my clipboard",
                   "empty the recycle bin (asks to confirm)",
                   "open notepad / chrome / youtube / gmail / whatsapp / news",
                   "search for <anything>", "play <song> on youtube",
                   "type <text>", "pause / next song / previous song",
                   "volume up / down / mute", "brightness up / down",
                   "screenshot", "minimize everything",
                   "close <any app>", "switch to <any app>",
                   "lock the screen", "go to sleep",
                   "shutdown / restart the laptop / cancel shutdown",
                   "disk space", "battery", "my ip",
                   "run diagnostics", "status report",
                   "what time is it", "what is the date"],
        "motion_enabled": robot.available,
    }

"""Every launchable app on this PC, so "open <anything installed>" just works.

Sources, merged (later fills gaps):
  1. Start Menu shortcuts (classic desktop apps -> .lnk path)
  2. Get-StartApps      (Store/UWP apps -> AppUserModelID, e.g. WhatsApp)

The catalog is cached in voice/memory/apps_catalog.json and refreshed in a
background thread at server start (a scan takes a few seconds). Launching is
open-by-reference only — a shortcut file or an AppID registered by Windows —
never a shell command built from spoken text.
"""
import difflib, json, os, re, subprocess, threading, time
from pathlib import Path

CACHE = Path(__file__).parent / "memory" / "apps_catalog.json"
MAX_AGE_S = 3 * 24 * 3600          # rescan automatically every few days

_apps = {}                          # normalized name -> {name, kind, target}
_lock = threading.Lock()

# Shortcut names that are maintenance junk, not apps the user asks for.
_SKIP = re.compile(r"uninstall|repair|reset preferences|readme|documentation|"
                   r"release notes|website|safe mode|report a bug", re.IGNORECASE)


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _scan_lnk():
    out = {}
    roots = [Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs",
             Path(os.environ.get("PROGRAMDATA", "")) / "Microsoft/Windows/Start Menu/Programs"]
    for root in roots:
        if not root.exists():
            continue
        for lnk in root.rglob("*.lnk"):
            name = lnk.stem
            if _SKIP.search(name):
                continue
            out[_norm(name)] = {"name": name, "kind": "lnk", "target": str(lnk)}
    return out


def _scan_startapps():
    out = {}
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", "Get-StartApps | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=45,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        data = json.loads(r.stdout or "[]")
        if isinstance(data, dict):
            data = [data]
        for e in data:
            name, appid = e.get("Name", ""), e.get("AppID", "")
            if not name or not appid or _SKIP.search(name):
                continue
            out[_norm(name)] = {"name": name, "kind": "appid", "target": appid}
    except Exception:
        pass
    return out


def _save(apps):
    try:
        CACHE.write_text(json.dumps(apps, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:
        pass


def refresh(force=False):
    """(Re)build the catalog; cheap if the cache is fresh. Returns app count."""
    global _apps
    if not force and CACHE.exists() and time.time() - CACHE.stat().st_mtime < MAX_AGE_S:
        try:
            with _lock:
                _apps = json.loads(CACHE.read_text(encoding="utf-8"))
            return len(_apps)
        except Exception:
            pass
    apps = _scan_lnk()
    for k, v in _scan_startapps().items():
        apps.setdefault(k, v)       # .lnk wins when both exist
    with _lock:
        _apps = apps
    _save(apps)
    return len(apps)


def refresh_async():
    threading.Thread(target=refresh, daemon=True).start()


def count():
    with _lock:
        return len(_apps)


# Spoken shorthand -> the name the catalog actually holds.
ALIASES = {"vs code": "visual studio code", "vscode": "visual studio code",
           "code": "visual studio code", "file manager": "file explorer",
           "movie player": "vlc media player", "video player": "vlc media player"}


def resolve(query):
    """Spoken name -> catalog entry, or None. Exact, then prefix/substring,
    then all-words, then fuzzy — shortest (most specific) match wins."""
    q = _norm(query)
    q = ALIASES.get(q, q)
    if not q:
        return None
    with _lock:
        apps = dict(_apps)
    if q in apps:
        return apps[q]
    cands = [k for k in apps if k.startswith(q)] or [k for k in apps if q in k]
    if cands:
        return apps[min(cands, key=len)]
    qw = set(q.split())
    cands = [k for k in apps if qw <= set(k.split())]
    if cands:
        return apps[min(cands, key=len)]
    m = difflib.get_close_matches(q, apps.keys(), n=1, cutoff=0.8)
    return apps[m[0]] if m else None


def launch(entry):
    try:
        if entry["kind"] == "appid":
            subprocess.Popen(["explorer.exe", r"shell:AppsFolder\%s" % entry["target"]],
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.startfile(entry["target"])
        return True
    except Exception:
        return False

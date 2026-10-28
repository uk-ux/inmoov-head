"""IRIS tasks & notes — the JARVIS productivity stores.

Plain files under voice/memory/ like everything else:

  notes.jsonl   spoken/typed captures, append-only
  tasks.json    the to-do list, with optional due times parsed from speech

"Connections" (the dashboard number) are note pairs sharing at least two
significant words — the same cheap keyword linking memory.py uses.
"""
import json, re, time, threading
from pathlib import Path

from memory import _words   # same stop-word filtering as fact recall

DIR = Path(__file__).parent / "memory"
DIR.mkdir(exist_ok=True)
NOTES = DIR / "notes.jsonl"
TASKS = DIR / "tasks.json"
_lock = threading.Lock()


def _load_tasks():
    try:
        return json.loads(TASKS.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_tasks(tasks):
    tmp = TASKS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(tasks, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(TASKS)


# ---------------------------------------------------------------- notes
def add_note(text):
    text = " ".join(text.split()).strip(" .")
    if len(text) < 3:
        return 0
    with _lock, open(NOTES, "a", encoding="utf-8") as f:
        f.write(json.dumps({"at": time.strftime("%Y-%m-%d %H:%M"),
                            "text": text[:400]}, ensure_ascii=False) + "\n")
    return note_stats()["notes"]


def all_notes():
    out = []
    try:
        with open(NOTES, encoding="utf-8") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    return out


def recent_notes(limit=5):
    return all_notes()[-limit:][::-1]


def note_stats():
    notes = all_notes()
    words = [_words(n["text"]) for n in notes]
    links = 0
    for i in range(len(words)):
        for j in range(i + 1, len(words)):
            if len(words[i] & words[j]) >= 2:
                links += 1
    return {"notes": len(notes), "connections": links}


# ---------------------------------------------------------------- tasks
_DUE = re.compile(
    r"\b(?:at\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?|"
    r"(tomorrow|tonight|this evening|this afternoon|today))\b", re.IGNORECASE)


def _parse_due(text):
    """Pull a due time out of the sentence; returns (clean_text, due_or_None).

    due is "YYYY-MM-DD HH:MM" (or date only when no clock time was given).
    """
    m = _DUE.search(text)
    if not m:
        return text, None
    day = time.strftime("%Y-%m-%d")
    hh = mm = None
    if m.group(1):
        hh, mm = int(m.group(1)), int(m.group(2) or 0)
        ap = (m.group(3) or "").replace(".", "").lower()
        if ap == "pm" and hh < 12:
            hh += 12
        elif ap == "am" and hh == 12:
            hh = 0
        elif not ap and hh <= 7:      # bare "at 5" almost always means 17:00
            hh += 12
    else:
        word = m.group(4).lower()
        if word == "tomorrow":
            day = time.strftime("%Y-%m-%d", time.localtime(time.time() + 86400))
        elif word == "tonight" or word == "this evening":
            hh, mm = 19, 0
        elif word == "this afternoon":
            hh, mm = 15, 0
    clean = (text[:m.start()] + text[m.end():]).strip(" ,.")
    due = day + (f" {hh:02d}:{mm:02d}" if hh is not None else "")
    return " ".join(clean.split()), due


def add_task(text):
    text = " ".join(text.split()).strip(" .")
    if len(text) < 3:
        return "I did not catch the task."
    clean, due = _parse_due(text)
    with _lock:
        tasks = _load_tasks()
        tasks.append({"id": int(time.time() * 1000), "text": clean[:200],
                      "due": due, "done": False,
                      "at": time.strftime("%Y-%m-%d %H:%M")})
        _save_tasks(tasks)
    if due and " " in due:
        clock = time.strftime("%I:%M %p", time.strptime(due, "%Y-%m-%d %H:%M")).lstrip("0")
        when = ("tomorrow at " if due[:10] != time.strftime("%Y-%m-%d") else "at ") + clock
        return f"Task added: {clean}, {when}."
    if due:
        return f"Task added for tomorrow: {clean}."
    return f"Task added: {clean}."


def pending():
    return [t for t in _load_tasks() if not t["done"]]


def complete(match=None, task_id=None):
    """Mark done by id (dashboard click) or fuzzy text (voice)."""
    with _lock:
        tasks = _load_tasks()
        target = None
        if task_id is not None:
            target = next((t for t in tasks if t["id"] == task_id), None)
        elif match:
            mw = _words(match)
            best = 0
            for t in tasks:
                if t["done"]:
                    continue
                hit = len(mw & _words(t["text"]))
                if hit > best:
                    best, target = hit, t
            if not best:
                target = None
        if not target or target["done"]:
            return None
        target["done"] = True
        target["done_at"] = time.strftime("%Y-%m-%d %H:%M")
        _save_tasks(tasks)
        return target["text"]


def spoken_task_list():
    open_tasks = pending()
    if not open_tasks:
        return "Your task list is clear."
    parts = []
    for t in open_tasks[:6]:
        if t.get("due") and " " in t["due"]:
            clock = time.strftime("%I:%M %p", time.strptime(t["due"], "%Y-%m-%d %H:%M")).lstrip("0")
            parts.append(f"{t['text']} at {clock}")
        else:
            parts.append(t["text"])
    more = len(open_tasks) - 6
    tail = f", and {more} more" if more > 0 else ""
    return (f"You have {len(open_tasks)} task{'s' if len(open_tasks) != 1 else ''}: "
            + "; ".join(parts) + tail + ".")


def spoken_notes(limit=3):
    notes = recent_notes(limit)
    if not notes:
        return "You have no notes yet. Say take a note, and then the note."
    s = note_stats()
    return (f"You have {s['notes']} notes. The latest: "
            + "; ".join(n["text"] for n in notes) + ".")


def dashboard_payload():
    today = time.strftime("%Y-%m-%d")
    tasks = _load_tasks()
    return {
        "tasks": [t for t in tasks if not t["done"]][:20],
        "done_today": sum(1 for t in tasks
                          if t["done"] and t.get("done_at", "").startswith(today)),
        "notes": recent_notes(4),
        "stats": note_stats(),
    }

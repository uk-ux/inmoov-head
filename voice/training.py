"""Teach IRIS — the user-facing 'training' system.

Three kinds of training, all plain files under voice/memory/:

  trained_qa.json   exact answers: "when I say X, say Y" — matched fuzzily
                    BEFORE the LLM, so taught answers are instant and verbatim
  style.json        behavior rules ("always call me boss") — appended to the
                    system prompt so every reply follows them
  (phrases.json)    speech adaptation: the user's most-used words become
                    whisper hotwords, so their recurring vocabulary is heard
                    correctly more often. Fully automatic.
"""
import difflib, json, re, threading, time
from pathlib import Path

import memory

DIR = Path(__file__).parent / "memory"
QA_FILE = DIR / "trained_qa.json"
STYLE_FILE = DIR / "style.json"
_lock = threading.Lock()


def _load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save(path, data):
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def _norm(s):
    return re.sub(r"[^\w\s஀-௿]", "", s.lower()).strip()


# ---------------------------------------------------------------- taught answers
def teach(question, answer):
    question = question.strip(" .?!,")
    answer = answer.strip()
    if not question or not answer:
        return "Tell me both the phrase and the answer."
    with _lock:
        qa = _load(QA_FILE, [])
        qa = [e for e in qa if _norm(e["q"]) != _norm(question)]   # retrain replaces
        qa.append({"q": question, "a": answer,
                   "at": time.strftime("%Y-%m-%d %H:%M")})
        _save(QA_FILE, qa)
    return f"Trained. When you say '{question}', I will say: {answer}"


def find_answer(text):
    """Best taught answer for this utterance, or None. Fuzzy, so small
    speech-recognition wobbles still hit the trained phrase."""
    n = _norm(text)
    if not n:
        return None
    best, score = None, 0.0
    for e in _load(QA_FILE, []):
        r = difflib.SequenceMatcher(None, n, _norm(e["q"])).ratio()
        if r > score:
            best, score = e, r
    return best["a"] if best and score >= 0.78 else None


def forget(sub):
    with _lock:
        qa = _load(QA_FILE, [])
        keep = [e for e in qa if sub.lower() not in e["q"].lower()]
        _save(QA_FILE, keep)
        return len(qa) - len(keep)


# ---------------------------------------------------------------- style rules
def add_style(rule):
    rule = rule.strip(" .")
    if len(rule) < 3:
        return "Tell me the rule."
    with _lock:
        st = _load(STYLE_FILE, [])
        if rule.lower() not in [s.lower() for s in st]:
            st.append(rule)
        st = st[-12:]                       # the LLM follows a short list best
        _save(STYLE_FILE, st)
    return f"Understood. From now on: {rule}."


def style_prompt():
    st = _load(STYLE_FILE, [])
    if not st:
        return ""
    return ("\n\nTRAINING — rules the user taught you. Always follow them:\n"
            + "\n".join("- " + s for s in st))


def clear_style():
    with _lock:
        n = len(_load(STYLE_FILE, []))
        _save(STYLE_FILE, [])
    return n


def stats():
    return {"qa": len(_load(QA_FILE, [])), "style": len(_load(STYLE_FILE, []))}


def describe_training():
    qa, st = _load(QA_FILE, []), _load(STYLE_FILE, [])
    if not qa and not st:
        return ("I have no custom training yet. Say: when I say something, "
                "say the answer. Or: train personality, then a rule.")
    parts = []
    if qa:
        parts.append(f"{len(qa)} trained answer{'s' if len(qa) != 1 else ''}: "
                     + "; ".join(f"'{e['q']}'" for e in qa[-5:]))
    if st:
        parts.append(f"{len(st)} behavior rule{'s' if len(st) != 1 else ''}: "
                     + "; ".join(st[-5:]))
    return "My training so far. " + ". ".join(parts) + "."


# ---------------------------------------------------------------- speech adaptation
_hw = {"t": 0.0, "v": "Iris InMoov"}


def hotwords(limit=24):
    """Whisper hotwords built from how this user actually talks. Cached a
    minute at a time; recomputed from the phrase memory."""
    if time.time() - _hw["t"] < 60:
        return _hw["v"]
    counts = {}
    try:
        for e in memory.common_phrases(200):
            for w in re.findall(r"[A-Za-z]{4,}", e["text"]):
                wl = w.lower()
                if wl in memory.STOP:
                    continue
                counts[wl] = counts.get(wl, 0) + e.get("count", 1)
    except Exception:
        pass
    top = sorted(counts, key=counts.get, reverse=True)[:limit]
    _hw["v"] = "Iris InMoov Udhaya " + " ".join(top)
    _hw["t"] = time.time()
    return _hw["v"]

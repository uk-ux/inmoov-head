"""InMoov long-term memory.

Three stores, all plain files under voice/memory/ so they survive restarts
and can be read or edited by hand:

  facts.json        things InMoov learned about the user / the world
  transcript.jsonl  every exchange, append-only (the raw record)
  phrases.json      sentences users actually say, with how often

Retrieval is deliberately keyword-based, not embeddings: it costs about a
millisecond, needs no extra model in VRAM, and for a few thousand short
facts it is accurate enough. Swap in embeddings later if the store grows.
"""
import json, re, time, threading
from pathlib import Path

DIR = Path(__file__).parent / "memory"
DIR.mkdir(exist_ok=True)
FACTS = DIR / "facts.json"
TRANSCRIPT = DIR / "transcript.jsonl"
PHRASES = DIR / "phrases.json"

MAX_FACTS = 500
_lock = threading.Lock()

STOP = set("""a an the is are was were be been being am i you he she it we they me my your his her its our
their this that these those of to in on at for with and or but if then than so as by from do does did
not no yes what who where when why how can could will would should may might must have has had very
just about into over under again more most some any all one two both each few other same
நான் நீங்கள் அவர் அவள் அது நாம் அவர்கள் என் உங்கள் இது அந்த ஒரு என்ன யார் எங்கே எப்போது ஏன் எப்படி""".split())


def _load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def _words(text):
    return {w for w in re.findall(r"[\w஀-௿]+", text.lower())
            if len(w) > 2 and w not in STOP}


def _stems(text):
    """Crude prefixes so 'like'/'likes'/'liked' and 'build'/'building' match."""
    return {w[:4] for w in _words(text)}


_FIRST_PERSON = [
    (r"\bmy\b", "the user's"), (r"\bmine\b", "the user's"),
    (r"\bi am\b", "the user is"), (r"\bi'm\b", "the user is"),
    (r"\bi have\b", "the user has"), (r"\bi've\b", "the user has"),
    (r"\bi like\b", "the user likes"), (r"\bi love\b", "the user loves"),
    (r"\bi want\b", "the user wants"), (r"\bi work\b", "the user works"),
    (r"\bi live\b", "the user lives"), (r"\bi will\b", "the user will"),
    (r"\bi\b", "the user"), (r"\bme\b", "the user"),
]


def to_third_person(text):
    """Store facts ABOUT the user, not in the user's voice.

    Without this, 'my name is Udhaya' gets recalled into the system prompt
    and the robot starts claiming to BE Udhaya.
    """
    out = text
    for pat, rep in _FIRST_PERSON:
        out = re.sub(pat, rep, out, flags=re.IGNORECASE)
    return out[0].upper() + out[1:] if out else out


# ---------------------------------------------------------------- facts
def all_facts():
    return _load(FACTS, [])


def add_fact(text, source="learned"):
    """Store one short fact. Ignores duplicates and near-duplicates."""
    text = " ".join(text.split())[:200]
    if len(text) < 4:
        return False
    with _lock:
        facts = _load(FACTS, [])
        new_words = _words(text)
        for f in facts:
            fw = _words(f["text"])
            if not new_words or not fw:
                continue
            overlap = len(new_words & fw) / max(1, len(new_words | fw))
            if overlap > 0.7:                 # already know this
                f["seen"] = f.get("seen", 1) + 1
                f["at"] = time.strftime("%Y-%m-%d %H:%M")
                _save(FACTS, facts)
                return False
        facts.append({"text": text, "source": source, "seen": 1,
                      "at": time.strftime("%Y-%m-%d %H:%M")})
        if len(facts) > MAX_FACTS:            # drop least-referenced first
            facts.sort(key=lambda f: (f.get("seen", 1), f["at"]))
            facts = facts[-MAX_FACTS:]
        _save(FACTS, facts)
    return True


def forget(substring=None):
    """Delete matching facts, or everything when substring is None."""
    with _lock:
        if substring is None:
            _save(FACTS, [])
            return "all"
        facts = _load(FACTS, [])
        keep = [f for f in facts if substring.lower() not in f["text"].lower()]
        _save(FACTS, keep)
        return len(facts) - len(keep)


def recall(query, limit=5):
    """Facts most related to the query, best first."""
    qw, qs = _words(query), _stems(query)
    if not qw:
        return []
    scored = []
    for f in all_facts():
        fw, fs = _words(f["text"]), _stems(f["text"])
        hit = len(qw & fw) + 0.5 * len(qs & fs)   # stems catch like/likes
        if hit:
            # favour overlap, then how often the fact has come up
            scored.append((hit + 0.1 * f.get("seen", 1), f["text"]))
    scored.sort(reverse=True)
    return [t for _, t in scored[:limit]]


# ---------------------------------------------------------------- phrases
def learn_phrase(text, lang):
    """Remember sentences the user actually says, and how often."""
    text = " ".join(text.split())
    if not (4 <= len(text) <= 160):
        return
    with _lock:
        store = _load(PHRASES, {})
        key = text.lower()
        entry = store.get(key, {"text": text, "lang": lang, "count": 0})
        entry["count"] += 1
        entry["at"] = time.strftime("%Y-%m-%d %H:%M")
        store[key] = entry
        if len(store) > 2000:
            keep = sorted(store.values(), key=lambda e: -e["count"])[:2000]
            store = {e["text"].lower(): e for e in keep}
        _save(PHRASES, store)


def common_phrases(limit=15):
    store = _load(PHRASES, {})
    return sorted(store.values(), key=lambda e: -e["count"])[:limit]


# ---------------------------------------------------------------- transcript
def log_exchange(user_text, reply, lang):
    line = json.dumps({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "lang": lang,
                       "user": user_text, "inmoov": reply}, ensure_ascii=False)
    with _lock, open(TRANSCRIPT, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def stats():
    n_lines = 0
    if TRANSCRIPT.exists():
        with open(TRANSCRIPT, encoding="utf-8") as f:
            n_lines = sum(1 for _ in f)
    return {"facts": len(all_facts()), "phrases": len(_load(PHRASES, {})),
            "exchanges": n_lines}


# ---------------------------------------------------------------- explicit teaching
TEACH = re.compile(
    r"^\s*(?:remember(?: that)?|note that|don'?t forget(?: that)?|"
    r"ஞாபகம்\s*வை|நினைவில்\s*வை)\s*[:,]?\s*(.+)$",
    re.IGNORECASE)
FORGET = re.compile(r"^\s*forget (?:about |that )?(.+?)\s*$", re.IGNORECASE)
WHAT_KNOW = re.compile(
    r"^\s*(?:what do you (?:know|remember)|what have you learned)\b.*$", re.IGNORECASE)


def handle_command(text):
    """If the user is explicitly teaching/asking about memory, do it here.

    Returns a reply string to send straight back, or None to continue to
    the normal LLM path.
    """
    m = TEACH.match(text)
    if m:
        raw = m.group(1).strip(" .!?")
        add_fact(to_third_person(raw), source="told")
        return f"I will remember that {raw}."
    m = FORGET.match(text)
    if m:
        what = m.group(1).strip(" .!?")
        if what.lower() in ("everything", "all", "it all"):
            forget(None)
            return "I have cleared everything I learned."
        n = forget(what)
        return (f"I forgot {n} thing{'s' if n != 1 else ''} about {what}."
                if n else f"I did not have anything about {what}.")
    if WHAT_KNOW.match(text):
        facts = all_facts()
        if not facts:
            return "I have not learned anything about you yet. Tell me something and I will remember it."
        recent = [f["text"] for f in facts[-5:]]
        return "Here is what I remember: " + "; ".join(recent) + "."
    return None

"""Multi-language support for InMoov.

How each layer knows the language:

  HEARING  faster-whisper auto-detects the spoken language and returns an
           ISO code (en, ta, te, hi, ...). No configuration needed.
  THINKING the LLM is told, per turn, to reply in that language by name.
  SPEAKING the reply text is routed to a voice by its SCRIPT — Telugu letters
           go to the Telugu voice, Tamil to the Tamil voice, Latin to the
           English voice — so it works no matter which language the model
           actually produced.

English speaks through Kokoro (most natural). Every Indian language speaks
through Meta's MMS-TTS (facebook/mms-tts-<code>), which is free, offline, and
covers dozens of languages with one interface.
"""
import re

# whisper code -> (English name, native name, MMS-TTS code or None=English/Kokoro)
LANGS = {
    "en": ("English",   "English",  None),
    "ta": ("Tamil",     "தமிழ்",    "tam"),
    "te": ("Telugu",    "తెలుగు",   "tel"),
    "hi": ("Hindi",     "हिन्दी",    "hin"),
    "kn": ("Kannada",   "ಕನ್ನಡ",    "kan"),
    "ml": ("Malayalam", "മലയാളം",  "mal"),
    "bn": ("Bengali",   "বাংলা",    "ben"),
    "mr": ("Marathi",   "मराठी",    "mar"),
    "gu": ("Gujarati",  "ગુજરાતી",  "guj"),
    "pa": ("Punjabi",   "ਪੰਜਾਬੀ",   "pan"),
    "ur": ("Urdu",      "اردو",     "urd"),
}

# Unicode block -> language, for routing the SPOKEN voice by the reply's script.
# Order matters: Devanagari is shared by Hindi and Marathi; we default to Hindi.
_SCRIPTS = [
    ("ta", 0x0B80, 0x0BFF),
    ("te", 0x0C00, 0x0C7F),
    ("kn", 0x0C80, 0x0CFF),
    ("ml", 0x0D00, 0x0D7F),
    ("bn", 0x0980, 0x09FF),
    ("gu", 0x0A80, 0x0AFF),
    ("pa", 0x0A00, 0x0A7F),
    ("ur", 0x0600, 0x06FF),
    ("hi", 0x0900, 0x097F),
]


def name(code):
    return LANGS.get(code, ("that language", "", None))[0]


def native_name(code):
    return LANGS.get(code, ("", "", None))[1]


def mms_code(code):
    return LANGS.get(code, (None, None, None))[2]


def is_supported(code):
    return code in LANGS


def detect_script(text):
    """Which language's script dominates this text? Returns a whisper code."""
    counts = {}
    for ch in text:
        o = ord(ch)
        for code, lo, hi in _SCRIPTS:
            if lo <= o <= hi:
                counts[code] = counts.get(code, 0) + 1
                break
    if not counts:
        return "en"
    return max(counts, key=counts.get)


def instruction(code):
    """The per-turn instruction that forces the reply language."""
    if code == "en" or code not in LANGS:
        return "\n\n(Important: answer ONLY in English, in one to three short sentences.)"
    nm, native, _ = LANGS[code]
    return (f"\n\n(Important: answer ONLY in {nm} ({native}) script, "
            f"in one or two short sentences. Do not use English.)")

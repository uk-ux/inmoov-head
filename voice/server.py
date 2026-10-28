"""InMoov voice chatbot backend.

Browser (orb.html) <-- WebSocket 8766 --> this server.
Pipeline: PCM from browser -> faster-whisper STT (ta/en autodetect)
       -> Ollama chat (streamed) -> TTS (Piper en / MMS-TTS ta) -> WAV back.

Everything runs locally. Jaw output is optional and off by default because
the browser calibration UI owns COM9; set JAW_SERIAL to enable later.
"""
import asyncio, difflib, io, json, re, sys, threading, time, urllib.error, urllib.request, wave
from pathlib import Path

import numpy as np

import memory
import skills
import languages
import tasks_notes
import training

HOST, PORT = "127.0.0.1", 8766
OLLAMA = "http://127.0.0.1:11434"
LLM_MODEL = "qwen3:8b"
WHISPER_MODEL = "large-v3-turbo" # fast, accurate multilingual recognition
PIPER_DIR = Path(__file__).parent / "models" / "piper"
# (MMS language models are chosen dynamically in languages.py)
WEB_SEARCH = True                # enrich answers with DuckDuckGo when online

# Cloud brain (optional) — voice/api_keys.json holds the Gemini key and is
# gitignored so it can never leak into the repo. When the key is present and
# Google is reachable, Gemini answers; any failure falls straight back to
# local Ollama, so IRIS keeps talking with the internet down.
# (Hybrid pattern from the deestudio028/jarvis reference project.)
_keys = {}
try:
    _keys = json.loads((Path(__file__).parent / "api_keys.json").read_text("utf-8"))
except Exception:
    pass
GEMINI_KEY = (_keys.get("gemini_api_key") or "").strip()
GEMINI_MODEL = _keys.get("gemini_model", "gemini-flash-latest")
LLM_PROVIDER = _keys.get("llm_provider", "auto" if GEMINI_KEY else "ollama")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta"

# English voices the user can pick in the UI's Voice tab. Tamil always uses
# MMS (the only decent free offline Tamil voice). First existing file wins
# as the default.
SPEECH_SPEED = 0.92              # <1 = calmer, more relaxed delivery

# engine "kokoro" = most natural (neural, 24 kHz); "piper" = fast fallback.
ENGLISH_VOICES = [
    {"id": "k-heart", "label": "Heart — calm, natural female (default)", "engine": "kokoro", "voice": "af_heart"},
    {"id": "k-bella", "label": "Bella — warm, natural female", "engine": "kokoro", "voice": "af_bella"},
    {"id": "k-nicole", "label": "Nicole — soft, gentle female", "engine": "kokoro", "voice": "af_nicole"},
    {"id": "k-george", "label": "George — British male (JARVIS-style)", "engine": "kokoro", "voice": "bm_george"},
    {"id": "k-fenrir", "label": "Fenrir — deep, natural male", "engine": "kokoro", "voice": "am_fenrir"},
    {"id": "k-michael", "label": "Michael — calm, natural male", "engine": "kokoro", "voice": "am_michael"},
    {"id": "lessac-high", "label": "Lessac — natural, US female", "file": "en_US-lessac-high.onnx"},
    {"id": "ryan-high", "label": "Ryan — natural, US male", "file": "en_US-ryan-high.onnx"},
    {"id": "hfc-female", "label": "HFC — warm, US female", "file": "en_US-hfc_female-medium.onnx"},
    {"id": "amy", "label": "Amy — clear, US female", "file": "en_US-amy-medium.onnx"},
    {"id": "alba", "label": "Alba — British female", "file": "en_GB-alba-medium.onnx"},
    {"id": "lessac", "label": "Lessac classic (medium)", "file": "en_US-lessac-medium.onnx"},
]
JAW_SERIAL = None                # e.g. "COM9" - keep None while the browser UI owns the port
JAW_CLOSED_US, JAW_MAX_US = 1300, 1600

TAMIL_RE = re.compile(r"[஀-௿]")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?…।])\s+")
SYSTEM_PROMPT = (
    "You are IRIS, a calm and gentle AI assistant created by Udhaya Kumar. "
    "You live in the InMoov robot head and control its face, and you can also "
    "help with the laptop. You speak in a relaxed, unhurried, warm way, like a "
    "thoughtful friend. Keep replies short: one to three spoken sentences. "
    "Never rush, never gush. Stay composed and kind even if the user is excited "
    "or upset. No emoji, no markdown, no lists, no stage directions, no "
    "exclamation marks. Always answer in the language the user used. You have "
    "moving eyes, eyelids, eyebrows, jaw and cheeks, and a camera to see faces."
)

def log(*a):
    """Never let a console encoding problem kill a conversation.

    The Windows console is cp1252; printing Tamil text raised
    UnicodeEncodeError and took the whole WebSocket connection down.
    """
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(x) for x in a)
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, "encoding", None) or "ascii"
        print(line.encode(enc, "replace").decode(enc, "replace"), flush=True)

# ---------------------------------------------------------------- STT
log("loading faster-whisper", WHISPER_MODEL, "...")
from faster_whisper import WhisperModel
try:
    # GPU is ~11x faster than CPU here (0.2 s vs 2.5 s per utterance) and is
    # the single biggest latency win in the pipeline. Falls back automatically.
    stt_model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="int8_float16")
    import numpy as _np
    stt_model.transcribe(_np.zeros(16000, dtype=_np.float32))  # force CUDA init
    log("whisper ready on GPU")
except Exception as e:
    log("GPU whisper unavailable (%s); using CPU" % str(e)[:60])
    stt_model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8",
                             cpu_threads=8)
    log("whisper ready on CPU")

# The name in every spelling whisper produces for it ("Iris" often comes out
# as Irish/Airis, and users address the robot as InMoov too).
_NAME = r"i\.?\s?r\.?\s?i\.?\s?s|iris|irish|airis|aeris|in[\s-]?moo?ve?|ஐரிஸ்|ఐరిస్|आइरिस"
WAKE_RE = re.compile(r"\b(" + _NAME + r")\b", re.IGNORECASE)
# Strip the name only when it LEADS the sentence ("Iris, open chrome"), never
# from the middle — "what is InMoov" must keep its subject.
WAKE_STRIP = re.compile(r"^\s*(?:hey|hi|hello|ok(?:ay)?)?[,\s]*(?:" + _NAME + r")\b[,.!\s]*",
                        re.IGNORECASE)
FOLLOWUP_S = 45   # after an exchange, hands-free keeps listening this long unaddressed
NAME_FIX = re.compile(r"\bin[\s-]?moo?ve?\b", re.IGNORECASE)

# Whisper's autodetect across all 99 languages misfires badly on short clips
# (a lone "InMoov" came back as Malayalam, then Bengali; English as Finnish
# and Spanish). Detection is therefore restricted to the languages actually
# spoken here; extend the list if the household gains one.
STT_LANGS = ["en", "ta", "te", "hi"]

def _whisper_pass(audio, language):
    segments, info = stt_model.transcribe(
        audio, language=language,
        # Single-pass decoding keeps physical and browser commands responsive.
        # large-v3-turbo remains accurate enough without five beam searches.
        beam_size=1,
        best_of=1, temperature=0.0,
        condition_on_previous_text=False,   # stops one bad guess poisoning the next
        no_speech_threshold=0.5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=300,
                            speech_pad_ms=400),   # keep word edges
        without_timestamps=True,
        hotwords=training.hotwords())   # adapts to the user's own vocabulary
    segs = list(segments)
    text = " ".join(s.text.strip() for s in segs).strip()
    conf = (sum(s.avg_logprob for s in segs) / len(segs)) if segs else -10.0
    return text, (info.language or "en"), conf, info

def transcribe(pcm16: bytes):
    """Returns (text, language, confidence). Confidence is the mean segment
    log-probability — hallucinated noise scores far below real speech."""
    audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
    if len(audio) < 1600:  # <0.1 s
        return "", "en", -10.0
    text, lang, conf, info = _whisper_pass(audio, None)
    if text and lang not in STT_LANGS:
        probs = getattr(info, "all_language_probs", None) or []
        allowed = [(l, p) for l, p in probs if l in STT_LANGS]
        best = max(allowed, key=lambda x: x[1])[0] if allowed else "en"
        log(f"lang {lang} not in {STT_LANGS}; re-hearing as {best}")
        text, lang, conf, _ = _whisper_pass(audio, best)
        lang = best
    text = NAME_FIX.sub("InMoov", text)
    return text, lang, conf

# ---------------------------------------------------------------- TTS english (Piper)
from piper import PiperVoice

try:
    from kokoro import KPipeline
    _kokoro = KPipeline(lang_code="a")
    log("kokoro ready (natural voices)")
except Exception as e:
    _kokoro = None
    log("kokoro unavailable (%s); piper only" % str(e)[:60])

available_voices = [
    v for v in ENGLISH_VOICES
    if (v.get("engine") == "kokoro" and _kokoro) or
       (v.get("engine") != "kokoro" and (PIPER_DIR / v["file"]).exists())
]
if not available_voices:
    raise SystemExit(f"no piper voice files in {PIPER_DIR}")
# A deeper male voice suits the physical InMoov head. Fall back cleanly when
# Kokoro is unavailable and only the installed Piper voices are present.
_default_voice = next((v for v in available_voices if v["id"] == "k-fenrir"),
                      next((v for v in available_voices if v["id"] == "k-george"),
                           available_voices[0]))
active_voice = {"id": _default_voice["id"]}
_piper_cache = {}

def get_piper(voice_id):
    if voice_id not in _piper_cache:
        entry = next(v for v in available_voices if v["id"] == voice_id)
        p = str(PIPER_DIR / entry["file"])
        log("loading piper voice", entry["file"], "...")
        try:
            _piper_cache[voice_id] = PiperVoice.load(p)
        except TypeError:
            _piper_cache[voice_id] = PiperVoice.load(p, p + ".json")
    return _piper_cache[voice_id]

if not next(v for v in available_voices if v["id"] == active_voice["id"]).get("engine") == "kokoro":
    get_piper(active_voice["id"])
log("default voice:", active_voice["id"])

def tts_kokoro(text: str, voice_name: str) -> bytes:
    audio = np.concatenate([g.audio.numpy() for g in
                            _kokoro(text, voice=voice_name, speed=SPEECH_SPEED)])
    pcm = np.clip(audio * 32767, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()

def tts_english(text: str, voice_id: str = None) -> bytes:
    voice_id = voice_id or active_voice["id"]
    entry = next(v for v in available_voices if v["id"] == voice_id)
    if entry.get("engine") == "kokoro":
        return tts_kokoro(text, entry["voice"])
    voice = get_piper(voice_id)
    # length_scale > 1 slows piper down to match kokoro's calm pacing
    try:
        voice.config.length_scale = 1 / SPEECH_SPEED
    except Exception:
        pass
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        if hasattr(voice, "synthesize_wav"):
            voice.synthesize_wav(text, w)
        else:
            w.setnchannels(1); w.setsampwidth(2)
            w.setframerate(voice.config.sample_rate)
            for chunk in voice.synthesize_stream_raw(text):
                w.writeframes(chunk)
    return buf.getvalue()

# ---------------------------------------------------------------- TTS tamil (MMS, lazy)
_mms_cache = {}     # mms_code -> (model, tokenizer, torch)
_mms_lock = threading.Lock()

def _get_mms(mms_code):
    with _mms_lock:
        if mms_code not in _mms_cache:
            log(f"loading facebook/mms-tts-{mms_code} (first use, ~15 s)...")
            import torch
            from transformers import VitsModel, AutoTokenizer
            model = VitsModel.from_pretrained(f"facebook/mms-tts-{mms_code}")
            tok = AutoTokenizer.from_pretrained(f"facebook/mms-tts-{mms_code}")
            _mms_cache[mms_code] = (model, tok, torch)
            log(f"mms-tts-{mms_code} ready")
    return _mms_cache[mms_code]

def tts_mms(text: str, mms_code: str) -> bytes:
    model, tok, torch = _get_mms(mms_code)
    with torch.no_grad():
        wav = model(**tok(text, return_tensors="pt")).waveform[0].numpy()
    pcm = np.clip(wav * 32767, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2)
        w.setframerate(model.config.sampling_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()

_tts_cache = {}          # (text, voice) -> wav bytes, for repeated short lines
_TTS_CACHE_MAX = 60

def tts(text: str, voice_id: str = None) -> bytes:
    # Skill replies repeat a lot ("Opening chrome.", "Done.", "Noted.") and
    # re-synthesising them costs seconds under memory pressure. Cache the
    # short ones; long LLM sentences are nearly always unique, so skip those.
    key = (text, voice_id or active_voice["id"])
    if len(text) <= 80 and key in _tts_cache:
        return _tts_cache[key]
    wav = _tts_uncached(text, voice_id)
    if len(text) <= 80:
        if len(_tts_cache) >= _TTS_CACHE_MAX:
            _tts_cache.pop(next(iter(_tts_cache)))
        _tts_cache[key] = wav
    return wav

def _tts_uncached(text: str, voice_id: str = None) -> bytes:
    # Route the VOICE by the reply's script, so it speaks correctly whatever
    # language the model produced (Telugu letters -> Telugu voice, and so on).
    mc = languages.mms_code(languages.detect_script(text))
    return tts_mms(text, mc) if mc else tts_english(text, voice_id)

# Indic voices are ~400 MB of torch each. Preloading both cost ~1 GB of RAM
# permanently and, on a 16 GB laptop that already runs at >90%, that memory
# pressure made EVERY reply slow (pages of the English voice kept getting
# evicted and faulted back in: 4.5 s to speak two words instead of 1.0 s).
# They now load on first use instead — a one-off ~3 s on the first Tamil or
# Telugu reply, in exchange for every English reply being fast.
PRELOAD_INDIC = False
if PRELOAD_INDIC:
    for _wc, _hi in (("tam", "வணக்கம்"), ("tel", "నమస్కారం")):
        threading.Thread(target=lambda c=_wc, h=_hi: tts_mms(h, c), daemon=True).start()

# ---------------------------------------------------------------- web search
SMALLTALK = re.compile(
    r"^\s*(hi|hello|hey|bye|goodbye|thanks|thank you|ok(ay)?|yes|no|"
    r"வணக்கம்|நன்றி|சரி|ஆம்|இல்லை)\b[\s!,.?]*$", re.IGNORECASE)

# Questions about the moving world always deserve a live search — even short
# ones ("latest news") and ones phrased at the robot ("do you know today's...").
FRESH_RE = re.compile(
    r"\b(news|latest|today|tonight|current(ly)?|right now|weather|temperature|"
    r"price|stock|score|match|election|release[ds]?|202\d|yesterday|"
    r"this (week|month|year))\b", re.IGNORECASE)

def web_search(query: str) -> str:
    """Top DuckDuckGo snippets, or '' if offline/failed/not worth searching."""
    if not WEB_SEARCH or SMALLTALK.match(query) or (
            len(query.split()) < 3 and not FRESH_RE.search(query)):
        return ""
    try:
        from ddgs import DDGS
        hits = list(DDGS().text(query, max_results=3))
        out = "\n".join(f"- {h['title']}: {h['body']}" for h in hits)
        return out[:1500]
    except Exception as e:
        log("web search skipped:", str(e)[:80])
        return ""

# ---------------------------------------------------------------- LLM (Ollama, streaming)
def extract_facts(user_text, reply, lang):
    """Ask the model what is worth remembering. Runs AFTER the reply is sent,
    so it never adds latency to the conversation."""
    prompt = (
        "From this exchange, list any durable facts about the USER worth "
        "remembering later (their name, job, likes, plans, relationships, "
        "or anything they asked you to remember). "
        "One short fact per line, in English, no bullets, no commentary. "
        "If there is nothing durable, reply exactly: NONE\n\n"
        f"User: {user_text}\nInMoov: {reply}")
    payload = {"model": LLM_MODEL, "stream": False, "keep_alive": "30m",
               "messages": [{"role": "user", "content": prompt}],
               "options": {"num_predict": 120, "temperature": 0.1}}
    if LLM_MODEL.startswith("qwen3"):
        payload["think"] = False
    try:
        req = urllib.request.Request(OLLAMA + "/api/chat", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = json.load(resp)["message"]["content"].strip()
    except Exception as e:
        log("fact extraction failed:", str(e)[:60]); return
    if out.upper().startswith("NONE"):
        return
    for line in out.splitlines():
        line = line.strip(" -*.	")
        if 4 < len(line) < 200 and not line.upper().startswith("NONE"):
            if memory.add_fact(line, source="learned"):
                log("learned:", line[:70])


def llm_stream(history, lang, on_delta, search_context="", memories=""):
    # Small models ignore language rules in the system prompt; forcing the
    # language inline on the last user message is what actually works.
    system = SYSTEM_PROMPT + training.style_prompt()
    if memories:
        system += (
            "\n\nMEMORY — facts you have learned about THE PERSON YOU ARE TALKING TO. "
            "These describe the user, not you. When they ask about themselves "
            "(their name, what they like, what they are doing), answer from these "
            "facts, and do not confuse them with your own identity. Use them "
            "naturally in conversation; never recite the list mechanically.\n"
            + memories)
    messages = [{"role": "system", "content": system}] + [dict(m) for m in history]
    if search_context:
        messages[-1]["content"] = (
            "Web search results (use them if relevant, ignore if not):\n"
            + search_context + "\n\nUser said: " + messages[-1]["content"])
    messages[-1]["content"] += languages.instruction(lang)
    # Cloud first, local fallback. If Gemini dies AFTER streaming words out,
    # we must not restart on Ollama — the room already heard the beginning —
    # so the fallback only fires when nothing was emitted yet.
    emitted = [False]
    def guarded(piece):
        emitted[0] = True
        on_delta(piece)
    if GEMINI_KEY and LLM_PROVIDER in ("auto", "gemini"):
        try:
            out = _gemini_stream(messages, guarded)
            if out:
                return out
        except Exception as e:
            log("gemini failed, using ollama:", str(e)[:80])
        if emitted[0]:
            return ""
    return _ollama_stream(messages, on_delta)


def _gemini_stream(messages, on_delta):
    system, contents = "", []
    for m in messages:
        if m["role"] == "system":
            system = m["content"]
        else:
            contents.append({"role": "user" if m["role"] == "user" else "model",
                             "parts": [{"text": m["content"]}]})
    gen = {"maxOutputTokens": 400, "temperature": 0.6}
    # thinkingBudget 0: Gemini 2.5-era Flash "thinks" by default and the
    # thought tokens count against maxOutputTokens, truncating short replies
    # mid-word. Gemini 3.x models REJECT this field (400), so send it only
    # where it applies.
    if "2.5" in GEMINI_MODEL or GEMINI_MODEL == "gemini-flash-latest":
        gen["thinkingConfig"] = {"thinkingBudget": 0}
    payload = {"contents": contents, "generationConfig": gen}
    if system:
        payload["system_instruction"] = {"parts": [{"text": system}]}
    full = []
    # The whole exchange holds the connection lock: the socket is shared, so a
    # second turn must not start writing while this one is still streaming.
    with _gem_lock:
        resp = _gemini_post(json.dumps(payload).encode())
        try:
            for raw in resp:
                raw = raw.decode("utf-8", "ignore").strip()
                if not raw.startswith("data:"):
                    continue
                data = raw[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    piece = "".join(p.get("text", "") for p in
                                    json.loads(data)["candidates"][0]["content"]["parts"])
                except Exception:
                    continue
                if piece:
                    full.append(piece)
                    on_delta(piece)
            if not resp.isclosed():      # leftover bytes would corrupt the next turn
                resp.read()
        except Exception:
            _close_gem()
            raise
    return "".join(full).strip()


# One kept-alive TLS connection to Google instead of a fresh handshake per
# reply. On a cold socket the handshake alone cost noticeable time before the
# first word; reusing it removes that from every follow-up turn. Any socket
# error just rebuilds the connection and retries once.
_gem_conn = [None]
_gem_lock = threading.Lock()

def _gemini_post(body):
    import http.client
    path = f"/v1beta/models/{GEMINI_MODEL}:streamGenerateContent?alt=sse"
    headers = {"Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY,
               "Connection": "keep-alive"}
    host = GEMINI_URL.split("//", 1)[1].split("/", 1)[0]
    for attempt in (1, 2):          # caller holds _gem_lock
        try:
            if _gem_conn[0] is None:
                _gem_conn[0] = http.client.HTTPSConnection(host, timeout=60)
            _gem_conn[0].request("POST", path, body=body, headers=headers)
            resp = _gem_conn[0].getresponse()
            if resp.status != 200:
                detail = resp.read(400).decode("utf-8", "ignore")
                _close_gem()
                raise urllib.error.HTTPError(path, resp.status, detail, None, None)
            return resp
        except (OSError, http.client.HTTPException):
            _close_gem()           # stale keep-alive socket: rebuild and retry
            if attempt == 2:
                raise

def _close_gem():
    try:
        if _gem_conn[0]:
            _gem_conn[0].close()
    except Exception:
        pass
    _gem_conn[0] = None


def _ollama_stream(messages, on_delta):
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "stream": True,
        "keep_alive": "30m",
        "options": {"num_predict": 220, "temperature": 0.6},
    }
    if LLM_MODEL.startswith("qwen3"):
        # qwen3 reasons before answering, which costs 20-40 s per reply.
        # Conversation does not need it.
        payload["think"] = False
    body = json.dumps(payload).encode()
    req = urllib.request.Request(OLLAMA + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    full = []
    with urllib.request.urlopen(req, timeout=120) as resp:
        for line in resp:
            if not line.strip():
                continue
            piece = json.loads(line).get("message", {}).get("content", "")
            if piece:
                full.append(piece)
                on_delta(piece)
    return "".join(full).strip()

# ---------------------------------------------------------------- optional jaw
_jaw = None
if JAW_SERIAL:
    import serial
    _jaw = serial.Serial(JAW_SERIAL, 115200, timeout=1)
    time.sleep(2)  # Uno resets on open; firmware sends READY, no movement
    log("jaw serial open on", JAW_SERIAL)

def jaw_play(wav_bytes: bytes):
    """Stream C11 pulses matching the WAV envelope. Called only if enabled."""
    if not _jaw:
        return
    with wave.open(io.BytesIO(wav_bytes)) as w:
        rate, n = w.getframerate(), w.getnframes()
        pcm = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32)
    frame = int(rate * 0.05)
    env = np.array([np.sqrt(np.mean(pcm[i:i+frame]**2)) for i in range(0, len(pcm), frame)])
    peak = np.percentile(env, 95) or 1.0
    env = np.clip(env / peak, 0, 1)
    level = 0.0
    for e in env:
        level = max(e, level * 0.75)          # fast attack, slow decay
        pulse = int(JAW_CLOSED_US + (JAW_MAX_US - JAW_CLOSED_US) * level)
        _jaw.write(f"C11 {pulse}\n".encode())
        time.sleep(0.05)
    _jaw.write(f"C11 {JAW_CLOSED_US}\n".encode())

def speech_envelope(wav_bytes: bytes, frame_ms=50):
    """Return normalized mouth-open levels for browser-owned servo control."""
    with wave.open(io.BytesIO(wav_bytes)) as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2 or not raw:
        return []
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    frame = max(1, int(rate * frame_ms / 1000))
    levels = []
    for start in range(0, len(samples), frame):
        chunk = samples[start:start + frame]
        levels.append(float(np.sqrt(np.mean(chunk * chunk))) if len(chunk) else 0.0)
    if not levels:
        return []
    peak = float(np.percentile(levels, 92)) or 1.0
    smoothed, previous = [], 0.0
    for raw_level in levels:
        target = max(0.0, min(1.0, (raw_level / peak - 0.06) / 0.94))
        previous = target if target > previous else previous * 0.68 + target * 0.32
        smoothed.append(round(previous, 3))
    smoothed.extend([round(smoothed[-1] * 0.45, 3), 0.0])
    return smoothed

def speech_emotion(text: str):
    """Choose a restrained facial cue for the sentence being spoken."""
    value = text.casefold()
    if re.search(r"\b(sorry|sad|unfortunately|loss|miss|hurt|failed|failure|afraid|worried)\w*\b", value):
        return "sad"
    if re.search(r"\b(warning|danger|careful|urgent|error|problem|stop|cannot|can't|critical|alert)\w*\b", value):
        return "focused"
    if re.search(r"\b(wow|surpris|amazing|incredible|unexpected)\w*\b", value):
        return "surprised"
    if re.search(r"\b(great|good|glad|happy|excellent|perfect|congrat|welcome|success|wonderful|pleased)\w*\b", value):
        return "happy"
    if text.rstrip().endswith("?"):
        return "curious"
    return "calm"


HEAD_ACTIONS = [
    (r"\b(?:close|shut)\s+(?:both\s+)?(?:your\s+)?eyes?\b", "close_eyes", "Closing my eyes."),
    (r"\b(?:open)\s+(?:both\s+)?(?:your\s+)?eyes?\b", "open_eyes", "Opening my eyes."),
    (r"\b(?:wink|close)\s+(?:your\s+)?left\s+eye\b", "wink_left", "Winking my left eye."),
    (r"\b(?:wink|close)\s+(?:your\s+)?right\s+eye\b", "wink_right", "Winking my right eye."),
    (r"\b(?:blink|blink your eyes|கண்\s*சிமிட்டு)\b", "blink", "Blinking."),
    (r"\b(?:look around|scan (?:the )?room)\b", "look_around", "Looking around."),
    (r"\blook (?:to (?:the )?)?left\b", "look_left", "Looking left."),
    (r"\blook (?:to (?:the )?)?right\b", "look_right", "Looking right."),
    (r"\blook up\b", "look_up", "Looking up."),
    (r"\blook down\b", "look_down", "Looking down."),
    (r"\b(?:look at me|look straight|center your eyes|centre your eyes)\b", "look_center", "Looking at you."),
    (r"\b(?:smile|happy face|look happy)\b", "happy", "Smiling."),
    (r"\b(?:look sad|sad face|frown)\b", "sad", "Showing a sad expression."),
    (r"\b(?:look surprised|surprised face|show surprise)\b", "surprised", "Showing surprise."),
    (r"\b(?:look focused|serious face|look angry|angry face)\b", "focused", "Showing a focused expression."),
    (r"\b(?:neutral|relax your face|rest your face|normal face)\b", "calm", "Back to neutral."),
]
HEAD_ACTIONS = [(re.compile(pattern, re.IGNORECASE), action, reply)
                for pattern, action, reply in HEAD_ACTIONS]


def match_head_action(text: str):
    """Return a browser-owned head action before the general skill router."""
    normalized = " ".join(text.split())
    for pattern, action, reply in HEAD_ACTIONS:
        if pattern.search(normalized):
            return action, reply
    return None, None

# ---------------------------------------------------------------- websocket session
import websockets

def sys_stats():
    import psutil, shutil
    b = psutil.sensors_battery()
    du_c = shutil.disk_usage("C:\\")
    du_u = shutil.disk_usage("U:\\")
    return {"type": "sys",
            "cpu": round(psutil.cpu_percent()), "ram": round(psutil.virtual_memory().percent),
            "batt": round(b.percent) if b else None,
            "plugged": bool(b.power_plugged) if b else None,
            "disk_c": round(du_c.used / du_c.total * 100),
            "disk_u": round(du_u.used / du_u.total * 100),
            "gpu": None}


# Two listeners can hear the SAME spoken question (orb window + tray
# assistant). The guards below keep IRIS from answering twice and from
# hearing her own replies through another client's open microphone.
CLIENTS = set()
HEAD_CLIENTS = set()
_last_turn = {"text": "", "t": 0.0}

def duplicate_turn(user_text):
    n = re.sub(r"[^\w\s]", "", user_text.lower()).strip()
    now = time.time()
    if (now - _last_turn["t"] < 3.0 and n and
            difflib.SequenceMatcher(None, n, _last_turn["text"]).ratio() > 0.8):
        return True
    _last_turn["text"], _last_turn["t"] = n, now
    return False

async def notify_peers(ws, wav):
    """Tell every OTHER client that reply audio is about to play, and for how
    long, so their open microphones mute instead of hearing IRIS herself."""
    if len(CLIENTS) < 2:
        return
    try:
        with wave.open(io.BytesIO(wav)) as w:
            secs = w.getnframes() / w.getframerate()
    except Exception:
        return
    msg = json.dumps({"type": "peer_speaking", "seconds": round(secs, 2)})
    for c in list(CLIENTS):
        if c is not ws:
            try:
                await c.send(msg)
            except Exception:
                pass

async def notify_head_speech(wav, text):
    """Send the face emotion; live jaw levels come from the audio player."""
    if not HEAD_CLIENTS:
        return
    message = json.dumps({"type": "head_speech",
                          "emotion": speech_emotion(text)})
    stale = []
    for client in list(HEAD_CLIENTS):
        try:
            await client.send(message)
        except Exception:
            stale.append(client)
    for client in stale:
        HEAD_CLIENTS.discard(client)


async def notify_head_action(action):
    """Send a deterministic voice command to the browser that owns COM9."""
    if not HEAD_CLIENTS:
        return False
    message = json.dumps({"type": "head_action", "action": action})
    delivered = False
    stale = []
    for client in list(HEAD_CLIENTS):
        try:
            await client.send(message)
            delivered = True
        except Exception:
            stale.append(client)
    for client in stale:
        HEAD_CLIENTS.discard(client)
    return delivered

async def notify_head_level(level):
    """Relay the level measured from audio that is playing right now."""
    if not HEAD_CLIENTS:
        return
    message = json.dumps({"type": "head_jaw", "level": round(max(0.0, min(1.0, level)), 3)})
    stale = []
    for client in list(HEAD_CLIENTS):
        try:
            await client.send(message)
        except Exception:
            stale.append(client)
    for client in stale:
        HEAD_CLIENTS.discard(client)

async def handle(ws):
    log("client connected")
    CLIENTS.add(ws)
    loop = asyncio.get_running_loop()
    history, chunks, capturing = [], [], False
    my_voice = {"id": active_voice["id"]}
    last_exchange = [0.0]          # hands-free follow-up window

    async def stats_loop():
        while True:
            try:
                await ws.send(json.dumps(await loop.run_in_executor(None, sys_stats)))
            except websockets.ConnectionClosed:
                return
            except Exception:
                pass
            await asyncio.sleep(3)
    stats_task = asyncio.create_task(stats_loop())

    async def send(obj):
        await ws.send(json.dumps(obj))

    async def respond(user_text, lang_hint):
        if duplicate_turn(user_text):
            log("duplicate turn ignored:", user_text[:40])
            await send({"type": "status", "state": "idle", "detail": "duplicate ignored"})
            return
        history.append({"role": "user", "content": user_text})
        await send({"type": "user", "text": user_text, "lang": lang_hint})
        await send({"type": "status", "state": "thinking"})
        memory.learn_phrase(user_text, lang_hint)
        head_action, head_reply = match_head_action(user_text)
        if head_action:
            delivered = await notify_head_action(head_action)
            direct = (head_reply if delivered else
                      "My head control is not connected. Press CONNECT HEAD, then try again.")
            _skill = "head:" + head_action
        else:
            direct, _skill = skills.match(user_text)
        # "remember that ..." / "forget ..." / "what do you know" are answered
        # directly so teaching is instant and reliable.
        if direct:
            log("skill:", _skill, "->", direct[:50])
        if not direct:
            direct = memory.handle_command(user_text)
        if not direct:
            # Taught answers ("when I say X, say Y") beat the LLM — verbatim
            # and instant, that is the point of training them.
            direct = training.find_answer(user_text)
        if direct:
            history.append({"role": "assistant", "content": direct})
            await send({"type": "reply", "text": direct})
            await send({"type": "status", "state": "speaking"})
            wav = await loop.run_in_executor(None, tts, direct, my_voice["id"])
            await notify_peers(ws, wav)
            if not head_action:
                await notify_head_speech(wav, direct)
            await send({"type": "audio",
                        "emotion": "hold" if head_action else speech_emotion(direct)})
            await ws.send(wav)
            await send({"type": "speech_done"})
            await send({"type": "memory", "stats": memory.stats()})
            await send({"type": "jarvis", **tasks_notes.dashboard_payload()})
            last_exchange[0] = time.time()   # skills open the follow-up window too
            return
        memories = "\n".join("- " + m for m in memory.recall(user_text))
        search_context = ""
        # Search only English world-questions: Tamil search results are poor and
        # triple the reply time, and questions about the robot itself
        # ("who are you", "what can you do") gain nothing from the web.
        robot_directed = re.search(r"(you|your|yours)", user_text, re.IGNORECASE)
        fresh = bool(FRESH_RE.search(user_text))
        if (WEB_SEARCH and lang_hint == "en" and
                (fresh or (not robot_directed and not SMALLTALK.match(user_text)
                           and len(user_text.split()) >= 3))):
            await send({"type": "status", "state": "thinking", "detail": "searching the web"})
            # Instant acknowledgment (Mark-LV pattern): a short spoken filler
            # covers the search delay so the room never gets dead air.
            ack = await loop.run_in_executor(None, tts, "One moment.", my_voice["id"])
            await notify_peers(ws, ack)
            await notify_head_speech(ack, "One moment.")
            await send({"type": "audio", "emotion": speech_emotion("One moment.")})
            await ws.send(ack)
            try:
                search_context = await asyncio.wait_for(
                    loop.run_in_executor(None, web_search, user_text), timeout=8)
            except asyncio.TimeoutError:
                search_context = ""
            await send({"type": "status", "state": "thinking"})
        deltas = asyncio.Queue()
        def on_delta(piece):
            loop.call_soon_threadsafe(deltas.put_nowait, piece)
        task = loop.run_in_executor(None, llm_stream, list(history), lang_hint,
                                    on_delta, search_context, memories)
        # Speak sentence-by-sentence while the LLM is still generating, so the
        # first words play ~2 s in instead of after the whole reply is done.
        sentence_q = asyncio.Queue()
        async def speaker():
            while True:
                sent = await sentence_q.get()
                if sent is None:
                    break
                wav = await loop.run_in_executor(None, tts, sent, my_voice["id"])
                await notify_peers(ws, wav)
                await notify_head_speech(wav, sent)
                await send({"type": "audio", "emotion": speech_emotion(sent)})
                await ws.send(wav)
                # Jaw moves with THIS sentence while the next one is still
                # being written, so speech and motion stay in step.
                if skills.robot.available:
                    loop.run_in_executor(None, jaw_play, wav)
        speak_task = asyncio.create_task(speaker())
        pending = ""
        first_sent = False
        async def feed(piece):
            nonlocal pending, first_sent
            pending += piece
            parts = SENTENCE_SPLIT.split(pending)
            for complete in parts[:-1]:
                if complete.strip():
                    if not first_sent:
                        first_sent = True
                        await send({"type": "status", "state": "speaking"})
                    await sentence_q.put(complete.strip())
            pending = parts[-1]
        while True:
            get = asyncio.create_task(deltas.get())
            done, _ = await asyncio.wait({get, task}, return_when=asyncio.FIRST_COMPLETED)
            if get in done:
                piece = get.result()
                await send({"type": "delta", "text": piece})
                await feed(piece)
            else:
                get.cancel()
                break
        while not deltas.empty():
            piece = deltas.get_nowait()
            await send({"type": "delta", "text": piece})
            await feed(piece)
        reply = task.result()
        if not reply:
            reply = "மன்னிக்கவும், மீண்டும் சொல்லுங்கள்." if lang_hint == "ta" else "Sorry, say that again?"
            await sentence_q.put(reply)
        if pending.strip():
            await sentence_q.put(pending.strip())
        history.append({"role": "assistant", "content": reply})
        if len(history) > 20:
            del history[:2]
        await send({"type": "reply", "text": reply})
        await sentence_q.put(None)
        await speak_task
        await send({"type": "speech_done"})
        last_exchange[0] = time.time()
        memory.log_exchange(user_text, reply, lang_hint)
        loop.run_in_executor(None, extract_facts, user_text, reply, lang_hint)
        await send({"type": "memory", "stats": memory.stats()})

    try:
        await send({"type": "status", "state": "idle", "detail": "ready"})
        await send({"type": "memory", "stats": memory.stats()})
        await send({"type": "skills", **skills.describe()})
        await send({"type": "voices",
                    "list": [{"id": v["id"], "label": v["label"]} for v in available_voices],
                    "active": my_voice["id"]})
        await send({"type": "jarvis", **tasks_notes.dashboard_payload()})
        async for message in ws:
            if isinstance(message, str):
                try:
                    hello = json.loads(message)
                except (TypeError, json.JSONDecodeError):
                    hello = {}
                if hello.get("type") == "head_client":
                    CLIENTS.discard(ws)
                    HEAD_CLIENTS.add(ws)
                    await send({"type": "head_ready"})
                    log("Face Control connected for jaw and emotion motion")
                    continue
                if hello.get("type") == "playback_client":
                    CLIENTS.discard(ws)
                    await send({"type": "playback_ready"})
                    continue
                if hello.get("type") == "jaw_level":
                    try:
                        level = float(hello.get("level", 0.0))
                    except (TypeError, ValueError):
                        level = 0.0
                    await notify_head_level(level)
                    continue
            if isinstance(message, bytes):
                if capturing:
                    chunks.append(message)
                continue
            msg = json.loads(message)
            if msg["type"] == "start":
                chunks, capturing = [], True
                await send({"type": "status", "state": "listening"})
            elif msg["type"] == "stop":
                capturing = False
                hands_free = bool(msg.get("handsfree"))
                await send({"type": "status", "state": "thinking"})
                pcm = b"".join(chunks)
                text, lang, conf = await loop.run_in_executor(None, transcribe, pcm)
                if not text:
                    await send({"type": "status", "state": "idle", "detail": "heard nothing"})
                    continue
                # Hands-free wake gate (Mark-LV pattern): answer only when
                # addressed by name, or within the follow-up window after an
                # exchange — so room chatter never triggers a reply.
                if hands_free:
                    # Distant mumbling and TV noise transcribe with very low
                    # confidence — those turns are junk, never answer them.
                    if conf < -1.1:
                        log("low confidence (%.2f), ignored: %s" % (conf, text[:50]))
                        await send({"type": "status", "state": "idle",
                                    "detail": "didn't catch that"})
                        continue
                    addressed = WAKE_RE.search(text)
                    recent = time.time() - last_exchange[0] < FOLLOWUP_S
                    if not addressed and not recent:
                        log("standby, ignored:", text[:50])
                        await send({"type": "status", "state": "idle",
                                    "detail": "standby — say 'Iris'"})
                        continue
                    if addressed:
                        stripped = WAKE_STRIP.sub("", text, count=1).strip()
                        if stripped and stripped != text:
                            text = stripped
                try:
                    await respond(text, lang)
                except websockets.ConnectionClosed:
                    raise
                except Exception as e:
                    log("turn failed:", repr(e)[:120])
                    await send({"type": "error", "text": "Something went wrong on that one."})
                    await send({"type": "status", "state": "idle"})
            elif msg["type"] == "text":
                user_text = msg.get("text", "").strip()
                if user_text:
                    try:
                        await respond(user_text, languages.detect_script(user_text))
                    except websockets.ConnectionClosed:
                        raise
                    except Exception as e:
                        log("turn failed:", repr(e)[:120])
                        await send({"type": "error", "text": "Something went wrong on that one."})
                        await send({"type": "status", "state": "idle"})
            elif msg["type"] == "motion":
                want = bool(msg.get("on"))
                if want:
                    skills.robot.port = msg.get("port") or "COM9"
                    ok = skills.robot.connect()
                    if not ok:
                        skills.robot.port = None
                    await send({"type": "motion", "on": ok,
                                "detail": skills.robot.last_error if not ok else "connected"})
                else:
                    skills.robot.off()
                    try: skills.robot.ser and skills.robot.ser.close()
                    except Exception: pass
                    skills.robot.ser = None; skills.robot.port = None
                    await send({"type": "motion", "on": False, "detail": "outputs off"})
            elif msg["type"] == "skills":
                await send({"type": "skills", **skills.describe()})
            elif msg["type"] == "jarvis":
                await send({"type": "jarvis", **tasks_notes.dashboard_payload()})
            elif msg["type"] == "task_done":
                tasks_notes.complete(task_id=msg.get("id"))
                await send({"type": "jarvis", **tasks_notes.dashboard_payload()})
            elif msg["type"] == "task_add":
                if msg.get("text", "").strip():
                    tasks_notes.add_task(msg["text"].strip())
                await send({"type": "jarvis", **tasks_notes.dashboard_payload()})
            elif msg["type"] == "note_add":
                if msg.get("text", "").strip():
                    tasks_notes.add_note(msg["text"].strip())
                await send({"type": "jarvis", **tasks_notes.dashboard_payload()})
            elif msg["type"] == "memory_list":
                await send({"type": "memory_list",
                            "facts": memory.all_facts()[-60:],
                            "phrases": memory.common_phrases(),
                            "stats": memory.stats()})
            elif msg["type"] == "memory_forget":
                memory.forget(msg.get("text") or None)
                await send({"type": "memory_list",
                            "facts": memory.all_facts()[-60:],
                            "phrases": memory.common_phrases(),
                            "stats": memory.stats()})
            elif msg["type"] == "set_voice":
                vid = msg.get("id")
                if any(v["id"] == vid for v in available_voices):
                    my_voice["id"] = vid
                    if not next(v for v in available_voices if v["id"] == vid).get("engine") == "kokoro":
                        await loop.run_in_executor(None, get_piper, vid)
                    await send({"type": "voice_set", "id": vid})
            elif msg["type"] == "say":
                sample = msg.get("text", "").strip()
                if sample:
                    wav = await loop.run_in_executor(None, tts, sample, my_voice["id"])
                    await notify_peers(ws, wav)
                    await notify_head_speech(wav, sample)
                    await send({"type": "audio", "emotion": speech_emotion(sample)})
                    await ws.send(wav)
                    await send({"type": "speech_done"})
    except websockets.ConnectionClosed:
        pass
    finally:
        CLIENTS.discard(ws)
        HEAD_CLIENTS.discard(ws)
        stats_task.cancel()
        log("client disconnected")

async def main():
    # quick ollama check so failures are loud at startup
    try:
        with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=5) as r:
            models = [m["name"] for m in json.load(r).get("models", [])]
        log("ollama ok, models:", models or "NONE - run: ollama pull " + LLM_MODEL)
    except Exception as e:
        log("WARNING: ollama not reachable:", e)
        log("start it, then: ollama pull", LLM_MODEL)
    if GEMINI_KEY:
        log(f"brain: {GEMINI_MODEL} (cloud) with {LLM_MODEL} fallback (local)")
    else:
        log(f"brain: {LLM_MODEL} (local only — add voice/api_keys.json for Gemini)")
    log(f"listening on ws://{HOST}:{PORT} - open http://127.0.0.1:8765/jarvis.html")
    async with websockets.serve(handle, HOST, PORT, max_size=32 * 1024 * 1024):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    finally:
        if _jaw:
            _jaw.write(b"0\n"); _jaw.close()

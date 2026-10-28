"""Loop-test the InMoov voice pipeline end to end.

Simulates the microphone: renders known phrases to speech (Piper for English,
MMS for Tamil), streams them to the server as 16 kHz PCM exactly like the
browser does, then scores what came back:
  - STT accuracy (similarity of transcript vs the spoken phrase)
  - language detection correctness
  - per-stage latency: STT, LLM, TTS
  - reply language correctness (Tamil question -> Tamil-script reply)

Usage:  python test_harness.py [seconds]   (default 0 = one cycle only)
Writes JSONL to voice/test_logs/run-<stamp>.jsonl and prints a summary.
"""
import asyncio, difflib, io, json, os, re, sys, time, wave
from pathlib import Path
os.environ.setdefault("HF_HOME", str(Path(__file__).parent / "models" / "hf"))

import numpy as np
import websockets

WS_URL = "ws://127.0.0.1:8766"
LOG_DIR = Path(__file__).parent / "test_logs"
LOG_DIR.mkdir(exist_ok=True)
TAMIL_RE = re.compile(r"[஀-௿]")

EN_PHRASES = [
    "Hello, who are you?",
    "What is your name?",
    "Can you move your eyes?",
    "Tell me something interesting about robots.",
    "How are you feeling today?",
    "What can you do?",
    "Do you like music?",
    "Where do you live?",
]
TA_PHRASES = [
    "வணக்கம், நீங்கள் யார்?",
    "உங்கள் பெயர் என்ன?",
    "நீங்கள் என்ன செய்ய முடியும்?",
    "இன்று எப்படி இருக்கிறீர்கள்?",
]
TE_PHRASES = [
    "నమస్కారం, మీరు ఎవరు?",
    "మీ పేరు ఏమిటి?",
    "మీరు ఏమి చేయగలరు?",
]
HI_PHRASES = [
    "नमस्ते, आप कौन हैं?",
    "आपका नाम क्या है?",
]

# ---------------- speech generation (the "user voice") ----------------
_piper = None
_mms = {}
def speak(text, lang):
    global _piper, _mms
    if lang == "en":
        if _piper is None:
            from piper import PiperVoice
            p = Path(__file__).parent / "models" / "piper" / "en_US-lessac-medium.onnx"
            try: _piper = PiperVoice.load(str(p))
            except TypeError: _piper = PiperVoice.load(str(p), str(p) + ".json")
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            if hasattr(_piper, "synthesize_wav"): _piper.synthesize_wav(text, w)
            else:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(_piper.config.sample_rate)
                for c in _piper.synthesize_stream_raw(text): w.writeframes(c)
        return buf.getvalue()
    mms = {"ta": "tam", "te": "tel", "hi": "hin"}.get(lang, "tam")
    if mms not in _mms:
        import torch
        from transformers import VitsModel, AutoTokenizer
        _mms[mms] = (torch, VitsModel.from_pretrained(f"facebook/mms-tts-{mms}"),
                     AutoTokenizer.from_pretrained(f"facebook/mms-tts-{mms}"))
    torch, model, tok = _mms[mms]
    with torch.no_grad():
        wav = model(**tok(text, return_tensors="pt")).waveform[0].numpy()
    pcm = np.clip(wav * 32767, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(model.config.sampling_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()

def wav_to_pcm16k(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if rate != 16000:
        x = np.arange(len(pcm))
        xi = np.arange(0, len(pcm), rate / 16000)
        pcm = np.interp(xi, x, pcm.astype(np.float32)).astype(np.int16)
    return pcm.tobytes()

# ---------------- scoring ----------------
def norm(s):
    return re.sub(r"[^\w\s஀-௿]", "", s.lower()).strip()
def similarity(a, b):
    return round(difflib.SequenceMatcher(None, norm(a), norm(b)).ratio(), 3)

# ---------------- one round-trip ----------------
async def round_trip(ws, phrase, lang):
    pcm = wav_to_pcm16k(speak(phrase, lang))
    r = {"phrase": phrase, "lang": lang, "audio_s": round(len(pcm) / 2 / 16000, 2)}
    await ws.send(json.dumps({"type": "start"}))
    for i in range(0, len(pcm), 8192):
        await ws.send(pcm[i:i + 8192])
        await asyncio.sleep(0.005)
    t_stop = time.time()
    await ws.send(json.dumps({"type": "stop"}))
    heard = reply = None
    audio_bytes = 0
    t_user = t_reply = None
    # Replies stream as one audio chunk per sentence, then a speech_done
    # marker. Drain to that marker or the next round desynchronizes.
    while True:
        m = await asyncio.wait_for(ws.recv(), timeout=240)
        if isinstance(m, bytes):
            audio_bytes += len(m)
            if "t_first_audio" not in r:
                # With sentence streaming the first audio can arrive BEFORE the
                # final reply message, so time it from stop, not from t_reply.
                r["t_first_audio"] = round(time.time() - t_stop, 2)
            continue
        d = json.loads(m)
        if d["type"] == "user":
            r["t_stt"] = round(time.time() - t_stop, 2)
            t_user = time.time()
            heard, r["stt_lang"] = d["text"], d.get("lang")
        elif d["type"] == "reply":
            t_reply = time.time()
            if t_user:
                r["t_llm"] = round(t_reply - t_user, 2)
            reply = d["text"]
        elif d["type"] == "speech_done":
            r["audio_bytes"] = audio_bytes
            break
        elif d["type"] == "status" and d.get("detail") == "heard nothing":
            r["error"] = "heard nothing"
            return r
        elif d["type"] == "error":
            # The server failed the turn (LLM down etc.) — end the round now
            # instead of sitting out the full recv timeout.
            r["error"] = "server: " + d.get("text", "turn failed")
            return r
    if not heard or reply is None:
        r["error"] = "incomplete round (heard=%r)" % heard
        return r
    r["heard"] = heard
    r["reply"] = reply
    r["stt_sim"] = similarity(phrase, heard)
    r["lang_ok"] = r.get("stt_lang") == lang
    r["reply_lang_ok"] = bool(TAMIL_RE.search(reply)) == (lang == "ta")
    r["t_total"] = round(time.time() - t_stop, 2)
    return r

async def main(duration):
    stamp = time.strftime("%H%M%S")
    log_path = LOG_DIR / f"run-{stamp}.jsonl"
    results, t0, cycle = [], time.time(), 0
    print(f"logging to {log_path}", flush=True)
    async with websockets.connect(WS_URL, max_size=64 * 1024 * 1024) as ws:
        await asyncio.wait_for(ws.recv(), timeout=10)   # initial status
        while True:
            cycle += 1
            for lang, phrases in (("en", EN_PHRASES), ("ta", TA_PHRASES), ("te", TE_PHRASES), ("hi", HI_PHRASES)):
                for phrase in phrases:
                    if duration and time.time() - t0 > duration:
                        break
                    try:
                        r = await round_trip(ws, phrase, lang)
                    except Exception as e:
                        r = {"phrase": phrase, "lang": lang, "error": str(e)[:200]}
                    r["cycle"] = cycle
                    results.append(r)
                    with open(log_path, "a", encoding="utf-8") as f:
                        f.write(json.dumps(r, ensure_ascii=False) + "\n")
                    ok = "err " if "error" in r else ""
                    print(f"  c{cycle} {lang} {ok}sim={r.get('stt_sim','-')} "
                          f"stt={r.get('t_stt','-')}s llm={r.get('t_llm','-')}s "
                          f"1st_audio={r.get('t_first_audio','-')}s "
                          f"total={r.get('t_total','-')}s | {phrase[:30]}", flush=True)
            if not duration or time.time() - t0 > duration:
                break

    good = [r for r in results if "error" not in r]
    def avg(key, sel=lambda r: True):
        v = [r[key] for r in good if key in r and sel(r)]
        return round(sum(v) / len(v), 2) if v else None
    summary = {
        "runs": len(results), "errors": len(results) - len(good),
        "stt_sim_en": avg("stt_sim", lambda r: r["lang"] == "en"),
        "stt_sim_ta": avg("stt_sim", lambda r: r["lang"] == "ta"),
        "stt_sim_te": avg("stt_sim", lambda r: r["lang"] == "te"),
        "stt_sim_hi": avg("stt_sim", lambda r: r["lang"] == "hi"),
        "lang_detect_ok": round(sum(r["lang_ok"] for r in good) / len(good), 3) if good else None,
        "reply_lang_ok": round(sum(r["reply_lang_ok"] for r in good) / len(good), 3) if good else None,
        "avg_t_stt": avg("t_stt"), "avg_t_llm": avg("t_llm"),
        "avg_t_first_audio": avg("t_first_audio"), "avg_t_total": avg("t_total"),
        "minutes": round((time.time() - t0) / 60, 1),
    }
    print("SUMMARY " + json.dumps(summary), flush=True)

if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 0))

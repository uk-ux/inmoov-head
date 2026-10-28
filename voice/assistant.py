r"""IRIS always-on voice client — a tray app, no browser needed.

Open microphone -> energy VAD segments an utterance -> streamed to the voice
server exactly like the orb page does (handsfree, so the server's wake gate
applies: IRIS answers only when addressed by name or shortly after an
exchange) -> reply WAVs play through the speakers.

Half-duplex: the mic is ignored while IRIS is speaking (plus a short tail),
so she never hears herself. The tray icon offers Open IRIS window,
Pause listening and Quit.

Run visibly for debugging:   voice\venv\Scripts\python.exe assistant.py
Ask one question and exit:   ... assistant.py --selftest "hello iris"
List audio devices:          ... assistant.py --devices
"""
import asyncio, io, json, os, queue, sys, threading, time, wave
from pathlib import Path

import numpy as np
import sounddevice as sd
import websockets

WS_URL = "ws://127.0.0.1:8766"
ORB_URL = "http://127.0.0.1:8765/jarvis.html"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

RATE = 16000
BLOCK = 480                  # 30 ms at 16 kHz
INPUT_DEVICE = None          # sounddevice index, None = Windows default
OUTPUT_DEVICE = None

# --- energy VAD ---
MIN_THRESH = 250             # int16 RMS floor for "speech" in a quiet room
START_BLOCKS = 3             # blocks above threshold to open an utterance
END_SILENCE_S = 0.9          # this much quiet closes the utterance
PRE_ROLL_S = 0.36            # audio kept from before the trigger
MIN_UTTER_S = 0.4            # shorter than this is a cough, not a sentence
MAX_UTTER_S = 12.0
SPEAK_TAIL_S = 0.4           # mic stays closed this long after IRIS finishes

LOG_PATH = Path(os.environ.get("TEMP", ".")) / "iris-assistant.log"


def log(*a):
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(x) for x in a)
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------- shared state
LISTEN_ON_START = False   # start MUTED: the open mic arms only when the user
                          # turns Listening on in the tray menu (their choice).

listening = threading.Event()
if LISTEN_ON_START:
    listening.set()
speaking = threading.Event()                     # set while replies play
peer_mute = {"until": 0.0}                       # IRIS speaking via another client
quitting = threading.Event()
status_text = {"s": "starting"}                  # tray tooltip

mic_q = queue.Queue(maxsize=400)                 # raw 30 ms blocks
play_q = queue.Queue()                           # reply WAVs, per sentence


# ---------------------------------------------------------------- microphone
def mic_callback(indata, frames, t, status):
    if speaking.is_set() or not listening.is_set() or time.time() < peer_mute["until"]:
        return
    try:
        mic_q.put_nowait(bytes(indata))
    except queue.Full:
        pass


# ---------------------------------------------------------------- playback
def playback_loop():
    """Plays reply sentences in order; holds the mic shut while doing so."""
    while not quitting.is_set():
        try:
            wav_bytes = play_q.get(timeout=0.25)
        except queue.Empty:
            continue
        speaking.set()
        try:
            with wave.open(io.BytesIO(wav_bytes)) as w:
                sr = w.getframerate()
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            sd.play(pcm, sr, device=OUTPUT_DEVICE)
            sd.wait()
        except Exception as e:
            log("playback failed:", str(e)[:80])
        if play_q.empty():
            time.sleep(SPEAK_TAIL_S)
            if play_q.empty():
                speaking.clear()


# ---------------------------------------------------------------- utterances
async def utterance_stream():
    """Yields complete spoken utterances (PCM16 bytes) from the mic queue."""
    loop = asyncio.get_running_loop()
    pre_roll_n = int(PRE_ROLL_S * RATE / BLOCK)
    end_silence_n = int(END_SILENCE_S * RATE / BLOCK)
    max_blocks = int(MAX_UTTER_S * RATE / BLOCK)
    noise_floor = 500.0
    pre = []
    while not quitting.is_set():
        # ---- idle: watch for speech onset
        voiced, in_speech = 0, False
        while not in_speech and not quitting.is_set():
            block = await loop.run_in_executor(None, mic_q.get)
            pcm = np.frombuffer(block, dtype=np.int16).astype(np.float32)
            rms = float(np.sqrt(np.mean(pcm * pcm)))
            thresh = max(noise_floor * 3.0, MIN_THRESH)
            if rms > thresh:
                voiced += 1
                if voiced >= START_BLOCKS:
                    in_speech = True
            else:
                voiced = 0
                # only quiet blocks teach the noise floor
                noise_floor = 0.95 * noise_floor + 0.05 * rms
            pre.append(block)
            if len(pre) > pre_roll_n:
                pre.pop(0)
        # ---- capturing
        chunks, silent = list(pre), 0
        pre = []
        thresh = max(noise_floor * 2.0, MIN_THRESH)   # hysteresis: easier to stay
        while len(chunks) < max_blocks and not quitting.is_set():
            block = await loop.run_in_executor(None, mic_q.get)
            chunks.append(block)
            pcm = np.frombuffer(block, dtype=np.int16).astype(np.float32)
            rms = float(np.sqrt(np.mean(pcm * pcm)))
            if rms > thresh:
                silent = 0
            else:
                silent += 1
                if silent >= end_silence_n:
                    break
        utter = b"".join(chunks)
        dur = len(utter) / 2 / RATE - END_SILENCE_S
        if dur >= MIN_UTTER_S:
            yield _normalize(utter)


def _normalize(utter, target_rms=2600.0, max_gain=6.0):
    """Software auto-gain. The browser mic path gets AGC from getUserMedia;
    this raw sounddevice path does not, and quiet, distant speech is the
    main source of misheard words. Boost soft utterances toward a healthy
    level, never past clipping."""
    pcm = np.frombuffer(utter, dtype=np.int16).astype(np.float32)
    rms = float(np.sqrt(np.mean(pcm * pcm))) or 1.0
    if rms >= target_rms:
        return utter
    gain = min(max_gain, target_rms / rms)
    return np.clip(pcm * gain, -32768, 32767).astype(np.int16).tobytes()


# ---------------------------------------------------------------- server link
async def session(selftest=None):
    async with websockets.connect(WS_URL, max_size=64 * 1024 * 1024) as ws:
        log("connected to", WS_URL)
        status_text["s"] = ("listening — say 'Iris'" if listening.is_set()
                            else "muted — right-click to turn Listening on")

        async def receiver(hook=None):
            async for m in ws:
                if isinstance(m, bytes):
                    play_q.put(m)
                    continue
                d = json.loads(m)
                t = d.get("type")
                if t == "user":
                    log("heard:", d.get("text"))
                elif t == "reply":
                    log("reply:", d.get("text"))
                elif t == "status" and d.get("detail"):
                    status_text["s"] = d["detail"]
                elif t == "peer_speaking":
                    peer_mute["until"] = max(
                        peer_mute["until"],
                        time.time() + float(d.get("seconds", 0)) + 0.6)
                elif t == "error":
                    log("server error:", d.get("text"))
                if hook:
                    await hook(d)

        done = asyncio.Event()

        async def receiver_done_hook(d):
            if d.get("type") == "speech_done":
                done.set()

        recv_task = asyncio.create_task(receiver(receiver_done_hook))

        if selftest is not None:
            await ws.send(json.dumps({"type": "text", "text": selftest}))
            await asyncio.wait_for(done.wait(), timeout=180)
            while not play_q.empty() or speaking.is_set():
                await asyncio.sleep(0.2)
            recv_task.cancel()
            return

        async for utter in utterance_stream():
            if quitting.is_set():
                break
            log("utterance: %.1f s" % (len(utter) / 2 / RATE))
            await ws.send(json.dumps({"type": "start"}))
            for i in range(0, len(utter), 8192):
                await ws.send(utter[i:i + 8192])
            await ws.send(json.dumps({"type": "stop", "handsfree": True}))
        recv_task.cancel()


async def run(selftest=None):
    stream = None
    if selftest is None:
        stream = sd.InputStream(samplerate=RATE, blocksize=BLOCK, channels=1,
                                dtype="int16", device=INPUT_DEVICE,
                                callback=mic_callback)
        stream.start()
        log("microphone open (device %s)" % (INPUT_DEVICE if INPUT_DEVICE is not None else "default"))
    while not quitting.is_set():
        try:
            await session(selftest)
            if selftest is not None:
                break
        except (OSError, websockets.WebSocketException) as e:
            status_text["s"] = "voice server offline — retrying"
            log("server unreachable (%s); retrying in 3 s" % str(e)[:60])
            await asyncio.sleep(3)
    if stream:
        stream.stop(); stream.close()


# ---------------------------------------------------------------- tray icon
def make_icon_image():
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, 60, 60), fill=(16, 42, 67, 255))
    d.ellipse((14, 14, 50, 50), fill=(64, 156, 255, 255))
    d.ellipse((24, 24, 40, 40), fill=(180, 225, 255, 255))
    return img


def tray(loop):
    try:
        import pystray
    except Exception as e:
        log("pystray unavailable (%s); running without tray" % str(e)[:60])
        quitting.wait()
        return

    def open_window(icon, item):
        import subprocess
        subprocess.Popen([EDGE, "--app=" + ORB_URL])

    def toggle_listen(icon, item):
        if listening.is_set():
            listening.clear()
            status_text["s"] = "muted — right-click to turn Listening on"
        else:
            listening.set()
            status_text["s"] = "listening — say 'Iris'"

    def do_quit(icon, item):
        quitting.set()
        loop.call_soon_threadsafe(lambda: None)
        icon.stop()

    icon = pystray.Icon(
        "IRIS", make_icon_image(), "IRIS",
        menu=pystray.Menu(
            pystray.MenuItem("Open IRIS window", open_window, default=True),
            pystray.MenuItem("Listening", toggle_listen,
                             checked=lambda item: listening.is_set()),
            pystray.MenuItem("Quit IRIS assistant", do_quit),
        ))

    def update_title():
        while not quitting.is_set():
            try:
                icon.title = "IRIS — " + status_text["s"]
            except Exception:
                pass
            time.sleep(2)
    threading.Thread(target=update_title, daemon=True).start()
    icon.run()
    os._exit(0)   # tray Quit ends everything, mic thread included


# ---------------------------------------------------------------- main
def main():
    if "--devices" in sys.argv:
        print(sd.query_devices())
        return
    selftest = None
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        selftest = sys.argv[i + 1] if len(sys.argv) > i + 1 else "Hello, can you hear me?"
    log("IRIS assistant starting", "(selftest)" if selftest else "")
    threading.Thread(target=playback_loop, daemon=True).start()
    loop = asyncio.new_event_loop()
    if selftest is not None:
        loop.run_until_complete(run(selftest))
        return
    t = threading.Thread(target=lambda: loop.run_until_complete(run()), daemon=True)
    t.start()
    tray(loop)


if __name__ == "__main__":
    main()

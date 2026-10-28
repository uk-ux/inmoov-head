# IRIS — the InMoov voice assistant

**IRIS** (the eye's iris, and Iris the Greek messenger goddess) is the
laptop app. **InMoov** is the robot it drives.

Offline voice chatbot: speak Tamil or English, InMoov thinks locally and
replies aloud in your language. UI is the orb page with a chat panel.

## Start everything

**Double-click the IRIS shortcut on the desktop** (or `U:\inmoov\START_IRIS.bat`).
Servers start hidden, IRIS opens as her own app window (no browser bars) showing
the **JARVIS dashboard** (`jarvis.html`): live clock, system meters, brain
status, today's tasks and schedule, the notes vault with connections, a
conversation panel with push-to-talk, and one-click command chips. Tasks and
notes are voice-first — "add task call amma at 6 pm", "take a note …",
"task call amma done", "what are my tasks", "read my notes" — and stored in
`voice/memory/tasks.json` / `notes.jsonl`. **"Daily briefing"** (or just
"good morning") speaks the date, battery, your tasks and live news headlines.
The orb-only view is still at orb.html ("orb view" link in the footer), and
the **tray assistant** starts: a blue orb icon near the clock. It starts
**muted** — right-click the orb and tick **Listening** when you want the
always-on mic; then "Iris, …" spoken out loud anytime gets an answer through
the speakers, no window needed. Right-click again to mute, or Quit.
(To make it listen from startup, set LISTEN_ON_START = True at the top of
voice/assistant.py.) IRIS also starts by herself at login (silently, tray
only) via the shortcut in `shell:startup`.

Debugging: server log is `%TEMP%\iris-server.log`, assistant log is
`%TEMP%\iris-assistant.log`. `START_VOICE.bat` is the old visible-windows
launcher, kept for troubleshooting. Voice client alone:
`voice\venv\Scripts\python.exe voice\assistant.py` (visible console;
`--selftest "hi"` for one text round trip, `--devices` to list audio devices).

In the window: hold the button (or Space) → talk → release. Or type in the
chat box.

**Voice tab** (top of the chat panel): pick between 6 English voices and
test them. Tamil always uses its own voice. Your choice is remembered.

**Web search**: when internet is available, questions are enriched with live
DuckDuckGo results ("searching the web" shows under the orb), so InMoov can
answer about current events. Offline, it answers from the model alone —
nothing breaks. Turn off with WEB_SEARCH = False in voice/server.py.

## Stack (all free, all local)

| Job | Component |
|---|---|
| Speech to text | faster-whisper `small` on **GPU** (0.3 s), Tamil/English autodetect |
| Thinking | Ollama + `qwen3:8b` with thinking disabled — far better Tamil grammar than qwen2.5 |
| Voice out, English | **Kokoro** neural TTS (deep male Fenrir by default) + Piper as fallback |
| Voice out, Tamil | Meta MMS-TTS `facebook/mms-tts-tam` (Piper has no Tamil voice) |
| UI | `control_ui/orb.html` — animated orb + chat panel, WebSocket to 8766 |

Reply language follows the reply text: Tamil script → MMS Tamil voice,
otherwise Piper English. The LLM is instructed to answer in the user's
language.

## Languages

Speak or type any of these; IRIS detects the language and replies in it,
each with its own voice:

- **English** — Kokoro neural voice
- **Tamil, Telugu, Hindi** — ready (MMS voices, downloaded)
- Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Urdu — download on
  first use

Whisper detects the spoken language; the reply is routed to a voice by its
script (Telugu letters -> Telugu voice, and so on).

## Training IRIS (say these)

- **"When I say <phrase>, say <answer>"** — teaches an exact answer. From
  then on that phrase (even slightly misheard) gets your answer verbatim,
  instantly, without the AI model. Repeat with the same phrase to retrain.
- **"Train personality: <rule>"** — e.g. "always call me boss", "answer in
  one short sentence". Becomes a standing rule in every AI reply.
  "Clear your personality" removes all rules.
- **"Show your training"** · **"Forget training <phrase>"**
- **"Remember that <fact>"** — teaches a fact about you (existing memory).
- **Speech adaptation is automatic**: your most-frequent words (from
  `memory/phrases.json`) are fed to whisper as hotwords, so your recurring
  names and vocabulary get recognized better the more you talk to her.

Stores: `memory/trained_qa.json`, `memory/style.json` — plain files, safe
to edit by hand.

## Skills (say these — they run instantly, before the model)

- **Head** (needs motion enabled): look around / left / right / up / down /
  at me, blink, smile, look sad, look surprised, neutral, stop moving
- **Diagnostics**: run diagnostics, status report
- **Laptop**: open ANY installed app by name — "open whatsapp / word / vlc /
  arduino ide / vs code" (Start Menu + Store apps are auto-indexed to
  `voice/memory/apps_catalog.json`; say "rescan my apps" after installing
  something new). Plus: open downloads/documents/pictures folder, volume,
  brightness, media keys, screenshot, press enter/escape, scroll up/down,
  switch window, read my clipboard, empty the recycle bin (spoken
  confirmation required), lock the screen, sleep, shutdown/restart with
  30 s spoken cancel, battery, disk space, time, date

Enable head motion in the **Skills** tab (COM9). The browser calibrator must
be disconnected first — one program owns the port.

## Model cache location

All AI models are cached on **U:** (`voice/models/hf`) because C: was full.
Set by `HF_HOME` at the top of server.py; do not remove it.

## Ports

- 8765 — static UI (http.server)
- 8766 — voice WebSocket (`voice/server.py`)
- 11434 — Ollama

## Jaw and expression sync

Keep `JAW_SERIAL = None`: Face Control is the only owner of COM9. The voice
server sends a 50 ms speech envelope and a matching emotion over WebSocket;
Face Control converts those normalized values through its calibrated CH11
limits and clamps every facial pose through the saved servo limits. Open Face
Control, connect the Uno, then speak through IRIS. English replies use the
deep male Fenrir voice by default.

## Offline check before demo day

Turn Wi-Fi off and do one full round-trip in each language. Models are
cached after first use: whisper in `%USERPROFILE%\.cache\huggingface`,
MMS likewise, Piper in `voice/models/`, qwen in `%USERPROFILE%\.ollama`.

## If something breaks

- Orb page says "voice server offline" → the `InMoov voice server` window
  is closed or crashed; rerun START_VOICE.bat and read its window.
- Replies never come → Ollama not running or model missing:
  `ollama list` should show `qwen3:8b`, else `ollama pull qwen3:8b`.
- Mic does nothing → Chrome site permissions → Microphone → Allow for
  127.0.0.1; and check Windows Settings > Privacy > Microphone.
- Tamil reply sounds robotic/fails → first Tamil reply loads MMS (~20 s);
  watch the server window.

## Tuning knobs (top of voice/server.py)

- `LLM_MODEL` — `qwen3:8b` (best Tamil) · `qwen2.5:7b` (faster, weak Tamil) · `qwen2.5:3b` (fastest)
- `SPEECH_SPEED` — 0.92 = calm. Lower = slower/calmer, 1.0 = normal.
- `WEB_SEARCH` — False turns off internet enrichment (faster, fully offline).
- `SYSTEM_PROMPT` — InMoov's personality; currently calm, gentle, unhurried.

Replies stream sentence-by-sentence, so speech starts before the full answer
is written. Voice choice is per browser tab (Voice tab), not global.

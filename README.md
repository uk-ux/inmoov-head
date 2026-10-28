# InMoov Head — IRIS

An animatronic InMoov robot head with 16 calibrated facial servos and an
offline bilingual (Tamil / English) voice assistant.

**IRIS** is the laptop-side application. **InMoov** is the robot head it drives.

Two subsystems that meet at the jaw servo:

| Subsystem | What it does |
|---|---|
| **Face control** | Browser UI → Web Serial → Arduino Nano/Uno → PCA9685 → 16 servos |
| **IRIS voice** | Mic → Whisper → local LLM → TTS → speakers, plus a jaw/emotion stream to the face |

---

## ⚠️ Safety rules — read before powering anything

These are not optional. A mistake here strips gears or destroys the controller.

- **Keep external servo power OFF** during all wiring changes and firmware uploads.
- The controller board, the PCA9685, and the external servo supply **must share a
  common ground.** A floating ground makes every servo move erratically and can
  push return current through the controller's I/O pins.
- **Never power servos from the board's 5V pin or from USB.** Use a separate
  regulated supply into the PCA9685 `POWER+` / `POWER-` terminals.
- Keep the physical servo-power cutoff **within reach** during any movement test.
- **Test one channel at a time** using the `K` or `S`/`ARM` commands.
- Stop immediately on hard contact, buzzing, cable tension, or unexpected motion.
- Do **not** run all-neutral, animation, blink, expressions, or camera-following
  until each channel has been individually verified.
- Never send movement commands automatically on reconnect.

> **Do not flash generic "PCA9685 servo sweep" tutorial sketches to this board.**
> They ignore the measured limits below and drive servos across their full range,
> into the head's mechanical hard stops. Use `firmware/pca9685_i2c_diagnostic`
> to test the I2C bus instead — it never commands a servo position.

---

## Hardware

**Controller:** Arduino Nano or Uno (ATmega328P) · **Driver:** one PCA9685 at I2C `0x40`

| Controller | PCA9685 |
|---|---|
| 5V | VCC (logic power only) |
| GND | GND |
| A4 | SDA |
| A5 | SCL |
| GND | OE |

External regulated servo supply: positive → PCA `POWER+`, negative → `POWER-`
**and** common ground with the controller. PCA address jumpers stay open for `0x40`.

---

## Calibration

Pulse values in **microseconds are authoritative**. The `0–180` numbers in the UI
are a calibration scale for mapping between two endpoints — they are *not*
mechanical degrees. Mechanically reversed servos legitimately have a *decreasing*
pulse as position increases.

Source of truth: [`hardware/HEAD_CALIBRATION_LOG.csv`](hardware/HEAD_CALIBRATION_LOG.csv)

| CH | Mechanism | Endpoint A | Rest | Endpoint B | Status |
|---:|---|---|---|---|---|
| 0 | Left eye horizontal | 1072 | 1412 | 1877 | ✅ confirmed |
| 1 | Left eye vertical | Up 1715 | 1545 | Down 1375 | ✅ reversed |
| 2 | Right eye horizontal | 1257 | 1482 | 1742 | ✅ confirmed |
| 3 | Right eye vertical | 1742 | 1472 | 1187 | ✅ confirmed |
| 4 | Left upper eyelid | Open 1367 | 1367 | Closed 1527 | ✅ rest = open |
| 5 | Left lower eyelid | Open 1623 | 1623 | Closed 1453 | ✅ reversed |
| 6 | Right upper eyelid | Open 1520 | 1520 | Closed 1420 | ✅ reversed |
| 7 | Right lower eyelid | Open 1287 | 1287 | Closed 1592 | ✅ rest = open |
| 8 | Left eyebrow | Lower 1677 | 1517 | Upper 1362 | ✅ reversed |
| 9 | Right eyebrow | Lower 1322 | 1537 | Upper 1670 | ✅ confirmed |
| 10 | Nose | Down 1366 | 1411 | Up 1500 | ⚠️ needs recheck |
| 11 | Jaw | Closed 1300 | 1300 | Open 1700 | ⚠️ needs recheck |
| 12 | Left forehead | Lower 1551 | 1471 | Upper 1396 | ✅ reversed |
| 13 | Right forehead | Lower 1490 | 1415 | Upper 1330 | ✅ reversed |
| 14 | Left cheek | Down 1700 | 1500 | Pulled 1300 | ⚠️ needs recheck |
| 15 | Right cheek | Down 1300 | 1500 | Pulled 1700 | ⚠️ needs recheck |

**Channels 0–7 are additionally stored in the controller's EEPROM** and survive
power loss and reflashing. On a blank chip the firmware seeds EEPROM from the
values compiled into `face_8_servo_uno.ino`. Verify what a board is actually
running with the `ALL` serial command.

> ⚠️ Channels 10, 11, 14, 15 are **not yet physically verified** on this build.
> Re-measure them per [`hardware/HEAD_CALIBRATION_WORKFLOW.md`](hardware/HEAD_CALIBRATION_WORKFLOW.md)
> before enabling expressions or animation.

---

## Setting up on a new device

### 1. Flash the firmware

Open `firmware/face_8_servo_uno/face_8_servo_uno.ino` in the Arduino IDE.

- **Board:** Arduino Nano (Processor: ATmega328P) or Arduino Uno
- Upload **with external servo power off**

Confirm over serial at **115200 baud**:

```
READY calibrated 16-servo face - outputs OFF
EYE CAL: S 0..7 select | ARM | + | - | M pulse
```

If you instead see `I2C FAULT: cut servo power and check wiring.`, the PCA9685 is
not answering — check SDA/SCL/VCC/GND and the address jumpers, then run
`firmware/pca9685_i2c_diagnostic` for a detailed report.

> Upload **flash only**. Never write the `.eep` file — that would overwrite the
> CH0–7 calibration stored in EEPROM.

### 2. Start the face control UI

Requires Python 3 and a **Chromium-based browser** (Chrome or Edge — Web Serial
is not available in Firefox or Safari).

```bash
python -m http.server 8765 --bind 127.0.0.1 --directory control_ui
```

Or run `START_HEAD_UI.bat` on Windows. Then open:

| Page | URL |
|---|---|
| Face control | http://127.0.0.1:8765/ |
| Easy eye/eyebrow calibrator (guided) | http://127.0.0.1:8765/easy-eye.html |
| Eye calibrator (CH0–7) | http://127.0.0.1:8765/eye-calibrator.html |
| Full 16-servo calibrator | http://127.0.0.1:8765/calibrator.html |

Click **Connect** and pick the board's serial port.

> **Only one program may own the serial port.** Close the Arduino Serial Monitor
> before connecting from the browser, and disconnect the browser before uploading
> firmware.

### 3. Start IRIS (voice) — optional

See [`voice/README.md`](voice/README.md) for the full guide. In short:

```bash
cd voice
python -m venv venv
venv\Scripts\pip install -r requirements.txt    # Windows
# venv/bin/pip install -r requirements.txt      # Linux/macOS
```

- Install [Ollama](https://ollama.com) and pull the model: `ollama pull qwen3:8b`
- Copy `voice/api_keys.json.example` → `voice/api_keys.json` and add your key
  (optional — Ollama alone works fully offline)
- Run `python voice/server.py`, then open http://127.0.0.1:8765/jarvis.html

Model weights (~1.7 GB) and the virtualenv are **not** in this repo; they download
on first run.

**Ports:** `8765` static UI · `8766` voice WebSocket · `11434` Ollama

---

## Serial protocol (115200 baud)

### Face control

| Command | Effect |
|---|---|
| `0` | Disable all PCA outputs — safest stop |
| `K<ch> <pulse>` | Disable other outputs, drive only this channel (calibration) |
| `C<ch> <pulse>` | Move one channel within limits, keeping the rest of the pose |
| `2` | Move all channels to saved rest/neutral |
| `1` | Start the onboard expression animation |
| `B1` / `B0` | Close / open all four eyelids |
| `E0`–`E3` | Both open · left wink · right wink · both closed |
| `A1` / `A0` | Enable / disable automatic blink |

Channels outside 0–15 and pulses outside each channel's compiled range are rejected.

### EEPROM eye calibration (CH0–7)

Type these into the Arduino Serial Monitor; values persist across reboots.

| Command | Effect |
|---|---|
| `S <ch>` | Select channel 0–7 (forces all outputs off first) |
| `ARM` | Energize **only** the selected channel at its rest pulse |
| `+` / `-` | Nudge ±5 µs |
| `M <pulse>` | Move to an absolute pulse (max 25 µs per step, 1000–2000 µs) |
| `A` / `R` / `B` | Record endpoint A / rest / endpoint B at the current pulse |
| `SHOW` / `ALL` | Print the selected channel / the full CH0–7 table |
| `SAVE` | Validate every record and write to EEPROM |
| `OFF` | All outputs off |
| `HELP` or `?` | Command summary |

`SAVE` refuses to write unless every channel passes validation: all pulses within
1000–2000 µs, endpoints at least 20 µs apart, and rest between the two endpoints.

---

## Repository layout

```
control_ui/          Browser UI (Web Serial — Chrome/Edge only)
  index.html app.js        Face control: sliders, expressions, camera face-following
  easy-eye.*               Guided calibration wizard (CH0–9)
  calibrator.*             Full 16-servo calibration workspace
  eye-calibrator.html      CH0–7 scoped calibrator
  jarvis.* orb.*           IRIS dashboard and orb view
  vendor/                  MediaPipe face landmarker (required for tracking)

voice/               IRIS assistant
  server.py                WebSocket server: STT, LLM, TTS, skills
  assistant.py             Always-on system-tray client
  skills.py                Head motion, laptop control, diagnostics
  memory.py training.py    Facts, trained Q&A, personality rules
  tasks_notes.py           Voice-first tasks and notes

firmware/
  face_8_servo_uno/        ★ The live sketch — 16 servos + EEPROM eye calibration
  pca9685_i2c_diagnostic/  Safe I2C test; never commands a servo position

hardware/            Calibration log, per-group procedures, wiring notes
```

### Not included in this repository

- **Digital twin** (`control_ui/twin/`) — deferred feature, ~94 MB
- **Voice model weights** and the Python virtualenv — download on first run
- **Personal IRIS memory** — conversation transcripts, learned facts, notes and
  tasks are private and regenerate on first run
- **Superseded firmware sketches** and generated Arduino build output
- `hardware/servo_inventory.csv` — an early superseded channel map; never use it

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `I2C FAULT` on boot | PCA9685 not answering. Check SDA (A4), SCL (A5), VCC, and the **common ground**; then run the I2C diagnostic. Often an intermittent wire, not a dead chip. |
| All servos move erratically | Broken common ground. Cut servo power, fully power down, re-make the ground, re-verify before re-powering. |
| Servos don't respond at all | Confirm the board is running the face firmware — check for the `READY` banner. A different sketch may have overwritten it. |
| "Access is denied" on the serial port | Another program owns it. Close the Serial Monitor or disconnect the browser tab. |
| No **Connect** button / Web Serial missing | Use Chrome or Edge. Firefox and Safari do not support Web Serial. |
| Calibration looks wrong after reflash | The board uses EEPROM values for CH0–7. Run `ALL` to see what it is actually using. |
| Eye moves the wrong way | Endpoint A/B direction labels are swapped for that channel — swap them in the calibration log and the UI's servo table. |
| IRIS gives no reply | Ollama not running or model missing: `ollama list` should show `qwen3:8b`. |

---

## License & credits

Based on the open-source [InMoov](https://inmoov.fr/) robot by Gaël Langevin.
Face tracking uses Google MediaPipe.

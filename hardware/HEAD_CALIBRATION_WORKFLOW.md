# InMoov head calibration workflow

Use this workflow whenever the head has been dismantled, stored, repaired, or
rewired. It is written for the current Arduino Uno + PCA9685 controller and the
local control page at http://127.0.0.1:8765/.

The values shown in the UI are commanded servo positions. They are not measured
physical angles. A saved browser draft does not update the Arduino firmware.

## Safety rules

1. Keep the external servo supply switched off while changing wiring or
   uploading firmware.
2. The Uno, PCA9685 and external servo supply must share ground.
3. Keep access to the servo-power switch during every movement test.
4. Stop immediately if a linkage reaches a hard stop, a servo buzzes strongly,
   a cable pulls tight, or a part bends.
5. Press **Outputs off** before touching a mechanism.
6. Calibrate only one channel at a time. Do not start animations, face tracking,
   auto blink, or expression loops until all individual channels pass.

## Phase 1 - mechanical and wiring inspection

- Servo horns and screws are secure.
- Linkages move freely by hand with servo power off.
- No printed part is cracked or rubbing another part.
- Servo plugs use signal on the PCA PWM row, red on V+, and brown/black on GND.
- Uno connections: 5V to VCC, GND to GND, A4 to SDA, A5 to SCL.
- External supply positive goes to PCA POWER+; supply negative goes to PCA
  POWER- and the common ground.
- PCA9685 address jumpers remain open for address `0x40`.

## Phase 2 - start the controller safely

1. Leave external servo power off.
2. Connect the Uno USB cable.
3. Open http://127.0.0.1:8765/ in Chrome or Edge.
4. Click **Connect Uno** and select the Arduino COM port.
5. Confirm that the page reports **Uno connected**. The firmware starts with all
   outputs off.
6. Switch on external servo power. Nothing should move until a command is sent.
7. If anything moves unexpectedly, switch servo power off and inspect wiring.

## Phase 3 - calibrate one servo

Repeat these steps for every channel in the order listed in Phase 4.

1. Find the servo card and press **Calibrate**.
2. The UI sends `0`, stopping animations and disabling all PCA outputs.
3. Check the displayed channel and allowed pulse range.
4. Start with the existing neutral/rest pulse and press **Move**. The `K` command
   activates only this servo; every other channel stays off.
5. Wait for the mechanism to settle and inspect it from the front and side.
6. Use **-5 us** or **+5 us** to approach the first useful endpoint slowly.
7. Stop before mechanical contact or strong buzzing. Move back to a comfortably
   unloaded position, then record the endpoint.
8. Move slowly through the center and record neutral/rest. Eyelids use open/rest
   instead of a separate neutral.
9. Approach and record the second endpoint in the same way.
10. Move back to neutral/rest once more and confirm that it is repeatable.
11. Press **Save draft**, then **Outputs off** before proceeding.

The calibrator refuses pulses outside the limits compiled into the current
firmware. If a mechanism needs travel outside that range, stop and review the
mechanical alignment and firmware limits before expanding it.

## Phase 4 - calibration order

| Step | Part | PCA channel | Current baseline |
|---:|---|---:|---|
| 1 | Left eye horizontal | 0 | Left 1300 / neutral 1477 / right 1700 |
| 2 | Left eye vertical | 1 | Up 1300 / neutral 1500 / down 1700 |
| 3 | Right eye horizontal | 2 | Left 1300 / neutral 1477 / right 1700 |
| 4 | Right eye vertical | 3 | Up 1700 / neutral 1522 / down 1300 |
| 5 | Left upper eyelid | 4 | Open 1322 / closed 1500 |
| 6 | Left lower eyelid | 5 | Open 1588 / closed 1411 |
| 7 | Right upper eyelid | 6 | Open 1655 / closed 1500 |
| 8 | Right lower eyelid | 7 | Open 1322 / closed 1500 |
| 9 | Left eyebrow | 8 | Lower 1677 / neutral 1500 / upper 1322 |
| 10 | Right eyebrow | 9 | Lower 1322 / neutral 1500 / upper 1700 |
| 11 | Nose | 10 | Down 1366 / neutral 1411 / up 1500 |
| 12 | Jaw | 11 | Closed/rest 1300 / fully open 1700 |
| 13 | Left forehead | 12 | Lower 1344 / neutral 1455 / upper 1700 |
| 14 | Right forehead | 13 | Lower 1611 / neutral 1566 / upper 1322 |
| 15 | Left cheek | 14 | Down 1700 / neutral 1500 / pulled 1300 |
| 16 | Right cheek | 15 | Down 1300 / neutral 1500 / pulled 1700 |

The right-eye vertical, left eyebrow, right forehead, left cheek and several
eyelid mechanisms are mechanically reversed. Reversed pulse order is expected.

## Phase 5 - export and apply the results

1. After all channels are recorded, press **Export all drafts**.
2. Keep the downloaded `inmoov-calibration-drafts.json` with the dated
   calibration record.
3. Review the values before editing code. Update both:
   - `firmware/face_8_servo_uno/face_8_servo_uno.ino`
   - `control_ui/app.js`
4. Compile the firmware and check every minimum, neutral/rest and maximum value.
5. Switch external servo power off and upload the firmware to the Uno.
6. Reconnect the UI. Do not send an automatic movement command on reconnect.

## Phase 6 - validation sequence

Run these tests in order and stop at the first problem:

1. Individual neutral/rest for CH0 through CH15.
2. Individual endpoint movement for every channel.
3. Left eye pair, then right eye pair, then both eyes together.
4. Each eyelid separately; then left wink, right wink and synchronized blink.
5. Eyebrows and forehead together.
6. Nose, jaw and each cheek separately.
7. **All neutral**.
8. One named facial expression.
9. Auto blink.
10. Expression loop.
11. Camera face following.

Only proceed to the next test when the previous test is smooth, quiet, repeatable
and free from mechanical contact.

## Fault recovery

- **Strong buzz or hard stop:** switch servo power off, press **Outputs off**, and
  reduce the endpoint before retesting.
- **I2C FAULT:** switch servo power off; check PCA VCC, common ground, SDA, SCL,
  loose connectors and the `0x40` address configuration; then reset the Uno.
- **No Arduino COM port:** reconnect USB, try another data-capable USB cable or
  USB port, and recheck Windows Device Manager.
- **Website unavailable:** from `U:\inmoov`, run
  `py -m http.server 8765 --bind 127.0.0.1 --directory control_ui`.
- **Wrong movement direction:** record the real mechanical direction; do not
  assume increasing pulse always means up or right.


# Eye mechanism calibration

User-confirmed values, 2026-09-12. The position scale is the existing
calibration scale, not measured physical degrees.

| Servo number | PCA9685 channel | Movement | Neutral position | Safe range |
| ---: | ---: | --- | ---: | --- |
| 0 | 0 | Left eye horizontal (left/right) | 80 | 0–180 |
| 1 | 1 | Left eye vertical (up/down) | 90 | 0–180 |
| 2 | 2 | Right eye horizontal (left/right) | 80 | 0–180 |
| 3 | 3 | Right eye vertical (up/down) | 100 | 0–180 |

The eye calibration sketch uses command numbers 1–4 for servo numbers 0–3:
`1 80`, `2 90`, `3 80`, and `4 100` are the neutral commands. The saved
endpoint range is 0–180 for each servo. Limits should still be approached
slowly with the assembled mechanism and stopped before mechanical resistance.

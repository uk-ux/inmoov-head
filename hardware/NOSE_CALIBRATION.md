# Nose calibration

User-confirmed calibration for one up/down nose servo on PCA9685 channel 10.

| Position | Pulse |
| --- | --- |
| Lower / nose down | 1366 us |
| Neutral | 1411 us |
| Upper / nose up | 1500 us |

```csv
servo,channel,lower_us,neutral_us,upper_us
1,10,1366,1411,1500
```

Use 1366–1500 us for subsequent calibrated nose motion, with neutral at 1411 us.
Values are pulse widths, not physical angles.

Calibration sketch: `firmware/nose_calibrator_uno/nose_calibrator_uno.ino`.
Integrated into `firmware/face_8_servo_uno/face_8_servo_uno.ino` and
`control_ui/app.js`: nose slider uses CH10, neutral 1411 us, range 1366–1500 us.
The historical firmware folder name now contains the 13-servo controller.

# Jaw and cheek calibration — 2026-09-16

Confirmed by the user using the Uno calibrator, where positions 0–180 map
to 1300–1700 microseconds. These are not measured physical angles.

| Part | PCA channel | Lower/down | Neutral | Upper/up |
| --- | --- | --- | --- | --- |
| Jaw | 11 | 1700 us (fully open) | 1300 us (closed) | 1300 us (closed) |
| Left cheek | 14 | 1700 us | 1500 us | 1300 us |
| Right cheek | 15 | 1300 us | 1500 us | 1700 us |

```csv
servo,channel,lower_us,neutral_us,upper_us
1,11,1700,1300,1300
2,14,1700,1500,1300
3,15,1300,1500,1700
```

Cheek rows were supplied directly by the user. Jaw row is derived from their
confirmed positions: 0 closed/neutral, 90 half open, 180 fully open, using the
current calibrator's mapping. Jaw half-open pulse is 1500 us.

Lower and upper describe physical movement, not numeric pulse order. The cheek
directions are mirrored. Use these exact directions in future UI integration.

Calibrator: `firmware/jaw_cheek_calibrator_uno/jaw_cheek_calibrator_uno.ino`.
Simple commands: `1 90`, `2 90`, `3 90`; servo number plus N/D/U saves neutral,
down or up; P prints; X disables all outputs. Serial 115200 baud, Newline.

Jaw and cheeks are now integrated into the combined `face_8_servo_uno` source
and control UI with manual sliders and neutral buttons. Compilation and calibration
consistency checks passed. The new 16-servo firmware was uploaded successfully
to COM9 on 2026-09-16 after the initial blocked attempt. Follow my face now
maps mouth opening to jaw and smile/squint/frown scores to the two cheeks.

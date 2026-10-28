# Confirmed eyebrow and forehead neutral positions

User-confirmed positions for the current assembled mechanism. Command positions
are calibration values, not measured physical degrees. Use pulse widths when
transferring calibration to later firmware.

| Joint | PCA9685 channel | Command | Neutral pulse | Confirmation |
| --- | --- | --- | --- | --- |
| Left eyebrow | 8 | `1 90` | 1500 us | EEPROM table supplied by user, 2026-09-15 |
| Right eyebrow | 9 | `2 90` | 1500 us | EEPROM table supplied by user, 2026-09-15 |
| Left forehead | 12 | `3 70` approx. | 1455 us | EEPROM table supplied by user, 2026-09-15 |
| Right forehead | 13 | `4 120` approx. | 1566 us | EEPROM table supplied by user, 2026-09-15 |

Latest status: original channels restored. User reports changed safe limits;
whether neutrals also changed remains unanswered. Recheck before animation.

Lower and upper mechanical limits remain unconfirmed. Existing 1500 us defaults
in the servo inventory do not confirm neutral positions for the other joints.

The current firmware maps command `2 40` to 1388 us. Its integer conversion
back to a displayed position reports 39; sending `2 39` would instead request
1386 us. Preserve 1388 us as the confirmed right-eyebrow neutral.

The exact EEPROM pulse values supplied on 2026-09-15 supersede all earlier
neutral estimates. Pulse widths are authoritative; command positions are only
approximate because integer mapping and display rounding can differ.

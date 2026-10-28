# Eyelid calibration

Updated 2026-09-17 from the user's new calibration table. Eyelids use only
open/rest and closed positions; the supplied middle/neutral column is ignored.

| Servo | Channel | Eyelid | Open/rest pulse | Closed pulse |
| ---: | ---: | --- | ---: | ---: |
| 1 | 4 | Left upper | 1322 us | 1500 us |
| 2 | 5 | Left lower | 1588 us | 1411 us |
| 3 | 6 | Right upper | 1655 us | 1500 us |
| 4 | 7 | Right lower | 1322 us | 1500 us |

Values are microseconds, not physical degrees. Open positions are also normal
rest positions. No separate neutral is used. Source rows received:
`1,4,1322,1322,1500`, `2,5,1588,1700,1411`, `3,6,1655,0,1500`,
`4,7,1322,0,1500`; first and last pulse columns were applied.

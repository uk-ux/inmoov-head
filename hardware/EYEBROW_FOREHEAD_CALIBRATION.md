# Eyebrow and Forehead Calibration

## Arduino Uno wiring

| Arduino Uno | PCA9685 |
| --- | --- |
| `5V` | `VCC` |
| `GND` | `GND` |
| `A4 / SDA` | `SDA` |
| `A5 / SCL` | `SCL` |

Use `firmware/eyebrow_forehead_calibrator_uno/eyebrow_forehead_calibrator_uno.ino`
and select `Arduino Uno` in Arduino IDE. Servo power still comes from the
separate regulated supply connected to PCA9685 `V+` and `GND`.

The Uno sketch uses only Arduino's built-in `Wire` library. It does not require
the Adafruit PWM Servo Driver Library.

## Channel map

| Selection | PCA9685 channel | Mechanism |
| ---: | ---: | --- |
| 1 | 8 | Robot's left eyebrow |
| 2 | 9 | Robot's right eyebrow |
| 3 | 12 | Robot's left forehead |
| 4 | 13 | Robot's right forehead |

Robot left and right are from the robot's point of view.

## Mechanical centring

Perform this on one servo at a time.

1. Keep the facial skin removed.
2. Remove the printed lever and servo horn from the servo spline, or disconnect
   the linkage so the servo can turn without loading the mechanism.
3. Upload
   `firmware/eyebrow_forehead_calibrator_uno/eyebrow_forehead_calibrator_uno.ino`.
4. Open Serial Monitor at 115200 baud and select `No line ending`.
5. Prefix every command with `#`. For example, type `#1` to select the left
   eyebrow and then type `#c`. The selected servo receives a 1500 us pulse; all
   other PCA9685 outputs remain off.
6. Switch servo power off while leaving the servo at that electrical centre.
7. Refit the horn at the nearest neutral mechanical position. The paired parts
   should have equal height and clearance.
8. Restore servo power, select the servo again, and type `#c` to check neutral.

## Finding limits

You can enter positions directly:

- `#a90` sets the selected servo to approximately 90 degrees.
- `#a80` and `#a100` set approximately 80 and 100 degrees.
- `#m1500` sets an exact 1500 us pulse.
- Angle input is restricted to 0-180, mapped into the guarded 1300-1700 us
  pulse range.
- Direct pulse input is restricted to 1300-1700 us.

1. Starting at centre, type `#+` repeatedly. Each command changes the pulse by
   only 5 us.
2. Stop before collision, binding, servo noise, visible twisting or excessive
   skin tension. Back away 15-25 us from that point and record it with `#u`.
3. Type `#c` to return to centre.
4. Repeat using `#-`. Back away 15-25 us from the other endpoint and record it
   with `#l`.
5. Adjust the visually neutral position with `#+` or `#-` and record it with
   `#r`.
6. Type `#p` and copy the printed lower, rest and upper values into
   `hardware/servo_inventory.csv`.
7. Type `#x` before disconnecting or adjusting a servo.

The prefix prevents text echoed from the Uno transmit pin back into its receive
pin from being interpreted as a motion command. Pins `0/RX` and `1/TX` must
still be left disconnected during calibration.

The lower and upper names refer to pulse width, not facial direction. A mirrored
servo may raise an eyebrow when pulse width decreases.

The sketch enforces a temporary 1300-1700 us guard. Reaching that guard does
not prove that the mechanism is safe there. The mechanical endpoint always has
priority.

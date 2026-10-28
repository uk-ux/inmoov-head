# InMoov Head: Arduino Mega 2560 + PCA9685

## First-stage scope

Build and verify the controller on a table with only one loose servo. Do not
connect the assembled head mechanisms during this stage.

The identified build is an InMoov i2Head. See `I2_HEAD_HARDWARE_PLAN.md` for
the 17-servo actuator map. The PCA9685 carries the 15 facial servos; the two
high-torque servo signals are assigned to Mega pins D44 and D45.

## Parts

- Arduino Mega 2560
- PCA9685 16-channel PWM/servo board, default I2C address `0x40`
- Regulated servo supply whose voltage matches the servo rating
- Inline fuse and accessible servo-power emergency switch
- Screw-terminal power distribution suitable for the expected current
- Electrolytic capacitor rated above the servo-supply voltage (size it after
  the servo inventory; `number of servos * 100 uF` is only a starting point)
- Multimeter
- USB cable and short I2C jumper wires

The final supply and fuse ratings must be selected after recording every servo
model and its stall current. Do not size them from servo count alone.

## Wiring

Connect everything while USB and servo power are disconnected.

| Arduino Mega 2560 | PCA9685 | Purpose |
| --- | --- | --- |
| `5V` | `VCC` | PCA9685 logic power only |
| `GND` | `GND` | Common signal reference |
| `20 / SDA` | `SDA` | I2C data |
| `21 / SCL` | `SCL` | I2C clock |

Connect the servo supply separately:

| Servo supply | Destination |
| --- | --- |
| Positive | Fuse -> emergency switch -> PCA9685 `V+` |
| Negative | PCA9685 `GND` and Arduino `GND` |

On a PCA9685 servo channel, the usual connector order is signal, positive, and
ground, but verify the markings printed on the actual board before inserting a
servo. Servo wire colours are not reliable enough to use as the only guide.

```text
Laptop USB --> Arduino Mega
                  |
                  +-- 5V  ----------> PCA9685 VCC (logic only)
                  +-- GND ----------> PCA9685 GND
                  +-- SDA / pin 20 -> PCA9685 SDA
                  +-- SCL / pin 21 -> PCA9685 SCL

Regulated servo PSU + --> fuse --> emergency switch --> PCA9685 V+
Regulated servo PSU - --------------------------------> common GND

PCA9685 channel 0 --> one loose test servo
```

Never connect the servo supply positive terminal to the Mega `5V` pin. The
grounds must be common, but the positive power paths stay separate.

For a full head, use appropriate fused power distribution rather than assuming
that thin jumpers or one small board terminal can safely carry the combined
stall current of all servos.

## Safe bring-up sequence

1. Leave every servo unplugged and leave servo power off.
2. Check for a short between `V+` and `GND` with a multimeter.
3. Connect Mega USB only and upload the bench-test sketch.
4. Open Serial Monitor at `115200` baud. It should find `0x40`.
5. Disconnect USB. Set and measure the external supply voltage before attaching
   it to the PCA9685.
6. Apply servo power with no servo connected and measure `V+` to `GND` on the
   PCA9685.
7. Switch servo power off. Plug one mechanically disconnected servo into
   channel 0 and keep its horn/linkage removed.
8. Restore power and type `n` in Serial Monitor to request a 1500 us centre
   pulse. Use `+` or `-` only for small 10 us adjustments.
9. Type `x` to stop the PWM signal before disconnecting the servo.

Stop immediately if a servo chatters, becomes hot, draws excessive current, or
tries to drive against a stop.

## Arduino software requirement

Install the `Adafruit PWM Servo Driver Library` through Arduino IDE Library
Manager before compiling `pca9685_bench_test.ino`.

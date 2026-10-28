#include <Wire.h>

// PCA9685 communication test for Arduino Uno.
// Uno A4 -> PCA SDA, A5 -> PCA SCL, 5V -> PCA VCC, GND -> PCA GND.
// Keep the external servo supply OFF while running this diagnostic.
// This sketch never sends a servo position. When the PCA answers, it forces
// the PCA9685 ALL_LED output into full-off mode.

const uint8_t PCA_ADDRESS = 0x40;
const uint8_t MODE1 = 0x00;
const uint8_t MODE2 = 0x01;
const uint8_t PRESCALE = 0xFE;
const uint8_t ALL_LED_ON_L = 0xFA;
const uint8_t ALL_LED_ON_H = 0xFB;
const uint8_t ALL_LED_OFF_L = 0xFC;
const uint8_t ALL_LED_OFF_H = 0xFD;

unsigned long nextTest = 0;
unsigned long testNumber = 0;

uint8_t ping(uint8_t address) {
  Wire.clearWireTimeoutFlag();
  Wire.beginTransmission(address);
  return Wire.endTransmission();
}

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.clearWireTimeoutFlag();
  Wire.beginTransmission(PCA_ADDRESS);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0 && !Wire.getWireTimeoutFlag();
}

bool readRegister(uint8_t reg, uint8_t &value) {
  Wire.clearWireTimeoutFlag();
  Wire.beginTransmission(PCA_ADDRESS);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0 || Wire.getWireTimeoutFlag()) return false;
  if (Wire.requestFrom(PCA_ADDRESS, (uint8_t)1) != 1) return false;
  value = Wire.read();
  return true;
}

bool forceAllOutputsOff() {
  return writeRegister(ALL_LED_ON_L, 0x00) &&
         writeRegister(ALL_LED_ON_H, 0x00) &&
         writeRegister(ALL_LED_OFF_L, 0x00) &&
         writeRegister(ALL_LED_OFF_H, 0x10);
}

void printHexByte(uint8_t value) {
  if (value < 0x10) Serial.print('0');
  Serial.print(value, HEX);
}

void runTest() {
  ++testNumber;
  Serial.println();
  Serial.print(F("TEST "));
  Serial.println(testNumber);
  Serial.print(F("SDA(A4): "));
  Serial.println(digitalRead(A4) ? F("HIGH") : F("LOW"));
  Serial.print(F("SCL(A5): "));
  Serial.println(digitalRead(A5) ? F("HIGH") : F("LOW"));

  const uint8_t status = ping(PCA_ADDRESS);
  if (Wire.getWireTimeoutFlag()) {
    Serial.println(F("RESULT: FAIL - I2C bus timeout"));
    Serial.println(F("Check for SDA/SCL short circuit or swapped wires."));
    return;
  }

  if (status != 0) {
    Serial.print(F("RESULT: FAIL - PCA9685 did not answer at 0x40; Wire status "));
    Serial.println(status);
    if (status == 2) Serial.println(F("Status 2: check VCC, GND, SDA, SCL and address jumpers."));
    else if (status == 3) Serial.println(F("Status 3 means data NACK."));
    else if (status == 4) Serial.println(F("Status 4 means another I2C error."));
    return;
  }

  Serial.println(F("PCA9685 FOUND at address 0x40"));
  if (!forceAllOutputsOff()) {
    Serial.println(F("RESULT: FAIL - PCA answered but outputs-off write failed."));
    return;
  }

  uint8_t mode1 = 0, mode2 = 0, prescale = 0;
  if (!readRegister(MODE1, mode1) ||
      !readRegister(MODE2, mode2) ||
      !readRegister(PRESCALE, prescale)) {
    Serial.println(F("RESULT: FAIL - PCA answered but register read failed."));
    return;
  }

  Serial.print(F("MODE1=0x")); printHexByte(mode1);
  Serial.print(F("  MODE2=0x")); printHexByte(mode2);
  Serial.print(F("  PRESCALE=0x")); printHexByte(prescale);
  Serial.println();
  Serial.println(F("ALL 16 OUTPUTS FORCED OFF"));
  Serial.println(F("RESULT: PASS - PCA9685 communication is working"));
}

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(100000);
  Wire.setWireTimeout(25000, true);
  delay(1000);
  Serial.println(F("PCA9685 SAFE DIAGNOSTIC"));
  Serial.println(F("External servo power must remain OFF."));
  Serial.println(F("Testing address 0x40 every 2 seconds."));
  runTest();
  nextTest = millis() + 2000;
}

void loop() {
  if ((long)(millis() - nextTest) >= 0) {
    runTest();
    nextTest = millis() + 2000;
  }
}

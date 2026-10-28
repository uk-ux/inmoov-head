#include <Wire.h>
#include <EEPROM.h>

// Uno A4=SDA, A5=SCL. PCA VCC from Uno 5V; servo V+ from external supply.
// Commands at 115200 baud: 1=animate, 2=neutral, 0=all outputs off.
// B1 closes all four eyelids together; B0 opens all four together.
// Uses exact saved pulse values for the calibrated mechanisms.
const uint8_t PCA = 0x40;
const uint8_t SERVO_COUNT = 16;
const uint8_t CH[SERVO_COUNT] = {0,1,2,3,4,5,6,7,8,9,12,13,10,11,14,15};
// Order: left-eye horizontal/vertical, right-eye horizontal/vertical,
// left/right eyebrow, left/right forehead.
int NEUTRAL_US[SERVO_COUNT] = {1412,1545,1482,1472,1367,1623,1520,1287,1517,1537,1471,1415,1411,1300,1500,1500};
int MINIMUM_US[SERVO_COUNT] = {1072,1375,1257,1187,1367,1453,1420,1287,1362,1322,1396,1330,1366,1300,1300,1300};
int MAXIMUM_US[SERVO_COUNT] = {1877,1715,1742,1742,1527,1623,1520,1592,1677,1670,1551,1490,1500,1700,1700,1700};
int LID_CLOSED_US[4] = {1527,1453,1420,1592};

// Eye calibration is entered directly in the Uno USB Serial Monitor. The Uno
// drives one PCA9685 channel at a time and stores the final values in EEPROM.
const uint32_t EYE_CAL_MAGIC=0x45594538UL;
const uint8_t EYE_CAL_VERSION=2;
struct EyeChannelCalibration { int16_t endpointA,rest,endpointB; };
struct EyeCalibrationStore {
  uint32_t magic;
  uint8_t version;
  EyeChannelCalibration channel[8];
};
EyeCalibrationStore savedEyeCalibration,workingEyeCalibration;
bool eyeCalibrationLoaded=false,eyeCalibrationArmed=false;
int8_t selectedEyeChannel=-1;
int eyeCalibrationPulse=1500;

bool validEyeRecord(const EyeChannelCalibration &c){
  if(c.endpointA<1000||c.endpointA>2000||c.rest<1000||c.rest>2000||c.endpointB<1000||c.endpointB>2000)return false;
  if(abs(c.endpointA-c.endpointB)<20)return false;
  int low=min(c.endpointA,c.endpointB),high=max(c.endpointA,c.endpointB);
  return c.rest>=low&&c.rest<=high;
}
void applyEyeCalibration(const EyeCalibrationStore &data){
  for(uint8_t ch=0;ch<8;ch++){
    const EyeChannelCalibration &c=data.channel[ch];
    NEUTRAL_US[ch]=c.rest;
    MINIMUM_US[ch]=min(c.endpointA,c.endpointB);
    MAXIMUM_US[ch]=max(c.endpointA,c.endpointB);
    if(ch>=4)LID_CLOSED_US[ch-4]=c.endpointB;
  }
}
void loadEyeCalibration(){
  EEPROM.get(0,savedEyeCalibration);
  bool valid=savedEyeCalibration.magic==EYE_CAL_MAGIC&&savedEyeCalibration.version==EYE_CAL_VERSION;
  for(uint8_t ch=0;ch<8&&valid;ch++)valid=validEyeRecord(savedEyeCalibration.channel[ch]);
  if(valid){applyEyeCalibration(savedEyeCalibration);workingEyeCalibration=savedEyeCalibration;eyeCalibrationLoaded=true;Serial.println(F("EYE CALIBRATION LOADED FROM EEPROM"));return;}
  const int endpointA[8]={1072,1715,1257,1742,1367,1623,1520,1287};
  const int endpointB[8]={1877,1375,1742,1187,1527,1453,1420,1592};
  workingEyeCalibration.magic=EYE_CAL_MAGIC;workingEyeCalibration.version=EYE_CAL_VERSION;
  for(uint8_t ch=0;ch<8;ch++)workingEyeCalibration.channel[ch]={(int16_t)endpointA[ch],(int16_t)NEUTRAL_US[ch],(int16_t)endpointB[ch]};
  savedEyeCalibration=workingEyeCalibration;applyEyeCalibration(savedEyeCalibration);EEPROM.put(0,savedEyeCalibration);eyeCalibrationLoaded=true;
  Serial.println(F("EYE CALIBRATION INITIALIZED FROM FIRMWARE"));
}
bool autoBlink=false, lidsOverride=false, lidsClosed=false;
int current[SERVO_COUNT], fromPose[SERVO_COUNT], target[SERVO_COUNT];
int lidFrom[4], lidCurrent[4], lidTarget[4];
unsigned long lidStarted[2]={0,0}, nextBlink=0;
uint8_t lidMask=0;
void setEyes(uint8_t mask){
  for(uint8_t eye=0;eye<2;eye++){
    if(lidsOverride&&((mask^lidMask)&(1<<eye))==0)continue;
    for(uint8_t j=eye*2;j<eye*2+2;j++){
      lidFrom[j]=lidsOverride?lidCurrent[j]:current[j+4];
      lidCurrent[j]=lidFrom[j];lidTarget[j]=(mask&(1<<eye))?LID_CLOSED_US[j]:NEUTRAL_US[j+4];
    }
    lidStarted[eye]=millis();
  }
  lidMask=mask;lidsClosed=mask==3;lidsOverride=true;
}
void blink(bool closeLids){setEyes(closeLids?3:0);}
uint16_t previousTicks[SERVO_COUNT] = {0};
bool ready=false, enabled=false, running=false, moving=false, returning=false;
unsigned long started=0, travel=700, hold=1200, nextMove=0, frame=0;
char commandLine[32];
uint8_t commandLength=0;
bool discardCommand=false;
unsigned long lastCommandByte=0;
void fault();

bool writeReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(PCA); Wire.write(reg); Wire.write(value);
  return Wire.endTransmission()==0;
}
bool pwm(uint8_t ch, uint16_t ticks) {
  Wire.beginTransmission(PCA); Wire.write(0x06+4*ch);
  Wire.write((uint8_t)0); Wire.write((uint8_t)0);
  Wire.write((uint8_t)(ticks&255)); Wire.write((uint8_t)(ticks>>8));
  return Wire.endTransmission()==0;
}
bool off() {
  enabled=false; running=false; moving=false;
  autoBlink=false;lidsOverride=false;eyeCalibrationArmed=false;
  bool ok=true; for(uint8_t i=0;i<16;++i) if(!pwm(i,4096)) ok=false;
  for(uint8_t i=0;i<SERVO_COUNT;++i) previousTicks[i]=0;
  return ok;
}

void showEyeCalibrationHelp(){
  Serial.println(F("EYE CAL: S 0..7 select | ARM | + | - | M pulse"));
  Serial.println(F("A endpoint-A | R rest | B endpoint-B | SHOW | ALL | SAVE | OFF"));
}
void showSelectedEyeCalibration(){
  if(selectedEyeChannel<0){Serial.println(F("No eye channel selected"));return;}
  EyeChannelCalibration &c=workingEyeCalibration.channel[selectedEyeChannel];
  Serial.print(F("CH"));Serial.print(selectedEyeChannel);Serial.print(F(" A="));Serial.print(c.endpointA);
  Serial.print(F(" REST="));Serial.print(c.rest);Serial.print(F(" B="));Serial.print(c.endpointB);
  Serial.print(F(" CURRENT="));Serial.print(eyeCalibrationPulse);Serial.println(eyeCalibrationArmed?F(" ARMED"):F(" OFF"));
}
void showAllEyeCalibration(){
  Serial.println(F("CH,endpointA_us,rest_us,endpointB_us"));
  for(uint8_t ch=0;ch<8;ch++){
    EyeChannelCalibration &c=workingEyeCalibration.channel[ch];
    Serial.print(ch);Serial.print(',');Serial.print(c.endpointA);Serial.print(',');Serial.print(c.rest);Serial.print(',');Serial.println(c.endpointB);
  }
}
void selectEyeCalibrationChannel(int ch){
  if(ch<0||ch>7){Serial.println(F("REJECTED: select CH0 through CH7"));return;}
  if(!off()){fault();return;}selectedEyeChannel=ch;eyeCalibrationPulse=workingEyeCalibration.channel[ch].rest;
  Serial.print(F("SELECTED CH"));Serial.print(ch);Serial.println(F("; outputs OFF; type ARM"));
}
void armEyeCalibration(){
  if(!ready){Serial.println(F("REJECTED: PCA not ready"));return;}
  if(selectedEyeChannel<0){Serial.println(F("Select with S 0 through S 7 first"));return;}
  if(!off()){fault();return;}eyeCalibrationPulse=workingEyeCalibration.channel[selectedEyeChannel].rest;
  if(!pwm(selectedEyeChannel,((long)eyeCalibrationPulse*4096+10000)/20000)){fault();return;}
  eyeCalibrationArmed=true;Serial.print(F("ARMED CH"));Serial.print(selectedEyeChannel);Serial.print(F(" at "));Serial.print(eyeCalibrationPulse);Serial.println(F("us; only this PCA channel is active"));
}
void moveEyeCalibration(int requestedPulse){
  if(!eyeCalibrationArmed||selectedEyeChannel<0){Serial.println(F("REJECTED: select and ARM first"));return;}
  if(requestedPulse<1000||requestedPulse>2000){Serial.println(F("REJECTED: absolute range 1000-2000us"));return;}
  if(abs(requestedPulse-eyeCalibrationPulse)>25){Serial.println(F("REJECTED: maximum step 25us; use + or -"));return;}
  eyeCalibrationPulse=requestedPulse;
  if(!pwm(selectedEyeChannel,((long)eyeCalibrationPulse*4096+10000)/20000)){fault();return;}
  Serial.print(F("CH"));Serial.print(selectedEyeChannel);Serial.print(F(" = "));Serial.print(eyeCalibrationPulse);Serial.println(F("us"));
}
void recordEyeCalibration(char point){
  if(!eyeCalibrationArmed||selectedEyeChannel<0){Serial.println(F("REJECTED: move and inspect first"));return;}
  EyeChannelCalibration &c=workingEyeCalibration.channel[selectedEyeChannel];
  if(point=='A')c.endpointA=eyeCalibrationPulse;else if(point=='R')c.rest=eyeCalibrationPulse;else c.endpointB=eyeCalibrationPulse;
  Serial.print(F("RECORDED CH"));Serial.print(selectedEyeChannel);Serial.print(' ');Serial.print(point);Serial.print(F(" = "));Serial.print(eyeCalibrationPulse);Serial.println(F("us"));
}
void saveEyeCalibration(){
  for(uint8_t ch=0;ch<8;ch++)if(!validEyeRecord(workingEyeCalibration.channel[ch])){
    Serial.print(F("REJECTED: invalid CH"));Serial.println(ch);return;
  }
  if(!off()){fault();return;}workingEyeCalibration.magic=EYE_CAL_MAGIC;workingEyeCalibration.version=EYE_CAL_VERSION;
  savedEyeCalibration=workingEyeCalibration;applyEyeCalibration(savedEyeCalibration);EEPROM.put(0,savedEyeCalibration);eyeCalibrationLoaded=true;
  Serial.println(F("EYE CALIBRATION SAVED IN UNO EEPROM; outputs OFF"));
}
bool handleEyeCalibrationCommand(){
  if(commandLine[0]=='S'&&commandLine[1]==' '){selectEyeCalibrationChannel(atoi(commandLine+2));return true;}
  if(strcmp(commandLine,"ARM")==0){armEyeCalibration();return true;}
  if(strcmp(commandLine,"+")==0){moveEyeCalibration(eyeCalibrationPulse+5);return true;}
  if(strcmp(commandLine,"-")==0){moveEyeCalibration(eyeCalibrationPulse-5);return true;}
  if(commandLine[0]=='M'&&commandLine[1]==' '){moveEyeCalibration(atoi(commandLine+2));return true;}
  if(commandLength==1&&(commandLine[0]=='A'||commandLine[0]=='R'||commandLine[0]=='B')){recordEyeCalibration(commandLine[0]);return true;}
  if(strcmp(commandLine,"SHOW")==0){showSelectedEyeCalibration();return true;}
  if(strcmp(commandLine,"ALL")==0){showAllEyeCalibration();return true;}
  if(strcmp(commandLine,"SAVE")==0){saveEyeCalibration();return true;}
  if(strcmp(commandLine,"OFF")==0){if(!off())fault();else Serial.println(F("OFF"));return true;}
  if(strcmp(commandLine,"HELP")==0||strcmp(commandLine,"?")==0){showEyeCalibrationHelp();return true;}
  return false;
}
void fault() { ready=false; off(); Serial.println(F("I2C FAULT: cut servo power and check wiring.")); }
bool sendPose() {
  if(lidsOverride){
    for(uint8_t j=0;j<4;j++){
      float t=min(1.0f,(float)(millis()-lidStarted[j/2])/80.0f);
      float e=t*t*(3-2*t);
      lidCurrent[j]=lidFrom[j]+(int)((lidTarget[j]-lidFrom[j])*e);current[j+4]=lidCurrent[j];
    }
  }
  for(uint8_t i=0;i<SERVO_COUNT;++i) {
    current[i]=constrain(current[i],MINIMUM_US[i],MAXIMUM_US[i]);
    uint16_t ticks=((long)current[i]*4096+10000)/20000;
    if(ticks!=previousTicks[i]) { if(!pwm(CH[i],ticks)){fault();return false;} previousTicks[i]=ticks; }
  }
  return true;
}
void moveTo(const int pose[SERVO_COUNT], unsigned long ms, unsigned long pause) {
  for(uint8_t i=0;i<SERVO_COUNT;++i){fromPose[i]=current[i];target[i]=pose[i];}
  started=millis(); travel=ms; hold=pause; moving=true;
}
void neutralMove() { moveTo(NEUTRAL_US,500,1800); returning=true; }
void expression() {
  // Last three entries: jaw CH11, left cheek CH14, right cheek CH15.
  // Cheek lift uses decreasing left pulses and increasing right pulses.
  // Each expression returns to closed jaw / relaxed cheeks through neutralMove.
  const int poses[5][SERVO_COUNT] = {
    {1422,1500,1422,1522,1367,1623,1520,1287,1362,1670,1396,1330,1411,1420,1360,1640}, // attentive smile
    {1555,1495,1555,1527,1367,1623,1520,1287,1362,1322,1396,1490,1411,1480,1400,1680}, // smiling glance right
    {1400,1504,1400,1518,1367,1623,1520,1287,1677,1670,1551,1330,1411,1380,1640,1360}, // concerned glance left
    {1477,1433,1477,1589,1367,1623,1520,1287,1362,1670,1396,1330,1460,1620,1420,1580}, // open-mouth surprise
    {1511,1544,1444,1478,1367,1623,1520,1287,1677,1670,1551,1330,1388,1360,1360,1440}  // asymmetric skeptical expression
  };
  moveTo(poses[random(0,5)],random(450,701),random(700,1801));
  returning=true;
}
void command() {
  if(discardCommand||commandLength==0)return;
  commandLine[commandLength]='\0';
  for(uint8_t i=0;i<commandLength;i++)if(commandLine[i]>='a'&&commandLine[i]<='z')commandLine[i]-=('a'-'A');
  if(handleEyeCalibrationCommand())return;
  if(commandLength==1&&commandLine[0]=='0'){if(!off())fault();else Serial.println(F("OFF"));return;}
  // Auto blink runs on the Uno, independent of browser timer throttling.
  // E0 both open; E1 left wink; E2 right wink; E3 both closed.
  if(commandLength==2&&commandLine[0]=='E'&&commandLine[1]>='0'&&commandLine[1]<='3'){
    if(!ready)return;
    if(!enabled){for(uint8_t i=0;i<SERVO_COUNT;i++)current[i]=NEUTRAL_US[i];if(!sendPose())return;enabled=true;}
    autoBlink=false;setEyes(commandLine[1]-'0');return;
  }
  if(commandLength==2&&commandLine[0]=='A'&&(commandLine[1]=='0'||commandLine[1]=='1')){
    if(!ready)return;
    if(!enabled){for(uint8_t i=0;i<SERVO_COUNT;i++)current[i]=NEUTRAL_US[i];if(!sendPose())return;enabled=true;}
    autoBlink=commandLine[1]=='1';blink(false);nextBlink=millis()+random(2500,5501);
    Serial.println(autoBlink?F("AUTO BLINK ON"):F("AUTO BLINK OFF"));return;
  }
  if(commandLength==2&&(commandLine[0]=='B'||commandLine[0]=='b')&&
     (commandLine[1]=='0'||commandLine[1]=='1')) {
    if(!ready)return;
    if(!enabled){for(uint8_t i=0;i<SERVO_COUNT;++i)current[i]=NEUTRAL_US[i];if(!sendPose())return;enabled=true;}
    const bool closeLids=commandLine[1]=='1';
    autoBlink=false;blink(closeLids);
    Serial.println(closeLids?F("BLINK CLOSED"):F("BLINK OPEN"));
    return;
  }
  if(commandLength>=6&&(commandLine[0]=='C'||commandLine[0]=='c'||commandLine[0]=='K')) {
    if(!ready)return;
    uint8_t p=1; int requestedChannel=0; bool channelDigit=false;
    while(p<commandLength&&commandLine[p]>='0'&&commandLine[p]<='9'){
      channelDigit=true;requestedChannel=requestedChannel*10+commandLine[p++]-'0';
    }
    if(!channelDigit||p>=commandLength||commandLine[p++]!=' ')return;
    int servo=-1;for(uint8_t i=0;i<SERVO_COUNT;++i)if(CH[i]==requestedChannel)servo=i;
    if(servo<0){Serial.println(F("REJECTED: channel not controlled"));return;}
    int pulse=0; bool digit=false;
    while(p<commandLength&&commandLine[p]>='0'&&commandLine[p]<='9'){
      digit=true;pulse=pulse*10+commandLine[p++]-'0';if(pulse>2000)return;
    }
    while(p<commandLength&&commandLine[p]==' ')++p;
    if(!digit||p!=commandLength||pulse<MINIMUM_US[servo]||pulse>MAXIMUM_US[servo]){
      Serial.println(F("REJECTED: pulse outside calibrated range"));return;
    }
    if(commandLine[0]=='K'){
      // Isolated calibration pulse, with automatic motions and other outputs off.
      if(!off()){fault();return;}
      current[servo]=pulse;
      if(!pwm(CH[servo],((long)pulse*4096+10000)/20000)){fault();return;}
      Serial.print(F("CAL CH"));Serial.print(requestedChannel);Serial.print(F(" PULSE "));Serial.println(pulse);
      return;
    }
    if(!enabled){for(uint8_t i=0;i<SERVO_COUNT;++i)current[i]=NEUTRAL_US[i];if(!sendPose())return;enabled=true;}
    running=false;
    int manualPose[SERVO_COUNT];
    // If UI commands arrive together, retain targets already queued for the
    // other servos so the final command represents the complete face pose.
    for(uint8_t i=0;i<SERVO_COUNT;++i)manualPose[i]=moving?target[i]:current[i];
    manualPose[servo]=pulse;
    if(servo>=4&&servo<=7){autoBlink=false;lidsOverride=false;}
    // Eyelids imitate short camera frames; the other features use a little more
    // smoothing. Eyelid commands arrive last in each camera pose update.
    moveTo(manualPose,(requestedChannel>=4&&requestedChannel<=7)?130:90,0);
    Serial.print(F("CHANNEL "));Serial.print(requestedChannel);Serial.print(F(" PULSE "));Serial.println(pulse);
    return;
  }
  if(commandLength!=1||(commandLine[0]!='1'&&commandLine[0]!='2'))return;
  char input=commandLine[0];
  if(!ready)return;
  if(!enabled){for(uint8_t i=0;i<SERVO_COUNT;++i)current[i]=NEUTRAL_US[i];if(!sendPose())return;enabled=true;}
  if(input=='2'){autoBlink=false;lidsOverride=false;running=false;neutralMove();Serial.println(F("NEUTRAL"));}
  else {running=true;neutralMove();Serial.println(F("RUNNING"));}
}
void setup() {
  Serial.begin(115200);
  loadEyeCalibration();
  Wire.begin(); Wire.setClock(100000); Wire.setWireTimeout(25000,true);
  if(!off()||!writeReg(0x00,0x10)||!writeReg(0xFE,121)||!writeReg(0x00,0x20)){fault();return;}
  delay(5); if(!writeReg(0x00,0xA0)||!off()){fault();return;}
  randomSeed(analogRead(A0)); for(uint8_t i=0;i<SERVO_COUNT;++i)current[i]=NEUTRAL_US[i];
  ready=true; Serial.println(F("READY calibrated 16-servo face - outputs OFF"));showEyeCalibrationHelp();
}
void loop() {
  while(Serial.available()) {
    char c=Serial.read();lastCommandByte=millis();
    if(c=='\r'||c=='\n'){
      if(commandLength||discardCommand)command();
      commandLength=0;discardCommand=false;
    }else if(!discardCommand){
      if(commandLength<sizeof(commandLine)-1)commandLine[commandLength++]=c;
      else discardCommand=true;
    }
  }
  if((commandLength||discardCommand)&&millis()-lastCommandByte>=40){
    command();commandLength=0;discardCommand=false;
  }
  if(!ready||!enabled)return;
  unsigned long now=millis();if(now-frame<20)return;frame=now;
  if(autoBlink){
    if(lidsClosed&&now-lidStarted[0]>=180){blink(false);nextBlink=now+random(2500,5501);}
    else if(!lidsClosed&&(long)(now-nextBlink)>=0)blink(true);
  }
  if(moving){unsigned long elapsed=now-started;
    float t=min(1.0f,(float)elapsed/travel);float e=t*t*t*(10.0f+t*(-15.0f+6.0f*t));
    for(uint8_t i=0;i<SERVO_COUNT;++i)current[i]=fromPose[i]+(int)((target[i]-fromPose[i])*e);
    if(!sendPose())return;
    if(elapsed>=travel){moving=false;nextMove=now+hold;}
  } else if(running&&(long)(now-nextMove)>=0){
    if(returning){expression();returning=false;}
    else{neutralMove();returning=true;}
  }
  if(lidsOverride&&!sendPose())return;
}

import {FaceLandmarker, FilesetResolver} from './vendor/package/vision_bundle.mjs';
import {mouthTargets} from './mouth-tracking.mjs';
import {createBlinkTracker} from './blink-tracking.mjs';
import {addCalibrators} from './calibrator.js';

const servos = [
  {group:'eyes',name:'Left eye — horizontal',ch:0,servo:1,low:1072,high:1877,neutral:1412,left:'Endpoint A',right:'Endpoint B'},
  {group:'eyes',name:'Left eye — vertical',ch:1,servo:2,low:1715,high:1375,neutral:1545,left:'Up',right:'Down'},
  {group:'eyes',name:'Right eye — horizontal',ch:2,servo:3,low:1257,high:1742,neutral:1482,left:'Endpoint A',right:'Endpoint B'},
  {group:'eyes',name:'Right eye — vertical',ch:3,servo:4,low:1187,high:1742,neutral:1472,left:'Endpoint A',right:'Endpoint B'},
  {group:'eyelids',name:'Left upper eyelid',ch:4,servo:5,low:1367,high:1527,neutral:1367,left:'Open',right:'Closed'},
  {group:'eyelids',name:'Left lower eyelid',ch:5,servo:6,low:1623,high:1453,neutral:1623,left:'Open',right:'Closed'},
  {group:'eyelids',name:'Right upper eyelid',ch:6,servo:7,low:1520,high:1420,neutral:1520,left:'Open',right:'Closed'},
  {group:'eyelids',name:'Right lower eyelid',ch:7,servo:8,low:1287,high:1592,neutral:1287,left:'Open',right:'Closed'},
  {group:'expression',name:'Left eyebrow',ch:8,servo:9,low:1677,high:1362,neutral:1517,left:'Lower',right:'Upper'},
  {group:'expression',name:'Right eyebrow',ch:9,servo:10,low:1322,high:1670,neutral:1537,left:'Lower',right:'Upper'},
  {group:'expression',name:'Left forehead',ch:12,servo:11,low:1551,high:1396,neutral:1471,left:'Lower',right:'Upper'},
  {group:'expression',name:'Right forehead',ch:13,servo:12,low:1490,high:1330,neutral:1415,left:'Lower',right:'Upper'},
  {group:'nose',name:'Nose up / down',ch:10,servo:13,low:1366,high:1500,neutral:1411,left:'Down',right:'Up'},
  {group:'jaw',name:'Jaw',ch:11,servo:14,low:1300,high:1700,neutral:1300,left:'Closed / neutral',right:'Fully open'},
  {group:'cheeks',name:'Left cheek',ch:14,servo:15,low:1700,high:1300,neutral:1500,left:'Down',right:'Up / pulled'},
  {group:'cheeks',name:'Right cheek',ch:15,servo:16,low:1300,high:1700,neutral:1500,left:'Down',right:'Up / pulled'}
];

// Easy Calibrator stores narrowed CH8/CH9 brow limits on this same local
// origin. Apply them before cards are built, so Face Control cannot command a
// brow into the eyelid collision area.
let customBrowCalibration=false;
try{
  const savedBrows=JSON.parse(localStorage.getItem('inmoov-brow-calibration-v1')||'{}');
  for(const ch of [8,9]){
    const record=savedBrows[ch],servo=servos.find(item=>item.ch===ch);if(!record||!servo)continue;
    const {a,r,b}=record,low=Math.min(a,b),high=Math.max(a,b);
    if([a,r,b].every(Number.isFinite)&&a>=1000&&a<=2000&&b>=1000&&b<=2000&&r>=low&&r<=high&&Math.abs(a-b)>=40){servo.low=a;servo.neutral=r;servo.high=b;customBrowCalibration=true}
  }
}catch{}

// Keep the latest recorded vertical-eye safe range authoritative in Face
// Control; older browser or EEPROM records must not replace these values.
const customVerticalEyeChannels=new Set();
try{
  const savedVerticalEyes=JSON.parse(localStorage.getItem('inmoov-eye-vertical-calibration-v1')||'{}');
  for(const ch of [1,3]){
    const record=savedVerticalEyes[ch],servo=servos.find(item=>item.ch===ch);
    if(!record||!servo)continue;
    const {a,r,b}=record,low=Math.min(a,b),high=Math.max(a,b);
    if(![a,r,b].every(Number.isFinite)||a<1000||a>2000||b<1000||b>2000||r<low||r>high||Math.abs(a-b)<40)continue;
    servo.low=a;servo.high=b;servo.neutral=r;
    customVerticalEyeChannels.add(ch);
  }
}catch{}

let port, writer, reader, reading=false, writeQueue=Promise.resolve(),serialBuffer='',eyeCalibrationRows=0;
const twinCommands='BroadcastChannel' in window?new BroadcastChannel('inmoov-twin-commands-v1'):null;
let cameraStream, faceLandmarker, cameraRunning=false, followEnabled=false;
let lastVideoTime=-1, lastTrackingSend=0;
const trackingValues=servos.map(s=>(s.neutral-s.low)*180/(s.high-s.low));
const lastTrackingPulses=Array(servos.length).fill(null);
let latestBlinkLeft=0, latestBlinkRight=0;
const blinkTracker=createBlinkTracker();
let lastEyeMask=0;
let autoBlinkEnabled=false, testBlinkTimer=null;
let gestureIndex=-1,gestureTimer=null,gestureLooping=false,gestureBusy=false,gestureGeneration=0;
let irisHeadSocket=null,irisReconnectTimer=null,speechMotionTimer=null,speechMotionActive=false,jawSilenceTimer=null;
const speechMotionQueue=[];
const gestures=[
  {name:'Happy',pose:{0:1422,1:1500,2:1422,3:1522,8:1362,9:1670,10:1411,11:1420,12:1700,13:1322,14:1360,15:1640}},
  {name:'Curious',pose:{0:1555,1:1495,2:1555,3:1527,8:1362,9:1322,10:1411,11:1360,12:1700,13:1611,14:1420,15:1580}},
  {name:'Surprised',pose:{0:1477,1:1433,2:1477,3:1589,8:1362,9:1670,10:1460,11:1620,12:1700,13:1322,14:1420,15:1580}},
  {name:'Concerned',pose:{0:1400,1:1504,2:1400,3:1518,8:1677,9:1670,10:1411,11:1380,12:1344,13:1322,14:1640,15:1360}},
  {name:'Skeptical',pose:{0:1511,1:1544,2:1444,3:1478,8:1677,9:1670,10:1388,11:1360,12:1344,13:1322,14:1360,15:1440}},
  {name:'Calm',pose:{0:1367,1:1545,2:1422,3:1442,8:1677,9:1322,10:1411,11:1300,12:1455,13:1566,14:1500,15:1500}}
];
function clearTestBlink(){clearTimeout(testBlinkTimer);testBlinkTimer=null;}
function setAutoBlink(on){
  autoBlinkEnabled=on;
  $('autoBlink').textContent=on?'Auto blink: ON':'Auto blink: OFF';
  $('autoBlink').setAttribute('aria-pressed',String(on));
}
function pauseFollowing(){followEnabled=false;$('follow').textContent='Follow my face';blinkTracker.reset();lastEyeMask=0;}
const $=id=>document.getElementById(id);
const controls=()=>document.querySelectorAll('button:not(#connect):not(#manualTab):not(#expressionTab):not([data-action="close"]):not([data-action="export"]):not([data-action="save"]),input');
const pulseAt=(s,value)=>Math.round(s.low+(s.high-s.low)*(value/180));
const valueAt=(s,pulse)=>Math.round((pulse-s.low)*180/(s.high-s.low));

function makeCard(s){
  const card=document.createElement('article'); card.className='card';card.id=`servo-${s.ch}`;
  const neutral=Math.max(0,Math.min(180,valueAt(s,s.neutral)));
  card.innerHTML=`<div class="card-head"><div><h3>${s.name}</h3><div class="meta">SERVO ${s.servo} · CH${s.ch}</div></div><div class="readout"><span>${neutral}</span>°</div></div><input aria-label="${s.name}" type="range" min="0" max="180" value="${neutral}"><div class="range-labels"><span>${s.left}</span><span>${s.right}</span></div><div class="card-actions"><button disabled>Neutral</button></div>`;
  const slider=card.querySelector('input'), readout=card.querySelector('.readout span'), neutralButton=card.querySelector('button');
  slider.addEventListener('input',()=>readout.textContent=slider.value);
  slider.addEventListener('change',()=>sendServo(s,Number(slider.value)));
  neutralButton.addEventListener('click',()=>{
    stopGestureLoop(false);paintGesture();gestureIndex=-1;
    if(s.group==='eyelids'){clearTestBlink();setAutoBlink(false);pauseFollowing();}
    slider.value=neutral;readout.textContent=neutral;sendRaw(`C${s.ch} ${s.neutral}`);
  });
  s.ui={slider,readout,neutralButton};
  $(s.group).appendChild(card);
}

servos.forEach(makeCard);
renderGestureButtons();
addCalibrators(servos,{
  connected:()=>Boolean(writer),
  stop:()=>{stopGestureLoop(false);paintGesture();gestureIndex=-1;clearTestBlink();pauseFollowing();setAutoBlink(false);return sendRaw('0');},
  move:(ch,pulse)=>sendRaw(`K${ch} ${pulse}`)
});
controls().forEach(el=>el.disabled=true);

function sendRaw(command){
  if(!writer)return Promise.resolve(false);
  writeQueue=writeQueue.then(()=>writer.write(new TextEncoder().encode(command+'\n')))
    .then(()=>{$('serialStatus').textContent='Sent: '+command;twinCommands?.postMessage({command,time:Date.now()});return true;})
    .catch(error=>{$('serialStatus').textContent=error.message;return false;});
  return writeQueue;
}
function sendServo(s,value){
  stopGestureLoop(false);paintGesture();gestureIndex=-1;
  if(s.group==='eyelids'){clearTestBlink();setAutoBlink(false);pauseFollowing();}
  sendRaw(`C${s.ch} ${pulseAt(s,value)}`);
}

function paintGesture(activeIndex=-1){
  document.querySelectorAll('[data-gesture]').forEach((button,index)=>button.setAttribute('aria-pressed',String(index===activeIndex)));
}
function stopGestureLoop(returnNeutral=false){
  const wasLooping=gestureLooping;gestureGeneration++;
  gestureLooping=false;clearTimeout(gestureTimer);gestureTimer=null;
  $('gesturePlay')?.setAttribute('aria-pressed','false');
  if(returnNeutral&&writer){
    setAutoBlink(false);sendRaw('A0');sendRaw('2');gestureIndex=-1;paintGesture();
    $('gestureStatus').textContent='Gesture loop stopped · returning to neutral';
  }else if(wasLooping&&$('gestureStatus'))$('gestureStatus').textContent='Gesture loop stopped';
}
async function applyGesture(index,generation=gestureGeneration){
  if(!writer||gestureBusy)return false;
  gestureBusy=true;gestureIndex=(index+gestures.length)%gestures.length;
  const gesture=gestures[gestureIndex];paintGesture(gestureIndex);
  try{
    for(const [channel,pulse] of Object.entries(gesture.pose)){
      const s=servos.find(item=>item.ch===Number(channel));if(!s)continue;
      const safePulse=clamp(pulse,Math.min(s.low,s.high),Math.max(s.low,s.high));
      const uiValue=clamp(valueAt(s,safePulse),0,180);
      s.ui.slider.value=uiValue;s.ui.readout.textContent=uiValue;
      await sendRaw(`C${channel} ${safePulse}`);
    }
    if(generation!==gestureGeneration)return false;
    $('gestureStatus').textContent=`Playing: ${gesture.name}${gestureLooping?' · loop ON':' · single gesture'}`;
    return true;
  }finally{gestureBusy=false;}
}
function scheduleGesture(){
  clearTimeout(gestureTimer);if(!gestureLooping)return;
  const generation=gestureGeneration;
  gestureTimer=setTimeout(async()=>{
    if(!gestureLooping||generation!==gestureGeneration)return;
    await applyGesture(gestureIndex+1,generation);
    if(gestureLooping&&generation===gestureGeneration)scheduleGesture();
  },Number($('gestureSpeed').value));
}
async function startGestureLoop(){
  if(!writer)return;
  stopGestureLoop(false);clearTestBlink();pauseFollowing();
  gestureLooping=true;$('gesturePlay').setAttribute('aria-pressed','true');
  setAutoBlink(true);await sendRaw('A1');
  const generation=gestureGeneration;gestureIndex=-1;await applyGesture(0,generation);
  if(gestureLooping&&generation===gestureGeneration)scheduleGesture();
}
async function playOneGesture(index){
  if(!writer)return;
  stopGestureLoop(false);clearTestBlink();pauseFollowing();
  setAutoBlink(true);await sendRaw('A1');await applyGesture(index,gestureGeneration);
}
async function nextGesture(){
  if(!writer)return;
  if(!gestureLooping){await playOneGesture(gestureIndex+1);return;}
  clearTimeout(gestureTimer);gestureTimer=null;
  const generation=gestureGeneration;
  await applyGesture(gestureIndex+1,generation);
  if(gestureLooping&&generation===gestureGeneration)scheduleGesture();
}
function renderGestureButtons(){
  gestures.forEach((gesture,index)=>{
    const button=document.createElement('button');button.textContent=gesture.name;
    button.dataset.gesture=String(index);button.setAttribute('aria-pressed','false');
    button.onclick=()=>playOneGesture(index);$('gestureButtons').appendChild(button);
  });
}

function applySpeechEmotion(name='calm'){
  if(!writer)return;
  const aliases={happy:'Happy',curious:'Curious',surprised:'Surprised',concerned:'Concerned',calm:'Calm'};
  const wanted=aliases[String(name).toLowerCase()]||'Calm';
  const gesture=gestures.find(item=>item.name===wanted);if(!gesture)return;
  stopGestureLoop(false);pauseFollowing();
  gestureIndex=gestures.indexOf(gesture);paintGesture(gestureIndex);
  for(const [channel,pulse] of Object.entries(gesture.pose)){
    if(Number(channel)===11)continue; // Speech envelope owns the jaw.
    const servo=servos.find(item=>item.ch===Number(channel));if(!servo)continue;
    const safePulse=clamp(pulse,Math.min(servo.low,servo.high),Math.max(servo.low,servo.high));
    const uiValue=clamp(valueAt(servo,safePulse),0,180);
    servo.ui.slider.value=uiValue;servo.ui.readout.textContent=uiValue;
    sendRaw(`C${channel} ${safePulse}`);
  }
  $('gestureStatus').textContent=`IRIS speech emotion: ${gesture.name}`;
}

function queueSpeechMotion(message){
  if(!Array.isArray(message.levels)||!message.levels.length)return;
  speechMotionQueue.push({levels:message.levels.map(level=>clamp(Number(level)||0,0,1)),frameMs:clamp(Number(message.frame_ms)||50,35,100),emotion:message.emotion||'calm'});
  if(!speechMotionActive)runNextSpeechMotion();
}

function runNextSpeechMotion(){
  clearTimeout(speechMotionTimer);speechMotionTimer=null;
  const motion=speechMotionQueue.shift();
  if(!motion){
    speechMotionActive=false;
    if(writer)setTimeout(()=>applySpeechEmotion('calm'),350);
    return;
  }
  speechMotionActive=true;
  if(!writer){speechMotionQueue.length=0;speechMotionActive=false;return;}
  applySpeechEmotion(motion.emotion);
  const jaw=servos.find(item=>item.ch===11);let index=0;
  const tick=()=>{
    if(!writer||index>=motion.levels.length){
      if(writer&&jaw){
        jaw.ui.slider.value=clamp(valueAt(jaw,jaw.neutral),0,180);jaw.ui.readout.textContent=jaw.ui.slider.value;
        sendRaw(`C11 ${jaw.neutral}`);
      }
      speechMotionTimer=setTimeout(runNextSpeechMotion,70);return;
    }
    const level=Math.pow(motion.levels[index++],0.72)*0.88;
    const pulse=clamp(Math.round(jaw.neutral+(jaw.high-jaw.neutral)*level),Math.min(jaw.low,jaw.high),Math.max(jaw.low,jaw.high));
    const uiValue=clamp(valueAt(jaw,pulse),0,180);
    jaw.ui.slider.value=uiValue;jaw.ui.readout.textContent=uiValue;
    sendRaw(`C11 ${pulse}`);
    speechMotionTimer=setTimeout(tick,motion.frameMs);
  };
  tick();
}

function applyLiveJaw(rawLevel){
  clearTimeout(jawSilenceTimer);jawSilenceTimer=null;
  if(!writer)return;
  const jaw=servos.find(item=>item.ch===11);if(!jaw)return;
  let level=clamp(Number(rawLevel)||0,0,1);
  if(level<0.005)level=0;
  const pulse=clamp(Math.round(jaw.neutral+(jaw.high-jaw.neutral)*Math.pow(level,0.78)*0.88),Math.min(jaw.low,jaw.high),Math.max(jaw.low,jaw.high));
  const uiValue=clamp(valueAt(jaw,pulse),0,180);
  jaw.ui.slider.value=uiValue;jaw.ui.readout.textContent=uiValue;
  sendRaw(`C11 ${pulse}`);
  jawSilenceTimer=setTimeout(()=>{
    if(!writer)return;
    jaw.ui.slider.value=clamp(valueAt(jaw,jaw.neutral),0,180);jaw.ui.readout.textContent=jaw.ui.slider.value;
    sendRaw(`C11 ${jaw.neutral}`);
  },180);
}

function connectIrisHead(){
  clearTimeout(irisReconnectTimer);
  if(irisHeadSocket&&(irisHeadSocket.readyState===WebSocket.OPEN||irisHeadSocket.readyState===WebSocket.CONNECTING))return;
  try{irisHeadSocket=new WebSocket('ws://127.0.0.1:8766')}catch{return}
  irisHeadSocket.onopen=()=>irisHeadSocket.send(JSON.stringify({type:'head_client'}));
  irisHeadSocket.onmessage=event=>{
    if(typeof event.data!=='string')return;
    try{
      const message=JSON.parse(event.data);
      if(message.type==='head_speech')applySpeechEmotion(message.emotion||'calm');
      if(message.type==='head_jaw')applyLiveJaw(message.level);
      if(message.type==='head_ready'&&$('gestureStatus'))$('gestureStatus').textContent='IRIS connected · connect Uno to enable speech motion';
    }catch{}
  };
  irisHeadSocket.onclose=()=>{irisHeadSocket=null;irisReconnectTimer=setTimeout(connectIrisHead,2000)};
  irisHeadSocket.onerror=()=>irisHeadSocket?.close();
}

function applyEyeCalibrationLine(line){
  const match=line.match(/^([0-7]),(-?\d+),(-?\d+),(-?\d+)$/);if(!match)return false;
  const [,channel,a,rest,b]=match.map(Number),servo=servos.find(item=>item.ch===channel);if(!servo)return false;
  const values=[a,rest,b];if(values.some(value=>value<1000||value>2000)||rest<Math.min(a,b)||rest>Math.max(a,b)||Math.abs(a-b)<20)return false;
  // Preserve explicit Face Control vertical-eye calibration over older EEPROM
  // rows, while still consuming the row so the full EEPROM load is recognized.
  if(!customVerticalEyeChannels.has(channel)){
    servo.low=a;servo.high=b;
    servo.neutral=rest;
  }
  const neutralValue=clamp(valueAt(servo,rest),0,180);servo.ui.slider.value=neutralValue;servo.ui.readout.textContent=neutralValue;
  eyeCalibrationRows|=1<<channel;
  if(eyeCalibrationRows===0xff)$('serialStatus').textContent='Loaded saved CH0-CH7 calibration from Uno EEPROM';
  return true;
}

function handleSerialLine(line){
  line=line.trim();if(!line)return;
  if(!applyEyeCalibrationLine(line))$('serialStatus').textContent=line;
}

async function readSerial(){
  reading=true; const decoder=new TextDecoder();serialBuffer='';
  while(port?.readable&&reading){
    reader=port.readable.getReader();
    try{while(true){
      const {value,done}=await reader.read();if(done)break;if(!value)continue;
      serialBuffer+=decoder.decode(value,{stream:true});const lines=serialBuffer.split(/\r?\n/);serialBuffer=lines.pop()||'';lines.forEach(handleSerialLine);
    }}
    catch(error){$('serialStatus').textContent=error.message}
    finally{reader.releaseLock();reader=null}
  }
}

async function connect(){
  if(!('serial' in navigator)){alert('Use Chrome or Edge. Web Serial is not available in this browser.');return}
  try{
    port=await navigator.serial.requestPort(); await port.open({baudRate:115200});
    writer=port.writable.getWriter(); $('status').textContent='Uno connected'; $('dot').classList.add('live');
    $('connect').textContent='Disconnect'; controls().forEach(el=>el.disabled=false);
    if(customBrowCalibration){$('animate').disabled=true;$('animate').title='Onboard animation is disabled because it does not yet contain the narrowed eyebrow limits.'}
    updateFollowButton(); readSerial();
    eyeCalibrationRows=0;await sendRaw('ALL');
    $('gestureStatus').textContent='Ready · choose a gesture or press Play loop';
  }catch(error){$('serialStatus').textContent=error.message}
}
async function disconnect(){
  clearTimeout(speechMotionTimer);clearTimeout(jawSilenceTimer);speechMotionTimer=jawSilenceTimer=null;speechMotionQueue.length=0;speechMotionActive=false;
  stopGestureLoop(false);clearTestBlink();if(writer)await sendRaw('0');setAutoBlink(false);pauseFollowing();
  reading=false; if(reader)await reader.cancel(); if(writer){writer.releaseLock();writer=null} if(port){await port.close();port=null}
  followEnabled=false;$('follow').textContent='Follow my face';
  $('status').textContent='Uno disconnected';$('dot').classList.remove('live');$('connect').textContent='Connect Uno';controls().forEach(el=>el.disabled=true);updateFollowButton();
  $('gestureStatus').textContent='Connect the Uno to play gestures.';paintGesture();gestureIndex=-1;
}

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const blendMap=result=>Object.fromEntries((result.faceBlendshapes?.[0]?.categories||[]).map(item=>[item.categoryName,item.score]));

async function loadFaceModel(){
  if(faceLandmarker)return;
  $('faceStatus').textContent='Loading face model…';
  const wasmPath=new URL('./vendor/package/wasm',import.meta.url).href;
  const modelPath=new URL('./vendor/face_landmarker.task',import.meta.url).href;
  const vision=await FilesetResolver.forVisionTasks(wasmPath);
  faceLandmarker=await FaceLandmarker.createFromOptions(vision,{
    baseOptions:{modelAssetPath:modelPath},runningMode:'VIDEO',numFaces:1,
    outputFaceBlendshapes:true,minFaceDetectionConfidence:.55,
    minFacePresenceConfidence:.55,minTrackingConfidence:.55
  });
}

async function startCamera(){
  if(cameraRunning){stopCamera();return}
  try{
    await loadFaceModel();
    cameraStream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:960},height:{ideal:600},facingMode:'user'},audio:false});
    $('video').srcObject=cameraStream;await $('video').play();cameraRunning=true;
    $('camera').textContent='Stop camera';$('faceStatus').textContent='Looking for one face…';
    updateFollowButton();requestAnimationFrame(trackFrame);
  }catch(error){$('faceStatus').textContent='Camera error: '+error.message}
}
function stopCamera(){
  followEnabled=false;cameraRunning=false;cameraStream?.getTracks().forEach(track=>track.stop());cameraStream=null;
  $('video').srcObject=null;$('camera').textContent='Start camera';$('follow').textContent='Follow my face';
  $('faceStatus').textContent='Camera off';clearOverlay();updateFollowButton();
}
function updateFollowButton(){
  $('follow').disabled=!(cameraRunning&&writer);
}
function clearOverlay(){const canvas=$('overlay');canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height)}
function drawLandmarks(points){
  const video=$('video'),canvas=$('overlay');
  if(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight){canvas.width=video.videoWidth;canvas.height=video.videoHeight}
  const context=canvas.getContext('2d');context.clearRect(0,0,canvas.width,canvas.height);context.fillStyle='#59d8d0b8';
  for(let i=0;i<points.length;i+=4){context.beginPath();context.arc(points[i].x*canvas.width,points[i].y*canvas.height,1.15,0,Math.PI*2);context.fill()}
}
function trackingTargets(result,time){
  const points=result.faceLandmarks[0];
  let minX=1,maxX=0,minY=1,maxY=0;
  for(const point of points){minX=Math.min(minX,point.x);maxX=Math.max(maxX,point.x);minY=Math.min(minY,point.y);maxY=Math.max(maxY,point.y)}
  const centerX=(minX+maxX)/2,centerY=(minY+maxY)/2;
  const shapes=blendMap(result);
  const inner=shapes.browInnerUp||0;
  const leftUp=Math.max(inner,shapes.browOuterUpLeft||0),rightUp=Math.max(inner,shapes.browOuterUpRight||0);
  const leftDown=shapes.browDownLeft||0,rightDown=shapes.browDownRight||0;
  latestBlinkLeft=shapes.eyeBlinkLeft||0;
  latestBlinkRight=shapes.eyeBlinkRight||0;
  const eyeMask=blinkTracker.update(latestBlinkLeft,latestBlinkRight,time);
  if(followEnabled&&!autoBlinkEnabled&&eyeMask!==lastEyeMask){
    lastEyeMask=eyeMask;
    sendRaw(`E${eyeMask}`);
    for(let i=4;i<=7;i++){
      const value=(eyeMask&(i<6?1:2))?180:0;
      servos[i].ui.slider.value=value;servos[i].ui.readout.textContent=value;
    }
  }
  const leftBlink=(eyeMask&1)?180:0,rightBlink=(eyeMask&2)?180:0;
  return [
    clamp((1-centerX)*260-40,15,165),clamp(centerY*250-35,20,160),
    clamp((1-centerX)*260-40,15,165),clamp(centerY*250-45,20,160),
    leftBlink,leftBlink,rightBlink,rightBlink,
    clamp(90+leftUp*80-leftDown*65,0,180),clamp(85+rightUp*80-rightDown*65,0,180),
    clamp(56+inner*95-leftDown*35,0,180),clamp(28+inner*95-rightDown*35,0,180),
    null, // Nose remains under manual control.
    ...mouthTargets(shapes)
  ];
}
function sendTracking(values,time){
  if(!followEnabled||time-lastTrackingSend<45)return;
  lastTrackingSend=time;
  // Eyelids use the atomic B command; other facial controls remain independent.
  const order=[0,1,2,3,8,9,10,11,13,14,15];
  order.forEach(index=>{
    const value=values[index];
    if(index>=4&&index<=7)trackingValues[index]=value;
    else trackingValues[index]+=(value-trackingValues[index])*(index===13?.5:.32);
    if(Math.abs(value-trackingValues[index])<.5)trackingValues[index]=value;
    const s=servos[index],uiValue=Math.round(trackingValues[index]);
    const pulse=pulseAt(s,uiValue);
    s.ui.slider.value=uiValue;s.ui.readout.textContent=uiValue;
    const reachedTarget=uiValue===Math.round(value);
    if(lastTrackingPulses[index]===null||Math.abs(pulse-lastTrackingPulses[index])>=4||(reachedTarget&&pulse!==lastTrackingPulses[index])){
      lastTrackingPulses[index]=pulse;sendRaw(`C${s.ch} ${pulse}`);
    }
  });
}
function trackFrame(time){
  if(!cameraRunning)return;
  const video=$('video');
  if(video.readyState>=2&&video.currentTime!==lastVideoTime){
    lastVideoTime=video.currentTime;
    try{
      const result=faceLandmarker.detectForVideo(video,time);
      if(result.faceLandmarks?.length){
        drawLandmarks(result.faceLandmarks[0]);
        const targets=trackingTargets(result,time);
        const blinkText=`blink L ${latestBlinkLeft.toFixed(2)} · R ${latestBlinkRight.toFixed(2)}`;
        $('faceStatus').textContent=(followEnabled?'Face detected • robot following • ':'Face detected • tracking paused • ')+blinkText;
        sendTracking(targets,time);
      }else{clearOverlay();$('faceStatus').textContent='No face detected';}
    }catch(error){$('faceStatus').textContent='Tracking error: '+error.message}
  }
  requestAnimationFrame(trackFrame);
}

$('connect').addEventListener('click',()=>port?disconnect():connect());
function selectView(view){
  const expression=view==='expressions';
  $('manualTab').setAttribute('aria-selected',String(!expression));
  $('expressionTab').setAttribute('aria-selected',String(expression));
  (expression?$('expressions'):$('manualControls')).scrollIntoView({behavior:'smooth',block:'start'});
}
$('manualTab').addEventListener('click',()=>selectView('manual'));
$('expressionTab').addEventListener('click',()=>selectView('expressions'));
$('animate').addEventListener('click',()=>{stopGestureLoop(false);paintGesture();gestureIndex=-1;clearTestBlink();pauseFollowing();sendRaw('B0');if(autoBlinkEnabled)sendRaw('A1');sendRaw('1')});
$('neutral').addEventListener('click',()=>{stopGestureLoop(false);clearTestBlink();pauseFollowing();setAutoBlink(false);paintGesture();gestureIndex=-1;sendRaw('2')});
$('autoBlink').addEventListener('click',()=>{
  clearTestBlink();setAutoBlink(!autoBlinkEnabled);blinkTracker.reset();lastEyeMask=0;
  sendRaw(autoBlinkEnabled?'A1':'A0');
});
$('testBlink').addEventListener('click',async()=>{
  clearTestBlink();setAutoBlink(false);pauseFollowing();
  sendRaw('B1');
  testBlinkTimer=setTimeout(()=>{sendRaw('B0');testBlinkTimer=null},180);
});
$('off').addEventListener('click',()=>{stopGestureLoop(false);clearTestBlink();pauseFollowing();setAutoBlink(false);paintGesture();gestureIndex=-1;sendRaw('0')});
$('gesturePlay').addEventListener('click',startGestureLoop);
$('gestureNext').addEventListener('click',nextGesture);
$('gestureStop').addEventListener('click',()=>stopGestureLoop(true));
$('gestureSpeed').addEventListener('change',()=>{if(gestureLooping)scheduleGesture()});
$('camera').addEventListener('click',startCamera);
$('follow').addEventListener('click',()=>{
  stopGestureLoop(false);paintGesture();gestureIndex=-1;clearTestBlink();setAutoBlink(false);sendRaw('A0');
  followEnabled=!followEnabled;$('follow').textContent=followEnabled?'Stop following':'Follow my face';
  lastTrackingPulses.fill(null);blinkTracker.reset();lastEyeMask=0;
  servos.forEach((s,i)=>trackingValues[i]=Number(s.ui.slider.value));
  if(!followEnabled)sendRaw('2');
});
navigator.serial?.addEventListener('disconnect',()=>disconnect().catch(()=>{}));
connectIrisHead();

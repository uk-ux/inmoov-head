/* IRIS · JARVIS HUD — same WebSocket protocol as the orb page.
   Push-to-talk + typing only: hands-free listening belongs to the tray
   assistant, so this page never becomes a third open microphone. */
'use strict';
const $=id=>document.getElementById(id);

/* ---------------- clock ---------------- */
function tickClock(){
  const d=new Date();
  let h=d.getHours(); const ap=h>=12?'PM':'AM'; h=h%12||12;
  $('clock').innerHTML=`${h}:${String(d.getMinutes()).padStart(2,'0')}<small> ${ap}</small>`;
  $('date').textContent=d.toLocaleDateString('en-GB',
    {weekday:'long',day:'2-digit',month:'long',year:'numeric'});
}
setInterval(tickClock,1000);tickClock();

/* ---------------- direct InMoov head connection ----------------
   IRIS owns the Uno port. The browser asks for COM9 once, then reconnects to
   the previously permitted port automatically on future launches. */
const HEAD_SERVOS={
  0:{low:1127,neutral:1367,high:1482},1:{low:1315,neutral:1475,high:1650},
  2:{low:1242,neutral:1422,high:1677},3:{low:1202,neutral:1442,high:1672},
  4:{low:1347,neutral:1347,high:1462},5:{low:1378,neutral:1378,high:1413},
  6:{low:1445,neutral:1445,high:1305},7:{low:1272,neutral:1272,high:1482},
  8:{low:1677,neutral:1677,high:1362},9:{low:1322,neutral:1322,high:1670},
  10:{low:1366,neutral:1411,high:1500},11:{low:1300,neutral:1300,high:1700},
  12:{low:1344,neutral:1455,high:1700},13:{low:1611,neutral:1566,high:1322},
  14:{low:1700,neutral:1500,high:1300},15:{low:1300,neutral:1500,high:1700}
};
const HEAD_POSES={
  happy:{0:1422,1:1500,2:1422,3:1522,8:1362,9:1670,10:1411,12:1700,13:1322,14:1360,15:1640},
  curious:{0:1555,1:1495,2:1555,3:1527,8:1362,9:1322,10:1411,12:1700,13:1611,14:1420,15:1580},
  surprised:{0:1477,1:1433,2:1477,3:1589,8:1362,9:1670,10:1460,12:1700,13:1322,14:1420,15:1580},
  concerned:{0:1400,1:1504,2:1400,3:1518,8:1677,9:1670,10:1411,12:1344,13:1322,14:1640,15:1360},
  sad:{0:1477,1:1580,2:1477,3:1518,8:1677,9:1670,10:1411,12:1344,13:1322,14:1600,15:1400},
  focused:{0:1511,1:1480,2:1444,3:1478,8:1677,9:1670,10:1388,12:1344,13:1322,14:1420,15:1580},
  calm:{0:1367,1:1475,2:1422,3:1442,8:1677,9:1322,10:1411,12:1455,13:1566,14:1500,15:1500}
};
const HEAD_EXPRESSION_STRENGTH={happy:.72,curious:.58,surprised:.78,concerned:.62,sad:.62,focused:.55,calm:1};
let headPort=null,headWriter=null,headReader=null,headReading=false,headQueue=Promise.resolve(),headText='',headCalmTimer=null,headActionTimer=null;
let currentHeadEmotion='calm',eyesHeldClosed=false,speechGazeTimer=null,speechGazeRestoreTimer=null;
const clampHead=(value,a,b)=>Math.max(Math.min(a,b),Math.min(Math.max(a,b),value));
function loadHeadLimits(){
  try{
    const brows=JSON.parse(localStorage.getItem('inmoov-brow-calibration-v1')||'{}');
    for(const ch of [8,9]){const r=brows[ch];if(r&&[r.a,r.r,r.b].every(Number.isFinite))HEAD_SERVOS[ch]={low:r.a,neutral:r.r,high:r.b}}
  }catch{}
  try{
    const eyes=JSON.parse(localStorage.getItem('inmoov-eye-vertical-calibration-v1')||'{}');
    const r=eyes[3];if(r&&[r.a,r.r,r.b].every(Number.isFinite))HEAD_SERVOS[3]={low:r.a,neutral:r.r,high:r.b};
  }catch{}
}
loadHeadLimits();
function setHeadBadge(mode,detail=''){
  const badge=$('headBadge');if(!badge)return;
  badge.className='badge '+(mode==='online'?'on':'off');
  badge.textContent=mode==='online'?'HEAD ONLINE':mode==='busy'?'HEAD BUSY':'CONNECT HEAD';
  badge.title=detail||'Connect the InMoov Uno';
}
function headSend(command){
  if(!headWriter)return Promise.resolve(false);
  headQueue=headQueue.then(()=>headWriter.write(new TextEncoder().encode(command+'\n')))
    .then(()=>true).catch(error=>{setHeadBadge('busy',error.message);return false});
  return headQueue;
}
async function readHead(){
  headReading=true;const decoder=new TextDecoder();
  while(headPort?.readable&&headReading){
    headReader=headPort.readable.getReader();
    try{
      while(headReading){
        const {value,done}=await headReader.read();if(done)break;
        headText+=decoder.decode(value,{stream:true});const lines=headText.split(/\r?\n/);headText=lines.pop()||'';
        for(const line of lines){
          const m=line.trim().match(/^([0-7]),(-?\d+),(-?\d+),(-?\d+)$/);if(!m)continue;
          const ch=Number(m[1]),a=Number(m[2]),neutral=Number(m[3]),b=Number(m[4]);
          if([a,neutral,b].every(v=>v>=1000&&v<=2000))HEAD_SERVOS[ch]={low:a,neutral,high:b};
        }
      }
    }catch{}finally{headReader?.releaseLock();headReader=null}
  }
}
async function openHead(port){
  if(headWriter)return true;
  try{
    await port.open({baudRate:115200});headPort=port;headWriter=port.writable.getWriter();
    setHeadBadge('online','IRIS owns the Uno serial connection');readHead();
    setTimeout(async()=>{
      await headSend('ALL');
      setTimeout(()=>{headSend('A1');applyHeadEmotion('calm')},350);
    },1800);return true;
  }catch(error){setHeadBadge('busy',error.message);return false}
}
async function ensureHeadConnected(choose=false){
  if(headWriter)return true;
  if(!('serial' in navigator)){setHeadBadge('busy','Use Chrome or Edge for Web Serial');return false}
  try{
    const permitted=await navigator.serial.getPorts();
    if(permitted.length)return openHead(permitted[0]);
    if(choose)return openHead(await navigator.serial.requestPort());
  }catch(error){setHeadBadge('busy',error.message)}
  return false;
}
function applyHeadEmotion(name='calm',returnToCalmMs=0,intensity=null){
  if(!headWriter)return;
  name=HEAD_POSES[name]?name:'calm';const pose=HEAD_POSES[name];
  const strength=intensity??HEAD_EXPRESSION_STRENGTH[name]??.65;
  clearTimeout(headCalmTimer);headCalmTimer=null;
  for(const [channel,target] of Object.entries(pose)){
    const servo=HEAD_SERVOS[channel];
    if(servo){
      const naturalTarget=name==='calm'?servo.neutral:Math.round(servo.neutral+(target-servo.neutral)*strength);
      headSend(`C${channel} ${clampHead(naturalTarget,servo.low,servo.high)}`);
    }
  }
  currentHeadEmotion=name;
  setHeadBadge('online',`IRIS expression: ${name}`);
  if(returnToCalmMs&&name!=='calm')headCalmTimer=setTimeout(()=>applyHeadEmotion('calm'),returnToCalmMs);
}
function moveHeadChannels(moves){
  for(const [channel,target] of Object.entries(moves)){
    const servo=HEAD_SERVOS[channel];
    if(servo)headSend(`C${channel} ${clampHead(target,servo.low,servo.high)}`);
  }
}
function applyHeadAction(action){
  if(!headWriter)return false;
  clearTimeout(headActionTimer);headActionTimer=null;
  const later=(ms,fn)=>{headActionTimer=setTimeout(fn,ms)};
  switch(action){
    case 'close_eyes': eyesHeldClosed=true;headSend('A0');headSend('B1');break;
    case 'open_eyes': eyesHeldClosed=false;headSend('B0');headSend('A1');break;
    case 'blink':
      eyesHeldClosed=true;
      headSend('A0');headSend('B1');
      later(190,()=>{eyesHeldClosed=false;headSend('B0');headSend('A1')});break;
    case 'wink_left':
      eyesHeldClosed=true;
      headSend('A0');headSend('E1');
      later(550,()=>{eyesHeldClosed=false;headSend('E0');headSend('A1')});break;
    case 'wink_right':
      eyesHeldClosed=true;
      headSend('A0');headSend('E2');
      later(550,()=>{eyesHeldClosed=false;headSend('E0');headSend('A1')});break;
    case 'look_left': moveHeadChannels({0:HEAD_SERVOS[0].low,2:HEAD_SERVOS[2].low});break;
    case 'look_right': moveHeadChannels({0:HEAD_SERVOS[0].high,2:HEAD_SERVOS[2].high});break;
    case 'look_up': moveHeadChannels({1:HEAD_SERVOS[1].low,3:HEAD_SERVOS[3].high});break;
    case 'look_down': moveHeadChannels({1:HEAD_SERVOS[1].high,3:HEAD_SERVOS[3].low});break;
    case 'look_center': moveHeadChannels({0:HEAD_SERVOS[0].neutral,1:HEAD_SERVOS[1].neutral,2:HEAD_SERVOS[2].neutral,3:HEAD_SERVOS[3].neutral});break;
    case 'look_around':
      moveHeadChannels({0:HEAD_SERVOS[0].high,2:HEAD_SERVOS[2].high});
      later(700,()=>{moveHeadChannels({0:HEAD_SERVOS[0].low,2:HEAD_SERVOS[2].low});later(850,()=>moveHeadChannels({0:HEAD_SERVOS[0].neutral,2:HEAD_SERVOS[2].neutral}))});break;
    case 'happy': applyHeadEmotion('happy');break;
    case 'sad': applyHeadEmotion('sad');break;
    case 'surprised': applyHeadEmotion('surprised');break;
    case 'focused': applyHeadEmotion('focused');break;
    case 'calm': applyHeadEmotion('calm');break;
    default:return false;
  }
  setHeadBadge('online',`Voice action: ${action.replaceAll('_',' ')}`);return true;
}
function stopSpeechGaze(){
  clearTimeout(speechGazeTimer);clearTimeout(speechGazeRestoreTimer);
  speechGazeTimer=speechGazeRestoreTimer=null;
}
function startSpeechGaze(token){
  stopSpeechGaze();
  const schedule=()=>{
    const delay=950+Math.random()*1500;
    speechGazeTimer=setTimeout(()=>{
      if(!playing||token!==playToken||holdHeadPoseAfterSpeech||eyesHeldClosed)return;
      const towardHigh=Math.random()>.5;
      const amount=.06+Math.random()*.07;
      const gaze={};
      for(const channel of [0,2]){
        const servo=HEAD_SERVOS[channel];
        const endpoint=towardHigh?servo.high:servo.low;
        gaze[channel]=Math.round(servo.neutral+(endpoint-servo.neutral)*amount);
      }
      moveHeadChannels(gaze);
      speechGazeRestoreTimer=setTimeout(()=>{
        if(!playing||token!==playToken)return;
        applyHeadEmotion(currentHeadEmotion);
        schedule();
      },320+Math.random()*360);
    },delay);
  };
  schedule();
}
function driveHeadJaw(rawLevel){
  if(!headWriter)return false;const jaw=HEAD_SERVOS[11];
  let level=Math.max(0,Math.min(1,Number(rawLevel)||0));if(level<0.005)level=0;
  const pulse=clampHead(Math.round(jaw.neutral+(jaw.high-jaw.neutral)*Math.pow(level,0.78)*0.88),jaw.low,jaw.high);
  headSend(`C11 ${pulse}`);return true;
}
async function testHeadJaw(){
  if(!await ensureHeadConnected(true))return;
  setHeadBadge('online','Testing CH11: 1500 µs, then 1300 µs closed');
  await headSend('C11 1500');
  setTimeout(()=>headSend('C11 1300'),1500);
}
$('headBadge').addEventListener('click',()=>headWriter?testHeadJaw():ensureHeadConnected(true));
navigator.serial?.addEventListener('disconnect',event=>{
  if(event.target!==headPort)return;headReading=false;headWriter?.releaseLock();headWriter=null;headPort=null;setHeadBadge('offline');
});
ensureHeadConnected(false);

/* ---------------- websocket ---------------- */
let ws,wsReady=false,state='idle',motionWs=null,motionReconnect=null,queuedHeadEmotion='calm';
function connectMotion(){
  clearTimeout(motionReconnect);
  if(motionWs&&(motionWs.readyState===WebSocket.OPEN||motionWs.readyState===WebSocket.CONNECTING))return;
  motionWs=new WebSocket('ws://127.0.0.1:8766');
  motionWs.onopen=()=>motionWs.send(JSON.stringify({type:'head_client'}));
  motionWs.onmessage=event=>{
    if(typeof event.data!=='string')return;
    try{
      const message=JSON.parse(event.data);
      if(message.type==='head_speech')queuedHeadEmotion=message.emotion||'calm';
      if(message.type==='head_action')applyHeadAction(message.action);
      if(message.type==='head_jaw')driveHeadJaw(message.level);
    }catch{}
  };
  motionWs.onclose=()=>{motionWs=null;motionReconnect=setTimeout(connectMotion,2000)};
  motionWs.onerror=()=>motionWs?.close();
}
function sendJawLevel(level){
  if(driveHeadJaw(level))return;
  if(motionWs?.readyState===WebSocket.OPEN)motionWs.send(JSON.stringify({type:'jaw_level',level}));
}
function connect(){
  ws=new WebSocket('ws://127.0.0.1:8766');
  ws.binaryType='arraybuffer';
  ws.onopen=()=>{wsReady=true;setLink(true);setState('idle','ready');
    try{if(localStorage.getItem('iris-hf')==='1'&&!handsFree)startHandsFree()}catch{}};
  ws.onclose=()=>{wsReady=false;setLink(false);setState('offline');setTimeout(connect,2000)};
  ws.onerror=()=>ws.close();
  ws.onmessage=e=>{
    if(typeof e.data!=='string'){
      if(expectAudio){expectAudio=false;playReply(e.data,queuedHeadEmotion);queuedHeadEmotion='calm'}
      return;
    }
    const m=JSON.parse(e.data);
    if(m.type==='status')setState(m.state,m.detail);
    else if(m.type==='user')addMsg('user',m.text);
    else if(m.type==='delta')appendTyping(m.text);
    else if(m.type==='reply')endTyping(m.text);
    else if(m.type==='audio'){expectAudio=true;queuedHeadEmotion=m.emotion||queuedHeadEmotion||'calm'}
    else if(m.type==='speech_done'){
      speechDone=true;
      if(!playing){setState('idle');if(!holdHeadPoseAfterSpeech)applyHeadEmotion('calm')}
    }
    else if(m.type==='sys')renderSys(m);
    else if(m.type==='peer_speaking')peerUntil=Date.now()+m.seconds*1000+600;
    else if(m.type==='jarvis')renderJarvis(m);
    else if(m.type==='memory'&&m.stats){$('factCount').textContent=m.stats.facts;
      $('exchCount').textContent=m.stats.exchanges}
    else if(m.type==='error')addMsg('iris','⚠ '+m.text);
  };
}
connectMotion();
function setLink(on){
  const b=$('linkBadge');
  b.className='badge '+(on?'on':'off');
  b.textContent=on?'LINK ONLINE':'LINK OFFLINE';
}
function setState(s,detail){
  state=s;
  $('orbWrap').className=s==='listening'?'listening':s==='thinking'?'thinking':s==='speaking'?'speaking':'';
  $('stateText').textContent=(detail||s||'idle').toUpperCase();
  if(!headWriter||playing||holdHeadPoseAfterSpeech)return;
  if(s==='listening')applyHeadEmotion('curious',0,.34);
  else if(s==='thinking')applyHeadEmotion('focused',0,.38);
  else if(s==='idle')applyHeadEmotion('calm');
}

/* ---------------- conversation ---------------- */
let typingEl=null;
function addMsg(cls,text){
  const d=document.createElement('div');
  d.className='msg '+(cls==='user'?'user':'iris');
  d.textContent=text;
  $('convo').appendChild(d);
  while($('convo').children.length>30)$('convo').firstChild.remove();
  $('convo').scrollTop=1e9;
  return d;
}
function appendTyping(text){
  if(!typingEl)typingEl=addMsg('iris',''),typingEl.classList.add('typing');
  typingEl.textContent+=text;
  $('convo').scrollTop=1e9;
}
function endTyping(text){
  if(typingEl){typingEl.classList.remove('typing');if(text)typingEl.textContent=text;typingEl=null}
  else if(text)addMsg('iris',text);
}

/* ---------------- system panel ---------------- */
function meter(id,pct,valueText,warnAt,critAt,stateWord){
  const el=$(id);if(!el||pct==null)return;
  el.querySelector('.row b').textContent=valueText;
  el.querySelector('.bar i').style.width=Math.max(0,Math.min(100,pct))+'%';
  el.className='meter'+(pct>=critAt?' crit':pct>=warnAt?' warn':'');
  const st=el.querySelector('.state');
  if(st)st.textContent=pct>=critAt?stateWord.toUpperCase():'';
}
function renderSys(m){
  meter('mCpu',m.cpu,m.cpu+'%',80,95,'high');
  meter('mRam',m.ram,m.ram+'%',85,95,'high');
  if(m.batt!=null){
    const low=!m.plugged&&m.batt<=20;
    meter('mBatt',100-m.batt,m.batt+'%'+(m.plugged?' ⚡':''),low?0:101,low?0:101,'low');
    $('mBatt').querySelector('.bar i').style.width=m.batt+'%';
  }
  meter('mDiskC',m.disk_c,m.disk_c+'%',88,95,'full');
  meter('mDiskU',m.disk_u,m.disk_u+'%',88,95,'full');
}

/* ---------------- tasks + notes ---------------- */
function renderJarvis(m){
  const ul=$('taskList');ul.innerHTML='';
  $('doneCount').textContent=m.done_today?m.done_today+' done today':'';
  if(!m.tasks.length){
    const d=document.createElement('div');d.className='empty';
    d.textContent='Nothing pending — say "add task …"';ul.appendChild(d);
  }
  for(const t of m.tasks){
    const li=document.createElement('li');
    const box=document.createElement('span');box.className='box';
    const txt=document.createElement('span');txt.textContent=t.text;
    li.append(box,txt);
    if(t.due&&t.due.includes(' ')){
      const due=document.createElement('span');due.className='due';
      const [,hm]=t.due.split(' ');let[h,mn]=hm.split(':').map(Number);
      const ap=h>=12?'PM':'AM';h=h%12||12;
      due.textContent=`${h}:${String(mn).padStart(2,'0')} ${ap}`;
      li.appendChild(due);
    }
    li.title='Click to mark done';
    li.onclick=()=>wsReady&&ws.send(JSON.stringify({type:'task_done',id:t.id}));
    ul.appendChild(li);
  }
  $('noteCount').textContent=m.stats.notes;
  $('connCount').textContent=m.stats.connections;
  const nl=$('noteList');nl.innerHTML='';
  if(!m.notes.length){
    const d=document.createElement('div');d.className='empty';
    d.textContent='No notes yet — say "take a note …"';nl.appendChild(d);
  }
  for(const n of m.notes){
    const d=document.createElement('div');d.className='note';
    const t=document.createElement('time');t.textContent=n.at.slice(5,16);
    const b=document.createElement('b');b.textContent=n.text;
    d.append(t,b);nl.appendChild(d);
  }
}
$('taskIn').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.value.trim()&&wsReady){
    ws.send(JSON.stringify({type:'task_add',text:e.target.value.trim()}));
    e.target.value='';
  }
});
$('noteIn').addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target.value.trim()&&wsReady){
    ws.send(JSON.stringify({type:'note_add',text:e.target.value.trim()}));
    e.target.value='';
  }
});

/* ---------------- text + command chips ---------------- */
function sendText(t){
  if(!wsReady||!t.trim())return;
  stopPlayback();
  ws.send(JSON.stringify({type:'text',text:t.trim()}));
}
$('textIn').addEventListener('keydown',e=>{
  if(e.key==='Enter'){sendText(e.target.value);e.target.value=''}
});
document.querySelectorAll('.chip').forEach(c=>
  c.addEventListener('click',()=>sendText(c.dataset.say)));

/* ---------------- mic capture (16 kHz mono int16, PTT only) ---------------- */
let micStream=null,micCtx=null,micNode=null,micSrc=null,micFilter=null,capturing=false;
let micDeviceId=null,micPeak=0;
async function listMics(){
  try{
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(device=>device.kind==='audioinput');
    const select=$('micSelect');if(!select||!devices.length)return;
    let saved=null;try{saved=localStorage.getItem('iris-mic-device')}catch{}
    select.innerHTML='';
    devices.forEach((device,index)=>{
      const option=document.createElement('option');option.value=device.deviceId;
      option.textContent=device.label||`Microphone ${index+1}`;select.appendChild(option);
    });
    if(saved&&devices.some(device=>device.deviceId===saved))select.value=saved;
    micDeviceId=select.value||null;
  }catch{}
}
$('micSelect').addEventListener('change',event=>{
  micDeviceId=event.target.value||null;
  try{localStorage.setItem('iris-mic-device',micDeviceId||'')}catch{}
  if(handsFree)stopHandsFree();
  micStream?.getTracks().forEach(track=>track.stop());micStream=null;
  micSrc?.disconnect();micFilter?.disconnect();micNode?.disconnect();micSrc=micFilter=micNode=null;
  setState('idle','microphone changed');
});
navigator.mediaDevices?.addEventListener?.('devicechange',listMics);
listMics();
async function startCapture(){
  if(!wsReady||capturing)return;
  try{
    if(!micStream){
      const audio={echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:16000};
      if(micDeviceId)audio.deviceId={exact:micDeviceId};
      micStream=await navigator.mediaDevices.getUserMedia({audio});listMics();
    }
  }catch{setState('idle','microphone permission denied');return}
  if(!micCtx){
    const AC=window.AudioContext||window.webkitAudioContext;
    try{micCtx=new AC({sampleRate:16000})}catch{micCtx=new AC()}
  }
  await micCtx.resume();
  micSrc=micCtx.createMediaStreamSource(micStream);
  micFilter=micCtx.createBiquadFilter();micFilter.type='highpass';micFilter.frequency.value=85;micFilter.Q.value=0.7;
  micNode=micCtx.createScriptProcessor(1024,1,1);
  const ratio=micCtx.sampleRate/16000;
  micNode.onaudioprocess=ev=>{
    if(!capturing)return;
    const f=ev.inputBuffer.getChannelData(0);
    let energy=0;for(let i=0;i<f.length;i+=4)energy+=f[i]*f[i];
    const level=Math.min(1,Math.sqrt(energy/(f.length/4))*8);micPeak=Math.max(micPeak,level);
    $('micBar').style.width=(level*100).toFixed(0)+'%';
    let out;
    if(ratio===1){
      out=new Int16Array(f.length);
      for(let i=0;i<f.length;i++)out[i]=Math.max(-32768,Math.min(32767,f[i]*1.25*32767));
    }else{
      const n=Math.floor(f.length/ratio);out=new Int16Array(n);
      for(let i=0;i<n;i++){
        const a=Math.floor(i*ratio),b=Math.min(f.length,Math.floor((i+1)*ratio));
        let acc=0;for(let j=a;j<b;j++)acc+=f[j];
        out[i]=Math.max(-32768,Math.min(32767,acc/Math.max(1,b-a)*1.25*32767));
      }
    }
    if(wsReady)ws.send(out.buffer);
  };
  micSrc.connect(micFilter);micFilter.connect(micNode);micNode.connect(micCtx.destination);
  micPeak=0;$('micBar').style.width='0%';
  capturing=true;ws.send(JSON.stringify({type:'start'}));
  $('talkBtn').classList.add('rec');$('talkLabel').textContent='RELEASE TO SEND';
  setState('listening');
}
function stopCapture(){
  if(!capturing)return;
  capturing=false;
  micNode?.disconnect();micFilter?.disconnect();micSrc?.disconnect();micNode=micFilter=micSrc=null;
  $('micBar').style.width='0%';
  $('talkBtn').classList.remove('rec');$('talkLabel').textContent='HOLD TO TALK';
  if(wsReady)ws.send(JSON.stringify({type:'stop',handsfree:handsFree}));
  if(!hfCapture)stopPlayback();   // button talk barges in; VAD-triggered doesn't
  hfCapture=false;
}
let hfCapture=false;

/* ---------------- hands-free: continuous listening, wake word on server ---------------- */
let handsFree=false,peerUntil=0,hfOpen=false,hfLoud=0,hfQuiet=0,noiseFloor=0.02,hfNode=null,hfSrc=null;
const HF_START=2,HF_END=9;    // quick speech trigger, about 0.6 s quiet to send
function vadTick(level){
  // Deaf while IRIS speaks or thinks here, or through another client.
  if(state==='speaking'||state==='thinking'||playing||Date.now()<peerUntil){hfLoud=0;hfQuiet=0;return}
  noiseFloor=level<noiseFloor?noiseFloor*0.97+level*0.03:noiseFloor*0.999+level*0.001;
  const gate=Math.max(0.055,noiseFloor*3.2);
  if(level>gate){
    hfQuiet=0;
    if(!hfOpen&&++hfLoud>=HF_START){hfOpen=true;hfLoud=0;hfCapture=true;startCapture()}
  }else{
    hfLoud=0;
    if(hfOpen&&++hfQuiet>=HF_END){hfOpen=false;hfQuiet=0;stopCapture()}
  }
}
async function startHandsFree(){
  if(!wsReady)return;
  try{
    if(!micStream){
      const audio={echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:16000};
      if(micDeviceId)audio.deviceId={exact:micDeviceId};
      micStream=await navigator.mediaDevices.getUserMedia({audio});listMics();
    }
  }catch{setState('idle','microphone permission denied');return}
  if(!micCtx){
    const AC=window.AudioContext||window.webkitAudioContext;
    try{micCtx=new AC({sampleRate:16000})}catch{micCtx=new AC()}
  }
  await micCtx.resume();
  hfSrc=micCtx.createMediaStreamSource(micStream);
  hfNode=micCtx.createScriptProcessor(1024,1,1);
  hfNode.onaudioprocess=ev=>{
    if(!handsFree)return;
    const f=ev.inputBuffer.getChannelData(0);
    let s=0;for(let i=0;i<f.length;i+=4)s+=f[i]*f[i];
    vadTick(Math.min(1,Math.sqrt(s/(f.length/4))*7));
  };
  hfSrc.connect(hfNode);hfNode.connect(micCtx.destination);
  handsFree=true;hfOpen=false;hfLoud=hfQuiet=0;noiseFloor=0.02;
  $('hfBtn').classList.add('on');
  setState('idle',"hands-free — say 'Iris'");
  try{localStorage.setItem('iris-hf','1')}catch{}
}
function stopHandsFree(){
  handsFree=false;hfOpen=false;
  hfNode?.disconnect();hfSrc?.disconnect();hfNode=hfSrc=null;
  if(capturing)stopCapture();
  $('hfBtn').classList.remove('on');
  setState('idle');
  try{localStorage.setItem('iris-hf','0')}catch{}
}
$('hfBtn').addEventListener('click',()=>handsFree?stopHandsFree():startHandsFree());
const talkBtn=$('talkBtn');
talkBtn.addEventListener('pointerdown',e=>{e.preventDefault();talkBtn.setPointerCapture(e.pointerId);startCapture()});
talkBtn.addEventListener('pointerup',()=>stopCapture());
talkBtn.addEventListener('pointercancel',()=>stopCapture());
window.addEventListener('keydown',e=>{
  if(e.code==='Space'&&e.target.tagName!=='INPUT'){e.preventDefault();startCapture()}
});
window.addEventListener('keyup',e=>{
  if(e.code==='Space'&&e.target.tagName!=='INPUT')stopCapture();
});

/* ---------------- playback ---------------- */
let outCtx=null,audioQueue=[],playing=false,speechDone=false,expectAudio=false,holdHeadPoseAfterSpeech=false;
let currentSource=null,playToken=0,analyser=null,analyserData=null;
function stopPlayback(){
  audioQueue=[];playing=false;speechDone=false;
  stopSpeechGaze();
  try{currentSource?.stop()}catch{}currentSource=null;
  sendJawLevel(0);
  if(!holdHeadPoseAfterSpeech)applyHeadEmotion('calm');
}
async function playReply(arrayBuffer,emotion='calm'){
  outCtx??=new (window.AudioContext||window.webkitAudioContext)();
  await outCtx.resume();
  if(!analyser){
    analyser=outCtx.createAnalyser();analyser.fftSize=512;
    analyser.connect(outCtx.destination);
    analyserData=new Uint8Array(analyser.frequencyBinCount);
  }
  try{audioQueue.push({buffer:await outCtx.decodeAudioData(arrayBuffer.slice(0)),emotion})}
  catch{return}
  if(!playing)playNext();
}
function playNext(){
  const item=audioQueue.shift();
  if(!item){
    playing=false;currentSource=null;stopSpeechGaze();sendJawLevel(0);
    if(speechDone)setState('idle');
    if(!holdHeadPoseAfterSpeech)applyHeadEmotion('calm');return;
  }
  const {buffer:buf,emotion}=item;
  playing=true;setState('speaking');
  holdHeadPoseAfterSpeech=emotion==='hold';
  if(!holdHeadPoseAfterSpeech)applyHeadEmotion(emotion||'calm');
  const myToken=++playToken;
  if(!holdHeadPoseAfterSpeech)startSpeechGaze(myToken);
  const src=outCtx.createBufferSource();src.buffer=buf;src.connect(analyser);
  currentSource=src;
  src.onended=()=>{
    if(myToken!==playToken||!playing)return;
    stopSpeechGaze();
    sendJawLevel(0);
    setTimeout(()=>{if(myToken===playToken&&playing)playNext()},90);
  };
  src.start();
}

/* ---------------- the orb — canvas core, reacts to IRIS's voice ---------------- */
const orbC=$('orbCanvas'),octx=orbC.getContext('2d');
let lvlS=0;
let jawLevel=0,lastJawSent=0;
function speechLevel(){
  if(!playing||!analyser)return 0;
  analyser.getByteTimeDomainData(analyserData);
  let s=0;
  for(let i=0;i<analyserData.length;i++){const v=(analyserData[i]-128)/128;s+=v*v}
  return Math.min(1,Math.sqrt(s/analyserData.length)*3.4);
}
function drawOrb(now){
  const W=orbC.width,H=orbC.height,cx=W/2,cy=H/2;
  octx.clearRect(0,0,W,H);
  const target=speechLevel();
  // This analyser contains only IRIS playback, so a very small gate removes
  // digital silence without throwing away the quieter parts of Fenrir's voice.
  const gated=target<0.003?0:Math.min(1,target*3.2);
  jawLevel+=(gated-jawLevel)*(gated>jawLevel?0.72:0.42);
  if(jawLevel<0.025)jawLevel=0;
  if(now-lastJawSent>=45){lastJawSent=now;sendJawLevel(jawLevel)}
  lvlS+=(target-lvlS)*(target>lvlS?0.5:0.08);   // fast attack, slow decay
  const li=state==='listening',th=state==='thinking';
  const boost=li?1.3:th?1.12:1;
  const tspin=th?0.3:1;                          // thinking spins the arcs faster
  const breathe=1+0.028*Math.sin(now/1150);
  const R=(98+lvlS*36)*breathe*(li?1.05:1);

  /* ambient bloom */
  let g=octx.createRadialGradient(cx,cy,R*0.2,cx,cy,R*3.0);
  g.addColorStop(0,`rgba(56,189,255,${0.16*boost+lvlS*0.22})`);
  g.addColorStop(0.5,'rgba(56,189,255,0.04)');
  g.addColorStop(1,'rgba(56,189,255,0)');
  octx.fillStyle=g;octx.fillRect(0,0,W,H);

  /* core sphere */
  g=octx.createRadialGradient(cx-R*0.32,cy-R*0.36,R*0.08,cx,cy,R);
  g.addColorStop(0,'rgba(214,242,255,0.96)');
  g.addColorStop(0.32,'rgba(96,206,255,0.92)');
  g.addColorStop(0.72,'rgba(9,82,132,0.96)');
  g.addColorStop(1,'rgba(2,26,46,1)');
  octx.beginPath();octx.arc(cx,cy,R,0,7);
  octx.fillStyle=g;
  octx.shadowColor='rgba(56,189,255,0.7)';
  octx.shadowBlur=34*boost+lvlS*46;
  octx.fill();octx.shadowBlur=0;
  octx.beginPath();octx.arc(cx,cy,R,0,7);
  octx.strokeStyle='rgba(150,222,255,0.3)';octx.lineWidth=1.2;octx.stroke();

  /* rotating arcs */
  const arcs=[
    {r:R+30,w:2,  sp: 3800,len:1.9,off:0,  a:0.55},
    {r:R+46,w:1.2,sp:-6200,len:0.9,off:2.1,a:0.38},
    {r:R+46,w:1.2,sp:-6200,len:0.5,off:4.6,a:0.38},
    {r:R+64,w:1,  sp: 9800,len:2.6,off:1.2,a:0.24},
  ];
  for(const A of arcs){
    const rot=now/(A.sp*tspin);
    octx.beginPath();octx.arc(cx,cy,A.r,rot+A.off,rot+A.off+A.len);
    octx.strokeStyle=`rgba(56,189,255,${Math.min(1,A.a*boost+lvlS*0.25)})`;
    octx.lineWidth=A.w;octx.stroke();
  }

  /* outer tick ring */
  const rt=R+82,n=60,rotr=now/32000;
  for(let i=0;i<n;i++){
    const a=rotr+i*2*Math.PI/n,long=i%5===0;
    octx.beginPath();
    octx.moveTo(cx+Math.cos(a)*rt,cy+Math.sin(a)*rt);
    octx.lineTo(cx+Math.cos(a)*(rt+(long?9:4)),cy+Math.sin(a)*(rt+(long?9:4)));
    octx.strokeStyle=`rgba(56,189,255,${long?0.3:0.12})`;
    octx.lineWidth=1;octx.stroke();
  }

  /* drifting particles */
  for(let i=0;i<14;i++){
    const a=now/(4200+i*260)+i*2.39,pr=R+30+(i%3)*17;
    const tw=0.22+0.2*Math.sin(now/700+i*1.7);
    octx.beginPath();
    octx.arc(cx+Math.cos(a)*pr,cy+Math.sin(a)*pr,1.7,0,7);
    octx.fillStyle=`rgba(170,228,255,${tw+lvlS*0.3})`;octx.fill();
  }
  requestAnimationFrame(drawOrb);
}
requestAnimationFrame(drawOrb);

connect();

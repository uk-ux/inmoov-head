/* InMoov voice orb - WS client, push-to-talk mic, chat, canvas orb. */
const WS_URL='ws://127.0.0.1:8766';
const $=id=>document.getElementById(id);
const messages=$('messages'),talkBtn=$('talk'),statusEl=$('status'),
      statusText=$('statusText'),badge=$('connBadge'),handsBtn=$('handsFree');

let ws=null,wsReady=false,expectAudio=false;
let state='idle';            // idle | listening | thinking | speaking
let micLevel=0,outLevel=0;
let capturing=false,micCtx=null,micNode=null,micStream=null,micDeviceId=null;
let outCtx=null,analyser=null,analyserData=null,currentSource=null;
let typingBubble=null;

/* ---------------- chat ---------------- */
function addMsg(kind,text){
  const row=document.createElement('div');row.className=`msg ${kind}`;
  const who=document.createElement('span');who.className='who';
  const stamp=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  who.textContent=(kind==='user'?'YOU':'IRIS')+' · '+stamp;
  const b=document.createElement('div');b.className='bubble';b.textContent=text;
  row.appendChild(who);row.appendChild(b);messages.appendChild(row);
  messages.scrollTop=messages.scrollHeight;
  return b;
}
function startTyping(){if(!typingBubble){typingBubble=addMsg('bot','');typingBubble.classList.add('typing')}}
function appendTyping(text){startTyping();typingBubble.textContent+=text;messages.scrollTop=messages.scrollHeight}
function endTyping(finalText){
  if(typingBubble){typingBubble.classList.remove('typing');if(finalText)typingBubble.textContent=finalText;typingBubble=null}
  else if(finalText)addMsg('bot',finalText);
  messages.scrollTop=messages.scrollHeight;
}

/* ---------------- status ---------------- */
const STATUS_TEXT={idle:'Ready',listening:'Listening',thinking:'Thinking',speaking:'Speaking'};
function setState(s,detail){
  state=s;
  statusEl.className='status-line'+(s==='listening'?' live':(s==='thinking'||s==='speaking')?' busy':'');
  const base=STATUS_TEXT[s]||s;
  statusText.textContent=detail?`${base} · ${detail}`:(handsFree&&s==='idle'?'Hands-free — just speak':base);
  const cap=$('stageStatus');
  if(cap){cap.classList.remove('err');
    cap.textContent=({idle:'SYSTEMS NOMINAL',listening:'AUDIO CAPTURE ACTIVE',thinking:'PROCESSING…',speaking:'VOICE OUTPUT ACTIVE'})[s]||'SYSTEMS NOMINAL'}
}
function setError(text){statusText.textContent=text;statusEl.className='status-line err'}

/* ---------------- websocket ---------------- */
function connect(){
  ws=new WebSocket(WS_URL);ws.binaryType='arraybuffer';
  ws.onopen=()=>{wsReady=true;badge.textContent='ONLINE';badge.className='badge on';
    talkBtn.disabled=false;handsBtn.disabled=false;
    $('textInput').disabled=false;$('sendBtn').disabled=false;setState('idle')};
  ws.onclose=()=>{wsReady=false;badge.textContent='OFFLINE';badge.className='badge';
    talkBtn.disabled=true;handsBtn.disabled=true;
    $('textInput').disabled=true;$('sendBtn').disabled=true;
    const cap=$('stageStatus');if(cap){cap.classList.add('err');cap.textContent='VOICE LINK OFFLINE'}
    setError('voice server offline — start voice\\START_VOICE.bat');setTimeout(connect,2000)};
  ws.onerror=()=>ws.close();
  ws.onmessage=e=>{
    if(typeof e.data!=='string'){if(expectAudio){expectAudio=false;playReply(e.data)}return}
    const m=JSON.parse(e.data);
    if(m.type==='status')setState(m.state,m.detail);
    else if(m.type==='user')addMsg('user',m.text);
    else if(m.type==='delta')appendTyping(m.text);
    else if(m.type==='reply')endTyping(m.text);
    else if(m.type==='audio')expectAudio=true;
    else if(m.type==='speech_done'){speechDone=true;if(!playing)setState('idle')}
    else if(m.type==='peer_speaking')peerUntil=Date.now()+m.seconds*1000+600;
    else if(m.type==='memory'||m.type==='memory_list')renderMemory(m);
    else if(m.type==='skills')renderSkills(m);
    else if(m.type==='sys')renderSys(m);
    else if(m.type==='jarvis')renderJarvis(m);
    else if(m.type==='motion')setMotion(m.on,m.detail);
    else if(m.type==='voices')renderVoices(m.list,m.active);
    else if(m.type==='voice_set')markVoice(m.id);
    else if(m.type==='error'){setError(m.text);endTyping()}
  };
}
connect();

/* ---------------- tabs + voice picker ---------------- */
const tabChat=$('tabChat'),tabVoice=$('tabVoice'),tabMemory=$('tabMemory'),tabSkills=$('tabSkills'),tabTasks=$('tabTasks');
function showTab(which){
  tabChat.classList.toggle('active',which==='chat');
  tabTasks.classList.toggle('active',which==='tasks');
  tabVoice.classList.toggle('active',which==='voice');
  tabMemory.classList.toggle('active',which==='memory');
  tabSkills.classList.toggle('active',which==='skills');
  $('chatPanel').hidden=which!=='chat';
  $('tasksPanel').hidden=which!=='tasks';
  $('voicePanel').hidden=which!=='voice';
  $('memoryPanel').hidden=which!=='memory';
  $('skillsPanel').hidden=which!=='skills';
  if(which==='skills'&&wsReady)ws.send(JSON.stringify({type:'skills'}));
  if(which==='memory'&&wsReady)ws.send(JSON.stringify({type:'memory_list'}));
  if(which==='tasks'&&wsReady)ws.send(JSON.stringify({type:'jarvis'}));
}
tabChat.onclick=()=>showTab('chat');
tabTasks.onclick=()=>showTab('tasks');
if(location.hash==='#tasks')showTab('tasks');
tabVoice.onclick=()=>showTab('voice');
tabMemory.onclick=()=>showTab('memory');
tabSkills.onclick=()=>showTab('skills');

let motionOn=false;
function renderSkills(d){
  if(d.robot){
    const fill=(id,arr)=>{
      const box=$(id);box.innerHTML='';
      for(const s of arr){
        const row=document.createElement('div');row.className='opt';
        row.innerHTML=`<span class="opt-text">&ldquo;${s}&rdquo;</span>`;
        box.appendChild(row);
      }
    };
    fill('robotSkills',d.robot);fill('laptopSkills',d.laptop);
  }
  if(d.motion_enabled!==undefined)setMotion(d.motion_enabled);
}
function setMotion(on,detail){
  motionOn=on;
  $('motionBtn').textContent=on?'Disable motion':'Enable motion (COM9)';
  $('motionBtn').className='btn'+(on?' btn-danger':'');
  $('motionNote').textContent=on
    ?'On. InMoov can move its eyes, face and jaw while speaking. Keep the servo power switch within reach.'
    :(detail&&detail!=='outputs off'?'Could not connect: '+detail
      :'Off. InMoov can talk but cannot move. Turn this on only after the servos are calibrated, with the power switch in reach. The browser calibrator must be disconnected first — one program at a time on COM9.');
}
$('motionBtn').onclick=()=>{
  if(!wsReady)return;
  if(!motionOn&&!confirm('Enable servo motion on COM9?\n\nMake sure the calibrator page is disconnected and the servo power switch is within reach.'))return;
  ws.send(JSON.stringify({type:'motion',on:!motionOn}));
};

function renderMemory(m){
  if(m.stats)$('memStats').textContent=
    `${m.stats.facts} things learned · ${m.stats.phrases} phrases heard · ${m.stats.exchanges} exchanges`;
  if(!m.facts)return;
  const box=$('memList');box.innerHTML='';
  if(!m.facts.length){
    box.innerHTML='<p class="note">Nothing learned yet. Talk to IRIS, or say "remember that my name is ...".</p>';
    return;
  }
  for(const f of [...m.facts].reverse()){
    const row=document.createElement('div');row.className='opt';
    row.innerHTML=`<span style="flex:1">${f.text}</span>`+
      `<button class="opt-x" title="Forget this" aria-label="Forget this">&times;</button>`;
    row.querySelector('.opt-x').onclick=()=>{
      if(wsReady)ws.send(JSON.stringify({type:'memory_forget',text:f.text}));
    };
    box.appendChild(row);
  }
}
/* ---------------- tasks + notes (JARVIS tab) ---------------- */
function renderJarvis(m){
  const list=$('taskList');if(!list)return;
  list.innerHTML='';
  $('taskDoneCount').textContent=m.done_today?m.done_today+' done today':'';
  if(!m.tasks.length)
    list.innerHTML='<p class="note">Nothing pending. Say "add task …", or type one below.</p>';
  for(const t of m.tasks){
    const row=document.createElement('div');row.className='opt';
    let due='';
    if(t.due&&t.due.includes(' ')){
      let[h,mn]=t.due.split(' ')[1].split(':').map(Number);
      const ap=h>=12?'PM':'AM';h=h%12||12;
      due=`<span class="opt-text" style="margin-left:auto">${h}:${String(mn).padStart(2,'0')} ${ap}</span>`;
    }else if(t.due){due='<span class="opt-text" style="margin-left:auto">tomorrow</span>'}
    row.innerHTML=`<span style="flex:1">${t.text}</span>${due}`+
      `<button class="opt-x" title="Mark done" aria-label="Mark done">&#10003;</button>`;
    row.querySelector('.opt-x').onclick=()=>{
      if(wsReady)ws.send(JSON.stringify({type:'task_done',id:t.id}));
    };
    list.appendChild(row);
  }
  $('noteStats').textContent=`${m.stats.notes} notes · ${m.stats.connections} connections`;
  const nl=$('noteList');nl.innerHTML='';
  if(!m.notes.length)
    nl.innerHTML='<p class="note">No notes yet. Say "take a note …".</p>';
  for(const n of m.notes){
    const row=document.createElement('div');row.className='opt';
    row.innerHTML=`<span class="opt-text">${n.at.slice(5,16)}</span><span style="flex:1">${n.text}</span>`;
    nl.appendChild(row);
  }
}
$('taskForm').addEventListener('submit',e=>{
  e.preventDefault();
  const text=$('taskInput').value.trim();
  if(text&&wsReady){ws.send(JSON.stringify({type:'task_add',text}));$('taskInput').value=''}
});
$('noteForm').addEventListener('submit',e=>{
  e.preventDefault();
  const text=$('noteInput').value.trim();
  if(text&&wsReady){ws.send(JSON.stringify({type:'note_add',text}));$('noteInput').value=''}
});
$('briefBtn').onclick=()=>{
  if(!wsReady)return;
  stopPlayback();showTab('chat');
  ws.send(JSON.stringify({type:'text',text:'daily briefing'}));
};

$('memClear').onclick=()=>{
  if(wsReady&&confirm('Forget everything InMoov has learned?'))
    ws.send(JSON.stringify({type:'memory_forget'}));
};

let voiceItems=[];
function renderVoices(list,active){
  voiceItems=list;
  let preferred=null;
  try{preferred=localStorage.getItem('inmoov-voice-v2')}catch{}
  const box=$('voiceList');box.innerHTML='';
  for(const v of list){
    const row=document.createElement('label');row.className='opt';
    row.innerHTML=`<input type="radio" name="voice" value="${v.id}"><span class="opt-text">${v.label}</span>`;
    row.querySelector('input').addEventListener('change',()=>{
      if(wsReady)ws.send(JSON.stringify({type:'set_voice',id:v.id}));
    });
    box.appendChild(row);
  }
  const want=preferred&&list.some(v=>v.id===preferred)?preferred:active;
  markVoice(want);
  if(want!==active&&wsReady)ws.send(JSON.stringify({type:'set_voice',id:want}));
}
function markVoice(id){
  document.querySelectorAll('#voiceList input').forEach(i=>i.checked=i.value===id);
  try{localStorage.setItem('inmoov-voice-v2',id)}catch{}
}
async function listMics(){
  try{
    const devs=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='audioinput');
    const sel=$('micSelect');if(!sel||!devs.length)return;
    let saved=null;try{saved=localStorage.getItem('inmoov-mic')}catch{}
    sel.innerHTML='';
    for(const d of devs){
      const o=document.createElement('option');
      o.value=d.deviceId;o.textContent=d.label||('Microphone '+(sel.length+1));
      sel.appendChild(o);
    }
    if(saved&&devs.some(d=>d.deviceId===saved)){sel.value=saved;micDeviceId=saved}
    else micDeviceId=sel.value||null;
  }catch{}
}
$('micSelect').addEventListener('change',async e=>{
  micDeviceId=e.target.value;
  try{localStorage.setItem('inmoov-mic',micDeviceId)}catch{}
  // drop the old stream so the next hold opens the newly chosen device
  micStream?.getTracks().forEach(t=>t.stop());micStream=null;
  micNode?.disconnect();micNode=null;
  setState('idle','microphone changed');
});
navigator.mediaDevices?.addEventListener?.('devicechange',listMics);
listMics();
$('voiceTest').addEventListener('click',()=>{
  if(!wsReady)return;
  stopPlayback();
  ws.send(JSON.stringify({type:'say',text:'Hello! I am InMoov. This is how my new voice sounds.'}));
});

/* ---------------- mic capture (16 kHz mono int16) ---------------- */
async function startCapture(){
  if(!wsReady||capturing)return;
  try{
    if(!micStream){
      const c={echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:16000};
      if(micDeviceId)c.deviceId={exact:micDeviceId};
      micStream=await navigator.mediaDevices.getUserMedia({audio:c});
      listMics();
    }
  }catch{setError('microphone permission denied');return}
  // Ask the browser for a 16 kHz context so IT does the resampling properly.
  // Picking every Nth sample by hand (the old way) aliases high frequencies
  // into the speech band and measurably wrecks recognition accuracy.
  if(!micCtx){
    const AC=window.AudioContext||window.webkitAudioContext;
    try{micCtx=new AC({sampleRate:16000})}catch{micCtx=new AC()}
  }
  await micCtx.resume();
  const src=micCtx.createMediaStreamSource(micStream);
  micNode=micCtx.createScriptProcessor(4096,1,1);
  const ratio=micCtx.sampleRate/16000;
  micNode.onaudioprocess=ev=>{
    if(!capturing)return;
    const f=ev.inputBuffer.getChannelData(0);
    let sum=0;for(let i=0;i<f.length;i+=8)sum+=f[i]*f[i];
    micLevel=Math.min(1,Math.sqrt(sum/(f.length/8))*7);
    const bar=$('micBar');if(bar)bar.style.width=(micLevel*100).toFixed(0)+'%';
    if(handsFree)vadTick(micLevel);
    let out;
    if(ratio===1){
      out=new Int16Array(f.length);
      for(let i=0;i<f.length;i++)out[i]=Math.max(-32768,Math.min(32767,f[i]*32767));
    }else{
      // Fallback: average each source window (box filter) instead of point
      // sampling, so we lose far less of the signal than nearest-neighbour.
      const n=Math.floor(f.length/ratio);out=new Int16Array(n);
      for(let i=0;i<n;i++){
        const a=Math.floor(i*ratio),b=Math.min(f.length,Math.floor((i+1)*ratio));
        let acc=0;for(let j=a;j<b;j++)acc+=f[j];
        const v=acc/Math.max(1,b-a);
        out[i]=Math.max(-32768,Math.min(32767,v*32767));
      }
    }
    if(wsReady)ws.send(out.buffer);
  };
  src.connect(micNode);micNode.connect(micCtx.destination);
  capturing=true;ws.send(JSON.stringify({type:'start'}));
  talkBtn.classList.add('rec');$('talkLabel').textContent='RELEASE TO SEND';setState('listening');
}
function stopCapture(){
  if(!capturing)return;
  capturing=false;micLevel=0;
  const bar=$('micBar');if(bar)bar.style.width='0%';
  micNode?.disconnect();micNode=null;
  talkBtn.classList.remove('rec');$('talkLabel').textContent='HOLD TO TALK';
  if(wsReady)ws.send(JSON.stringify({type:'stop',handsfree:handsFree}));
  stopPlayback();          // barge-in: talking interrupts the robot's audio
}

/* ---------------- playback + analyser ---------------- */
/* Sentences arrive one at a time while the model is still writing.
   Queue them and play back-to-back so speech starts early and stays seamless. */
let audioQueue=[],playing=false,speechDone=false;
function stopPlayback(){
  audioQueue=[];playing=false;speechDone=false;
  try{currentSource?.stop()}catch{}currentSource=null;outLevel=0;
}
async function playReply(arrayBuffer){
  outCtx??=new (window.AudioContext||window.webkitAudioContext)();
  await outCtx.resume();
  if(!analyser){analyser=outCtx.createAnalyser();analyser.fftSize=512;analyser.connect(outCtx.destination);analyserData=new Uint8Array(analyser.frequencyBinCount)}
  try{
    audioQueue.push(await outCtx.decodeAudioData(arrayBuffer.slice(0)));
  }catch{return setError('audio decode failed')}
  if(!playing)playNext();
}
let playToken=0;
function playNext(){
  const buf=audioQueue.shift();
  if(!buf){
    playing=false;currentSource=null;outLevel=0;
    if(speechDone)setState('idle');
    return;
  }
  playing=true;setState('speaking');
  const myToken=++playToken;
  const src=outCtx.createBufferSource();src.buffer=buf;src.connect(analyser);
  currentSource=src;
  src.onended=()=>{
    // Ignore a stale source that was replaced or stopped; only the newest
    // one may chain, so two sentences can never overlap.
    if(myToken!==playToken||!playing)return;
    setTimeout(()=>{if(myToken===playToken&&playing)playNext()},90); // breath between sentences
  };
  src.start();
}
function sampleOutLevel(){
  if(!currentSource||!analyser)return;
  analyser.getByteTimeDomainData(analyserData);
  let sum=0;for(let i=0;i<analyserData.length;i++){const v=(analyserData[i]-128)/128;sum+=v*v}
  outLevel=Math.min(1,Math.sqrt(sum/analyserData.length)*3.2);
}

/* ---------------- hands-free (JARVIS mode) ----------------
   No button: an energy gate watches the mic. Speech above the noise floor
   starts a turn; ~900 ms of quiet ends it. InMoov's own speech is ignored
   so it cannot talk to itself. */
let handsFree=false,hfOpen=false,hfLoud=0,hfQuiet=0,noiseFloor=0.02,hfStream=null,hfCtx=null,hfNode=null;
let peerUntil=0;   // another client (tray assistant) is playing IRIS's voice
const HF_START_FRAMES=3, HF_END_FRAMES=14;   // ~100 ms speech, ~900 ms silence

function vadTick(level){
  // Ignore the room while InMoov is speaking or thinking about a reply,
  // or while her voice is coming out of another client's speaker.
  if(state==='speaking'||state==='thinking'||Date.now()<peerUntil){hfLoud=0;hfQuiet=0;return}
  noiseFloor=level<noiseFloor?noiseFloor*0.97+level*0.03:noiseFloor*0.999+level*0.001;
  const gate=Math.max(0.055,noiseFloor*3.2);
  if(level>gate){
    hfQuiet=0;
    if(!hfOpen&&++hfLoud>=HF_START_FRAMES){hfOpen=true;hfLoud=0;startCapture()}
  }else{
    hfLoud=0;
    if(hfOpen&&++hfQuiet>=HF_END_FRAMES){hfOpen=false;hfQuiet=0;stopCapture()}
  }
}

async function startHandsFree(){
  if(!wsReady)return;
  try{
    const c={echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1};
    if(micDeviceId)c.deviceId={exact:micDeviceId};
    hfStream=await navigator.mediaDevices.getUserMedia({audio:c});
  }catch{setError('Microphone permission denied');return}
  const AC=window.AudioContext||window.webkitAudioContext;
  hfCtx=new AC();await hfCtx.resume();
  const src=hfCtx.createMediaStreamSource(hfStream);
  hfNode=hfCtx.createScriptProcessor(2048,1,1);
  hfNode.onaudioprocess=ev=>{
    if(!handsFree)return;
    const f=ev.inputBuffer.getChannelData(0);
    let s=0;for(let i=0;i<f.length;i+=4)s+=f[i]*f[i];
    const lvl=Math.min(1,Math.sqrt(s/(f.length/4))*7);
    if(!capturing){
      micLevel=lvl;
      const bar=$('micBar');if(bar)bar.style.width=(lvl*100).toFixed(0)+'%';
      vadTick(lvl);
    }
  };
  src.connect(hfNode);hfNode.connect(hfCtx.destination);
  handsFree=true;hfOpen=false;hfLoud=hfQuiet=0;noiseFloor=0.02;
  handsBtn.classList.add('on');talkBtn.disabled=true;
  setState('idle');
}
function stopHandsFree(){
  handsFree=false;hfOpen=false;
  hfNode?.disconnect();hfNode=null;
  hfStream?.getTracks().forEach(t=>t.stop());hfStream=null;
  hfCtx?.close().catch(()=>{});hfCtx=null;
  handsBtn.classList.remove('on');talkBtn.disabled=!wsReady;
  if(capturing)stopCapture();
  const bar=$('micBar');if(bar)bar.style.width='0%';
  setState('idle');
}
handsBtn.addEventListener('click',()=>handsFree?stopHandsFree():startHandsFree());

/* ---------------- push-to-talk ---------------- */
talkBtn.addEventListener('pointerdown',e=>{e.preventDefault();talkBtn.setPointerCapture(e.pointerId);startCapture()});
talkBtn.addEventListener('pointerup',()=>stopCapture());
talkBtn.addEventListener('pointercancel',()=>stopCapture());
window.addEventListener('keydown',e=>{
  if(e.code!=='Space'||e.repeat||e.target.tagName==='INPUT')return;
  e.preventDefault();startCapture();
});
window.addEventListener('keyup',e=>{if(e.code==='Space'&&e.target.tagName!=='INPUT'){e.preventDefault();stopCapture()}});

/* ---------------- typed chat ---------------- */
$('composer').addEventListener('submit',e=>{
  e.preventDefault();
  const text=$('textInput').value.trim();
  if(!text||!wsReady)return;
  $('textInput').value='';stopPlayback();
  ws.send(JSON.stringify({type:'text',text}));
});

/* ---------------- orb ---------------- */
const canvas=$('orb'),ctx2=canvas.getContext('2d');
const PALETTES={
  idle:     ['#062330','#136a85','#41d9ff','#c9f4ff'],
  listening:['#0d3a26','#1f9e63','#5fe39a','#d8ffe9'],
  thinking: ['#3a2a10','#b07c2a','#ffb340','#ffeccb'],
  speaking: ['#08303f','#1e9cc4','#5ee4ff','#ffffff']
};
const BLOBS=Array.from({length:5},(_,i)=>({
  phase:i*2.39996,               /* golden-angle spacing */
  speed:0.00022+i*0.00007,
  orbit:0.16+((i*0.13)%0.3),
  size:0.42+((i*0.19)%0.34)
}));
let smoothLevel=0;
const TAU=Math.PI*2;
/* palette of the reference emblem: icy blue band, white frame, amber accent */
const ICE='#a9d8e8', ICE_HI='#d8f2fb', FRAME='#eef8fd', AMBER='#f0c04a';
function stArc(cx,cy,r,a0,a1,w,color,alpha){
  ctx2.beginPath();ctx2.arc(cx,cy,r,a0,a1);
  ctx2.strokeStyle=color;ctx2.globalAlpha=alpha;ctx2.lineWidth=w;ctx2.stroke();
}
function drawOrb(t){
  const W=canvas.width,H=canvas.height,cx=W/2,cy=H/2;
  const target=state==='listening'?micLevel:state==='speaking'?outLevel:state==='thinking'?0.20+0.12*Math.sin(t*0.006):0.04;
  smoothLevel=target>smoothLevel?target:smoothLevel*0.92+target*0.08;
  const lv=smoothLevel;
  const base=W*0.5*(1+0.006*Math.sin(t*0.0012));      // gentle breathing
  const spin=state==='thinking'?2.2:1;
  const rotBand=t*0.00008*spin, rotTick=-t*0.00013*spin, rotFrame=t*0.00004*spin;
  /* state tint on the inner rim + text glow */
  const tint=state==='listening'?'#7fe8b0':state==='thinking'?AMBER:state==='speaking'?'#ffffff':ICE_HI;

  ctx2.clearRect(0,0,W,H);
  ctx2.lineCap='butt';

  /* faint halo */
  const halo=ctx2.createRadialGradient(cx,cy,base*0.3,cx,cy,base*0.98);
  halo.addColorStop(0,'rgba(140,205,230,0.10)');halo.addColorStop(1,'transparent');
  ctx2.globalAlpha=1;ctx2.fillStyle=halo;ctx2.fillRect(0,0,W,H);

  /* ═══ broad segmented ice band (the dominant annulus) ═══ */
  const bandR=base*0.525, bandW=base*0.155, SEG=44, gap=0.012;
  ctx2.save();ctx2.translate(cx,cy);ctx2.rotate(rotBand);
  for(let i=0;i<SEG;i++){
    const a0=i*TAU/SEG+gap, a1=(i+1)*TAU/SEG-gap;
    const shade=0.62+0.26*Math.sin(i*2.7)+lv*0.25;
    ctx2.beginPath();ctx2.arc(0,0,bandR,a0,a1);
    ctx2.strokeStyle=ICE;ctx2.globalAlpha=Math.min(1,Math.max(0.35,shade));
    ctx2.lineWidth=bandW;ctx2.stroke();
  }
  /* faint radial seams + screw dots on the band */
  ctx2.globalAlpha=0.5;ctx2.strokeStyle='#052029';ctx2.lineWidth=2;
  for(let i=0;i<SEG;i++){
    const a=i*TAU/SEG;
    ctx2.beginPath();
    ctx2.moveTo(Math.cos(a)*(bandR-bandW/2),Math.sin(a)*(bandR-bandW/2));
    ctx2.lineTo(Math.cos(a)*(bandR+bandW/2),Math.sin(a)*(bandR+bandW/2));
    ctx2.stroke();
  }
  ctx2.fillStyle='#e9f8ff';
  for(let i=0;i<10;i++){
    const a=i*TAU/10+0.31;
    ctx2.globalAlpha=0.55;
    ctx2.beginPath();ctx2.arc(Math.cos(a)*bandR,Math.sin(a)*bandR,base*0.008,0,TAU);ctx2.fill();
  }
  ctx2.restore();

  /* crisp rims of the band */
  ctx2.shadowColor=tint;ctx2.shadowBlur=8+lv*26;
  stArc(cx,cy,base*0.435,0,TAU,base*0.012,tint,0.95);           // inner rim (state tinted)
  ctx2.shadowBlur=0;
  stArc(cx,cy,base*0.415,0,TAU,2,FRAME,0.55);
  stArc(cx,cy,base*0.615,0,TAU,2.5,ICE_HI,0.7);

  /* ═══ amber accent arcs (left side, like the reference) ═══ */
  ctx2.save();ctx2.translate(cx,cy);ctx2.rotate(rotBand*0.5);
  stArc(0,0,base*0.468,TAU*0.42,TAU*0.60,2.5,AMBER,0.9);
  stArc(0,0,base*0.492,TAU*0.47,TAU*0.585,2,AMBER,0.75);
  stArc(0,0,base*0.53,TAU*0.545,TAU*0.585,base*0.028,AMBER,0.85); // small block
  ctx2.restore();

  /* ═══ tick bezel ═══ */
  ctx2.save();ctx2.translate(cx,cy);ctx2.rotate(rotTick);
  ctx2.strokeStyle=ICE_HI;ctx2.lineWidth=2.2;
  const tickIn=base*0.655,tickOut=base*0.715;
  for(let i=0;i<64;i++){
    const a=i*TAU/64;
    ctx2.globalAlpha=0.35+0.35*((i%4===0)?1:0)+lv*0.2;
    ctx2.beginPath();
    ctx2.moveTo(Math.cos(a)*tickIn,Math.sin(a)*tickIn);
    ctx2.lineTo(Math.cos(a)*(i%4===0?tickOut:tickIn+base*0.032),Math.sin(a)*(i%4===0?tickOut:tickIn+base*0.032));
    ctx2.stroke();
  }
  ctx2.restore();
  stArc(cx,cy,base*0.652,0,TAU,1.5,ICE,0.35);

  /* ═══ outer mechanical frame: broken arcs + blocks ═══ */
  ctx2.save();ctx2.translate(cx,cy);ctx2.rotate(rotFrame);
  const FR=[[8,74,0,3],[98,34,3,5],[145,86,0,3],[243,58,2,4],[312,34,0,3]];
  for(const [d0,span,off,w] of FR){
    stArc(0,0,base*(0.775+off*0.01),d0*TAU/360,(d0+span)*TAU/360,w,FRAME,0.8);
  }
  const BLOCKS=[[86,7],[137,6],[236,7],[305,6],[352,9]];
  for(const [d0,span] of BLOCKS){
    stArc(0,0,base*0.775,d0*TAU/360,(d0+span)*TAU/360,base*0.034,FRAME,0.9);
  }
  /* notch details */
  for(const [d0,span] of [[60,3],[180,3],[275,3]]){
    stArc(0,0,base*0.82,d0*TAU/360,(d0+span)*TAU/360,base*0.02,ICE,0.6);
  }
  ctx2.restore();

  /* ═══ dark center + name ═══ */
  const hole=ctx2.createRadialGradient(cx,cy,0,cx,cy,base*0.41);
  hole.addColorStop(0,'rgba(10,26,34,'+(0.35+lv*0.4)+')');
  hole.addColorStop(1,'rgba(2,8,11,0.9)');
  ctx2.globalAlpha=1;ctx2.fillStyle=hole;
  ctx2.beginPath();ctx2.arc(cx,cy,base*0.408,0,TAU);ctx2.fill();

  ctx2.font='700 '+Math.round(W*0.062)+'px Rajdhani, "Segoe UI", sans-serif';
  ctx2.textAlign='center';ctx2.textBaseline='middle';
  ctx2.shadowColor=tint;ctx2.shadowBlur=16+lv*30;
  ctx2.fillStyle='#f4fcff';
  ctx2.fillText('I . R . I . S .',cx,cy+W*0.004);
  ctx2.shadowBlur=0;ctx2.globalAlpha=1;
}
(function loop(t){sampleOutLevel();drawOrb(t||0);requestAnimationFrame(loop)})();


/* ---------------- HUD: live system stats + clock ---------------- */
function setBar(id,vid,val,warnAt=80){
  const bar=$(id);if(bar==null||val==null)return;
  bar.style.width=val+'%';
  bar.className='hud-bar'+(val>=92?' crit':val>=warnAt?' warn':'');
  const v=$(vid);if(v)v.textContent=val+'%';
}
function renderSys(m){
  setBar('sysCpu','sysCpuV',m.cpu);
  setBar('sysRam','sysRamV',m.ram);
  if(m.batt!=null){setBar('sysBatt','sysBattV',m.batt,25);
    const b=$('sysBatt');if(b&&m.batt<25&&!m.plugged)b.className='hud-bar crit';}
  setBar('sysDiskC','sysDiskCV',m.disk_c,85);
  setBar('sysDiskU','sysDiskUV',m.disk_u,85);
}
function tickClock(){
  const d=new Date();
  const set=(id,t)=>{const e=$(id);if(e)e.textContent=t};
  set('hudDay',String(d.getDate()).padStart(2,'0'));
  set('hudMonth',d.toLocaleString('en',{month:'long'}).toUpperCase());
  set('hudWeekday',d.toLocaleString('en',{weekday:'long'}).toUpperCase());
  set('hudClock',d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}));
}
tickClock();setInterval(tickClock,15000);

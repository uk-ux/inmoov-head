const SERVOS=[
  {group:'Eyes',name:'Left eye horizontal',ch:0,servo:1,aUs:1300,restUs:1477,bUs:1700,a:'Left',b:'Right'},
  {group:'Eyes',name:'Left eye vertical',ch:1,servo:2,aUs:1300,restUs:1500,bUs:1700,a:'Up',b:'Down'},
  {group:'Eyes',name:'Right eye horizontal',ch:2,servo:3,aUs:1300,restUs:1477,bUs:1700,a:'Left',b:'Right'},
  {group:'Eyes',name:'Right eye vertical',ch:3,servo:4,aUs:1700,restUs:1522,bUs:1300,a:'Up',b:'Down'},
  {group:'Eyelids',name:'Left upper eyelid',ch:4,servo:5,aUs:1322,restUs:1322,bUs:1500,a:'Open',b:'Closed',restIsA:true},
  {group:'Eyelids',name:'Left lower eyelid',ch:5,servo:6,aUs:1588,restUs:1588,bUs:1411,a:'Open',b:'Closed',restIsA:true},
  {group:'Eyelids',name:'Right upper eyelid',ch:6,servo:7,aUs:1655,restUs:1655,bUs:1500,a:'Open',b:'Closed',restIsA:true},
  {group:'Eyelids',name:'Right lower eyelid',ch:7,servo:8,aUs:1322,restUs:1322,bUs:1500,a:'Open',b:'Closed',restIsA:true},
  {group:'Eyebrows',name:'Left eyebrow',ch:8,servo:9,aUs:1677,restUs:1500,bUs:1322,a:'Lower',b:'Upper'},
  {group:'Eyebrows',name:'Right eyebrow',ch:9,servo:10,aUs:1322,restUs:1500,bUs:1700,a:'Lower',b:'Upper'},
  {group:'Nose',name:'Nose up / down',ch:10,servo:13,aUs:1366,restUs:1411,bUs:1500,a:'Down',b:'Up'},
  {group:'Jaw',name:'Jaw',ch:11,servo:14,aUs:1300,restUs:1300,bUs:1700,a:'Closed',b:'Fully open'},
  {group:'Forehead',name:'Left forehead',ch:12,servo:11,aUs:1344,restUs:1455,bUs:1700,a:'Lower',b:'Upper'},
  {group:'Forehead',name:'Right forehead',ch:13,servo:12,aUs:1611,restUs:1566,bUs:1322,a:'Lower',b:'Upper'},
  {group:'Cheeks',name:'Left cheek',ch:14,servo:15,aUs:1700,restUs:1500,bUs:1300,a:'Down',b:'Pulled'},
  {group:'Cheeks',name:'Right cheek',ch:15,servo:16,aUs:1300,restUs:1500,bUs:1700,a:'Down',b:'Pulled'}
];

const STORAGE_KEY='inmoov-full-calibration-v1';
const $=id=>document.getElementById(id);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const bounds=s=>[Math.min(s.aUs,s.bUs),Math.max(s.aUs,s.bUs)];
const pulseToPosition=(s,pulse)=>clamp(Math.round((pulse-s.aUs)*180/(s.bUs-s.aUs)),0,180);
const chip=point=>point?`${point.pulse}`:'—';

let port=null,writer=null,reader=null,reading=false,queue=Promise.resolve();
let active=SERVOS[0],activePulse=SERVOS[0].restUs,lastMovedPulse=null,lastMoveAt=0;
let drafts={},saved=loadSaved();

function loadSaved(){
  try{
    const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}');
    return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  }catch{return {}}
}

function setMessage(text,tone=''){
  $('moveStatus').textContent=text;
  $('moveStatus').className=`message ${tone}`.trim();
}

// ---------- card grid ----------
function buildCards(){
  const grid=$('cardGrid');
  for(const s of SERVOS){
    const [min,max]=bounds(s);
    const card=document.createElement('div');
    card.className='fcard';card.id=`fcard-${s.ch}`;card.tabIndex=0;
    card.innerHTML=
      `<div class="fc-top"><span class="channel">CH${s.ch}</span>`+
      `<div class="fc-name"><strong>${s.name}</strong><span>${s.group} · servo ${s.servo} · ${min}–${max} us</span></div>`+
      `<span class="saved-dot"></span></div>`+
      `<div class="fc-chips">`+
      `<span class="fc-chip" data-k="a">${s.a}: <b>—</b></span>`+
      `<span class="fc-chip" data-k="n">Rest: <b>—</b></span>`+
      `<span class="fc-chip" data-k="b">${s.b}: <b>—</b></span></div>`+
      `<div class="fc-bottom"><button class="fc-test" disabled>Test rest</button><span class="fc-state">Not saved</span></div>`;
    card.addEventListener('click',()=>select(s));
    card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(s)}});
    const test=card.querySelector('.fc-test');
    test.addEventListener('click',e=>{e.stopPropagation();select(s);goRest()});
    s.ui={card,chips:{a:card.querySelector('[data-k="a"] b'),n:card.querySelector('[data-k="n"] b'),b:card.querySelector('[data-k="b"] b')},state:card.querySelector('.fc-state'),test};
    grid.appendChild(card);
  }
}

function renderCard(s){
  const record=saved[s.ch],draft=drafts[s.ch]||{};
  s.ui.chips.a.textContent=chip(draft.a||record?.endpoint_a);
  s.ui.chips.n.textContent=chip(draft.neutral||record?.neutral_or_rest);
  s.ui.chips.b.textContent=chip(draft.b||record?.endpoint_b);
  s.ui.card.classList.toggle('saved',Boolean(record));
  s.ui.card.classList.toggle('active',s.ch===active.ch);
  s.ui.state.textContent=record?'Saved':(draft.a||draft.b||draft.neutral)?'In progress':'Not saved';
}

function renderAll(){
  SERVOS.forEach(renderCard);
  const count=Object.keys(saved).filter(ch=>SERVOS.some(s=>s.ch===Number(ch))).length;
  $('progressStatus').textContent=`${count} / 16 saved`;
}

// ---------- selection + active bar ----------
function select(servo){
  active=servo;activePulse=servo.restUs;lastMovedPulse=null;
  const [min,max]=bounds(servo);
  $('activeGroup').textContent=servo.group.toUpperCase();
  $('activeName').textContent=servo.name;
  $('activeMeta').textContent=`CH${servo.ch} · servo ${servo.servo} · ${min}–${max} us`;
  $('labelA').textContent=servo.a;$('labelB').textContent=servo.b;
  $('sliderLabelA').textContent=`${servo.a} ${servo.aUs}`;$('sliderLabelB').textContent=`${servo.b} ${servo.bUs}`;
  $('recordNeutral').hidden=Boolean(servo.restIsA);
  $('pulseSlider').min=min;$('pulseSlider').max=max;
  $('pulseInput').min=min;$('pulseInput').max=max;
  syncInputs(servo.restUs);renderAll();
  setMessage(`CH${servo.ch} selected. Nothing moved. Rest = ${servo.restUs} us.`,'warn');
  servo.ui.card.scrollIntoView({block:'nearest'});
}

function syncInputs(pulse){
  const [min,max]=bounds(active);
  activePulse=clamp(Math.round(Number(pulse)||min),min,max);
  $('pulseInput').value=activePulse;$('pulseSlider').value=activePulse;
  $('positionReadout').textContent=`pos ${pulseToPosition(active,activePulse)}`;
}

// ---------- serial ----------
async function sendRaw(command){
  if(!writer)return false;
  queue=queue.then(()=>writer.write(new TextEncoder().encode(command+'\n')))
    .then(()=>true).catch(error=>{setMessage(error.message,'bad');return false});
  return queue;
}

async function readSerial(){
  reading=true;const decoder=new TextDecoder();
  while(port?.readable&&reading){
    reader=port.readable.getReader();
    try{
      while(true){
        const {value,done}=await reader.read();if(done)break;
        if(value){const reply=decoder.decode(value,{stream:true}).trim().split(/\r?\n/).at(-1);if(reply){$('controllerStatus').textContent=reply;if(reply.includes('FAULT'))setMessage(reply,'bad')}}
      }
    }catch(error){if(reading)setMessage(error.message,'bad')}
    finally{reader.releaseLock();reader=null}
  }
}

async function connect(){
  if(!('serial' in navigator))return setMessage('Use Chrome or Edge. This browser does not support Web Serial.','bad');
  try{
    port=await navigator.serial.requestPort();await port.open({baudRate:115200});writer=port.writable.getWriter();
    $('connectionStatus').textContent='Uno connected';$('connect').textContent='Disconnect';$('controllerStatus').textContent='Connected / no movement sent';
    updateEnabled();readSerial();setMessage('Connected. Confirm the safety checkbox, then Test rest on CH0.','good');
  }catch(error){setMessage(`Connection failed: ${error.message}`,'bad')}
}

async function disconnect(){
  if(writer)await sendRaw('0');reading=false;if(reader)await reader.cancel();
  if(writer){writer.releaseLock();writer=null}if(port){await port.close();port=null}
  $('connectionStatus').textContent='Disconnected';$('connect').textContent='Connect Uno';$('controllerStatus').textContent='Outputs off';
  $('armed').checked=false;lastMovedPulse=null;updateEnabled();setMessage('Disconnected.','warn');
}

async function outputsOff(){
  if(!writer)return;await sendRaw('0');lastMovedPulse=null;
  $('controllerStatus').textContent='Outputs off';setMessage('All PCA9685 outputs are off.','good');
}

function updateEnabled(){
  const armed=Boolean(writer)&&$('armed').checked;
  ['minus10','minus5','goRest','plus5','plus10','goPulse','recordA','recordNeutral','recordB','saveNext'].forEach(id=>$(id).disabled=!armed);
  SERVOS.forEach(s=>s.ui.test.disabled=!armed);
  $('outputsOff').disabled=!writer;
}

// ---------- movement (K only) ----------
async function moveTo(pulse){
  if(!writer)return setMessage('Connect the Uno first.','bad');
  if(!$('armed').checked)return setMessage('Confirm the safety checkbox before moving.','warn');
  syncInputs(pulse);
  const ok=await sendRaw(`K${active.ch} ${activePulse}`);if(!ok)return;
  lastMovedPulse=activePulse;lastMoveAt=performance.now();
  setMessage(`CH${active.ch} → ${activePulse} us (pos ${pulseToPosition(active,activePulse)}). Only this channel is driven. Inspect, then record.`,'good');
}
const nudge=delta=>moveTo(activePulse+delta);
const goRest=()=>moveTo(active.restUs);

// ---------- record + save ----------
function currentPoint(){
  if(lastMovedPulse===null||lastMovedPulse!==activePulse||performance.now()-lastMoveAt<500){
    setMessage('Move to this value, wait half a second, inspect it, then record.','warn');return null;
  }
  return {position:pulseToPosition(active,activePulse),pulse:activePulse,verified:true};
}

function recordPoint(field){
  const point=currentPoint();if(!point)return;
  drafts[active.ch]??={};drafts[active.ch][field]=point;
  if(active.restIsA&&field==='a')drafts[active.ch].neutral={...point};
  renderCard(active);
  const label=field==='a'?active.a:field==='b'?active.b:'rest';
  setMessage(`Recorded ${point.pulse} us as ${label} for CH${active.ch}.`,'good');
}

function saveActive(){
  const draft=drafts[active.ch]||{};
  if(!draft.a||!draft.b||(!active.restIsA&&!draft.neutral))return setMessage('Record both endpoints and rest before saving.','bad');
  if(draft.a.pulse===draft.b.pulse)return setMessage('The two endpoints must be different.','bad');
  const neutral=active.restIsA?draft.a:draft.neutral;
  const low=Math.min(draft.a.pulse,draft.b.pulse),high=Math.max(draft.a.pulse,draft.b.pulse);
  if(neutral.pulse<low||neutral.pulse>high)return setMessage('Rest must be between the two endpoint pulses.','bad');
  saved[active.ch]={channel:active.ch,servo:active.servo,part:active.name,group:active.group,endpoint_a_label:active.a,endpoint_a:draft.a,neutral_or_rest:neutral,endpoint_b_label:active.b,endpoint_b:draft.b,updated:new Date().toISOString(),applied_to_firmware:false};
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(saved))}catch{return setMessage('Browser storage failed. Export the values now.','bad')}
  renderAll();
  const start=SERVOS.findIndex(s=>s.ch===active.ch);
  const next=[...SERVOS.slice(start+1),...SERVOS.slice(0,start)].find(s=>!saved[s.ch]);
  outputsOff();
  if(next){select(next);setMessage(`CH${start>=0?SERVOS[start].ch:''} saved, outputs off. Next: CH${next.ch} ${next.name}. Press R (or Rest) to start it.`,'good')}
  else setMessage('All 16 channels saved. Export JSON and CSV for firmware review.','good');
}

// ---------- export (same format as classic calibrator) ----------
function download(name,type,text){
  const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportJson(){
  const data={version:1,kind:'inmoov-calibration-drafts-not-applied',exported:new Date().toISOString(),saved_count:Object.keys(saved).length,servos:SERVOS.map(s=>saved[s.ch]||{channel:s.ch,part:s.name,status:'not_saved'})};
  download('inmoov-16-servo-calibration.json','application/json',JSON.stringify(data,null,2));
}
function csvCell(value){return `"${String(value??'').replaceAll('"','""')}"`}
function exportCsv(){
  const header=['channel','part','endpoint_a_label','endpoint_a_position','endpoint_a_us','neutral_position','neutral_us','endpoint_b_label','endpoint_b_position','endpoint_b_us','updated'];
  const rows=[header.join(',')];
  for(const servo of SERVOS){
    const r=saved[servo.ch];
    rows.push([servo.ch,servo.name,r?.endpoint_a_label,r?.endpoint_a?.position,r?.endpoint_a?.pulse,r?.neutral_or_rest?.position,r?.neutral_or_rest?.pulse,r?.endpoint_b_label,r?.endpoint_b?.position,r?.endpoint_b?.pulse,r?.updated].map(csvCell).join(','));
  }
  download('inmoov-16-servo-calibration.csv','text/csv',rows.join('\r\n'));
}

// ---------- keyboard ----------
window.addEventListener('keydown',e=>{
  const tag=e.target.tagName;
  if(tag==='INPUT'&&e.target.type!=='checkbox'&&e.target.type!=='range'){
    if(e.key==='Enter'&&e.target.id==='pulseInput'){e.preventDefault();moveTo($('pulseInput').value)}
    return;
  }
  const key=e.key.toLowerCase();
  if(e.key==='ArrowLeft'){e.preventDefault();nudge(e.shiftKey?-10:-5)}
  else if(e.key==='ArrowRight'){e.preventDefault();nudge(e.shiftKey?10:5)}
  else if(e.key==='ArrowUp'||e.key==='ArrowDown'){
    e.preventDefault();
    const i=SERVOS.findIndex(s=>s.ch===active.ch);
    select(SERVOS[(i+(e.key==='ArrowDown'?1:SERVOS.length-1))%SERVOS.length]);
  }
  else if(key==='r'){e.preventDefault();goRest()}
  else if(key==='a'){e.preventDefault();recordPoint('a')}
  else if(key==='n'&&!active.restIsA){e.preventDefault();recordPoint('neutral')}
  else if(key==='b'){e.preventDefault();recordPoint('b')}
  else if(e.key==='Enter'){e.preventDefault();saveActive()}
  else if(e.key===' '||e.key==='Escape'||e.key==='0'){e.preventDefault();outputsOff()}
});

// ---------- wire up ----------
buildCards();
$('pulseSlider').addEventListener('input',e=>syncInputs(e.target.value));
$('pulseSlider').addEventListener('change',e=>moveTo(e.target.value));
$('pulseInput').addEventListener('input',e=>{const v=Number(e.target.value);if(Number.isFinite(v))activePulse=clamp(Math.round(v),...bounds(active))});
$('goPulse').onclick=()=>moveTo($('pulseInput').value);
$('minus10').onclick=()=>nudge(-10);$('minus5').onclick=()=>nudge(-5);
$('plus5').onclick=()=>nudge(5);$('plus10').onclick=()=>nudge(10);
$('goRest').onclick=goRest;
$('recordA').onclick=()=>recordPoint('a');$('recordNeutral').onclick=()=>recordPoint('neutral');$('recordB').onclick=()=>recordPoint('b');
$('saveNext').onclick=saveActive;
$('exportJson').onclick=exportJson;$('exportCsv').onclick=exportCsv;
$('armed').addEventListener('change',()=>{lastMovedPulse=null;updateEnabled();setMessage($('armed').checked?'Safety confirmed. Movement unlocked for one channel at a time.':'Movement controls locked.',$('armed').checked?'warn':'')});
$('connect').onclick=()=>port?disconnect():connect();
$('outputsOff').onclick=outputsOff;
navigator.serial?.addEventListener('disconnect',()=>disconnect().catch(()=>{}));

select(active);renderAll();

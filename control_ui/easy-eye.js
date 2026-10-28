const SERVOS=[
  {ch:0,name:'Left eye horizontal',rest:1412},
  {ch:1,name:'Left eye vertical',rest:1545,minus:'◀ Hold DOWN',plus:'Hold UP ▶',aLabel:'Set UP limit',bLabel:'Set DOWN limit'},
  {ch:2,name:'Right eye horizontal',rest:1482},
  {ch:3,name:'Right eye vertical',rest:1472},
  {ch:4,name:'Left upper eyelid',rest:1367},
  {ch:5,name:'Left lower eyelid',rest:1623},
  {ch:6,name:'Right upper eyelid',rest:1520},
  {ch:7,name:'Right lower eyelid',rest:1287},
  {ch:8,name:'Left eyebrow',rest:1517,min:1362,max:1677,minus:'◀ Hold UPPER',plus:'Hold LOWER ▶',aLabel:'Set LOWER safe limit',bLabel:'Set UPPER safe limit'},
  {ch:9,name:'Right eyebrow',rest:1537,min:1322,max:1670,minus:'◀ Hold LOWER',plus:'Hold UPPER ▶',aLabel:'Set LOWER safe limit',bLabel:'Set UPPER safe limit'}
];
const $=id=>document.getElementById(id);
let port,writer,reader,reading=false,queue=Promise.resolve();
let selected=SERVOS[0],pulse=selected.rest,armed=false;
let holdTimer=null,holdBusy=false;
const records=Object.fromEntries(SERVOS.map(s=>[s.ch,{}]));
try{
  const saved=JSON.parse(localStorage.getItem('inmoov-brow-calibration-v1')||'{}');
  for(const ch of [8,9])if(saved[ch])records[ch]=saved[ch];
}catch{}

function renderChannels(){
  $('channels').innerHTML='';
  for(const servo of SERVOS){
    const button=document.createElement('button');button.className=`channel${servo.ch===selected.ch?' active':''}`;
    button.innerHTML=`<strong>CH${servo.ch} · ${servo.name}</strong><span>Rest ${servo.rest} µs</span>`;
    button.onclick=()=>selectServo(servo);$('channels').appendChild(button);
  }
}
function render(){
  $('selectedName').textContent=selected.name;$('selectedMeta').textContent=`CH${selected.ch} · saved rest ${selected.rest} µs`;
  $('pulse').textContent=pulse;const r=records[selected.ch];
  const lid=selected.ch>=4&&selected.ch<=7,brow=selected.ch>=8;
  $('minus').textContent=selected.minus||'◀ Hold toward A';$('plus').textContent=selected.plus||'Hold toward B ▶';
  $('labelA').textContent=lid?'Set OPEN / REST':(selected.aLabel||'Set endpoint A');
  $('labelR').textContent='Set center';
  $('labelB').textContent=lid?'Set CLOSED':(selected.bLabel||'Set endpoint B');
  $('setR').hidden=lid;
  $('valueA').textContent=r.a?`${r.a} µs`:'Not set';$('valueR').textContent=r.r?`${r.r} µs`:'Not set';$('valueB').textContent=r.b?`${r.b} µs`:'Not set';
  const connected=Boolean(writer),safe=$('safe').checked;
  $('start').disabled=!connected||!safe;['minus','plus','setA','setR','setB'].forEach(id=>$(id).disabled=!connected||!safe||!armed);
  $('save').disabled=!connected;$('off').disabled=!connected;
  const complete=lid?Boolean(r.a&&r.b):Boolean(r.a&&r.r&&r.b);
  $('next').disabled=!complete;
  $('guide').textContent=!armed?'Press Start selected servo at rest.':!r.a?(lid?'Hold a movement button until fully open, then press Set OPEN / REST.':selected.ch===1?'Hold UP until the safe limit, then press Set UP limit.':brow?`Move carefully, then press ${selected.aLabel}.`:'Hold toward endpoint A, then record it.'):(!lid&&!r.r)?'Move to the natural center, then press Set center.':!r.b?(lid?'Move carefully to closed, then press Set CLOSED.':selected.ch===1?'Hold DOWN until the safe limit, then press Set DOWN limit.':brow?`Move carefully, then press ${selected.bLabel}.`:'Hold toward endpoint B, then record it.'):'This servo is complete. Press the green button for the next channel.';
  renderChannels();
}
function message(text){$('reply').textContent=text}
async function send(command){
  if(!writer)return false;
  queue=queue.then(()=>writer.write(new TextEncoder().encode(command+'\n'))).catch(error=>message(error.message));
  await queue;return true;
}
async function selectServo(servo){
  if(writer)await send(servo.ch<8?`S ${servo.ch}`:'OFF');selected=servo;pulse=servo.rest;armed=false;message(`CH${servo.ch} selected · no movement`);render();
}
async function start(){
  if(selected.ch<8){await send(`S ${selected.ch}`);await send('ARM')}else await send(`K${selected.ch} ${selected.rest}`);
  pulse=selected.rest;armed=true;message(`Only CH${selected.ch} is active at ${pulse} µs`);render();
}
async function nudge(delta){
  pulse=Math.max(selected.min||1000,Math.min(selected.max||2000,pulse+delta));
  await send(selected.ch<8?(delta>0?'+':'-'):`K${selected.ch} ${pulse}`);message(`CH${selected.ch}: ${pulse} µs`);render();
}
async function record(key,command){records[selected.ch][key]=pulse;if(selected.ch<8)await send(command);message(`Recorded ${command} = ${pulse} µs for CH${selected.ch}`);render()}
async function recordA(){
  records[selected.ch].a=pulse;if(selected.ch<8)await send('A');
  if(selected.ch>=4){records[selected.ch].r=pulse;await send('R')}
  message(selected.ch>=4?`Open/rest saved at ${pulse} µs`:`Endpoint A saved at ${pulse} µs`);render();
}
function stopHold(){clearInterval(holdTimer);holdTimer=null;holdBusy=false}
async function holdStep(delta){if(holdBusy||!armed)return;holdBusy=true;try{await nudge(delta)}finally{holdBusy=false}}
function startHold(delta){if(!armed)return;stopHold();holdStep(delta);holdTimer=setInterval(()=>holdStep(delta),180)}
async function nextServo(){
  await send('OFF');const next=SERVOS[(SERVOS.indexOf(selected)+1)%SERVOS.length];selected=next;pulse=next.rest;armed=false;$('safe').checked=false;message(`CH${next.ch} selected · confirm safety before starting`);render();
}
async function off(){await send('OFF');armed=false;$('safe').checked=false;message('All PCA outputs OFF');render()}

async function readSerial(){
  reading=true;const decoder=new TextDecoder();
  while(port?.readable&&reading){
    reader=port.readable.getReader();
    try{
      while(true){
        const {value,done}=await reader.read();if(done)break;
        if(value){
          const line=decoder.decode(value,{stream:true}).trim().split(/\r?\n/).at(-1);
          if(line){
            message(line);
            if(line.includes('FAULT')||line.includes('REJECTED')){armed=false;render()}
          }
        }
      }
    }catch(error){if(reading)message(error.message)}
    finally{reader.releaseLock();reader=null}
  }
}
async function connect(){
  if(!('serial' in navigator)){message('Use Chrome or Edge for Web Serial');return}
  try{port=await navigator.serial.requestPort();await port.open({baudRate:115200});writer=port.writable.getWriter();$('connect').textContent='Disconnect';$('connection').textContent='Uno connected';$('dot').classList.add('live');readSerial();message('Connected · choose a servo');render()}catch(error){message(error.message)}
}
async function disconnect(){
  if(writer)await send('OFF');reading=false;if(reader)await reader.cancel();if(writer){writer.releaseLock();writer=null}if(port){await port.close();port=null}
  armed=false;$('connect').textContent='Connect Uno';$('connection').textContent='Disconnected';$('dot').classList.remove('live');message('Disconnected');render();
}

$('connect').onclick=()=>port?disconnect():connect();$('safe').onchange=render;$('start').onclick=start;
for(const [button,delta] of [[$('minus'),-5],[$('plus'),5]]){
  button.onpointerdown=event=>{event.preventDefault();button.setPointerCapture?.(event.pointerId);startHold(delta)};
  button.onpointerup=stopHold;button.onpointercancel=stopHold;button.onpointerleave=stopHold;
}
$('setA').onclick=recordA;$('setR').onclick=()=>record('r','R');$('setB').onclick=()=>record('b','B');$('next').onclick=nextServo;$('save').onclick=async()=>{
  const brows={8:records[8],9:records[9]};
  const verticalEyes={1:records[1],3:records[3]};
  localStorage.setItem('inmoov-brow-calibration-v1',JSON.stringify(brows));
  localStorage.setItem('inmoov-eye-vertical-calibration-v1',JSON.stringify(verticalEyes));
  await send('SAVE');armed=false;message('Eye limits saved in Uno EEPROM and Face Control · eyebrow limits saved for Face Control · outputs OFF');render();
};$('off').onclick=off;
navigator.serial?.addEventListener('disconnect',()=>disconnect().catch(()=>{}));render();

// Measurement recorder: stored drafts do not silently change operating limits.
export function addCalibrators(servos,{connected,stop,move}){
  const key='inmoov-calibration-drafts-v1';
  let records={};try{records=JSON.parse(localStorage.getItem(key)||'{}');if(!records||Array.isArray(records)||typeof records!=='object')records={};}catch{}
  const dialog=document.createElement('dialog');dialog.className='calibration-dialog';
  dialog.innerHTML=`<h2 id="cal-title">Calibrate</h2>
    <p>Pause at each position and inspect the real mechanism. These are commanded pulses, not measured angles. First activation may jump.</p>
    <p id="cal-range"></p><label for="cal-pulse">Target pulse (microseconds)</label>
    <input id="cal-pulse" type="number" step="1">
    <div class="cal-actions"><button data-action="minus">−5 µs</button><button data-action="move">Move</button><button data-action="plus">+5 µs</button></div>
    <div class="cal-actions"><button data-action="a"></button><button data-action="neutral">Record neutral</button><button data-action="b"></button></div>
    <pre id="cal-values"></pre><p id="cal-status" role="status"></p>
    <p>Save stores a calibration draft in this browser. Export it for review and firmware integration. Existing animation and blink settings are not changed.</p>
    <div class="cal-actions"><button data-action="save">Save draft</button><button data-action="export">Export all drafts</button><button data-action="off" class="danger">Outputs off</button><button data-action="close">Close</button></div>`;
  dialog.setAttribute('aria-labelledby','cal-title');document.body.appendChild(dialog);
  const get=id=>dialog.querySelector('#'+id),btn=a=>dialog.querySelector(`[data-action="${a}"]`);
  let active,draft,lastSent=null,settledAt=0,busy=false;
  const show=()=>get('cal-values').textContent=`${active.left}: ${draft.a??'not recorded'} µs\n${active.group==='eyelids'?'':`Neutral: ${draft.neutral??'not recorded'} µs\n`}${active.right}: ${draft.b??'not recorded'} µs`;
  const status=text=>get('cal-status').textContent=text;
  async function doMove(delta=0){
    if(busy||!connected())return status('Connect Uno before moving.');
    const value=Number(get('cal-pulse').value)+delta;
    const min=Math.min(active.low,active.high),max=Math.max(active.low,active.high);
    if(get('cal-pulse').value.trim()===''||!Number.isInteger(value)||value<min||value>max)return status(`Enter a whole pulse from ${min} to ${max} µs.`);
    busy=true;lastSent=null;
    try{
      const ok=await move(active.ch,value);
      if(!ok)return status('Command failed. Check connection.');
      get('cal-pulse').value=value;lastSent=value;settledAt=performance.now()+500;
      status(`Sent CH${active.ch}: ${value} µs. Wait and check movement before recording.`);
    }finally{busy=false;}
  }
  function record(field){
    if(!connected()||lastSent===null||busy||performance.now()<settledAt)return status('Move first, wait half a second, then record only if the mechanism reached the position.');
    draft[field]=lastSent;
    if(active.group==='eyelids')draft.neutral=draft.a;
    show();status('Recorded in draft. Check every position, then Save draft.');
  }
  btn('move').onclick=()=>doMove();btn('minus').onclick=()=>doMove(-5);btn('plus').onclick=()=>doMove(5);
  btn('a').onclick=()=>record('a');btn('b').onclick=()=>record('b');btn('neutral').onclick=()=>record('neutral');
  btn('save').onclick=()=>{
    const {a,b,neutral}=draft,min=Math.min(active.low,active.high),max=Math.max(active.low,active.high);
    if(![a,b,neutral].every(v=>Number.isInteger(v)&&v>=min&&v<=max)||a===b||neutral<Math.min(a,b)||neutral>Math.max(a,b))return status('Record two different endpoints and a neutral between them (or at an endpoint).');
    const next={...records,[active.ch]:{channel:active.ch,name:active.name,a_label:active.left,a_us:a,neutral_us:neutral,b_label:active.right,b_us:b,updated:new Date().toISOString()}};
    try{localStorage.setItem(key,JSON.stringify(next));records=next;status('Draft saved in this browser. Export it to update the firmware later.');}catch{status('Browser storage failed. Draft was not saved.');}
  };
  btn('export').onclick=()=>{
    const blob=new Blob([JSON.stringify({version:1,kind:'calibration-drafts-not-applied',parts:Object.values(records)},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='inmoov-calibration-drafts.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const halt=async()=>{lastSent=null;await stop();status('Outputs off.');};
  btn('off').onclick=halt;
  btn('close').onclick=async()=>{await halt();dialog.close();};
  dialog.addEventListener('cancel',e=>{e.preventDefault();btn('close').click();});
  servos.forEach(s=>{
    const button=document.createElement('button');button.textContent='Calibrate';button.disabled=true;
    s.ui.neutralButton.parentElement.prepend(button);
    button.onclick=async()=>{
      if(!connected())return;
      active=s;const prior=records[s.ch];draft={a:prior?.a_us,neutral:prior?.neutral_us,b:prior?.b_us};lastSent=null;
      get('cal-title').textContent=`Calibrate ${s.name} · CH${s.ch}`;
      const input=get('cal-pulse');input.min=Math.min(s.low,s.high);input.max=Math.max(s.low,s.high);input.value=s.neutral;
      get('cal-range').textContent=`Current firmware range: ${input.min}–${input.max} µs. Larger changes require firmware review.`;
      btn('a').textContent=`Record ${s.left}`;btn('b').textContent=`Record ${s.right}`;btn('neutral').hidden=s.group==='eyelids';
      show();status('Stopping animation and tracking…');dialog.showModal();
      await halt();status('Outputs off. Enter a pulse, press Move, and observe before recording.');
    };
  });
}

const PIDS = [
  {key:'rpm', name:'Régime moteur', unit:'rpm', cmd:'010C', parse:b=>((b[2]*256+b[3])/4).toFixed(0)},
  {key:'speed', name:'Vitesse véhicule', unit:'km/h', cmd:'010D', parse:b=>b[2].toFixed(0)},
  {key:'load', name:'Charge moteur', unit:'%', cmd:'0104', parse:b=>(b[2]*100/255).toFixed(1)},
  {key:'absLoad', name:'Charge absolue', unit:'%', cmd:'0143', parse:b=>((b[2]*256+b[3])*100/255).toFixed(1)},
  {key:'throttle', name:'Papillon', unit:'%', cmd:'0111', parse:b=>(b[2]*100/255).toFixed(1)},
  {key:'coolant', name:'Liquide refroid.', unit:'°C', cmd:'0105', parse:b=>(b[2]-40).toFixed(0)},
  {key:'iat', name:'IAT', unit:'°C', cmd:'010F', parse:b=>(b[2]-40).toFixed(0)},
  {key:'ambient', name:'Temp. ambiante', unit:'°C', cmd:'0146', parse:b=>(b[2]-40).toFixed(0)},
  {key:'maf', name:'MAF', unit:'g/s', cmd:'0110', parse:b=>((b[2]*256+b[3])/100).toFixed(2)},
  {key:'map', name:'MAP', unit:'kPa', cmd:'010B', parse:b=>b[2].toFixed(0)},
  {key:'baro', name:'Baro', unit:'kPa', cmd:'0133', parse:b=>b[2].toFixed(0)},
  {key:'stft1', name:'STFT B1', unit:'%', cmd:'0106', parse:b=>((b[2]-128)*100/128).toFixed(1)},
  {key:'ltft1', name:'LTFT B1', unit:'%', cmd:'0107', parse:b=>((b[2]-128)*100/128).toFixed(1)},
  {key:'o2b1s1', name:'O2 B1S1 pré-cat', unit:'V', cmd:'0114', parse:b=>(b[2]/200).toFixed(3)},
  {key:'o2b1s2', name:'O2 B1S2 post-cat', unit:'V', cmd:'0115', parse:b=>(b[2]/200).toFixed(3)},
  {key:'fuelRate', name:'Débit carburant', unit:'L/h', cmd:'015E', parse:b=>((b[2]*256+b[3])*0.05).toFixed(2)},
  {key:'timing', name:'Avance allumage', unit:'°BTDC', cmd:'010E', parse:b=>(b[2]/2-64).toFixed(1)},
  // PIDs Honda non standards : à remplacer par les commandes exactes K-Line/CAN si tu les as.
  {key:'vtec', name:'i‑VTEC', unit:'status', cmd:null, parse:null},
  {key:'vtecPress', name:'Pression VTEC', unit:'switch', cmd:null, parse:null},
  {key:'oilTemp', name:'Température huile', unit:'°C', cmd:null, parse:null}
];

const SERVICE_UUIDS = ['0000ffe0-0000-1000-8000-00805f9b34fb','6e400001-b5a3-f393-e0a9-e50e24dcca9e'];
const WRITE_UUIDS = ['0000ffe1-0000-1000-8000-00805f9b34fb','6e400002-b5a3-f393-e0a9-e50e24dcca9e'];
const NOTIFY_UUIDS = ['0000ffe1-0000-1000-8000-00805f9b34fb','6e400003-b5a3-f393-e0a9-e50e24dcca9e'];
let server, writeChar, notifyChar, rx='', pendingResolve=null, logging=false, timer=null, rows=[];

const $ = id => document.getElementById(id);
const log = m => {$('console').textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`; $('console').scrollTop = $('console').scrollHeight};

function render(){
  $('gauges').innerHTML = PIDS.map(p=>`<div class="card"><div class="name">${p.name}</div><div class="value" id="v-${p.key}">—</div><div class="unit">${p.unit}</div></div>`).join('');
}
function setStatus(text, cls=''){ $('status').textContent=text; $('status').className=cls; }
function bytesToHexResponse(txt){
  const clean = txt.replace(/SEARCHING|STOPPED|NO DATA|>/gi,' ').replace(/\s+/g,' ').trim();
  const m = clean.match(/41\s+[0-9A-F]{2}(?:\s+[0-9A-F]{2})+/i);
  return m ? m[0].split(/\s+/).map(x=>parseInt(x,16)) : null;
}
async function writeLine(s){ await writeChar.writeValue(new TextEncoder().encode(s+'\r')); }
async function cmd(s, timeout=1200){
  rx=''; await writeLine(s);
  return new Promise(res=>{ pendingResolve=res; setTimeout(()=>{ if(pendingResolve){pendingResolve=null; res(rx)} }, timeout); });
}
function onNotify(e){
  rx += new TextDecoder().decode(e.target.value);
  if(rx.includes('>') && pendingResolve){ const r=rx; const done=pendingResolve; pendingResolve=null; done(r); }
}
async function connect(){
  if(!navigator.bluetooth){ alert('Web Bluetooth non disponible. Android Chrome conseillé; iPhone Safari ne le supporte pas.'); return; }
  const device = await navigator.bluetooth.requestDevice({filters:[{namePrefix:'OBD'},{namePrefix:'ELM'},{namePrefix:'Vgate'}], optionalServices:SERVICE_UUIDS});
  server = await device.gatt.connect();
  for(let i=0;i<SERVICE_UUIDS.length;i++){
    try{ const svc=await server.getPrimaryService(SERVICE_UUIDS[i]); writeChar=await svc.getCharacteristic(WRITE_UUIDS[i]); notifyChar=await svc.getCharacteristic(NOTIFY_UUIDS[i]); break; }catch(e){}
  }
  if(!writeChar || !notifyChar) throw new Error('Service BLE série introuvable');
  await notifyChar.startNotifications(); notifyChar.addEventListener('characteristicvaluechanged', onNotify);
  setStatus('Connecté','ok'); $('logBtn').disabled=false; $('csvBtn').disabled=false;
  for(const c of ['ATZ','ATE0','ATL0','ATS0','ATH0','ATSP0']) log(`${c}: ${await cmd(c,1600)}`);
}
async function poll(){
  const row = {time:new Date().toISOString()};
  for(const p of PIDS){
    if(!p.cmd){ row[p.key]=''; continue; }
    const r = await cmd(p.cmd);
    const b = bytesToHexResponse(r);
    let val = '';
    try{ if(b && b[1]===parseInt(p.cmd.slice(2),16)) val=p.parse(b); }catch(e){}
    row[p.key]=val;
    const el=$('v-'+p.key); if(el) el.textContent = val || '—';
  }
  if(logging) rows.push(row);
}
function startStop(){
  logging=!logging; $('logBtn').textContent=logging?'Arrêter log':'Démarrer log';
  if(logging){ rows=[]; timer=setInterval(poll, 1000); poll(); setStatus('Logging','warn'); }
  else { clearInterval(timer); setStatus('Connecté','ok'); }
}
function exportCsv(){
  const headers=['time',...PIDS.map(p=>p.key)];
  const csv=[headers.join(',')].concat(rows.map(r=>headers.map(h=>`"${String(r[h]??'').replaceAll('"','""')}"`).join(','))).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='honda-obd-log.csv'; a.click();
}
render();
$('connectBtn').onclick=()=>connect().catch(e=>{log('Erreur: '+e.message); setStatus('Erreur','warn')});
$('logBtn').onclick=startStop; $('csvBtn').onclick=exportCsv; $('clearBtn').onclick=()=>{$('console').textContent=''; rows=[]};

// ============================================================
// LP BOT MONITOR v2 — Con Balance, Tokens y Transacciones
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_DIR = path.join(__dirname, 'logs');
const ENV_FILE = path.join(__dirname, '.env');

function getState() {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {}
  return { activePositions: [], positionHistory: [], totalNetPnL: 0 };
}
function getLogs(lines = 80) {
  try { const f = path.join(LOG_DIR, 'bot-' + new Date().toISOString().slice(0, 10) + '.log'); if (!fs.existsSync(f)) return 'Sin logs hoy'; return fs.readFileSync(f, 'utf8').split('\\n').slice(-lines).join('\\n'); } catch (_) { return 'Error'; }
}
function getPM2Status() {
  try { const { execSync } = require('child_process'); const p = JSON.parse(execSync('pm2 jlist 2>/dev/null').toString()); const b = p.find(x => x.name === 'lp-bot'); if (b) return { status: b.pm2_env.status, uptime: b.pm2_env.pm_uptime, restarts: b.pm2_env.restart_time, cpu: b.monit?.cpu || 0, mem: ((b.monit?.memory || 0) / 1e6).toFixed(1) }; } catch (_) {}
  return { status: 'unknown', uptime: 0, restarts: 0, cpu: 0, mem: 0 };
}
function getWalletAddr() {
  try { const { execSync } = require('child_process');
    const key = fs.readFileSync(ENV_FILE, 'utf8').trim().split('=')[1];
    if (key) { const r = execSync("cd /root/lp-bot && node -e \"const{Keypair}=require('@solana/web3.js');const d=function(s){const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';const M={};A.split('').forEach((c,i)=>M[c]=i);let z=0;for(let i=0;i<s.length&&s[i]==='1';i++)z++;const sz=Math.ceil(s.length*733/1000)+1;const b=new Uint8Array(sz);for(let i=0;i<s.length;i++){let carry=M[s[i]];for(let j=sz-1;j>=0;j--){carry+=58*b[j];b[j]=carry%256;carry=Math.floor(carry/256)}}let st=0;while(st<sz&&b[st]===0)st++;const r=new Uint8Array(z+sz-st);for(let i=z+sz-st-1,j=sz-1;j>=st;i--,j--)r[i]=b[j];return r};console.log(Keypair.fromSecretKey(d('" + key + "')).publicKey.toString())\" 2>/dev/null").toString().trim(); return r; }
  } catch (_) {} return '';
}

let cachedAddr = '';

const HTML = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta name="theme-color" content="#f0b90b"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="/manifest.json"><title>LP Monitor</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#06080e;color:#dfe4ed;font-family:monospace;font-size:12px;padding:8px;min-height:100vh}
.c{background:#0b0e18;border:1px solid #1a2035;border-radius:10px;padding:11px;margin-bottom:7px}
.t{font-weight:700;font-size:9px;letter-spacing:2px;margin-bottom:5px;color:#f0b90b}
.sts{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin:5px 0;font-size:8px;text-align:center}
.st{background:#0d1120;border-radius:4px;padding:5px 2px}.stl{color:#5c6478;font-size:6px}.stv{font-weight:800;font-size:11px}
.pc{background:#0d1120;border:1px solid #1a2035;border-radius:6px;padding:8px;margin:4px 0;font-size:9px}
.log{background:#060810;border:1px solid #1a2035;border-radius:6px;padding:5px;max-height:280px;overflow-y:auto;font-size:7px;white-space:pre-wrap;word-break:break-all;line-height:1.4}
.tabs{display:flex;gap:2px;margin-bottom:5px}.tab{flex:1;padding:6px 2px;border-radius:5px;border:1px solid #1a2035;background:#0b0e18;color:#5c6478;font-size:8px;font-weight:700;text-align:center;cursor:pointer}
.tab.on{background:#f0b90b18;border-color:#f0b90b44;color:#f0b90b}
.on-g{color:#86efac}.on-r{color:#fca5a5}
.b{display:block;width:100%;padding:10px;border-radius:8px;border:none;font-weight:800;font-size:11px;margin-top:5px;font-family:monospace;cursor:pointer;background:#f0b90b22;color:#f0b90b;border:1px solid #f0b90b44}
.alert{background:#ef444422;border:1px solid #ef444444;color:#fca5a5;padding:5px;border-radius:4px;font-size:9px;margin:4px 0}
#refresh{position:fixed;bottom:10px;right:10px;width:44px;height:44px;border-radius:50%;background:#f0b90b;color:#000;border:none;font-size:18px;font-weight:800;cursor:pointer;z-index:99}
.wb{font-size:28px;font-weight:800;color:#fff;text-align:center;padding:6px 0}
.wu{font-size:14px;color:#86efac;text-align:center}
.wa{word-break:break-all;font-size:8px;color:#5c6478;text-align:center;padding:3px 0}
.tk{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #1a203533;font-size:9px}
.tx{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a203533;font-size:8px}
a{color:#f0b90b;text-decoration:none}
</style></head><body>
<div class="c"><div style="display:flex;align-items:center;gap:6px"><div style="width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg,#f0b90b,#f97316);display:flex;align-items:center;justify-content:center;font-size:13px">💧</div><div><div style="font-size:13px;font-weight:800;color:#f0b90b">LP BOT MONITOR</div><div style="font-size:7px;color:#5c6478" id="pm2s">Cargando...</div></div><div style="margin-left:auto" id="dot">⚪</div></div></div>
<div class="c"><div class="t">💰 WALLET</div><div class="wb" id="wB">—</div><div class="wu" id="wU">—</div><div class="wa" id="wA">...</div><a id="wL" href="#" target="_blank" style="display:block;text-align:center;font-size:8px;margin-top:2px">Solscan ↗</a></div>
<div class="c"><div class="sts" id="stats"></div></div>
<div class="tabs"><div class="tab on" onclick="sT('wal')">💰WAL</div><div class="tab" onclick="sT('pos')">📊POS</div><div class="tab" onclick="sT('log')">📋LOG</div><div class="tab" onclick="sT('ctl')">⚙️CTL</div></div>
<div id="walTab" class="c"><div class="t">🪙 TOKENS</div><div id="tL">Cargando...</div><div style="margin-top:8px"><div class="t">📜 ÚLTIMAS TRANSACCIONES</div><div id="xL">Cargando...</div></div></div>
<div id="posTab" class="c" style="display:none"><div class="t">📊 POSICIONES LP</div><div id="pL">Cargando...</div></div>
<div id="logTab" class="c" style="display:none"><div class="t">📋 LOGS</div><div id="lC" class="log">Cargando...</div></div>
<div id="ctlTab" class="c" style="display:none"><div class="t">⚙️ CONTROL</div><button class="b" onclick="api('/restart')">🔄 Reiniciar Bot</button><button class="b" onclick="api('/stop')" style="color:#fca5a5;border-color:#ef444444;background:#ef444411">⏹ Parar Bot</button><button class="b" onclick="api('/start')" style="color:#86efac;border-color:#22c55e44;background:#22c55e11">▶ Iniciar Bot</button><div style="margin-top:8px;font-size:8px;color:#5c6478" id="cM"></div></div>
<button id="refresh" onclick="loadAll()">↻</button>
<script>
let curTab='wal',wAddr='',solP=0;
function sT(t){curTab=t;['wal','pos','log','ctl'].forEach(x=>{const e=document.getElementById(x+'Tab');if(e)e.style.display=x===t?'block':'none'});document.querySelectorAll('.tab').forEach((e,i)=>{e.className='tab'+(['wal','pos','log','ctl'][i]===t?' on':'')})}

async function getSolP(){try{const r=await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');if(r.ok){const d=await r.json();const p=(d.pairs||[]).find(x=>(x.quoteToken?.symbol||'').includes('USD'));if(p)solP=+(p.priceUsd||0)}}catch(_){}}

async function getWal(){if(!wAddr)return;
try{const r=await fetch('https://solana-rpc.publicnode.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[wAddr]})});
if(r.ok){const d=await r.json();const s=(d.result?.value||0)/1e9;document.getElementById('wB').textContent=s.toFixed(4)+' SOL';document.getElementById('wU').textContent='≈ $'+(s*solP).toFixed(2)+' USD'}

const tr=await fetch('https://solana-rpc.publicnode.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'getTokenAccountsByOwner',params:[wAddr,{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{encoding:'jsonParsed'}]})});
if(tr.ok){const td=await tr.json();const ac=td.result?.value||[];
const tks=ac.map(a=>{const i=a.account?.data?.parsed?.info;return{mint:i?.mint||'',amt:+(i?.tokenAmount?.uiAmount||0),dec:i?.tokenAmount?.decimals||0}}).filter(t=>t.amt>0).sort((a,b)=>b.amt-a.amt);
document.getElementById('tL').innerHTML=tks.length?tks.map(t=>'<div class="tk"><div style="color:#a5f3fc">'+t.mint.slice(0,6)+'...'+t.mint.slice(-4)+'</div><div style="font-weight:800;color:#fff">'+t.amt.toFixed(Math.min(t.dec,4))+'</div></div>').join(''):'<div style="color:#5c6478;font-size:9px">Solo SOL</div>'}

const sr=await fetch('https://solana-rpc.publicnode.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'getSignaturesForAddress',params:[wAddr,{limit:10}]})});
if(sr.ok){const sd=await sr.json();const sigs=sd.result||[];
document.getElementById('xL').innerHTML=sigs.length?sigs.map(s=>{const t=s.blockTime?new Date(s.blockTime*1000).toLocaleString('es-AR',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}):'?';const ok=s.err===null;
return'<div class="tx"><div><span style="color:'+(ok?'#86efac':'#fca5a5')+'">'+(ok?'✅':'❌')+'</span> '+t+'</div><div><a href="https://solscan.io/tx/'+s.signature+'" target="_blank">'+s.signature.slice(0,10)+'...↗</a></div></div>'}).join(''):'<div style="color:#5c6478">Sin txns</div>'}
}catch(_){}}

async function loadAll(){try{
const r=await fetch('/api/status');const d=await r.json();const pm=d.pm2||{};const st=d.state||{};const pos=st.activePositions||[];const hist=st.positionHistory||[];const isOn=pm.status==='online';
document.getElementById('dot').innerHTML=isOn?'🟢':'🔴';
document.getElementById('pm2s').textContent=isOn?'Online | CPU:'+pm.cpu+'% | RAM:'+pm.mem+'MB':'Offline';
if(d.walletAddr&&!wAddr){wAddr=d.walletAddr;document.getElementById('wA').textContent=wAddr;document.getElementById('wL').href='https://solscan.io/account/'+wAddr}
const up=pm.uptime?Math.floor((Date.now()-pm.uptime)/60000):0;
const tN=pos.reduce((s,p)=>s+(p.netPnL||p.net||0),0)+(st.totalNetPnL||0);
document.getElementById('stats').innerHTML='<div class="st"><div class="stl">STATUS</div><div class="stv '+(isOn?'on-g':'on-r')+'">'+(isOn?'ON':'OFF')+'</div></div><div class="st"><div class="stl">UPTIME</div><div class="stv">'+Math.floor(up/60)+'h'+(up%60)+'m</div></div><div class="st"><div class="stl">LP</div><div class="stv" style="color:#06b6d4">'+pos.length+'</div></div><div class="st"><div class="stl">PnL</div><div class="stv '+(tN>=0?'on-g':'on-r')+'">'+(tN>=0?'+':'')+tN.toFixed(4)+'</div></div>';

let ph='';if(pos.length){pos.forEach(p=>{const inR=p.cp>=p.rLow&&p.cp<=p.rHigh;ph+='<div class="pc"><div style="display:flex;justify-content:space-between"><div><b style="color:#f0b90b">'+(p.sym||'?')+'</b></div><div style="color:'+((p.net||0)>=0?'#86efac':'#fca5a5')+';font-weight:800">'+((p.net||0)>=0?'+':'')+((p.net||0)).toFixed(4)+'◎</div></div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:2px;margin:3px 0;font-size:7px"><div>Cap<br><b>'+(p.cap||0).toFixed(2)+'◎</b></div><div>Fees<br><b style="color:#86efac">+'+(p.fees||0).toFixed(4)+'</b></div><div>IL<br><b style="color:'+((p.il||0)>=-2?'#86efac':'#fca5a5')+'">'+(p.il||0).toFixed(1)+'%</b></div><div>Rng<br><b style="color:'+(inR?'#86efac':'#fca5a5')+'">'+(inR?'IN':'OUT')+'</b></div></div></div>'})}else{ph='<div style="color:#5c6478;font-size:9px">Sin posiciones</div>'}
if(hist.length){ph+='<div style="margin-top:6px;font-size:7px;color:#f0b90b;font-weight:700">HIST</div>';hist.slice(0,8).forEach(h=>{ph+='<div style="display:flex;justify-content:space-between;font-size:8px;padding:2px 0;border-bottom:1px solid #1a203533"><span>'+(h.sym||'?')+'</span><span style="color:'+((h.pnl||0)>=0?'#86efac':'#fca5a5')+'">'+((h.pnl||0)>=0?'+':'')+((h.pnl||0)).toFixed(4)+'◎</span></div>'})}
document.getElementById('pL').innerHTML=ph;
document.getElementById('lC').textContent=d.logs||'Sin logs';const lc=document.getElementById('lC');lc.scrollTop=lc.scrollHeight;
}catch(e){document.getElementById('pm2s').textContent='Err: '+e.message}
await getSolP();await getWal()}

async function api(p){document.getElementById('cM').textContent='...';try{const r=await fetch(p,{method:'POST'});const d=await r.json();document.getElementById('cM').textContent=d.msg||'OK';setTimeout(loadAll,2000)}catch(e){document.getElementById('cM').textContent='Err: '+e.message}}
loadAll();setInterval(loadAll,15000);
</script></body></html>`;

const MANIFEST = JSON.stringify({name:"LP Bot Monitor",short_name:"LP Mon",start_url:"/",display:"standalone",background_color:"#06080e",theme_color:"#f0b90b",icons:[{src:"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💧</text></svg>",sizes:"any",type:"image/svg+xml"}]});

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); }
  else if (req.url === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(MANIFEST); }
  else if (req.url === '/api/status') {
    if (!cachedAddr) cachedAddr = getWalletAddr();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pm2: getPM2Status(), state: getState(), logs: getLogs(80), walletAddr: cachedAddr, time: new Date().toISOString() }));
  }
  else if (req.url === '/restart' && req.method === 'POST') { try { require('child_process').execSync('pm2 restart lp-bot'); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({msg:'✅ Reiniciado'})); } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({msg:'❌ '+e.message})); }}
  else if (req.url === '/stop' && req.method === 'POST') { try { require('child_process').execSync('pm2 stop lp-bot'); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({msg:'⏹ Detenido'})); } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({msg:'❌ '+e.message})); }}
  else if (req.url === '/start' && req.method === 'POST') { try { require('child_process').execSync('cd /root/lp-bot && export SNIPER_KEY=$(cat .env | cut -d= -f2) && pm2 start index.js --name lp-bot 2>/dev/null || pm2 restart lp-bot'); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({msg:'▶ Iniciado'})); } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({msg:'❌ '+e.message})); }}
  else { res.writeHead(404); res.end('Not found'); }
});
server.listen(PORT, '0.0.0.0', () => { console.log('LP Monitor v2 on http://0.0.0.0:' + PORT); });

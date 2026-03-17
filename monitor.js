// ============================================================
// LP BOT MONITOR — Dashboard Web para celular
// Corre en el VPS, accedés desde http://TU_IP:3000
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_DIR = path.join(__dirname, 'logs');

function getState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { activePositions: [], positionHistory: [], totalNetPnL: 0 };
}

function getLogs(lines = 50) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(LOG_DIR, `bot-${today}.log`);
    if (!fs.existsSync(logFile)) return 'Sin logs hoy';
    const content = fs.readFileSync(logFile, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch (_) { return 'Error leyendo logs'; }
}

function getPM2Status() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('pm2 jlist 2>/dev/null').toString();
    const procs = JSON.parse(out);
    const bot = procs.find(p => p.name === 'lp-bot');
    if (bot) return { status: bot.pm2_env.status, uptime: bot.pm2_env.pm_uptime, restarts: bot.pm2_env.restart_time, cpu: bot.monit?.cpu || 0, mem: ((bot.monit?.memory || 0) / 1e6).toFixed(1) };
  } catch (_) {}
  return { status: 'unknown', uptime: 0, restarts: 0, cpu: 0, mem: 0 };
}

const HTML = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta name="theme-color" content="#f0b90b"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="/manifest.json"><title>LP Bot Monitor</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#06080e;color:#dfe4ed;font-family:monospace;font-size:12px;padding:8px;min-height:100vh}
.c{background:#0b0e18;border:1px solid #1a2035;border-radius:10px;padding:11px;margin-bottom:7px}
.t{font-weight:700;font-size:9px;letter-spacing:2px;margin-bottom:5px;color:#f0b90b}
.sts{display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin:5px 0;font-size:8px;text-align:center}
.st{background:#0d1120;border-radius:4px;padding:5px 2px}.stl{color:#5c6478;font-size:6px}.stv{font-weight:800;font-size:11px}
.pc{background:#0d1120;border:1px solid #1a2035;border-radius:6px;padding:8px;margin:4px 0;font-size:9px}
.log{background:#060810;border:1px solid #1a2035;border-radius:6px;padding:5px;max-height:300px;overflow-y:auto;font-size:7px;white-space:pre-wrap;word-break:break-all;line-height:1.4}
.tabs{display:flex;gap:2px;margin-bottom:5px}.tab{flex:1;padding:6px 2px;border-radius:5px;border:1px solid #1a2035;background:#0b0e18;color:#5c6478;font-size:8px;font-weight:700;text-align:center;cursor:pointer}
.tab.on{background:#f0b90b18;border-color:#f0b90b44;color:#f0b90b}
.on-g{color:#86efac}.on-r{color:#fca5a5}.on-y{color:#fde68a}
.b{display:block;width:100%;padding:10px;border-radius:8px;border:none;font-weight:800;font-size:11px;margin-top:5px;font-family:monospace;cursor:pointer;background:#f0b90b22;color:#f0b90b;border:1px solid #f0b90b44}
.alert{background:#ef444422;border:1px solid #ef444444;color:#fca5a5;padding:5px;border-radius:4px;font-size:9px;margin:4px 0}
#refresh{position:fixed;bottom:10px;right:10px;width:44px;height:44px;border-radius:50%;background:#f0b90b;color:#000;border:none;font-size:18px;font-weight:800;cursor:pointer;z-index:99;box-shadow:0 2px 10px #f0b90b44}
</style></head><body>
<div class="c"><div style="display:flex;align-items:center;gap:6px"><div style="width:26px;height:26px;border-radius:6px;background:linear-gradient(135deg,#f0b90b,#f97316);display:flex;align-items:center;justify-content:center;font-size:13px">💧</div><div><div style="font-size:13px;font-weight:800;color:#f0b90b">LP BOT MONITOR</div><div style="font-size:7px;color:#5c6478" id="pm2s">Cargando...</div></div><div style="margin-left:auto" id="dot">⚪</div></div></div>
<div class="c"><div class="sts" id="stats"><div class="st"><div class="stl">STATUS</div><div class="stv">—</div></div><div class="st"><div class="stl">UPTIME</div><div class="stv">—</div></div><div class="st"><div class="stl">POOLS</div><div class="stv">—</div></div><div class="st"><div class="stl">NET PnL</div><div class="stv">—</div></div></div></div>
<div class="tabs"><div class="tab on" onclick="sT('pos')">📊 POSICIONES</div><div class="tab" onclick="sT('log')">📋 LOGS</div><div class="tab" onclick="sT('ctl')">⚙️ CONTROL</div></div>
<div id="posTab" class="c"><div class="t">📊 POSICIONES LP</div><div id="posL">Cargando...</div></div>
<div id="logTab" class="c" style="display:none"><div class="t">📋 LOGS EN VIVO</div><div id="logC" class="log">Cargando...</div></div>
<div id="ctlTab" class="c" style="display:none"><div class="t">⚙️ CONTROL</div>
<button class="b" onclick="api('/restart')">🔄 Reiniciar Bot</button>
<button class="b" onclick="api('/stop')" style="color:#fca5a5;border-color:#ef444444;background:#ef444411">⏹ Parar Bot</button>
<button class="b" onclick="api('/start')" style="color:#86efac;border-color:#22c55e44;background:#22c55e11">▶ Iniciar Bot</button>
<div style="margin-top:10px;font-size:8px;color:#5c6478" id="ctlMsg"></div>
</div>
<button id="refresh" onclick="loadAll()">↻</button>
<script>
let curTab='pos';
function sT(t){curTab=t;['pos','log','ctl'].forEach(x=>{document.getElementById(x+'Tab').style.display=x===t?'block':'none'});document.querySelectorAll('.tab').forEach((el,i)=>{el.className='tab'+(['pos','log','ctl'][i]===t?' on':'')})}
const $=n=>n>=1e6?'$'+(n/1e6).toFixed(1)+'M':n>=1e3?'$'+(n/1e3).toFixed(0)+'K':'$'+n.toFixed(0);

async function loadAll(){
  try{
    const r=await fetch('/api/status');const d=await r.json();
    const pm=d.pm2||{};const st=d.state||{};const pos=st.activePositions||[];const hist=st.positionHistory||[];
    const isOn=pm.status==='online';
    document.getElementById('dot').innerHTML=isOn?'🟢':'🔴';
    document.getElementById('pm2s').textContent=isOn?'Online | CPU:'+pm.cpu+'% | RAM:'+pm.mem+'MB | Restarts:'+pm.restarts:'Offline';
    const up=pm.uptime?Math.floor((Date.now()-pm.uptime)/60000):0;const upH=Math.floor(up/60),upM=up%60;
    const tNet=pos.reduce((s,p)=>s+(p.netPnL||p.net||0),0)+(st.totalNetPnL||0);
    document.getElementById('stats').innerHTML=
      '<div class="st"><div class="stl">STATUS</div><div class="stv '+(isOn?'on-g':'on-r')+'">'+(isOn?'ON':'OFF')+'</div></div>'+
      '<div class="st"><div class="stl">UPTIME</div><div class="stv">'+upH+'h'+upM+'m</div></div>'+
      '<div class="st"><div class="stl">LP</div><div class="stv" style="color:#06b6d4">'+pos.length+'</div></div>'+
      '<div class="st"><div class="stl">NET PnL</div><div class="stv '+(tNet>=0?'on-g':'on-r')+'">'+(tNet>=0?'+':'')+tNet.toFixed(4)+'</div></div>';
    
    // Positions
    let ph='';
    if(pos.length){pos.forEach(p=>{
      const inR=p.cp>=p.rLow&&p.cp<=p.rHigh;
      ph+='<div class="pc">'+(p.exitAlert?'<div class="alert">🚨 '+(p.exitR||p.exitReason||'')+'</div>':'')+
        '<div style="display:flex;justify-content:space-between"><div><b style="color:#f0b90b">'+(p.sym||'?')+'</b> <span style="color:#5c6478;font-size:7px">'+(p.dex||'')+'</span></div>'+
        '<div style="color:'+((p.net||p.netPnL||0)>=0?'#86efac':'#fca5a5')+';font-weight:800">'+((p.net||p.netPnL||0)>=0?'+':'')+((p.net||p.netPnL||0)).toFixed(4)+'◎</div></div>'+
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:2px;margin:3px 0;font-size:7px">'+
        '<div>Capital<br><b>'+(p.cap||p.capitalSOL||0).toFixed(2)+'◎</b></div>'+
        '<div>Fees<br><b style="color:#86efac">+'+(p.fees||p.estFees||0).toFixed(4)+'</b></div>'+
        '<div>IL<br><b style="color:'+((p.il||0)>=-2?'#86efac':(p.il||0)>=-5?'#fde68a':'#fca5a5')+'">'+(p.il||0).toFixed(1)+'%</b></div>'+
        '<div>Range<br><b style="color:'+(inR?'#86efac':'#fca5a5')+'">'+(inR?'IN ✅':'OUT ⚠️')+'</b></div></div></div>';
    })}else{ph='<div style="color:#5c6478;font-size:9px">Sin posiciones activas</div>'}
    if(hist.length){ph+='<div style="margin-top:6px;font-size:7px;color:#f0b90b;font-weight:700">HISTORIAL</div>';
      hist.slice(0,10).forEach(h=>{ph+='<div style="display:flex;justify-content:space-between;font-size:8px;padding:2px 0;border-bottom:1px solid #1a203533"><span>'+(h.sym||'?')+' <span style="color:#5c6478">'+(h.reason||'').slice(0,25)+'</span></span><span style="color:'+((h.pnl||h.pnlSOL||0)>=0?'#86efac':'#fca5a5')+'">'+((h.pnl||h.pnlSOL||0)>=0?'+':'')+((h.pnl||h.pnlSOL||0)).toFixed(4)+'◎</span></div>'})
    }
    document.getElementById('posL').innerHTML=ph;
    
    // Logs
    document.getElementById('logC').textContent=d.logs||'Sin logs';
    const lc=document.getElementById('logC');lc.scrollTop=lc.scrollHeight;
    
  }catch(e){document.getElementById('pm2s').textContent='Error: '+e.message}
}

async function api(path){
  document.getElementById('ctlMsg').textContent='Ejecutando...';
  try{const r=await fetch(path,{method:'POST'});const d=await r.json();document.getElementById('ctlMsg').textContent=d.msg||'OK';setTimeout(loadAll,2000)}catch(e){document.getElementById('ctlMsg').textContent='Error: '+e.message}
}

loadAll();setInterval(loadAll,10000);
</script></body></html>`;

const MANIFEST = JSON.stringify({
  name: "LP Bot Monitor",
  short_name: "LP Mon",
  start_url: "/",
  display: "standalone",
  background_color: "#06080e",
  theme_color: "#f0b90b",
  icons: [{ src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💧</text></svg>", sizes: "any", type: "image/svg+xml" }]
});

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  } else if (req.url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(MANIFEST);
  } else if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pm2: getPM2Status(),
      state: getState(),
      logs: getLogs(80),
      time: new Date().toISOString()
    }));
  } else if (req.url === '/restart' && req.method === 'POST') {
    try { require('child_process').execSync('pm2 restart lp-bot'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg: '✅ Bot reiniciado' })); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg: '❌ ' + e.message })); }
  } else if (req.url === '/stop' && req.method === 'POST') {
    try { require('child_process').execSync('pm2 stop lp-bot'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg: '⏹ Bot detenido' })); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg: '❌ ' + e.message })); }
  } else if (req.url === '/start' && req.method === 'POST') {
    try { require('child_process').execSync('cd /root/lp-bot && export SNIPER_KEY=$(cat .env | cut -d= -f2) && pm2 start index.js --name lp-bot'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg: '▶ Bot iniciado' })); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg: '❌ ' + e.message })); }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`💧 LP Bot Monitor running on http://0.0.0.0:${PORT}`);
  console.log(`📱 Open from your phone: http://YOUR_IP:${PORT}`);
});

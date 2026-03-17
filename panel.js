var http = require('http');
var exec = require('child_process').exec;
var fs = require('fs');

var PORT = 3000;
var STATE_FILE = '/root/lp-bot/state.json';
var CONFIG_FILE = '/root/lp-bot/config.json';

function runCmd(cmd) {
  return new Promise(function(resolve) {
    exec(cmd, { timeout: 8000 }, function(err, stdout) {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtSOL(n) { return Number(n || 0).toFixed(4); }
function fmtUSD(n) { var v = Number(n||0); return v >= 1000 ? '$' + (v/1000).toFixed(1) + 'K' : '$' + v.toFixed(0); }
function fmtPct(n) { return (Number(n||0) * 100).toFixed(2) + '%'; }
function fmtTime(ts) { if (!ts) return '-'; var d = new Date(ts * 1000); return d.toLocaleDateString('es-AR') + ' ' + d.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}); }

async function getData() {
  var d = { status:'offline', uptime:'-', restarts:0, cpu:'-', mem:'-', logs:'', positions:[], history:[], totalPnL:0, totalFees:0, totalIL:0, config:null, procs:[], balance:0, invested:0 };
  try {
    var raw = await runCmd('pm2 jlist 2>/dev/null');
    if (raw) {
      var list = JSON.parse(raw);
      d.procs = list.map(function(p) { return { name:p.name, status:p.pm2_env.status }; });
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === 'lp-bot') {
          d.status = list[i].pm2_env.status;
          var ms = Date.now() - list[i].pm2_env.pm_uptime;
          var days = Math.floor(ms/86400000);
          var hrs = Math.floor((ms%86400000)/3600000);
          var mins = Math.floor((ms%3600000)/60000);
          d.uptime = (days > 0 ? days+'d ':'') + hrs+'h '+mins+'m';
          d.restarts = list[i].pm2_env.restart_time;
          if (list[i].monit) { d.cpu = list[i].monit.cpu+'%'; d.mem = (list[i].monit.memory/1024/1024).toFixed(0)+'MB'; }
        }
      }
    }
  } catch(e) {}
  try {
    var logs = await runCmd('pm2 logs lp-bot --nostream --lines 50 2>/dev/null');
    if (logs && logs.length > 5) d.logs = logs;
  } catch(e) {}
  try {
    if (fs.existsSync(STATE_FILE)) {
      var st = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
      if (st.activePositions) d.positions = st.activePositions;
      if (st.positionHistory) d.history = st.positionHistory;
      d.totalPnL = st.totalNetPnL || 0;
      d.totalFees = st.totalFeesEarned || 0;
      d.totalIL = st.totalILLoss || 0;
    }
  } catch(e) {}
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      d.config = JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'));
    }
  } catch(e) {}
  // Parse balance from logs
  try {
    var balMatch = d.logs.match(/Balance:\s+([\d.]+)\s+SOL/);
    if (balMatch) d.balance = parseFloat(balMatch[1]);
    var invMatch = d.logs.match(/Invested:\s+([\d.]+)\s+SOL/);
    if (invMatch) d.invested = parseFloat(invMatch[1]);
  } catch(e) {}
  return d;
}

function buildHTML(d) {
  var now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Salta' });
  var statusColor = d.status === 'online' ? '#00e676' : '#ef4444';
  var totalCapital = d.balance + d.invested;
  var utilization = totalCapital > 0 ? (d.invested / totalCapital * 100) : 0;
  var utilColor = utilization < 30 ? '#ef4444' : utilization < 60 ? '#ffab40' : '#00e676';
  var idle = totalCapital - d.invested;

  // Config analysis
  var cfg = d.config || {};
  var strategy = cfg.STRATEGY || {};
  var safety = cfg.SAFETY || {};
  var filters = cfg.FILTERS || {};
  var maxPools = strategy.MAX_POOLS_SIMULTANEOUS || 1;
  var capitalPerPool = strategy.CAPITAL_PER_POOL_PERCENT || 15;
  var maxDeployable = maxPools * capitalPerPool;
  var minLiq = filters.MIN_LIQUIDITY_USD || 50000;
  var minVol = filters.MIN_VOLUME_24H_USD || 100000;
  var maxIL = safety.MAX_IMPERMANENT_LOSS_PERCENT || 8;
  var scanInterval = strategy.SCAN_INTERVAL_SEC || 60;

  // Recommendations
  var recs = [];
  if (utilization < 30) {
    recs.push({icon:'!!', color:'#ef4444', title:'Capital ocioso: ' + fmtSOL(idle) + ' SOL sin trabajar', desc:'Solo ' + utilization.toFixed(0) + '% del capital esta desplegado. Aumentar MAX_POOLS o CAPITAL_PER_POOL.'});
  }
  if (maxPools <= 2) {
    recs.push({icon:'+', color:'#ffab40', title:'Pocas posiciones simultaneas (max: ' + maxPools + ')', desc:'Aumentar a 3-5 pools diversifica riesgo y aumenta fees ganados.'});
  }
  if (capitalPerPool < 20) {
    recs.push({icon:'$', color:'#4fc3f7', title:'Capital por pool bajo (' + capitalPerPool + '%)', desc:'Con ' + fmtSOL(totalCapital) + ' SOL, subir a 25-30% genera mas fees sin riesgo excesivo.'});
  }
  if (maxDeployable < 70) {
    recs.push({icon:'%', color:'#ffab40', title:'Maximo desplegable: ' + maxDeployable + '%', desc:'MAX_POOLS x CAPITAL_PER_POOL = ' + maxDeployable + '%. Idealmente deberia ser 70-85%.'});
  }
  if (minLiq > 30000) {
    recs.push({icon:'~', color:'#90caf9', title:'Liquidez minima alta (' + fmtUSD(minLiq) + ')', desc:'Bajar a $20-30K abre mas pools de memecoins con alto APY.'});
  }

  // Position cards
  var posHTML = '';
  if (d.positions.length > 0) {
    for (var i = 0; i < d.positions.length; i++) {
      var p = d.positions[i];
      var ratio = p.entryPrice > 0 ? (p.curPrice / p.entryPrice) : 1;
      var ilPct = ((p.il || 0) * 100).toFixed(3);
      var netPnL = p.netPnL || 0;
      var netColor = netPnL >= 0 ? '#00e676' : '#ef4444';
      var priceRange = p.rangeLow && p.rangeHigh ? (p.curPrice >= p.rangeLow && p.curPrice <= p.rangeHigh) : true;
      var rangeStatus = priceRange ? '<span style="color:#00e676">IN RANGE</span>' : '<span style="color:#ef4444">OUT OF RANGE</span>';
      var age = p.entryTime ? Math.floor((Date.now()/1000 - p.entryTime) / 3600) : 0;

      posHTML += '<div style="background:linear-gradient(135deg,#111827 0%,#0f172a 100%);border:1px solid #1e293b;border-radius:12px;padding:16px;margin-bottom:12px">'
        // Header
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #1e293b">'
        + '<div><span style="font-size:20px;font-weight:bold;color:#e0f2fe">' + esc(p.sym||'?') + '</span>'
        + '<span style="color:#475569;font-size:12px;margin-left:8px">' + esc(p.dex||'') + '</span></div>'
        + '<div style="text-align:right">' + rangeStatus + '<div style="color:#475569;font-size:10px;margin-top:2px">' + age + 'h activa</div></div>'
        + '</div>'

        // Main metrics row
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">'
        + metricBox('Capital', fmtSOL(p.capitalSOL) + ' SOL', '#e0f2fe')
        + metricBox('Precio', Number(p.curPrice||0).toFixed(6), '#e0f2fe')
        + metricBox('Ratio', ratio.toFixed(3) + 'x', ratio >= 1 ? '#00e676' : '#ef4444')
        + '</div>'

        // PnL row
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">'
        + metricBox('Fees', '+' + fmtSOL(p.estFees), '#00e676')
        + metricBox('IL', ilPct + '%', parseFloat(ilPct) > -1 ? '#ffab40' : '#ef4444')
        + metricBox('Net PnL', (netPnL>=0?'+':'') + fmtSOL(netPnL) + ' SOL', netColor)
        + '</div>'

        // Market data
        + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px">'
        + metricBoxSmall('Liquidez', fmtUSD(p.curLiq))
        + metricBoxSmall('Vol 24h', fmtUSD(p.curVol))
        + metricBoxSmall('Chg 24h', (p.chg24>=0?'+':'') + Number(p.chg24||0).toFixed(1) + '%')
        + metricBoxSmall('Rebalances', String(p.rebalanceCount||0))
        + '</div>'

        // Price range bar
        + priceBar(p.rangeLow, p.rangeHigh, p.curPrice, p.entryPrice)
        + '</div>';
    }
  } else {
    posHTML = '<div style="background:#111827;border:1px solid #1e293b;border-radius:12px;padding:24px;text-align:center;color:#334155">Sin posiciones activas — el bot esta buscando pools que cumplan los filtros</div>';
  }

  // History table
  var histHTML = '';
  if (d.history.length > 0) {
    histHTML += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">'
      + '<tr style="border-bottom:1px solid #1e293b">'
      + '<th style="text-align:left;padding:8px;color:#64748b;font-weight:600">Token</th>'
      + '<th style="text-align:left;padding:8px;color:#64748b;font-weight:600">DEX</th>'
      + '<th style="text-align:right;padding:8px;color:#64748b;font-weight:600">Capital</th>'
      + '<th style="text-align:right;padding:8px;color:#64748b;font-weight:600">PnL</th>'
      + '<th style="text-align:right;padding:8px;color:#64748b;font-weight:600">Chg24h</th>'
      + '<th style="text-align:left;padding:8px;color:#64748b;font-weight:600">Razon</th>'
      + '<th style="text-align:right;padding:8px;color:#64748b;font-weight:600">Cerrada</th>'
      + '</tr>';
    for (var i = 0; i < d.history.length; i++) {
      var h = d.history[i];
      var hPnL = h.pnlSOL || 0;
      var hColor = hPnL >= 0 ? '#00e676' : '#ef4444';
      var emergency = h.emergency ? '<span style="color:#ef4444;font-size:10px"> EMERG</span>' : '';
      histHTML += '<tr style="border-bottom:1px solid #0f172a">'
        + '<td style="padding:8px;color:#e0f2fe;font-weight:600">' + esc(h.sym||'?') + emergency + '</td>'
        + '<td style="padding:8px;color:#64748b">' + esc(h.dex||'') + '</td>'
        + '<td style="padding:8px;text-align:right">' + fmtSOL(h.capitalSOL) + '</td>'
        + '<td style="padding:8px;text-align:right;color:' + hColor + ';font-weight:600">' + (hPnL>=0?'+':'') + fmtSOL(hPnL) + '</td>'
        + '<td style="padding:8px;text-align:right;color:' + ((h.chg24||0)>=0?'#00e676':'#ef4444') + '">' + (h.chg24>=0?'+':'') + Number(h.chg24||0).toFixed(1) + '%</td>'
        + '<td style="padding:8px;color:#94a3b8;font-size:11px">' + esc(h.reason||'') + '</td>'
        + '<td style="padding:8px;text-align:right;color:#64748b;font-size:11px">' + fmtTime(h.closeTime) + '</td>'
        + '</tr>';
    }
    histHTML += '</table></div>';
  } else {
    histHTML = '<div style="color:#334155;padding:12px;text-align:center">Sin historial de trades</div>';
  }

  // Config table
  var cfgHTML = '';
  if (d.config) {
    cfgHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">'
      + cfgItem('Max Pools', maxPools)
      + cfgItem('Capital/Pool', capitalPerPool + '%')
      + cfgItem('Max Desplegable', maxDeployable + '%')
      + cfgItem('Min Liquidez', fmtUSD(minLiq))
      + cfgItem('Min Volumen', fmtUSD(minVol))
      + cfgItem('Max IL', maxIL + '%')
      + cfgItem('Rango Buffer', ((strategy.PRICE_RANGE_BUFFER||0.15)*100) + '%')
      + cfgItem('Scan Interval', scanInterval + 's')
      + '</div>';
  }

  // Recs
  var recsHTML = '';
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    recsHTML += '<div style="background:#111827;border-left:3px solid '+r.color+';border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:8px">'
      + '<div style="color:'+r.color+';font-weight:bold;font-size:13px;margin-bottom:3px">' + esc(r.title) + '</div>'
      + '<div style="color:#64748b;font-size:11px">' + esc(r.desc) + '</div></div>';
  }

  // Logs
  var logLines = esc(d.logs).split('\n').slice(-35).map(function(l) {
    var c = '#475569';
    if (/error|fatal|fail/i.test(l)) c = '#ef4444';
    else if (/warn/i.test(l)) c = '#ffab40';
    else if (/ok|entry|buy|open|in range/i.test(l)) c = '#00e676';
    else if (/status report/i.test(l)) c = '#4fc3f7';
    else if (/scan|check|found/i.test(l)) c = '#334155';
    return '<div style="color:'+c+'">'+l+'</div>';
  }).join('');

  // PM2
  var procsHTML = d.procs.map(function(p) {
    var pc = p.status==='online'?'#00e676':'#ef4444';
    return '<span style="display:inline-flex;align-items:center;gap:6px;background:#111827;border:1px solid #1e293b;border-radius:6px;padding:4px 12px;margin-right:6px;font-size:12px">'
      +'<span style="width:6px;height:6px;border-radius:50%;background:'+pc+'"></span>'+esc(p.name)+'</span>';
  }).join('');

  // Assemble
  return '<!DOCTYPE html><html><head>'
  + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>LP Bot Terminal</title>'
  + '<style>'
  + '@import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700&display=swap");'
  + '*{margin:0;padding:0;box-sizing:border-box}'
  + 'body{background:#080c14;color:#cbd5e1;font-family:"Inter",sans-serif;min-height:100vh}'
  + '.container{max-width:900px;margin:0 auto;padding:12px}'
  + '.mono{font-family:"JetBrains Mono",monospace}'
  + '.section{margin-bottom:20px}'
  + '.section-head{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#4fc3f7;font-weight:700;margin-bottom:10px;display:flex;align-items:center;gap:8px}'
  + '.section-head::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,#1e293b,transparent)}'

  // Capital utilization bar
  + '.util-bar{background:#0f172a;border-radius:6px;height:24px;position:relative;overflow:hidden;margin:8px 0}'
  + '.util-fill{height:100%;border-radius:6px;transition:width 0.5s}'
  + '.util-labels{display:flex;justify-content:space-between;font-size:10px;color:#64748b;margin-top:4px}'

  + '@media(max-width:600px){.container{padding:8px} .grid3{grid-template-columns:1fr 1fr!important}}'
  + '</style></head><body>'
  + '<div class="container">'

  // ═══ HEADER ═══
  + '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #1e293b;margin-bottom:16px">'
  + '<div>'
  + '<div style="font-size:22px;font-weight:700;letter-spacing:-0.5px">LP Bot <span style="color:#4fc3f7">Terminal</span></div>'
  + '<div class="mono" style="font-size:10px;color:#334155;margin-top:2px">' + now + ' | v3.0</div>'
  + '</div>'
  + '<div style="display:flex;align-items:center;gap:10px">'
  + '<div style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:8px;background:' + (d.status==='online'?'rgba(0,230,118,0.1)':'rgba(239,68,68,0.1)') + ';border:1px solid ' + (d.status==='online'?'rgba(0,230,118,0.2)':'rgba(239,68,68,0.2)') + '">'
  + '<span style="width:8px;height:8px;border-radius:50%;background:'+statusColor+';box-shadow:0 0 8px '+statusColor+'"></span>'
  + '<span class="mono" style="font-size:12px;font-weight:600;color:'+statusColor+'">'+d.status.toUpperCase()+'</span></div>'
  + '<button onclick="location.reload()" style="background:#1e293b;color:#94a3b8;border:1px solid #334155;border-radius:8px;padding:6px 16px;font-family:Inter,sans-serif;font-size:12px;cursor:pointer">Refresh</button>'
  + '</div></div>'

  // ═══ PORTFOLIO OVERVIEW ═══
  + '<div class="section">'
  + '<div class="section-head">Portfolio</div>'
  + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px" class="grid3">'
  + statCard('Total Capital', fmtSOL(totalCapital) + ' SOL', '#e0f2fe', true)
  + statCard('Invertido', fmtSOL(d.invested) + ' SOL', '#4fc3f7', true)
  + statCard('Disponible', fmtSOL(idle) + ' SOL', idle > totalCapital*0.5 ? '#ffab40' : '#94a3b8', true)
  + statCard('Net PnL', (d.totalPnL>=0?'+':'') + fmtSOL(d.totalPnL) + ' SOL', d.totalPnL>=0?'#00e676':'#ef4444', true)
  + '</div>'

  // Utilization bar
  + '<div style="margin-top:12px;background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px">'
  + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
  + '<span style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:1px">Utilizacion del Capital</span>'
  + '<span class="mono" style="font-size:14px;font-weight:700;color:'+utilColor+'">' + utilization.toFixed(1) + '%</span></div>'
  + '<div class="util-bar"><div class="util-fill" style="width:'+utilization+'%;background:linear-gradient(90deg,'+utilColor+','+utilColor+'88)"></div></div>'
  + '<div class="util-labels"><span>0%</span><span>Optimo: 60-80%</span><span>100%</span></div>'
  + '</div></div>'

  // ═══ ACTIVE POSITIONS ═══
  + '<div class="section">'
  + '<div class="section-head">Posiciones Activas (' + d.positions.length + '/' + maxPools + ')</div>'
  + posHTML + '</div>'

  // ═══ RECOMMENDATIONS ═══
  + (recs.length > 0 ? '<div class="section"><div class="section-head">Optimizacion de Capital</div>' + recsHTML + '</div>' : '')

  // ═══ CONFIG ═══
  + (cfgHTML ? '<div class="section"><div class="section-head">Configuracion Actual</div>' + cfgHTML + '</div>' : '')

  // ═══ HISTORY ═══
  + '<div class="section"><div class="section-head">Historial de Trades (' + d.history.length + ')</div>' + histHTML + '</div>'

  // ═══ SYSTEM ═══
  + '<div class="section"><div class="section-head">Sistema</div>'
  + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px" class="grid3">'
  + statCard('Uptime', d.uptime, '#94a3b8', false)
  + statCard('Restarts', String(d.restarts), '#94a3b8', false)
  + statCard('CPU', d.cpu, '#94a3b8', false)
  + statCard('RAM', d.mem, '#94a3b8', false)
  + '</div>'
  + '<div style="margin-bottom:8px">' + procsHTML + '</div></div>'

  // ═══ LOGS ═══
  + '<div class="section"><div class="section-head">Logs</div>'
  + '<div class="mono" style="background:#0a0e17;border:1px solid #1e293b;border-radius:10px;padding:12px;max-height:300px;overflow-y:auto;font-size:10px;line-height:1.7;white-space:pre-wrap;word-break:break-all">'
  + logLines + '</div></div>'

  + '</div>'
  + '<script>setTimeout(function(){location.reload()},25000)</script>'
  + '</body></html>';
}

function statCard(label, value, color, big) {
  return '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:'+(big?'14px 12px':'10px 12px')+';text-align:center">'
    + '<div style="font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:1px;font-weight:600">'+label+'</div>'
    + '<div class="mono" style="font-size:'+(big?'18px':'15px')+';font-weight:700;color:'+color+';margin-top:4px">'+value+'</div></div>';
}

function metricBox(label, value, color) {
  return '<div style="background:#0a0e17;border:1px solid #131b2e;border-radius:8px;padding:8px 10px;text-align:center">'
    + '<div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">'+label+'</div>'
    + '<div class="mono" style="font-size:15px;font-weight:700;color:'+color+';margin-top:3px">'+value+'</div></div>';
}

function metricBoxSmall(label, value) {
  return '<div style="background:#0a0e17;border:1px solid #131b2e;border-radius:6px;padding:6px 8px;text-align:center">'
    + '<div style="font-size:8px;color:#475569;text-transform:uppercase;letter-spacing:0.5px">'+label+'</div>'
    + '<div class="mono" style="font-size:12px;font-weight:600;color:#94a3b8;margin-top:2px">'+value+'</div></div>';
}

function cfgItem(label, value) {
  return '<div style="display:flex;justify-content:space-between;padding:6px 10px;background:#0f172a;border-radius:6px">'
    + '<span style="font-size:11px;color:#64748b">'+label+'</span>'
    + '<span class="mono" style="font-size:12px;font-weight:600;color:#e0f2fe">'+value+'</span></div>';
}

function priceBar(low, high, cur, entry) {
  if (!low || !high || !cur) return '';
  var pct = (cur - low) / (high - low) * 100;
  pct = Math.max(0, Math.min(100, pct));
  var entryPct = entry ? Math.max(0, Math.min(100, (entry - low) / (high - low) * 100)) : -1;
  var barColor = (pct > 10 && pct < 90) ? '#00e676' : '#ffab40';
  return '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #131b2e">'
    + '<div style="display:flex;justify-content:space-between;font-size:9px;color:#475569;margin-bottom:4px">'
    + '<span>Low: ' + Number(low).toFixed(6) + '</span>'
    + '<span style="color:#4fc3f7">Price Range</span>'
    + '<span>High: ' + Number(high).toFixed(6) + '</span></div>'
    + '<div style="position:relative;background:#131b2e;height:8px;border-radius:4px;overflow:visible">'
    + '<div style="position:absolute;height:100%;width:'+pct+'%;background:linear-gradient(90deg,#1e293b,'+barColor+');border-radius:4px"></div>'
    + '<div style="position:absolute;left:'+pct+'%;top:-3px;width:14px;height:14px;background:'+barColor+';border-radius:50%;transform:translateX(-50%);border:2px solid #080c14;box-shadow:0 0 6px '+barColor+'"></div>'
    + (entryPct >= 0 ? '<div style="position:absolute;left:'+entryPct+'%;top:-1px;width:2px;height:10px;background:#4fc3f7;opacity:0.5" title="Entry"></div>' : '')
    + '</div></div>';
}

var server = http.createServer(function(req, res) {
  if (req.url === '/api/status') {
    getData().then(function(d) {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify(d));
    });
    return;
  }
  getData().then(function(d) {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(buildHTML(d));
  }).catch(function(e) {
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end('<html><body style="background:#080c14;color:#ef4444;padding:20px;font-family:monospace"><h2>Error</h2><pre>'+esc(e.message)+'</pre></body></html>');
  });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('LP Bot Terminal corriendo en puerto ' + PORT);
});

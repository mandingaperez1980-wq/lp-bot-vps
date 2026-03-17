var http = require('http');
var exec = require('child_process').exec;
var fs = require('fs');

var PORT = 3000;
var WALLET = '4itdVpQyANnryEcF7WtEeUv16UEo5m5FxuGHwrQ1uoYJ';
var STATE_FILE = '/root/lp-bot/state.json';

function runCmd(cmd) {
  return new Promise(function(resolve) {
    exec(cmd, { timeout: 8000 }, function(err, stdout) {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatSOL(n) {
  return Number(n || 0).toFixed(4);
}

function formatUSD(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', {maximumFractionDigits: 0});
}

async function getData() {
  var d = { status:'unknown', uptime:'-', restarts:'-', cpu:'-', mem:'-', logs:'No logs', positions:[], history:[], totalPnL:0, totalFees:0, totalIL:0, procs:[] };
  try {
    var raw = await runCmd('pm2 jlist 2>/dev/null');
    if (raw) {
      var list = JSON.parse(raw);
      d.procs = list.map(function(p) { return { name: p.name, status: p.pm2_env.status }; });
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === 'lp-bot') {
          d.status = list[i].pm2_env.status;
          var ms = Date.now() - list[i].pm2_env.pm_uptime;
          d.uptime = Math.floor(ms/3600000) + 'h ' + Math.floor((ms%3600000)/60000) + 'm';
          d.restarts = list[i].pm2_env.restart_time;
          if (list[i].monit) {
            d.cpu = list[i].monit.cpu + '%';
            d.mem = (list[i].monit.memory/1024/1024).toFixed(1) + 'MB';
          }
        }
      }
    }
  } catch(e) {}
  try {
    var logs = await runCmd('pm2 logs lp-bot --nostream --lines 30 2>/dev/null');
    if (logs && logs.length > 5) d.logs = logs;
  } catch(e) {}
  try {
    if (fs.existsSync(STATE_FILE)) {
      var st = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
      if (st.activePositions) d.positions = st.activePositions;
      if (st.positionHistory) d.history = st.positionHistory;
      if (st.totalNetPnL !== undefined) d.totalPnL = st.totalNetPnL;
      if (st.totalFeesEarned !== undefined) d.totalFees = st.totalFeesEarned;
      if (st.totalILLoss !== undefined) d.totalIL = st.totalILLoss;
    }
  } catch(e) {}
  return d;
}

var server = http.createServer(function(req, res) {
  getData().then(function(d) {
    var color = d.status === 'online' ? '#00e676' : '#ff5252';

    // Active positions
    var posHTML = '';
    if (d.positions.length > 0) {
      for (var i = 0; i < d.positions.length; i++) {
        var p = d.positions[i];
        var il = ((p.il || 0) * 100).toFixed(2);
        var fees = formatSOL(p.estFees);
        var net = formatSOL(p.netPnL);
        var netColor = (p.netPnL || 0) >= 0 ? '#00e676' : '#ff5252';
        var ratio = p.entryPrice > 0 ? (p.curPrice / p.entryPrice).toFixed(2) : '-';
        posHTML += '<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:8px">';
        posHTML += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';
        posHTML += '<span style="color:#4fc3f7;font-weight:bold;font-size:16px">' + esc(p.sym || '?') + '</span>';
        posHTML += '<span style="color:#888;font-size:11px">' + esc(p.dex || '') + '</span>';
        posHTML += '</div>';
        posHTML += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">Capital</div><div style="font-size:14px;font-weight:bold">' + formatSOL(p.capitalSOL) + ' SOL</div></div>';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">Ratio</div><div style="font-size:14px;font-weight:bold">' + ratio + 'x</div></div>';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">IL</div><div style="font-size:14px;font-weight:bold;color:#ffab40">' + il + '%</div></div>';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">Fees</div><div style="font-size:14px;font-weight:bold;color:#00e676">+' + fees + '</div></div>';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">Net PnL</div><div style="font-size:14px;font-weight:bold;color:' + netColor + '">' + net + ' SOL</div></div>';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">Liquidity</div><div style="font-size:14px;font-weight:bold">' + formatUSD(p.curLiq) + '</div></div>';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">Volume 24h</div><div style="font-size:14px;font-weight:bold">' + formatUSD(p.curVol) + '</div></div>';
        posHTML += '<div style="background:#0a0e17;border-radius:6px;padding:6px 10px;flex:1;min-width:45%"><div style="font-size:9px;color:#666;text-transform:uppercase">Rebalances</div><div style="font-size:14px;font-weight:bold">' + (p.rebalanceCount || 0) + '</div></div>';
        posHTML += '</div></div>';
      }
    } else {
      posHTML = '<div style="color:#3d5070;padding:8px;font-style:italic">Sin posiciones activas</div>';
    }

    // History
    var histHTML = '';
    if (d.history.length > 0) {
      for (var i = 0; i < d.history.length; i++) {
        var h = d.history[i];
        var hColor = (h.pnlSOL || 0) >= 0 ? '#00e676' : '#ff5252';
        var closeDate = h.closeTime ? new Date(h.closeTime * 1000).toLocaleDateString('es-AR') : '-';
        histHTML += '<div style="background:#111827;border:1px solid #1e293b;border-radius:6px;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">';
        histHTML += '<div><span style="color:#4fc3f7;font-weight:bold">' + esc(h.sym || '?') + '</span> <span style="color:#555;font-size:11px">' + closeDate + '</span></div>';
        histHTML += '<div style="text-align:right"><div style="color:' + hColor + ';font-weight:bold">' + formatSOL(h.pnlSOL) + ' SOL</div>';
        histHTML += '<div style="color:#888;font-size:10px">' + esc(h.reason || '') + '</div></div>';
        histHTML += '</div>';
      }
    } else {
      histHTML = '<div style="color:#3d5070;padding:8px;font-style:italic">Sin historial</div>';
    }

    // Logs
    var logLines = esc(d.logs).split('\n').map(function(l) {
      var c = '#778';
      if (/error|fatal|fail/i.test(l)) c = '#ff5252';
      else if (/warn/i.test(l)) c = '#ffab40';
      else if (/ok|entry|buy|open|in range/i.test(l)) c = '#00e676';
      else if (/scan|check/i.test(l)) c = '#3d5070';
      return '<div style="color:'+c+'">'+l+'</div>';
    }).join('');

    // PM2 procs
    var procsHTML = d.procs.map(function(p) {
      var pc = p.status === 'online' ? '#00e676' : '#ff5252';
      return '<span style="background:#111827;border:1px solid #1e293b;border-radius:6px;padding:4px 12px;margin-right:8px;display:inline-block;margin-bottom:4px">'
        + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'+pc+';margin-right:6px"></span>'
        + esc(p.name) + '</span>';
    }).join('');

    var now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Salta' });

    var html = '<!DOCTYPE html><html><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>LP Bot Monitor</title></head>'
    + '<body style="background:#0a0e17;color:#ddd;font-family:monospace;padding:12px;margin:0">'

    // Header
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #1e293b">'
    + '<div style="font-size:18px;font-weight:bold">LP Bot <span style="color:#4fc3f7">Monitor</span></div>'
    + '<div><span style="color:#555;font-size:11px;margin-right:8px">' + now + '</span>'
    + '<button onclick="location.reload()" style="background:#1e293b;color:#4fc3f7;border:1px solid #2d3f5f;border-radius:6px;padding:6px 14px;font-family:monospace;cursor:pointer">Refresh</button></div>'
    + '</div>'

    // Status cards
    + '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">'
    + '<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:12px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px">Status</div><div style="font-size:20px;font-weight:bold;color:'+color+';margin-top:4px">'+d.status.toUpperCase()+'</div></div>'
    + '<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:12px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px">Uptime</div><div style="font-size:20px;font-weight:bold;margin-top:4px">'+d.uptime+'</div></div>'
    + '<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:12px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px">Total PnL</div><div style="font-size:20px;font-weight:bold;margin-top:4px;color:'+(d.totalPnL>=0?'#00e676':'#ff5252')+'">'+formatSOL(d.totalPnL)+' SOL</div></div>'
    + '<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:12px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1px">CPU / RAM</div><div style="font-size:16px;font-weight:bold;margin-top:4px">'+d.cpu+' / '+d.mem+'</div></div>'
    + '</div>'

    // Active positions
    + '<div style="font-size:12px;color:#4fc3f7;text-transform:uppercase;letter-spacing:1.5px;margin:20px 0 10px;font-weight:bold">Posiciones Activas (' + d.positions.length + ')</div>'
    + posHTML

    // History
    + '<div style="font-size:12px;color:#4fc3f7;text-transform:uppercase;letter-spacing:1.5px;margin:20px 0 10px;font-weight:bold">Historial (' + d.history.length + ')</div>'
    + histHTML

    // PM2
    + '<div style="font-size:12px;color:#4fc3f7;text-transform:uppercase;letter-spacing:1.5px;margin:20px 0 10px;font-weight:bold">PM2 Procesos</div>'
    + '<div style="margin-bottom:12px">' + procsHTML + '</div>'

    // Logs
    + '<div style="font-size:12px;color:#4fc3f7;text-transform:uppercase;letter-spacing:1.5px;margin:20px 0 10px;font-weight:bold">Logs Recientes</div>'
    + '<div style="background:#080c14;border:1px solid #1e293b;border-radius:8px;padding:10px;max-height:350px;overflow-y:auto;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all">'
    + logLines + '</div>'

    + '<script>setTimeout(function(){location.reload()},30000)</script>'
    + '</body></html>';

    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(html);
  }).catch(function(e) {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end('<html><body style="background:#111;color:red;padding:20px;font-family:monospace">Error: '+esc(e.message)+'</body></html>');
  });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('Monitor corriendo en puerto ' + PORT);
});

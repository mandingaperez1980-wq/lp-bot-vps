var http = require('http');
var exec = require('child_process').exec;
var fs = require('fs');

var PORT = 3000;

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

async function getData() {
  var d = { status:'unknown', uptime:'-', restarts:'-', cpu:'-', mem:'-', logs:'No logs', positions:[] };
  try {
    var raw = await runCmd('pm2 jlist 2>/dev/null');
    if (raw) {
      var list = JSON.parse(raw);
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
    if (fs.existsSync('/root/lp-bot/state.json')) {
      var st = JSON.parse(fs.readFileSync('/root/lp-bot/state.json','utf8'));
      if (st.positions) d.positions = st.positions;
    }
  } catch(e) {}
  return d;
}

var server = http.createServer(function(req, res) {
  getData().then(function(d) {
    var color = d.status === 'online' ? '#0f0' : '#f44';

    var posHTML = '';
    if (d.positions.length > 0) {
      for (var i = 0; i < d.positions.length; i++) {
        var p = d.positions[i];
        var pnl = p.pnl || 0;
        posHTML += '<div style="background:#1a1a2e;padding:10px;border-radius:8px;margin-bottom:8px">';
        posHTML += '<b style="color:#4fc3f7">' + esc(p.symbol||p.token||'?') + '</b> ';
        posHTML += '<span style="color:#888">Size: ' + (p.size||p.amount||0).toFixed(4) + ' SOL</span> ';
        posHTML += '<span style="color:' + (pnl>=0?'#0f0':'#f44') + '">PnL: ' + (pnl>=0?'+':'') + (pnl*100).toFixed(2) + '%</span>';
        posHTML += '</div>';
      }
    } else {
      posHTML = '<div style="color:#555;padding:8px">Sin posiciones activas</div>';
    }

    var logLines = esc(d.logs).split('\n').map(function(l) {
      var c = '#aaa';
      if (/error|fatal|fail/i.test(l)) c = '#f44';
      else if (/warn/i.test(l)) c = '#fa0';
      else if (/ok|entry|buy|open/i.test(l)) c = '#0f0';
      else if (/scan|check/i.test(l)) c = '#555';
      return '<div style="color:'+c+'">'+l+'</div>';
    }).join('');

    var html = '<!DOCTYPE html><html><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>LP Bot</title></head>'
    + '<body style="background:#0a0e17;color:#ddd;font-family:monospace;padding:12px;margin:0">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
    + '<div style="font-size:18px;font-weight:bold">LP Bot <span style="color:#4fc3f7">Monitor</span></div>'
    + '<button onclick="location.reload()" style="background:#1e293b;color:#4fc3f7;border:1px solid #333;border-radius:6px;padding:6px 14px;font-family:monospace">Refresh</button>'
    + '</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">'
    + '<div style="background:#111827;border:1px solid #222;border-radius:8px;padding:10px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase">Status</div><div style="font-size:18px;font-weight:bold;color:'+color+';margin-top:4px">'+d.status.toUpperCase()+'</div></div>'
    + '<div style="background:#111827;border:1px solid #222;border-radius:8px;padding:10px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase">Uptime</div><div style="font-size:18px;font-weight:bold;margin-top:4px">'+d.uptime+'</div></div>'
    + '<div style="background:#111827;border:1px solid #222;border-radius:8px;padding:10px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase">Restarts</div><div style="font-size:18px;font-weight:bold;margin-top:4px">'+d.restarts+'</div></div>'
    + '<div style="background:#111827;border:1px solid #222;border-radius:8px;padding:10px;flex:1;min-width:45%;text-align:center"><div style="font-size:10px;color:#666;text-transform:uppercase">CPU / RAM</div><div style="font-size:14px;font-weight:bold;margin-top:4px">'+d.cpu+' / '+d.mem+'</div></div>'
    + '</div>'
    + '<div style="font-size:12px;color:#4fc3f7;text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px">Posiciones</div>'
    + posHTML
    + '<div style="font-size:12px;color:#4fc3f7;text-transform:uppercase;letter-spacing:1px;margin:16px 0 8px">Logs</div>'
    + '<div style="background:#080c14;border:1px solid #222;border-radius:8px;padding:10px;max-height:350px;overflow-y:auto;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all">'
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

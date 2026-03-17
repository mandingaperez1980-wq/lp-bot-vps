// ============================================================
// LP BOT MONITOR v3 — Dashboard web para VPS
// Corre en puerto 3000
// ============================================================

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const WALLET = '4itdVpQyANnryEcF7WtEeUv16UEo5m5FxuGHwrQ1uoYJ';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const LOG_DIR = '/root/lp-bot/logs';
const STATE_FILE = '/root/lp-bot/state.json';

// --- Helpers ---

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve(err ? (stderr || err.message) : stdout.trim());
    });
  });
}

async function fetchJSON(url, body) {
  try {
    const https = require('https');
    const httpMod = url.startsWith('https') ? https : require('http');
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        timeout: 8000
      };
      const req = httpMod.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  } catch { return null; }
}

async function getSolBalance() {
  const resp = await fetchJSON(RPC_URL, {
    jsonrpc: '2.0', id: 1,
    method: 'getBalance',
    params: [WALLET]
  });
  if (resp && resp.result && resp.result.value !== undefined) {
    return (resp.result.value / 1e9).toFixed(4);
  }
  return 'Error';
}

async function getPm2Status() {
  const raw = await runCmd('pm2 jlist 2>/dev/null');
  try {
    const list = JSON.parse(raw);
    return list.map(p => ({
      name: p.name,
      status: p.pm2_env.status,
      uptime: p.pm2_env.pm_uptime,
      restarts: p.pm2_env.restart_time,
      cpu: p.monit ? p.monit.cpu : 0,
      memory: p.monit ? (p.monit.memory / 1024 / 1024).toFixed(1) : '0'
    }));
  } catch {
    return [];
  }
}

async function getRecentLogs(lines = 40) {
  // Try PM2 logs first
  let logs = await runCmd(`pm2 logs lp-bot --nostream --lines ${lines} 2>/dev/null`);
  if (logs && logs.length > 10) return logs;
  // Fallback to log file
  const logFile = path.join(LOG_DIR, 'bot.log');
  if (fs.existsSync(logFile)) {
    logs = await runCmd(`tail -n ${lines} ${logFile}`);
    return logs;
  }
  return 'No logs found';
}

function getBotState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

function formatUptime(startMs) {
  if (!startMs) return '—';
  const diff = Date.now() - startMs;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- HTML Dashboard ---

function buildHTML(data) {
  const { pm2, balance, logs, state, serverTime } = data;

  const botProc = pm2.find(p => p.name === 'lp-bot') || null;
  const statusColor = botProc && botProc.status === 'online' ? '#00e676' : '#ff5252';
  const statusText = botProc ? botProc.status.toUpperCase() : 'NOT FOUND';
  const uptimeStr = botProc ? formatUptime(botProc.uptime) : '—';
  const restartsStr = botProc ? botProc.restarts : '—';
  const cpuStr = botProc ? botProc.cpu + '%' : '—';
  const memStr = botProc ? botProc.memory + ' MB' : '—';

  // Positions from state
  let positionsHTML = '<div class="empty">Sin posiciones activas</div>';
  if (state && state.positions && state.positions.length > 0) {
    positionsHTML = state.positions.map(p => {
      const pnlColor = (p.pnl || 0) >= 0 ? '#00e676' : '#ff5252';
      const pnlSign = (p.pnl || 0) >= 0 ? '+' : '';
      return `
        <div class="pos-card">
          <div class="pos-name">${escapeHtml(p.symbol || p.token || 'Unknown')}</div>
          <div class="pos-details">
            <span>Entry: ${(p.entryPrice || 0).toFixed(8)}</span>
            <span>Size: ${(p.size || p.amount || 0).toFixed(4)} SOL</span>
            <span style="color:${pnlColor}">PnL: ${pnlSign}${((p.pnl || 0) * 100).toFixed(2)}%</span>
            ${p.status ? '<span>Status: ' + escapeHtml(p.status) + '</span>' : ''}
          </div>
        </div>`;
    }).join('');
  }

  // Stats
  let statsHTML = '';
  if (state && state.stats) {
    const s = state.stats;
    statsHTML = `
      <div class="stat"><span class="stat-label">Total Trades</span><span class="stat-value">${s.totalTrades || 0}</span></div>
      <div class="stat"><span class="stat-label">Wins</span><span class="stat-value" style="color:#00e676">${s.wins || 0}</span></div>
      <div class="stat"><span class="stat-label">Losses</span><span class="stat-value" style="color:#ff5252">${s.losses || 0}</span></div>
      <div class="stat"><span class="stat-label">Total PnL</span><span class="stat-value">${(s.totalPnlSol || 0).toFixed(4)} SOL</span></div>
    `;
  }

  // Color-code log lines
  const logLines = escapeHtml(logs).split('\n').map(line => {
    let cls = '';
    if (/error|fatal|fail/i.test(line)) cls = 'log-error';
    else if (/warn/i.test(line)) cls = 'log-warn';
    else if (/ok|success|✅|🟢|entry|buy|open/i.test(line)) cls = 'log-ok';
    else if (/scan|check|monitor/i.test(line)) cls = 'log-dim';
    return `<div class="${cls}">${line}</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LP Bot Monitor</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Space+Grotesk:wght@400;600;700&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: #0a0e17;
    color: #e0e6f0;
    font-family: 'Space Grotesk', sans-serif;
    min-height: 100vh;
    padding: 16px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid #1a2035;
  }

  .header h1 {
    font-size: 1.4rem;
    font-weight: 700;
    letter-spacing: -0.5px;
  }

  .header h1 span { color: #4fc3f7; }

  .header .time {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: #6b7a99;
  }

  .status-bar {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
  }

  .status-card {
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 10px;
    padding: 14px 18px;
    flex: 1;
    min-width: 140px;
  }

  .status-card .label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #6b7a99;
    margin-bottom: 6px;
  }

  .status-card .value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.2rem;
    font-weight: 600;
  }

  .status-dot {
    display: inline-block;
    width: 10px; height: 10px;
    border-radius: 50%;
    margin-right: 6px;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .section-title {
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: #4fc3f7;
    margin: 20px 0 10px;
    font-weight: 600;
  }

  .stats-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  .stat {
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 10px 14px;
    text-align: center;
    min-width: 100px;
    flex: 1;
  }

  .stat-label {
    display: block;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #6b7a99;
    margin-bottom: 4px;
  }

  .stat-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.1rem;
    font-weight: 600;
  }

  .pos-card {
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 8px;
  }

  .pos-name {
    font-weight: 600;
    font-size: 1rem;
    margin-bottom: 6px;
    color: #4fc3f7;
  }

  .pos-details {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: #8899bb;
  }

  .empty {
    color: #3d4f70;
    font-style: italic;
    padding: 10px;
  }

  .log-box {
    background: #0d1117;
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 12px;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .log-error { color: #ff5252; }
  .log-warn { color: #ffab40; }
  .log-ok { color: #00e676; }
  .log-dim { color: #3d5070; }

  .refresh-btn {
    background: #1e293b;
    color: #4fc3f7;
    border: 1px solid #2d3f5f;
    border-radius: 6px;
    padding: 6px 14px;
    font-family: 'Space Grotesk', sans-serif;
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .refresh-btn:hover { background: #2d3f5f; }

  .pm2-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .pm2-chip {
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 6px 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
  }

  @media (max-width: 600px) {
    .status-card { min-width: 45%; }
    .stat { min-width: 45%; }
    body { padding: 10px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1><span>&#x1F4A7;</span> LP Bot <span>Monitor</span></h1>
  <div>
    <span class="time">${serverTime}</span>
    <button class="refresh-btn" onclick="location.reload()">Refresh</button>
  </div>
</div>

<div class="status-bar">
  <div class="status-card">
    <div class="label">Bot Status</div>
    <div class="value">
      <span class="status-dot" style="background:${statusColor};box-shadow:0 0 8px ${statusColor}"></span>
      ${statusText}
    </div>
  </div>
  <div class="status-card">
    <div class="label">Balance</div>
    <div class="value">${balance} SOL</div>
  </div>
  <div class="status-card">
    <div class="label">Uptime</div>
    <div class="value">${uptimeStr}</div>
  </div>
  <div class="status-card">
    <div class="label">Restarts</div>
    <div class="value">${restartsStr}</div>
  </div>
  <div class="status-card">
    <div class="label">CPU / RAM</div>
    <div class="value">${cpuStr} / ${memStr}</div>
  </div>
</div>

${statsHTML ? `<div class="section-title">Estadísticas</div><div class="stats-row">${statsHTML}</div>` : ''}

<div class="section-title">Posiciones Activas</div>
${positionsHTML}

<div class="section-title">PM2 Procesos</div>
<div class="pm2-row">
  ${pm2.map(p => `<div class="pm2-chip"><span class="status-dot" style="background:${p.status === 'online' ? '#00e676' : '#ff5252'};width:8px;height:8px"></span> ${escapeHtml(p.name)} — ${p.status}</div>`).join('')}
</div>

<div class="section-title">Logs Recientes</div>
<div class="log-box">${logLines}</div>

<script>
  // Auto-refresh every 30 seconds
  setTimeout(() => location.reload(), 30000);
</script>

</body>
</html>`;
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const [pm2, balance, logs] = await Promise.all([
        getPm2Status(),
        getSolBalance(),
        getRecentLogs(40)
      ]);
      const state = getBotState();
      const serverTime = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Salta' });

      const html = buildHTML({ pm2, balance, logs, state, serverTime });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error: ' + e.message);
    }
  } else if (req.url === '/api/status') {
    try {
      const [pm2, balance] = await Promise.all([getPm2Status(), getSolBalance()]);
      const state = getBotState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pm2, balance, state, time: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Monitor running on http://0.0.0.0:${PORT}`);
  console.log(`Open: http://YOUR_IP:${PORT}`);
});

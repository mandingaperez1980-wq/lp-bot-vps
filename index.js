// ============================================================
// MEMECOIN SNIPER PRO v5.0 — VPS Edition
// Multi-Source: DexScreener + GeckoTerminal + Birdeye + PumpFun
// Features: Multi-TP, Stop Loss, Trailing Stop, Partial Sells,
//           Jito MEV, Smart Scoring, Rug Detection
// ============================================================

const { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
let bs58; try { const b = require('bs58'); bs58 = b.default || b; } catch(e) { bs58 = null; }
const fs = require('fs');
const path = require('path');
const { createScanner } = require('./scanner');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG_FILE = path.join(__dirname, 'config.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const LOG_DIR = path.join(__dirname, 'logs');

let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) { console.error('Config error:', e.message); process.exit(1); }

const SNIPER = {
  entrySOL: (CFG.STRATEGY.CAPITAL_PER_POOL_PERCENT || 20) / 100,
  maxPositions: CFG.STRATEGY.MAX_POOLS_SIMULTANEOUS || 5,
  minScore: 55,
  reserveSOL: CFG.STRATEGY.MIN_CAPITAL_RESERVE_SOL || 0.5,
  scanIntervalMs: (CFG.STRATEGY.SCAN_INTERVAL_SEC || 30) * 1000,
  monitorIntervalMs: (CFG.STRATEGY.MONITOR_INTERVAL_SEC || 15) * 1000,

  tp1: { mult: 1.5, sellPct: 40 },
  tp2: { mult: 2.5, sellPct: 30 },
  tp3: { mult: 5.0, sellPct: 20 },

  slPercent: 25,
  trailingAfterMult: 1.8,
  trailingDropPct: 18,

  cooldownMs: 120000,
  maxAgeMs: 3600000,

  jitoEnabled: true,
  jitoTipLamports: CFG.EXECUTION.JITO_TIP_LAMPORTS || 100000,
  jitoBundleUrl: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',

  scoring: { buyRatio:25, momentum5m:20, momentum1h:15, volumeScore:15, liquidityScore:10, holderScore:10, freshScore:5 },

  minMcap: CFG.FILTERS.MIN_MCAP_USD || 1000000,
  maxMcap: CFG.FILTERS.MAX_MCAP_USD || 1000000000,
  minLiquidity: CFG.FILTERS.MIN_LIQUIDITY_USD || 100000,
  minVolume24h: CFG.FILTERS.MIN_VOLUME_24H_USD || 75000,
  minTxns24h: CFG.FILTERS.MIN_TXNS_24H || 200,
  maxWhaleConcentration: CFG.SAFETY.MAX_WHALE_CONCENTRATION_PERCENT || 30,

  dailyLossLimit: CFG.SAFETY.DAILY_LOSS_LIMIT_USD || 500,
  circuitBreakerLosses: CFG.SAFETY.CIRCUIT_BREAKER_LOSSES || 3,
  rugDetection: CFG.SAFETY.EXIT_IF_RUG_DETECTED !== false,

  jupQuote: CFG.DEX_APIS.JUPITER_QUOTE || 'https://lite-api.jup.ag/swap/v1/quote',
  jupSwap: CFG.DEX_APIS.JUPITER_SWAP || 'https://lite-api.jup.ag/swap/v1/swap',
  dexApi: CFG.DEX_APIS.DEXSCREENER || 'https://api.dexscreener.com/latest/dex',

  slippageBps: CFG.EXECUTION.SLIPPAGE_TOLERANCE_BPS || 200,
  emergencySlippageBps: CFG.EXECUTION.EMERGENCY_SLIPPAGE_BPS || 500,
  priorityFee: CFG.EXECUTION.PRIORITY_FEE_CAP_LAMPORTS || 500000,
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ============================================================
// GLOBALS
// ============================================================
let CONN, KP, PUBKEY;
let balance = 0;
let positions = [];
let history = [];
let scanCount = 0;
let totalPnL = 0;
let totalTrades = 0;
let wins = 0;
let losses = 0;
let dailyLoss = 0;
let dailyDate = '';
let consecutiveLosses = 0;
let circuitOpen = false;
let buyTimestamps = {};

// ============================================================
// LOGGING
// ============================================================
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(path.join(LOG_DIR, 'bot.log'), { flags: 'a' });

function log(msg, level) {
  level = level || 'INFO';
  var ts = new Date().toISOString();
  var icons = { INFO:'i', OK:'V', WARN:'!', ERROR:'X', TRADE:'$', SELL:'>', BUY:'<', SNIPE:'*', TRAIL:'^', SL:'#', TP:'T', RUG:'!', SCAN:'?' };
  var icon = icons[level] || 'i';
  var line = '[' + ts + '] [' + icon + '] [' + level + '] ' + msg;
  console.log(line);
  logStream.write(line + '\n');
}

// Initialize scanner
const scanner = createScanner(CFG, SNIPER, log);

// ============================================================
// STATE MANAGEMENT
// ============================================================
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      activePositions: positions,
      positionHistory: history.slice(0, 50),
      totalNetPnL: totalPnL,
      totalFeesEarned: 0,
      totalILLoss: 0,
      stats: { totalTrades: totalTrades, wins: wins, losses: losses, totalPnL: totalPnL, consecutiveLosses: consecutiveLosses, dailyLoss: dailyLoss, dailyDate: dailyDate },
      deployerWallets: []
    }, null, 2));
  } catch(e) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      positions = st.activePositions || [];
      history = st.positionHistory || [];
      totalPnL = st.totalNetPnL || 0;
      if (st.stats) {
        totalTrades = st.stats.totalTrades || 0;
        wins = st.stats.wins || 0;
        losses = st.stats.losses || 0;
        consecutiveLosses = st.stats.consecutiveLosses || 0;
        dailyLoss = st.stats.dailyLoss || 0;
        dailyDate = st.stats.dailyDate || '';
      }
      log('State loaded: ' + positions.length + ' positions, ' + history.length + ' history, PnL: ' + totalPnL.toFixed(4) + ' SOL', 'INFO');
    }
  } catch(e) { log('State load error: ' + e.message, 'WARN'); }
}

// ============================================================
// WALLET
// ============================================================
async function initWallet() {
  var key = process.env.SNIPER_KEY;
  if (!key) { log('SNIPER_KEY not set!', 'ERROR'); return false; }
  try {
    var decoded = bs58.decode(key);
    KP = Keypair.fromSecretKey(decoded);
    PUBKEY = KP.publicKey.toString();
    var rpcs = [CFG.RPC.PRIMARY].concat(CFG.RPC.FALLBACKS || []).filter(Boolean);
    for (var i = 0; i < rpcs.length; i++) {
      if (rpcs[i].includes('YOUR_HELIUS_KEY')) continue;
      try {
        CONN = new Connection(rpcs[i], { commitment: CFG.RPC.COMMITMENT || 'confirmed' });
        var bal = await CONN.getBalance(KP.publicKey);
        balance = bal / LAMPORTS_PER_SOL;
        log('Wallet: ' + PUBKEY.slice(0,8) + '...' + PUBKEY.slice(-6), 'OK');
        log('Balance: ' + balance.toFixed(4) + ' SOL', 'OK');
        log('RPC: ' + rpcs[i].split('?')[0], 'OK');
        return true;
      } catch(e) { continue; }
    }
    log('All RPCs failed', 'ERROR');
    return false;
  } catch(e) { log('Wallet init error: ' + e.message, 'ERROR'); return false; }
}

async function refreshBalance() {
  try { var bal = await CONN.getBalance(KP.publicKey); balance = bal / LAMPORTS_PER_SOL; } catch(e) {}
}

// ============================================================
// FETCH HELPER
// ============================================================
async function fetchJSON(url, options) {
  options = options || {};
  try {
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, options.timeout || 12000);
    var resp = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    clearTimeout(timeout);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.json();
  } catch(e) { return null; }
}

// ============================================================
// JUPITER SWAP ENGINE
// ============================================================
async function jupiterSwap(inputMint, outputMint, amountLamports, isEmergency) {
  try {
    var slippage = isEmergency ? SNIPER.emergencySlippageBps : SNIPER.slippageBps;
    var quoteUrl = SNIPER.jupQuote + '?inputMint=' + inputMint + '&outputMint=' + outputMint + '&amount=' + amountLamports + '&slippageBps=' + slippage;
    var quote = await fetchJSON(quoteUrl);
    if (!quote || quote.error) throw new Error('Quote failed: ' + (quote ? quote.error : 'no response'));

    var swapBody = {
      quoteResponse: quote,
      userPublicKey: PUBKEY,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: SNIPER.priorityFee
    };
    var swapResp = await fetch(SNIPER.jupSwap, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody),
      signal: AbortSignal.timeout(15000)
    });
    if (!swapResp.ok) throw new Error('Swap request failed: ' + swapResp.status);
    var swapData = await swapResp.json();
    if (swapData.error) throw new Error(swapData.error);

    var txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    var tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([KP]);

    var txId = null;
    if (SNIPER.jitoEnabled && !isEmergency) {
      txId = await sendViaJito(tx);
    }
    if (!txId) {
      txId = await CONN.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3, preflightCommitment: 'confirmed' });
    }
    try { await CONN.confirmTransaction(txId, 'confirmed'); } catch(e) {}
    return { ok: true, txId: txId, outAmount: quote.outAmount ? parseInt(quote.outAmount) : 0 };
  } catch(e) {
    log('Swap error: ' + e.message, 'ERROR');
    return { ok: false, error: e.message };
  }
}

async function sendViaJito(tx) {
  try {
    var serialized = Buffer.from(tx.serialize()).toString('base64');
    var resp = await fetch(SNIPER.jitoBundleUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[serialized]] }),
      signal: AbortSignal.timeout(10000)
    });
    var data = await resp.json();
    if (data.result) { log('Jito bundle: ' + data.result, 'INFO'); return data.result; }
    return null;
  } catch(e) { log('Jito failed: ' + e.message, 'WARN'); return null; }
}

// ============================================================
// BUY LOGIC
// ============================================================
async function buyToken(token) {
  // Enrich token data before buying
  token = await scanner.enrichToken(token);

  var entrySOL = Math.min(balance * SNIPER.entrySOL, balance - SNIPER.reserveSOL);
  if (entrySOL < 0.05) { log('Insufficient balance', 'WARN'); return false; }

  var amountLamports = Math.floor(entrySOL * LAMPORTS_PER_SOL);
  var sources = token.sources ? token.sources.join('+') : token.source || '?';
  log('BUY ' + token.sym + ' | ' + entrySOL.toFixed(4) + ' SOL | Score: ' + token.score + ' | Sources: ' + sources + ' | MCap: $' + (token.mcap/1000).toFixed(0) + 'K', 'BUY');

  var result = await jupiterSwap(SOL_MINT, token.addr, amountLamports, false);
  if (!result.ok) {
    log('Failed to buy ' + token.sym + ': ' + result.error, 'ERROR');
    return false;
  }

  var pos = {
    sym: token.sym, addr: token.addr, pair: token.pair, dex: token.dex,
    entryPrice: token.price, entryPriceNative: token.priceNative,
    curPrice: token.price, entrySOL: entrySOL, capitalSOL: entrySOL,
    tokensHeld: result.outAmount || 0,
    entryTime: Math.floor(Date.now() / 1000),
    entryMcap: token.mcap, entryLiq: token.liq, entryScore: token.score,
    sources: sources,
    peakPrice: token.price, peakMult: 1.0, curMult: 1.0,
    tp1Hit: false, tp2Hit: false, tp3Hit: false,
    soldPct: 0, realizedSOL: 0,
    trailingActive: false, trailingPeak: token.price,
    curLiq: token.liq, curVol: token.vol24, chg24: token.c24,
    netPnL: 0, estFees: 0, il: 0, rebalanceCount: 0,
    txId: result.txId, exitAlert: false, exitReason: '', status: 'active',
    rangeLow: token.price * 0.75, rangeHigh: token.price * 1.5
  };

  positions.push(pos);
  buyTimestamps[token.addr] = Date.now();
  saveState();
  log('BOUGHT ' + token.sym + ' | TX: ' + result.txId.slice(0,16) + '...', 'SNIPE');
  return true;
}

// ============================================================
// SELL LOGIC (PARTIAL)
// ============================================================
async function sellToken(pos, sellPercent, reason, isEmergency) {
  if (sellPercent <= 0 || pos.soldPct >= 100) return false;
  var actualSellPct = Math.min(sellPercent, 100 - pos.soldPct);
  var tokensToSell = Math.floor(pos.tokensHeld * (actualSellPct / 100));
  if (tokensToSell <= 0) return false;

  log('SELL ' + actualSellPct + '% of ' + pos.sym + ' | Reason: ' + reason + ' | Mult: ' + pos.curMult.toFixed(2) + 'x', 'SELL');
  var result = await jupiterSwap(pos.addr, SOL_MINT, tokensToSell, isEmergency);
  if (!result.ok) {
    if (!isEmergency) {
      log('Retrying emergency sell...', 'WARN');
      return await sellToken(pos, sellPercent, reason, true);
    }
    return false;
  }

  var solReceived = result.outAmount ? result.outAmount / LAMPORTS_PER_SOL : 0;
  pos.realizedSOL += solReceived;
  pos.soldPct += actualSellPct;
  pos.tokensHeld -= tokensToSell;
  log('SOLD ' + actualSellPct + '% of ' + pos.sym + ' for ' + solReceived.toFixed(4) + ' SOL | Total sold: ' + pos.soldPct + '%', 'TRADE');

  if (pos.soldPct >= 95) closePosition(pos, reason);
  saveState();
  return true;
}

function closePosition(pos, reason) {
  var pnl = pos.realizedSOL - pos.entrySOL;
  totalPnL += pnl;
  totalTrades++;
  if (pnl >= 0) { wins++; consecutiveLosses = 0; }
  else { losses++; consecutiveLosses++; dailyLoss += Math.abs(pnl); }

  var pnlPct = pos.entrySOL > 0 ? (pnl / pos.entrySOL * 100) : 0;
  log('CLOSED ' + pos.sym + ' | PnL: ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' SOL (' + pnlPct.toFixed(1) + '%) | Reason: ' + reason, pnl >= 0 ? 'TP' : 'SL');
  log('Record: ' + wins + 'W/' + losses + 'L | Total PnL: ' + (totalPnL >= 0 ? '+' : '') + totalPnL.toFixed(4) + ' SOL', 'INFO');

  history.unshift({
    sym: pos.sym, addr: pos.addr, dex: pos.dex, capitalSOL: pos.capitalSOL,
    entryPrice: pos.entryPrice, curPrice: pos.curPrice, sources: pos.sources,
    closeTime: Math.floor(Date.now() / 1000), reason: reason,
    pnlSOL: pnl, pnlPct: pnlPct, chg24: pos.chg24,
    emergency: reason.indexOf('RUG') >= 0 || reason.indexOf('EMERG') >= 0
  });
  positions = positions.filter(function(p) { return p.addr !== pos.addr; });

  if (consecutiveLosses >= SNIPER.circuitBreakerLosses) {
    circuitOpen = true;
    log('CIRCUIT BREAKER: ' + consecutiveLosses + ' losses. Pausing 15min.', 'ERROR');
    setTimeout(function() { circuitOpen = false; consecutiveLosses = 0; log('Circuit breaker reset', 'OK'); }, 900000);
  }
  saveState();
}

// ============================================================
// MONITOR ENGINE (TP/SL/Trailing)
// ============================================================
async function monitorPositions() {
  for (var i = 0; i < positions.length; i++) {
    var pos = positions[i];
    try {
      var data = await fetchJSON(SNIPER.dexApi + '/tokens/' + pos.addr);
      if (!data || !data.pairs || data.pairs.length === 0) continue;

      var pair = data.pairs.find(function(p) { return p.pairAddress === pos.pair; }) || data.pairs[0];
      var curPrice = parseFloat(pair.priceUsd || 0);
      if (curPrice <= 0) continue;

      pos.curPrice = curPrice;
      pos.curMult = curPrice / pos.entryPrice;
      pos.curLiq = pair.liquidity ? pair.liquidity.usd || pos.curLiq : pos.curLiq;
      pos.curVol = pair.volume ? pair.volume.h24 || pos.curVol : pos.curVol;
      pos.chg24 = pair.priceChange ? pair.priceChange.h24 || 0 : 0;

      if (curPrice > pos.peakPrice) { pos.peakPrice = curPrice; pos.peakMult = pos.curMult; }
      if (pos.trailingActive && curPrice > pos.trailingPeak) pos.trailingPeak = curPrice;

      var unrealizedValue = pos.entrySOL * pos.curMult * ((100 - pos.soldPct) / 100);
      pos.netPnL = pos.realizedSOL + unrealizedValue - pos.entrySOL;
      pos.estFees = pos.realizedSOL > 0 ? pos.realizedSOL - (pos.entrySOL * pos.soldPct / 100) : 0;
      pos.il = pos.curMult < 1 ? (1 - pos.curMult) * -1 : 0;

      var mult = pos.curMult.toFixed(2);

      // RUG DETECTION
      if (SNIPER.rugDetection) {
        if (pos.entryLiq > 0 && pos.curLiq < pos.entryLiq * 0.5) {
          log('RUG: ' + pos.sym + ' liquidity dropped ' + ((1 - pos.curLiq / pos.entryLiq) * 100).toFixed(0) + '%', 'RUG');
          await sellToken(pos, 100 - pos.soldPct, 'RUG: Liquidity drop', true);
          continue;
        }
        if (pos.curMult < 0.3 && pos.peakMult > 1) {
          log('RUG: ' + pos.sym + ' crashed ' + ((1 - pos.curMult) * 100).toFixed(0) + '%', 'RUG');
          await sellToken(pos, 100 - pos.soldPct, 'RUG: Price crash', true);
          continue;
        }
      }

      // STOP LOSS
      if (pos.curMult <= (1 - SNIPER.slPercent / 100)) {
        log('STOP LOSS: ' + pos.sym + ' at ' + mult + 'x', 'SL');
        await sellToken(pos, 100 - pos.soldPct, 'SL: -' + SNIPER.slPercent + '%', true);
        continue;
      }

      // TAKE PROFIT 1
      if (!pos.tp1Hit && pos.curMult >= SNIPER.tp1.mult) {
        log('TP1: ' + pos.sym + ' at ' + mult + 'x — selling ' + SNIPER.tp1.sellPct + '%', 'TP');
        if (await sellToken(pos, SNIPER.tp1.sellPct, 'TP1: ' + mult + 'x')) pos.tp1Hit = true;
      }

      // TAKE PROFIT 2
      if (!pos.tp2Hit && pos.curMult >= SNIPER.tp2.mult) {
        log('TP2: ' + pos.sym + ' at ' + mult + 'x — selling ' + SNIPER.tp2.sellPct + '%', 'TP');
        if (await sellToken(pos, SNIPER.tp2.sellPct, 'TP2: ' + mult + 'x')) pos.tp2Hit = true;
      }

      // TAKE PROFIT 3
      if (!pos.tp3Hit && pos.curMult >= SNIPER.tp3.mult) {
        log('TP3: ' + pos.sym + ' at ' + mult + 'x — selling ' + SNIPER.tp3.sellPct + '%', 'TP');
        if (await sellToken(pos, SNIPER.tp3.sellPct, 'TP3: ' + mult + 'x')) pos.tp3Hit = true;
      }

      // TRAILING STOP
      if (pos.curMult >= SNIPER.trailingAfterMult && !pos.trailingActive) {
        pos.trailingActive = true;
        pos.trailingPeak = curPrice;
        log('TRAILING ON: ' + pos.sym + ' at ' + mult + 'x', 'TRAIL');
      }
      if (pos.trailingActive && pos.trailingPeak > 0) {
        var dropFromPeak = (1 - curPrice / pos.trailingPeak) * 100;
        if (dropFromPeak >= SNIPER.trailingDropPct) {
          log('TRAILING STOP: ' + pos.sym + ' dropped ' + dropFromPeak.toFixed(1) + '% from peak', 'TRAIL');
          await sellToken(pos, 100 - pos.soldPct, 'TRAIL: -' + dropFromPeak.toFixed(0) + '% from peak');
          continue;
        }
      }

      if (scanCount % 5 === 0) {
        var age = Math.floor((Date.now() / 1000 - pos.entryTime) / 60);
        var emoji = pos.curMult >= 1 ? '+' : '-';
        log(emoji + ' ' + pos.sym + ': ' + mult + 'x | Peak: ' + pos.peakMult.toFixed(2) + 'x | Sold: ' + pos.soldPct + '% | Real: ' + pos.realizedSOL.toFixed(4) + ' SOL | ' + age + 'm' + (pos.trailingActive ? ' | TRAIL' : ''), 'INFO');
      }
    } catch(e) { log('Monitor error ' + pos.sym + ': ' + e.message, 'ERROR'); }
  }
}

// ============================================================
// AUTO-SNIPE (ENTRY LOGIC)
// ============================================================
async function autoSnipe(tokens) {
  if (circuitOpen) return;
  if (positions.length >= SNIPER.maxPositions) return;

  var today = new Date().toISOString().split('T')[0];
  if (dailyDate !== today) { dailyDate = today; dailyLoss = 0; }
  if (dailyLoss > SNIPER.dailyLossLimit / 100) return;

  await refreshBalance();
  var available = balance - SNIPER.reserveSOL;
  if (available < 0.05) return;

  for (var i = 0; i < tokens.length; i++) {
    if (positions.length >= SNIPER.maxPositions) break;
    if (available < 0.05) break;

    var token = tokens[i];

    if (buyTimestamps[token.addr] && Date.now() - buyTimestamps[token.addr] < SNIPER.cooldownMs) continue;
    var recent = history.find(function(h) { return h.addr === token.addr && h.closeTime > Date.now()/1000 - 3600; });
    if (recent) continue;
    if (token.c5 < 0) continue;
    if (token.buys5 > 0 && token.buys5 <= token.sells5) continue;

    var bought = await buyToken(token);
    if (bought) {
      await refreshBalance();
      available = balance - SNIPER.reserveSOL;
      await new Promise(function(r) { setTimeout(r, 3000); });
    }
  }
}

// ============================================================
// STATUS REPORT
// ============================================================
function printReport() {
  log('=====================================================', 'INFO');
  log('   MEMECOIN SNIPER PRO v5.0 — Status Report', 'INFO');
  log('=====================================================', 'INFO');
  log('Balance:     ' + balance.toFixed(4) + ' SOL', 'INFO');
  var invested = positions.reduce(function(s, p) { return s + p.entrySOL * (1 - p.soldPct/100); }, 0);
  log('Invested:    ' + invested.toFixed(4) + ' SOL across ' + positions.length + ' positions', 'INFO');
  log('Total PnL:   ' + (totalPnL >= 0 ? '+' : '') + totalPnL.toFixed(4) + ' SOL', 'INFO');
  log('Record:      ' + wins + 'W / ' + losses + 'L (' + (totalTrades > 0 ? (wins/totalTrades*100).toFixed(0) : 0) + '% WR)', 'INFO');
  log('Circuit:     ' + (circuitOpen ? 'OPEN' : 'OK'), 'INFO');
  log('Jito MEV:    ' + (SNIPER.jitoEnabled ? 'ON' : 'OFF'), 'INFO');
  log('Sources:     DexScreener + GeckoTerminal + Birdeye + PumpFun', 'INFO');
  log('-----------------------------------------------------', 'INFO');
  for (var i = 0; i < positions.length; i++) {
    var p = positions[i];
    log('  ' + p.sym + ': ' + p.curMult.toFixed(2) + 'x | Sold: ' + p.soldPct + '% | Real: ' + p.realizedSOL.toFixed(4) + ' SOL' + (p.trailingActive ? ' TRAIL' : '') + ' | ' + (p.sources || ''), 'INFO');
  }
  log('=====================================================', 'INFO');
}

// ============================================================
// MAIN LOOP
// ============================================================
async function cycle() {
  scanCount++;
  try {
    if (scanCount % 20 === 0) printReport();

    await monitorPositions();

    var tokens = await scanner.scan(positions);

    if (scanCount % 5 === 0) {
      var posStr = positions.map(function(p) { return p.sym + ':' + p.curMult.toFixed(2) + 'x'; }).join(' ');
      log('Scan #' + scanCount + ' | Found: ' + tokens.length + ' | Pos: ' + positions.length + '/' + SNIPER.maxPositions + ' | Bal: ' + balance.toFixed(4) + ' SOL | PnL: ' + (totalPnL >= 0 ? '+' : '') + totalPnL.toFixed(4) + ' | ' + posStr, 'SCAN');
    }

    await autoSnipe(tokens);
    saveState();
  } catch(e) { log('Cycle error: ' + e.message, 'ERROR'); }
}

// ============================================================
// START
// ============================================================
async function main() {
  console.log('');
  console.log('  ======================================');
  console.log('  MEMECOIN SNIPER PRO v5.0');
  console.log('  --------------------------------------');
  console.log('  Multi-TP | Stop Loss | Trailing Stop');
  console.log('  Jito MEV | Smart Score | Rug Detect');
  console.log('  DexScreener+Gecko+Birdeye+PumpFun');
  console.log('  ======================================');
  console.log('');

  loadState();

  var ok = await initWallet();
  if (!ok) { log('Wallet init failed. Exiting.', 'ERROR'); process.exit(1); }

  log('Config:', 'INFO');
  log('  Entry: ' + (SNIPER.entrySOL * 100).toFixed(0) + '% | MaxPos: ' + SNIPER.maxPositions, 'INFO');
  log('  TP1: ' + SNIPER.tp1.mult + 'x(' + SNIPER.tp1.sellPct + '%) | TP2: ' + SNIPER.tp2.mult + 'x(' + SNIPER.tp2.sellPct + '%) | TP3: ' + SNIPER.tp3.mult + 'x(' + SNIPER.tp3.sellPct + '%)', 'INFO');
  log('  SL: -' + SNIPER.slPercent + '% | Trail: ' + SNIPER.trailingDropPct + '% after ' + SNIPER.trailingAfterMult + 'x', 'INFO');
  log('  Score min: ' + SNIPER.minScore + ' | MCap: $' + (SNIPER.minMcap/1e6).toFixed(1) + 'M-$' + (SNIPER.maxMcap/1e9).toFixed(1) + 'B', 'INFO');
  log('  Jito: ' + (SNIPER.jitoEnabled ? 'ON' : 'OFF') + ' | Rug: ' + (SNIPER.rugDetection ? 'ON' : 'OFF'), 'INFO');
  log('  Sources: DexScreener + GeckoTerminal + Birdeye + PumpFun', 'INFO');
  console.log('');
  log('Bot started — operating 24/7', 'OK');
  console.log('');

  await cycle();
  setInterval(cycle, SNIPER.scanIntervalMs);

  var shutdown = function() {
    log('Shutting down...', 'WARN');
    saveState();
    printReport();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(function(e) { log('Fatal: ' + e.message, 'ERROR'); process.exit(1); });

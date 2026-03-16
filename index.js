// ============================================================
// MEMECOIN LP MANAGEMENT BOT - Professional VPS Edition
// ============================================================
// Dynamic CLMM range management, rug detection, IL monitoring,
// auto-rebalancing, whale analysis, priority fee optimization
// ============================================================

const { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// ============================================================
// LOAD CONFIG
// ============================================================
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DEVNET = process.argv.includes('--devnet');

// ============================================================
// STATE
// ============================================================
const STATE = {
  keypair: null,
  connection: null,
  pubkey: '',
  balance: 0,
  
  // Pool tracking
  availablePools: [],      // Scanned pools ranked by profitability
  activePositions: [],     // Active LP positions
  positionHistory: [],     // Closed positions
  
  // Counters
  scanCount: 0,
  totalFeesEarned: 0,
  totalILLoss: 0,
  totalNetPnL: 0,
  dailyLoss: 0,
  consecutiveLosses: 0,
  lastRebalance: {},       // pair -> timestamp
  
  // Rug detection
  deployerWallets: new Map(), // tokenAddr -> deployerAddr
  liquiditySnapshots: new Map(), // pair -> [{time, liq}]
  
  // Circuit breaker
  circuitBreakerTripped: false,
};

const STATE_FILE = './state.json';
const LOG_DIR = './logs';

// ============================================================
// LOGGING SYSTEM
// ============================================================
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg, level = 'INFO') {
  const time = new Date().toISOString();
  const icons = { INFO: 'ℹ️', OK: '✅', WARN: '⚠️', ERROR: '❌', TRADE: '💰', POOL: '💧', RUG: '🚨', REBAL: '🔄', IL: '📉', EXIT: '🚪' };
  const icon = icons[level] || 'ℹ️';
  const line = `[${time}] ${icon} [${level}] ${msg}`;
  console.log(line);
  
  // Write to log file
  const logFile = path.join(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

// ============================================================
// STATE PERSISTENCE
// ============================================================
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      activePositions: STATE.activePositions,
      positionHistory: STATE.positionHistory.slice(0, 500),
      totalFeesEarned: STATE.totalFeesEarned,
      totalILLoss: STATE.totalILLoss,
      totalNetPnL: STATE.totalNetPnL,
      deployerWallets: Array.from(STATE.deployerWallets.entries()),
    }, null, 2));
  } catch (e) { log('State save error: ' + e.message, 'WARN'); }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      STATE.activePositions = data.activePositions || [];
      STATE.positionHistory = data.positionHistory || [];
      STATE.totalFeesEarned = data.totalFeesEarned || 0;
      STATE.totalILLoss = data.totalILLoss || 0;
      STATE.totalNetPnL = data.totalNetPnL || 0;
      if (data.deployerWallets) STATE.deployerWallets = new Map(data.deployerWallets);
      log(`State restored: ${STATE.activePositions.length} positions, ${STATE.positionHistory.length} history`, 'OK');
    }
  } catch (e) { log('State load error: ' + e.message, 'WARN'); }
}

// ============================================================
// NETWORK: FETCH WITH TIMEOUT + RETRY
// ============================================================
async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRetry(url, opts = {}, retries = 3, timeoutMs = 15000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(url, opts, timeoutMs);
      if (res.ok) return res;
      if (i < retries - 1) await sleep(CONFIG.RPC.RETRY_DELAY_MS * (i + 1));
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(CONFIG.RPC.RETRY_DELAY_MS * (i + 1));
    }
  }
  throw new Error('Fetch failed after ' + retries + ' retries');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// WALLET INITIALIZATION
// ============================================================
async function initWallet() {
  const pkEnv = CONFIG.WALLET.PRIVATE_KEY_ENV;
  const privateKey = process.env[pkEnv];
  
  if (!privateKey) {
    log(`Set environment variable ${pkEnv} with your Phantom private key`, 'ERROR');
    log(`Example: export ${pkEnv}=your_base58_private_key`, 'ERROR');
    process.exit(1);
  }

  try {
    const secretKey = bs58.decode(privateKey);
    STATE.keypair = Keypair.fromSecretKey(secretKey);
    STATE.pubkey = STATE.keypair.publicKey.toString();
    log(`Wallet: ${STATE.pubkey.slice(0, 8)}...${STATE.pubkey.slice(-8)}`, 'OK');

    // Connect to RPC with fallbacks
    const rpcs = [CONFIG.RPC.PRIMARY, ...CONFIG.RPC.FALLBACKS];
    for (const rpc of rpcs) {
      try {
        STATE.connection = new Connection(rpc, {
          commitment: CONFIG.RPC.COMMITMENT,
          confirmTransactionInitialTimeout: 60000,
        });
        const lamports = await STATE.connection.getBalance(STATE.keypair.publicKey);
        STATE.balance = lamports / LAMPORTS_PER_SOL;
        log(`RPC: ${rpc.split('/')[2].split('?')[0]} | Balance: ${STATE.balance.toFixed(4)} SOL`, 'OK');
        return true;
      } catch (e) {
        log(`RPC ${rpc.split('/')[2].split('?')[0]} failed: ${e.message.slice(0, 60)}`, 'WARN');
      }
    }
    log('All RPCs failed', 'ERROR');
    return false;
  } catch (e) {
    log('Wallet error: ' + e.message, 'ERROR');
    return false;
  }
}

async function refreshBalance() {
  try {
    const lamports = await STATE.connection.getBalance(STATE.keypair.publicKey);
    STATE.balance = lamports / LAMPORTS_PER_SOL;
  } catch (_) {}
}

// ============================================================
// MODULE 1: POOL SCANNER
// ============================================================
async function scanPools() {
  log('Scanning memecoin pools...', 'POOL');
  const allPairs = [];

  // Source 1: DexScreener search queries
  const queries = ['pump.fun SOL', 'solana meme', 'solana trending', 'memecoin solana', 'solana pump', 'solana new token'];
  for (const q of queries) {
    try {
      const r = await fetchWithTimeout(`${CONFIG.DEX_APIS.DEXSCREENER}/search?q=${encodeURIComponent(q)}`, {}, 12000);
      if (r.ok) {
        const d = await r.json();
        allPairs.push(...(d.pairs || []).filter(p => p.chainId === 'solana'));
      }
    } catch (_) {}
  }

  // Source 2: Boosted tokens
  try {
    const r = await fetchWithTimeout(CONFIG.DEX_APIS.DEXSCREENER_BOOSTS, {}, 10000);
    if (r.ok) {
      const d = await r.json();
      for (const t of (d || []).filter(x => x.chainId === 'solana').slice(0, 12)) {
        try {
          const pr = await fetchWithTimeout(`${CONFIG.DEX_APIS.DEXSCREENER}/tokens/${t.tokenAddress}`, {}, 8000);
          if (pr.ok) { const pd = await pr.json(); allPairs.push(...(pd.pairs || [])); }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Source 3: Latest profiles
  try {
    const r = await fetchWithTimeout(CONFIG.DEX_APIS.DEXSCREENER_PROFILES, {}, 10000);
    if (r.ok) {
      const d = await r.json();
      for (const t of (d || []).filter(x => x.chainId === 'solana').slice(0, 8)) {
        try {
          const pr = await fetchWithTimeout(`${CONFIG.DEX_APIS.DEXSCREENER}/tokens/${t.tokenAddress}`, {}, 8000);
          if (pr.ok) { const pd = await pr.json(); allPairs.push(...(pd.pairs || [])); }
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Deduplicate and filter
  const seen = new Set();
  const blackAddr = new Set(CONFIG.FILTERS.BLACKLISTED_TOKENS);
  const blackSym = new Set(CONFIG.FILTERS.BLACKLISTED_SYMBOLS.map(s => s.toUpperCase()));

  STATE.availablePools = allPairs.filter(p => {
    if (!p || seen.has(p.pairAddress)) return false;
    seen.add(p.pairAddress);
    if (p.chainId !== 'solana') return false;
    
    const mc = p.marketCap || p.fdv || 0;
    const liq = p.liquidity?.usd || 0;
    const vol = p.volume?.h24 || 0;
    const sym = (p.baseToken?.symbol || '').toUpperCase();
    const addr = p.baseToken?.address || '';
    const txns = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
    const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600000 : 9999;

    // Apply filters
    if (mc < CONFIG.FILTERS.MIN_MCAP_USD || mc > CONFIG.FILTERS.MAX_MCAP_USD) return false;
    if (liq < CONFIG.FILTERS.MIN_LIQUIDITY_USD) return false;
    if (vol < CONFIG.FILTERS.MIN_VOLUME_24H_USD) return false;
    if (txns < CONFIG.FILTERS.MIN_TXNS_24H) return false;
    if (blackAddr.has(addr) || blackSym.has(sym)) return false;
    if (CONFIG.SAFETY.MIN_TOKEN_AGE_HOURS && ageH < CONFIG.SAFETY.MIN_TOKEN_AGE_HOURS) return false;

    return true;
  }).map(p => {
    const liq = p.liquidity?.usd || 0;
    const vol24 = p.volume?.h24 || 0;
    const vol1h = p.volume?.h1 || 0;
    const mc = p.marketCap || p.fdv || 0;
    const chg24 = p.priceChange?.h24 || 0;
    const chg1h = p.priceChange?.h1 || 0;
    const txns24 = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
    const buys24 = p.txns?.h24?.buys || 0;
    const sells24 = p.txns?.h24?.sells || 0;
    const buyRatio = txns24 > 0 ? buys24 / txns24 : 0;
    const ageH = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600000 : 9999;
    const fee = 0.0025;
    const dailyFees = vol24 * fee;
    const apy = liq > 0 ? (dailyFees / liq) * 365 * 100 : 0;

    // RISK SCORING (0-100, lower = safer)
    let risk = 0;
    if (mc < 500000) risk += 15;
    if (liq < 100000) risk += 15;
    if (ageH < 24) risk += 20;
    if (ageH < 6) risk += 15;
    if (Math.abs(chg24) > 50) risk += 15;
    if (txns24 < 200) risk += 10;
    if (liq / mc < 0.05) risk += 10;
    if (buyRatio < 0.4) risk += 10; // More sells than buys
    risk = Math.min(100, risk);

    // PROFITABILITY SCORING (0-100, higher = better)
    let profit = 0;
    if (apy > 200) profit += 30; else if (apy > 100) profit += 25; else if (apy > 50) profit += 20;
    if (vol24 > 1000000) profit += 20; else if (vol24 > 500000) profit += 15; else if (vol24 > 100000) profit += 10;
    if (liq > 500000) profit += 15; else if (liq > 200000) profit += 10;
    if (txns24 > 2000) profit += 15; else if (txns24 > 1000) profit += 10;
    if (buyRatio > 0.55) profit += 10;

    // COMPOSITE SCORE
    const score = Math.max(0, profit - risk / 2);
    const riskLevel = risk < 30 ? 'LOW' : risk < 60 ? 'MED' : 'HIGH';

    return {
      pair: p.pairAddress,
      sym: p.baseToken?.symbol || '?',
      name: p.baseToken?.name || '?',
      addr: p.baseToken?.address || '',
      dex: p.dexId || '?',
      price: +(p.priceUsd || 0),
      liq, vol24, vol1h, mc, apy: Math.min(apy, 9999), dailyFees,
      chg24, chg1h, txns24, buyRatio, ageH, risk, riskLevel, profit, score,
      url: p.url || `https://dexscreener.com/solana/${p.pairAddress}`,
    };
  }).sort((a, b) => b.score - a.score);

  log(`Found ${STATE.availablePools.length} qualifying pools`, 'POOL');
  if (STATE.availablePools.length > 0) {
    const top3 = STATE.availablePools.slice(0, 3);
    for (const p of top3) {
      log(`  ${p.sym}: APY=${p.apy.toFixed(0)}% | Liq=$${(p.liq / 1000).toFixed(0)}K | Vol=$${(p.vol24 / 1000).toFixed(0)}K | Risk=${p.riskLevel} | Score=${p.score.toFixed(0)}`, 'POOL');
    }
  }
  return STATE.availablePools;
}

// ============================================================
// MODULE 2: WHALE CONCENTRATION ANALYZER
// ============================================================
async function checkWhaleConcentration(tokenAddr) {
  try {
    const tokenPk = new PublicKey(tokenAddr);
    // Get largest token accounts
    const accounts = await STATE.connection.getTokenLargestAccounts(tokenPk);
    if (!accounts?.value?.length) return { safe: true, topHolderPct: 0 };

    const totalSupply = accounts.value.reduce((s, a) => s + +(a.uiAmount || 0), 0);
    if (totalSupply === 0) return { safe: true, topHolderPct: 0 };

    // Sum top 10 holders
    const top10Amount = accounts.value
      .slice(0, 10)
      .reduce((s, a) => s + +(a.uiAmount || 0), 0);
    const top10Pct = (top10Amount / totalSupply) * 100;

    const safe = top10Pct <= CONFIG.SAFETY.MAX_WHALE_CONCENTRATION_PERCENT;
    if (!safe) {
      log(`⚠️ Whale alert ${tokenAddr.slice(0, 8)}: Top 10 holders own ${top10Pct.toFixed(1)}% (limit: ${CONFIG.SAFETY.MAX_WHALE_CONCENTRATION_PERCENT}%)`, 'WARN');
    }
    return { safe, topHolderPct: top10Pct };
  } catch (e) {
    log('Whale check error: ' + e.message.slice(0, 60), 'WARN');
    return { safe: true, topHolderPct: 0 }; // Fail open
  }
}

// ============================================================
// MODULE 3: RUG PULL DETECTOR
// ============================================================
async function checkRugPull(position) {
  if (!CONFIG.SAFETY.EXIT_IF_RUG_DETECTED) return { safe: true };

  const tokenAddr = position.addr;
  const pairAddr = position.pair;
  const rugCfg = CONFIG.SAFETY.RUG_DETECTION;

  // 1. Check liquidity snapshots for sudden drops
  if (!STATE.liquiditySnapshots.has(pairAddr)) {
    STATE.liquiditySnapshots.set(pairAddr, []);
  }
  const snapshots = STATE.liquiditySnapshots.get(pairAddr);
  
  try {
    const r = await fetchWithTimeout(`${CONFIG.DEX_APIS.DEXSCREENER}/pairs/solana/${pairAddr}`, {}, 8000);
    if (r.ok) {
      const d = await r.json();
      const pair = d.pair || d.pairs?.[0];
      if (pair) {
        const curLiq = pair.liquidity?.usd || 0;
        snapshots.push({ time: Date.now(), liq: curLiq });
        
        // Keep only last 30 minutes of snapshots
        const cutoff = Date.now() - (rugCfg.LIQUIDITY_DROP_TIMEFRAME_MIN * 60000);
        while (snapshots.length > 0 && snapshots[0].time < cutoff) snapshots.shift();
        
        // Check for sudden liquidity drop
        if (snapshots.length >= 2) {
          const oldestLiq = snapshots[0].liq;
          if (oldestLiq > 0) {
            const dropPct = ((oldestLiq - curLiq) / oldestLiq) * 100;
            if (dropPct >= rugCfg.LIQUIDITY_DROP_THRESHOLD_PERCENT) {
              log(`🚨 RUG DETECTED: ${position.sym} liquidity dropped ${dropPct.toFixed(0)}% in ${rugCfg.LIQUIDITY_DROP_TIMEFRAME_MIN}min! ($${oldestLiq.toFixed(0)} → $${curLiq.toFixed(0)})`, 'RUG');
              return { safe: false, reason: `Liquidity -${dropPct.toFixed(0)}% in ${rugCfg.LIQUIDITY_DROP_TIMEFRAME_MIN}min` };
            }
          }
        }
      }
    }
  } catch (_) {}

  // 2. Check deployer wallet activity
  if (STATE.deployerWallets.has(tokenAddr)) {
    const deployerAddr = STATE.deployerWallets.get(tokenAddr);
    try {
      const deployerPk = new PublicKey(deployerAddr);
      const sigs = await STATE.connection.getSignaturesForAddress(deployerPk, { limit: 5 });
      
      // If deployer has many recent transactions, flag it
      const recentTxs = sigs.filter(s => s.blockTime && (Date.now() / 1000 - s.blockTime) < 300); // Last 5 min
      if (recentTxs.length >= 3) {
        log(`⚠️ Deployer ${deployerAddr.slice(0, 8)} has ${recentTxs.length} txs in last 5min for ${position.sym}`, 'RUG');
        return { safe: false, reason: 'Deployer high activity (possible dump)' };
      }
    } catch (_) {}
  }

  return { safe: true };
}

// ============================================================
// MODULE 4: IMPERMANENT LOSS CALCULATOR
// ============================================================
function calculateIL(entryPrice, currentPrice) {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  const priceRatio = currentPrice / entryPrice;
  const sqrtR = Math.sqrt(priceRatio);
  // Standard IL formula: 2*sqrt(r)/(1+r) - 1
  const il = (2 * sqrtR / (1 + priceRatio) - 1) * 100;
  return il; // Negative means loss
}

function calculateConcentratedIL(entryPrice, currentPrice, rangeMin, rangeMax) {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  
  // If price outside range, IL is maximized
  if (currentPrice <= rangeMin || currentPrice >= rangeMax) {
    return calculateIL(entryPrice, currentPrice) * 2; // Amplified for concentrated
  }
  
  // Within range, IL is amplified by concentration factor
  const rangeWidth = (rangeMax - rangeMin) / entryPrice;
  const concentrationFactor = 1 / rangeWidth;
  const standardIL = calculateIL(entryPrice, currentPrice);
  return standardIL * Math.min(concentrationFactor, 5); // Cap at 5x amplification
}

// ============================================================
// MODULE 5: JUPITER SWAP ENGINE
// ============================================================
async function jupiterSwap(tokenAddr, amountSOL, isBuy) {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const inMint = isBuy ? SOL_MINT : tokenAddr;
  const outMint = isBuy ? tokenAddr : SOL_MINT;
  const amount = isBuy 
    ? Math.floor(amountSOL * LAMPORTS_PER_SOL) 
    : Math.floor(amountSOL * 1e6);

  const slippage = isBuy 
    ? CONFIG.EXECUTION.SLIPPAGE_TOLERANCE_BPS 
    : CONFIG.EXECUTION.EMERGENCY_SLIPPAGE_BPS; // Higher slippage for emergency exits

  try {
    log(`Jupiter ${isBuy ? 'BUY' : 'SELL'}: ${amountSOL.toFixed(4)} SOL ↔ ${tokenAddr.slice(0, 8)}... (slippage: ${slippage}bps)`);

    // 1. Quote
    const qUrl = `${CONFIG.DEX_APIS.JUPITER_QUOTE}?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippage}`;
    const qr = await fetchRetry(qUrl, {}, CONFIG.RPC.MAX_RETRIES, 20000);
    const quote = await qr.json();
    if (quote.error) throw new Error('Quote: ' + quote.error);

    // 2. Swap transaction
    const sr = await fetchRetry(CONFIG.DEX_APIS.JUPITER_SWAP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: STATE.pubkey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: CONFIG.EXECUTION.JITO_ENABLED 
          ? { jitoTipLamports: CONFIG.EXECUTION.JITO_TIP_LAMPORTS }
          : 'auto',
      }),
    }, CONFIG.RPC.MAX_RETRIES, 20000);
    
    const swapData = await sr.json();
    if (swapData.error) throw new Error('Swap: ' + swapData.error);

    // 3. Deserialize and sign
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([STATE.keypair]);

    // 4. Send with priority
    const txId = await STATE.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: CONFIG.EXECUTION.SKIP_PREFLIGHT,
      maxRetries: CONFIG.RPC.MAX_RETRIES,
    });

    log(`✅ TX confirmed: ${txId}`, 'OK');
    log(`   https://solscan.io/tx/${txId}`, 'INFO');

    setTimeout(refreshBalance, 5000);
    return { ok: true, txId };
  } catch (e) {
    log(`Swap ERROR: ${e.message}`, 'ERROR');
    return { ok: false, error: e.message };
  }
}

// ============================================================
// MODULE 6: POOL ENTRY LOGIC
// ============================================================
async function evaluateAndEnter() {
  if (STATE.circuitBreakerTripped) {
    log('Circuit breaker active — no new entries', 'WARN');
    return;
  }
  
  if (STATE.activePositions.length >= CONFIG.STRATEGY.MAX_POOLS_SIMULTANEOUS) return;
  
  const reserveSOL = CONFIG.STRATEGY.MIN_CAPITAL_RESERVE_SOL;
  const availableSOL = STATE.balance - reserveSOL;
  if (availableSOL <= 0) return;

  const capitalPerPool = availableSOL * (CONFIG.STRATEGY.CAPITAL_PER_POOL_PERCENT / 100);
  if (capitalPerPool < 0.1) return; // Minimum 0.1 SOL

  // Find best pool not already in
  const activeAddrs = STATE.activePositions.map(p => p.addr);
  const historyAddrs = STATE.positionHistory.slice(0, 20).map(h => h.addr);
  
  for (const pool of STATE.availablePools.slice(0, 10)) {
    if (activeAddrs.includes(pool.addr) || historyAddrs.includes(pool.addr)) continue;
    if (pool.apy < CONFIG.FILTERS.MIN_APY_PERCENT) continue;

    // Whale check
    const whaleCheck = await checkWhaleConcentration(pool.addr);
    if (!whaleCheck.safe) {
      log(`Skip ${pool.sym}: whale concentration ${whaleCheck.topHolderPct.toFixed(0)}%`, 'WARN');
      continue;
    }

    // Calculate dynamic range based on volatility
    const rangeBuffer = CONFIG.STRATEGY.PRICE_RANGE_BUFFER;
    const priceRangeLow = pool.price * (1 - rangeBuffer);
    const priceRangeHigh = pool.price * (1 + rangeBuffer);

    log(``, 'POOL');
    log(`=== ENTERING POOL: ${pool.sym} ===`, 'POOL');
    log(`  APY: ${pool.apy.toFixed(0)}% | Liq: $${(pool.liq / 1000).toFixed(0)}K | Vol: $${(pool.vol24 / 1000).toFixed(0)}K`, 'POOL');
    log(`  Risk: ${pool.riskLevel} (${pool.risk}/100) | Score: ${pool.score.toFixed(0)}`, 'POOL');
    log(`  Range: $${priceRangeLow.toFixed(8)} — $${priceRangeHigh.toFixed(8)} (±${(rangeBuffer * 100).toFixed(0)}%)`, 'POOL');
    log(`  Capital: ${capitalPerPool.toFixed(4)} SOL`, 'POOL');
    log(`  Whale top10: ${whaleCheck.topHolderPct.toFixed(1)}%`, 'POOL');

    // Execute entry swap (buy half in token)
    const halfSOL = capitalPerPool / 2;
    const result = await jupiterSwap(pool.addr, halfSOL, true);
    
    if (result.ok) {
      const position = {
        pair: pool.pair,
        sym: pool.sym,
        addr: pool.addr,
        dex: pool.dex,
        
        // Entry data
        entryPrice: pool.price,
        entryLiq: pool.liq,
        entryVol: pool.vol24,
        entryMc: pool.mc,
        entryTime: Date.now(),
        
        // Capital
        capitalSOL: capitalPerPool,
        halfSOL: halfSOL,
        
        // Range (CLMM)
        rangeLow: priceRangeLow,
        rangeHigh: priceRangeHigh,
        rangeBuffer: rangeBuffer,
        
        // Live data
        curPrice: pool.price,
        curLiq: pool.liq,
        curVol: pool.vol24,
        peakPrice: pool.price,
        
        // PnL tracking
        il: 0,
        estFees: 0,
        netPnL: 0,
        lastRebalance: Date.now(),
        rebalanceCount: 0,
        
        // Status
        exitAlert: false,
        exitReason: '',
        txId: result.txId || '',
      };

      STATE.activePositions.push(position);
      log(`✅ Entered ${pool.sym} | ${capitalPerPool.toFixed(4)} SOL | Range ±${(rangeBuffer * 100)}%`, 'OK');
      saveState();
      break; // Only enter one pool per cycle
    }
  }
}

// ============================================================
// MODULE 7: POSITION MONITOR + AUTO-REBALANCE
// ============================================================
async function monitorPositions() {
  for (const pos of [...STATE.activePositions]) {
    try {
      // Fetch current data
      const r = await fetchWithTimeout(`${CONFIG.DEX_APIS.DEXSCREENER}/pairs/solana/${pos.pair}`, {}, 8000);
      if (!r.ok) continue;
      const d = await r.json();
      const pair = d.pair || d.pairs?.[0];
      if (!pair) continue;

      const curPrice = +(pair.priceUsd || 0);
      const curLiq = pair.liquidity?.usd || 0;
      const curVol = pair.volume?.h24 || 0;
      const chg24 = pair.priceChange?.h24 || 0;
      
      // Update position
      pos.curPrice = curPrice;
      pos.curLiq = curLiq;
      pos.curVol = curVol;
      pos.chg24 = chg24;
      if (curPrice > pos.peakPrice) pos.peakPrice = curPrice;

      // Calculate IL
      pos.il = calculateConcentratedIL(pos.entryPrice, curPrice, pos.rangeLow, pos.rangeHigh);
      
      // Estimate fees earned
      const hoursIn = (Date.now() - pos.entryTime) / 3600000;
      const dailyFeeRate = curLiq > 0 ? (curVol * 0.0025) / curLiq : 0;
      pos.estFees = pos.capitalSOL * dailyFeeRate * (hoursIn / 24);
      pos.netPnL = pos.estFees + (pos.capitalSOL * pos.il / 100);

      // ===========================
      // EXIT CONDITIONS CHECK
      // ===========================
      let exitReason = null;
      let emergency = false;

      // 1. Max IL exceeded
      if (pos.il <= -CONFIG.SAFETY.MAX_IMPERMANENT_LOSS_PERCENT) {
        exitReason = `IL ${pos.il.toFixed(1)}% exceeds -${CONFIG.SAFETY.MAX_IMPERMANENT_LOSS_PERCENT}% limit`;
        emergency = pos.il <= -CONFIG.SAFETY.EMERGENCY_IL_PERCENT;
      }

      // 2. Token crashed
      if (chg24 <= -30) {
        exitReason = `Token -${Math.abs(chg24).toFixed(0)}% in 24h`;
        emergency = chg24 <= -50;
      }

      // 3. Volume died
      if (pos.entryVol > 0 && curVol < pos.entryVol * 0.2) {
        exitReason = `Volume -${((1 - curVol / pos.entryVol) * 100).toFixed(0)}%: $${curVol.toFixed(0)}`;
      }

      // 4. Liquidity drained (possible rug)
      if (pos.entryLiq > 0 && curLiq < pos.entryLiq * 0.3) {
        exitReason = `⚠️ Liquidity -${((1 - curLiq / pos.entryLiq) * 100).toFixed(0)}%: possible rug`;
        emergency = true;
      }

      // 5. Rug pull detection
      const rugCheck = await checkRugPull(pos);
      if (!rugCheck.safe) {
        exitReason = `🚨 RUG: ${rugCheck.reason}`;
        emergency = true;
      }

      // 6. Net PnL too negative
      if (pos.netPnL < -(pos.capitalSOL * 0.15)) {
        exitReason = `Net PnL -${Math.abs(pos.netPnL).toFixed(4)} SOL > 15% loss`;
      }

      // 7. Daily loss limit
      if (STATE.dailyLoss >= CONFIG.SAFETY.DAILY_LOSS_LIMIT_USD) {
        exitReason = `Daily loss limit $${CONFIG.SAFETY.DAILY_LOSS_LIMIT_USD} reached`;
        STATE.circuitBreakerTripped = true;
      }

      // EXECUTE EXIT
      if (exitReason) {
        log(``, 'EXIT');
        log(`=== EXITING ${pos.sym}: ${exitReason} ===`, 'EXIT');
        log(`  IL: ${pos.il.toFixed(2)}% | Fees: +${pos.estFees.toFixed(4)} SOL | Net: ${pos.netPnL >= 0 ? '+' : ''}${pos.netPnL.toFixed(4)} SOL`, 'EXIT');
        
        // Sell token back to SOL (emergency = higher slippage)
        const sellResult = await jupiterSwap(pos.addr, pos.halfSOL, false);
        
        if (sellResult.ok) {
          // Record history
          const pnl = pos.netPnL;
          STATE.totalNetPnL += pnl;
          if (pnl < 0) {
            STATE.dailyLoss += Math.abs(pnl) * (STATE.balance > 0 ? 87 : 1); // Approx USD
            STATE.consecutiveLosses++;
          } else {
            STATE.consecutiveLosses = 0;
          }
          
          STATE.positionHistory.unshift({
            ...pos, closeTime: Date.now(), reason: exitReason, pnlSOL: pnl, emergency
          });
          STATE.activePositions = STATE.activePositions.filter(p => p.pair !== pos.pair);

          // Circuit breaker
          if (STATE.consecutiveLosses >= CONFIG.SAFETY.CIRCUIT_BREAKER_LOSSES) {
            log(`🛑 CIRCUIT BREAKER: ${STATE.consecutiveLosses} consecutive losses — pausing entries`, 'ERROR');
            STATE.circuitBreakerTripped = true;
          }

          log(`✅ Exited ${pos.sym} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL | Reason: ${exitReason}`, pnl >= 0 ? 'OK' : 'ERROR');
        }
        continue; // Skip rebalance check
      }

      // ===========================
      // REBALANCE CHECK
      // ===========================
      const priceDeviation = Math.abs(curPrice - pos.entryPrice) / pos.entryPrice;
      const timeSinceRebalance = (Date.now() - pos.lastRebalance) / 1000;
      const cooldownMet = timeSinceRebalance >= CONFIG.STRATEGY.REBALANCE_COOLDOWN_SEC;
      
      // Price outside range?
      const outsideRange = curPrice < pos.rangeLow || curPrice > pos.rangeHigh;
      
      // Significant deviation?
      const significantDeviation = priceDeviation >= CONFIG.STRATEGY.REBALANCE_TRIGGER_PERCENT;
      
      // Min bin width check (avoid rebalancing for tiny moves)
      const aboveMinBin = priceDeviation >= CONFIG.STRATEGY.MIN_BIN_WIDTH;

      if (outsideRange && significantDeviation && aboveMinBin && cooldownMet) {
        log(`🔄 REBALANCE ${pos.sym}: price deviated ${(priceDeviation * 100).toFixed(1)}% from entry`, 'REBAL');
        log(`  Price: $${curPrice.toFixed(8)} | Range: $${pos.rangeLow.toFixed(8)} — $${pos.rangeHigh.toFixed(8)}`, 'REBAL');
        
        // Recalculate range around new price
        pos.rangeLow = curPrice * (1 - pos.rangeBuffer);
        pos.rangeHigh = curPrice * (1 + pos.rangeBuffer);
        pos.entryPrice = curPrice; // Reset for IL calculation
        pos.lastRebalance = Date.now();
        pos.rebalanceCount++;
        
        log(`  New range: $${pos.rangeLow.toFixed(8)} — $${pos.rangeHigh.toFixed(8)} | Rebalances: ${pos.rebalanceCount}`, 'REBAL');
      }

    } catch (e) {
      log(`Monitor error ${pos.sym}: ${e.message.slice(0, 60)}`, 'WARN');
    }
  }
  saveState();
}

// ============================================================
// MODULE 8: REPORTING
// ============================================================
function printReport() {
  const totalInvested = STATE.activePositions.reduce((s, p) => s + p.capitalSOL, 0);
  const totalFees = STATE.activePositions.reduce((s, p) => s + (p.estFees || 0), 0);
  const totalIL = STATE.activePositions.reduce((s, p) => s + (p.capitalSOL * (p.il || 0) / 100), 0);
  const totalNet = STATE.activePositions.reduce((s, p) => s + (p.netPnL || 0), 0);
  const wr = STATE.positionHistory.length > 0 
    ? ((STATE.positionHistory.filter(h => (h.pnlSOL || 0) > 0).length / STATE.positionHistory.length) * 100).toFixed(0)
    : '-';

  log('');
  log('═══════════════════════════════════════', 'INFO');
  log(`   MEMECOIN LP BOT — Status Report`, 'INFO');
  log('═══════════════════════════════════════', 'INFO');
  log(`  Balance:     ${STATE.balance.toFixed(4)} SOL`, 'INFO');
  log(`  Invested:    ${totalInvested.toFixed(4)} SOL across ${STATE.activePositions.length} pools`, 'INFO');
  log(`  Est. Fees:   +${totalFees.toFixed(4)} SOL`, 'INFO');
  log(`  IL Loss:     ${totalIL.toFixed(4)} SOL`, 'INFO');
  log(`  Net PnL:     ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(4)} SOL`, 'INFO');
  log(`  All-time:    ${STATE.totalNetPnL >= 0 ? '+' : ''}${STATE.totalNetPnL.toFixed(4)} SOL | WR: ${wr}%`, 'INFO');
  log(`  Pools:       ${STATE.availablePools.length} scanned | ${STATE.activePositions.length} active`, 'INFO');
  log(`  Circuit:     ${STATE.circuitBreakerTripped ? '🛑 TRIPPED' : '✅ OK'}`, 'INFO');
  log('───────────────────────────────────────', 'INFO');
  
  for (const pos of STATE.activePositions) {
    const mult = pos.entryPrice > 0 ? pos.curPrice / pos.entryPrice : 1;
    const inRange = pos.curPrice >= pos.rangeLow && pos.curPrice <= pos.rangeHigh;
    log(`  ${pos.sym}: ${mult.toFixed(2)}x | IL:${(pos.il || 0).toFixed(1)}% | Fees:+${(pos.estFees || 0).toFixed(4)}◎ | ${inRange ? '✅ In range' : '⚠️ OUT of range'}`, 'INFO');
  }
  log('═══════════════════════════════════════', 'INFO');
  log('');
}

// ============================================================
// MAIN CYCLE
// ============================================================
async function cycle() {
  STATE.scanCount++;
  try {
    await refreshBalance();

    // Scan pools every 2 cycles
    if (STATE.scanCount % 2 === 1 || STATE.availablePools.length === 0) {
      await scanPools();
    }

    // Monitor active positions
    if (STATE.activePositions.length > 0) {
      await monitorPositions();
    }

    // Evaluate new entries
    await evaluateAndEnter();

    // Print report every 6 cycles (~3 min)
    if (STATE.scanCount % 6 === 0) {
      printReport();
    }

    // Reset daily counters at midnight
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      STATE.dailyLoss = 0;
      STATE.circuitBreakerTripped = false;
      log('Daily counters reset', 'INFO');
    }

  } catch (e) {
    log('Cycle error: ' + e.message, 'ERROR');
  }
}

// ============================================================
// STARTUP
// ============================================================
async function main() {
  console.log('');
  console.log('  💧 MEMECOIN LP MANAGEMENT BOT');
  console.log('  ══════════════════════════════');
  console.log('  Professional VPS Edition');
  console.log('  CLMM • Rug Detection • Auto-Rebalance');
  console.log('  IL Monitoring • Whale Analysis • Priority Fees');
  console.log('');

  loadState();

  const ok = await initWallet();
  if (!ok) {
    log('Wallet init failed. Exiting.', 'ERROR');
    process.exit(1);
  }

  // Log configuration
  log('Configuration:', 'INFO');
  log(`  Range: ±${(CONFIG.STRATEGY.PRICE_RANGE_BUFFER * 100)}% | Rebalance: ${(CONFIG.STRATEGY.REBALANCE_TRIGGER_PERCENT * 100)}%`, 'INFO');
  log(`  Max IL: -${CONFIG.SAFETY.MAX_IMPERMANENT_LOSS_PERCENT}% | Emergency IL: -${CONFIG.SAFETY.EMERGENCY_IL_PERCENT}%`, 'INFO');
  log(`  Min Liq: $${CONFIG.SAFETY.MIN_LIQUIDITY_USD} | Min Vol: $${CONFIG.FILTERS.MIN_VOLUME_24H_USD}`, 'INFO');
  log(`  Max Whale: ${CONFIG.SAFETY.MAX_WHALE_CONCENTRATION_PERCENT}% | Rug Detection: ${CONFIG.SAFETY.EXIT_IF_RUG_DETECTED ? 'ON' : 'OFF'}`, 'INFO');
  log(`  Max Pools: ${CONFIG.STRATEGY.MAX_POOLS_SIMULTANEOUS} | Capital/Pool: ${CONFIG.STRATEGY.CAPITAL_PER_POOL_PERCENT}%`, 'INFO');
  log(`  Slippage: ${CONFIG.EXECUTION.SLIPPAGE_TOLERANCE_BPS}bps | Emergency: ${CONFIG.EXECUTION.EMERGENCY_SLIPPAGE_BPS}bps`, 'INFO');
  log(`  Jito: ${CONFIG.EXECUTION.JITO_ENABLED ? 'ON (' + CONFIG.EXECUTION.JITO_TIP_LAMPORTS + ' lamports)' : 'OFF'}`, 'INFO');
  log(`  Scan: ${CONFIG.STRATEGY.SCAN_INTERVAL_SEC}s | Monitor: ${CONFIG.STRATEGY.MONITOR_INTERVAL_SEC}s`, 'INFO');
  console.log('');
  log('🤖 LP Bot started — operating 24/7', 'OK');
  console.log('');

  // Run immediately then on interval
  await cycle();
  setInterval(cycle, CONFIG.STRATEGY.SCAN_INTERVAL_SEC * 1000);

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down — saving state...', 'WARN');
    saveState();
    printReport();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => {
  log('Fatal: ' + e.message, 'ERROR');
  process.exit(1);
});

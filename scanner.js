// ============================================================
// MULTI-SOURCE SCANNER v2.0
// Sources: DexScreener, GeckoTerminal, Birdeye, PumpFun, Jupiter
// Drop-in replacement for scan() in index.js
// ============================================================
// Usage: Replace the scan() function in index.js with this file
//   const { createScanner } = require('./scanner');
//   const scanner = createScanner(CONFIG, SNIPER, log);
//   // In cycle(): const tokens = await scanner.scan();
// ============================================================

function createScanner(CFG, SNIPER, log) {

  const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
  const BIRDEYE_BASE = 'https://public-api.birdeye.so';
  const PUMPFUN_BASE = 'https://frontend-api-v3.pump.fun';
  const DEXSCREENER_BASE = CFG.DEX_APIS?.DEXSCREENER || 'https://api.dexscreener.com/latest/dex';
  const DEXSCREENER_BOOSTS = CFG.DEX_APIS?.DEXSCREENER_BOOSTS || 'https://api.dexscreener.com/token-boosts/top/v1';
  const DEXSCREENER_PROFILES = CFG.DEX_APIS?.DEXSCREENER_PROFILES || 'https://api.dexscreener.com/token-profiles/latest/v1';

  const BIRDEYE_KEY = CFG.APIS?.BIRDEYE_API_KEY || '';
  const SOL_MINT = 'So11111111111111111111111111111111111111112';

  const BLACKLISTED = new Set(CFG.FILTERS?.BLACKLISTED_TOKENS || []);
  const BLACKLISTED_SYMS = new Set(CFG.FILTERS?.BLACKLISTED_SYMBOLS || []);

  // Rate limiter
  const rateLimits = {};
  function canCall(source, maxPerMin) {
    const now = Date.now();
    if (!rateLimits[source]) rateLimits[source] = [];
    rateLimits[source] = rateLimits[source].filter(t => now - t < 60000);
    if (rateLimits[source].length >= maxPerMin) return false;
    rateLimits[source].push(now);
    return true;
  }

  async function fetchJSON(url, options = {}) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeout || 12000);
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) return null;
      return await resp.json();
    } catch(e) { return null; }
  }

  // ═══════════════════════════════════════════════
  // SOURCE 1: DexScreener (search + boosts + profiles)
  // ═══════════════════════════════════════════════
  async function scanDexScreener() {
    const pairs = [];
    const queries = ['pump.fun SOL', 'solana meme', 'solana trending', 'solana new'];

    for (const q of queries) {
      if (!canCall('dexscreener', 25)) break;
      const data = await fetchJSON(`${DEXSCREENER_BASE}/search?q=${encodeURIComponent(q)}`);
      if (data && data.pairs) {
        pairs.push(...data.pairs.filter(p => p.chainId === 'solana'));
      }
    }

    // Boosted tokens (promoted/trending on DexScreener)
    if (canCall('dexscreener', 25)) {
      const boosts = await fetchJSON(DEXSCREENER_BOOSTS);
      if (Array.isArray(boosts)) {
        const solBoosts = boosts.filter(b => b.chainId === 'solana').slice(0, 8);
        for (const b of solBoosts) {
          if (!canCall('dexscreener', 25)) break;
          const data = await fetchJSON(`${DEXSCREENER_BASE}/tokens/${b.tokenAddress}`);
          if (data && data.pairs) pairs.push(...data.pairs);
        }
      }
    }

    // Token profiles (recently updated)
    if (canCall('dexscreener', 25)) {
      const profiles = await fetchJSON(DEXSCREENER_PROFILES);
      if (Array.isArray(profiles)) {
        const solProfiles = profiles.filter(p => p.chainId === 'solana').slice(0, 5);
        for (const p of solProfiles) {
          if (!canCall('dexscreener', 25)) break;
          const data = await fetchJSON(`${DEXSCREENER_BASE}/tokens/${p.tokenAddress}`);
          if (data && data.pairs) pairs.push(...data.pairs);
        }
      }
    }

    log(`[DexScreener] ${pairs.length} pairs found`, 'SCAN');
    return pairs.map(normalizeDexScreener);
  }

  function normalizeDexScreener(p) {
    return {
      source: 'dexscreener',
      sym: p.baseToken?.symbol || '?',
      addr: p.baseToken?.address || '',
      pair: p.pairAddress || '',
      price: parseFloat(p.priceUsd || 0),
      priceNative: parseFloat(p.priceNative || 0),
      mcap: p.marketCap || p.fdv || 0,
      liq: p.liquidity?.usd || 0,
      vol24: p.volume?.h24 || 0,
      c5: p.priceChange?.m5 || 0,
      c1h: p.priceChange?.h1 || 0,
      c6h: p.priceChange?.h6 || 0,
      c24: p.priceChange?.h24 || 0,
      buys5: p.txns?.m5?.buys || 0,
      sells5: p.txns?.m5?.sells || 0,
      buys1h: p.txns?.h1?.buys || 0,
      sells1h: p.txns?.h1?.sells || 0,
      buys24: p.txns?.h24?.buys || 0,
      sells24: p.txns?.h24?.sells || 0,
      dex: p.dexId || '',
      age: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600000 : 999
    };
  }

  // ═══════════════════════════════════════════════
  // SOURCE 2: GeckoTerminal (FREE - trending + new + top)
  // ═══════════════════════════════════════════════
  async function scanGeckoTerminal() {
    const tokens = [];

    // Trending pools on Solana
    if (canCall('gecko', 10)) {
      const data = await fetchJSON(`${GECKO_BASE}/networks/solana/trending_pools?page=1`);
      if (data && data.data) {
        tokens.push(...data.data.map(normalizeGecko));
      }
    }

    // New pools on Solana
    if (canCall('gecko', 10)) {
      const data = await fetchJSON(`${GECKO_BASE}/networks/solana/new_pools?page=1`);
      if (data && data.data) {
        tokens.push(...data.data.map(normalizeGecko));
      }
    }

    // Top pools by volume on popular DEXes
    const dexes = ['raydium', 'orca', 'meteora'];
    for (const dex of dexes) {
      if (!canCall('gecko', 10)) break;
      const data = await fetchJSON(`${GECKO_BASE}/networks/solana/dexes/${dex}/pools?page=1&sort=h24_volume_usd_desc`);
      if (data && data.data) {
        tokens.push(...data.data.map(normalizeGecko));
      }
    }

    log(`[GeckoTerminal] ${tokens.length} tokens found`, 'SCAN');
    return tokens;
  }

  function normalizeGecko(pool) {
    const attr = pool.attributes || {};
    const txH1 = attr.transactions?.h1 || {};
    const txH24 = attr.transactions?.h24 || {};
    const chg = attr.price_change_percentage || {};

    return {
      source: 'geckoterminal',
      sym: attr.name ? attr.name.split(' / ')[0].replace('$','') : '?',
      addr: attr.address || pool.id?.split('_')[1] || '',
      pair: attr.address || '',
      price: parseFloat(attr.base_token_price_usd || 0),
      priceNative: parseFloat(attr.base_token_price_native_currency || 0),
      mcap: parseFloat(attr.fdv_usd || attr.market_cap_usd || 0),
      liq: parseFloat(attr.reserve_in_usd || 0),
      vol24: parseFloat(attr.volume_usd?.h24 || 0),
      c5: parseFloat(chg.m5 || 0),
      c1h: parseFloat(chg.h1 || 0),
      c6h: parseFloat(chg.h6 || 0),
      c24: parseFloat(chg.h24 || 0),
      buys5: 0,
      sells5: 0,
      buys1h: txH1.buys || 0,
      sells1h: txH1.sells || 0,
      buys24: txH24.buys || 0,
      sells24: txH24.sells || 0,
      dex: attr.dex_id || '',
      age: attr.pool_created_at ? (Date.now() - new Date(attr.pool_created_at).getTime()) / 3600000 : 999
    };
  }

  // ═══════════════════════════════════════════════
  // SOURCE 3: Birdeye (needs API key - free tier)
  // ═══════════════════════════════════════════════
  async function scanBirdeye() {
    if (!BIRDEYE_KEY) return [];
    const tokens = [];
    const headers = { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' };

    // Trending tokens
    if (canCall('birdeye', 10)) {
      const data = await fetchJSON(`${BIRDEYE_BASE}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20`, { headers });
      if (data && data.data && data.data.tokens) {
        tokens.push(...data.data.tokens.map(normalizeBirdeye));
      }
    }

    // Top traders (gainers)
    if (canCall('birdeye', 10)) {
      const data = await fetchJSON(`${BIRDEYE_BASE}/defi/token_trending?sort_by=volume24hChangePercent&sort_type=desc&offset=0&limit=20`, { headers });
      if (data && data.data && data.data.tokens) {
        tokens.push(...data.data.tokens.map(normalizeBirdeye));
      }
    }

    // New listings
    if (canCall('birdeye', 10)) {
      const data = await fetchJSON(`${BIRDEYE_BASE}/defi/tokenlist?sort_by=v24hChangePercent&sort_type=desc&offset=0&limit=20&min_liquidity=50000`, { headers });
      if (data && data.data && data.data.tokens) {
        tokens.push(...data.data.tokens.map(normalizeBirdeye));
      }
    }

    log(`[Birdeye] ${tokens.length} tokens found`, 'SCAN');
    return tokens;
  }

  function normalizeBirdeye(t) {
    return {
      source: 'birdeye',
      sym: t.symbol || '?',
      addr: t.address || '',
      pair: '',
      price: t.price || t.v || 0,
      priceNative: 0,
      mcap: t.mc || t.fdv || 0,
      liq: t.liquidity || 0,
      vol24: t.v24hUSD || t.volume24h || 0,
      c5: 0,
      c1h: t.v1hChangePercent || 0,
      c6h: t.v6hChangePercent || 0,
      c24: t.v24hChangePercent || t.priceChange24h || 0,
      buys5: 0, sells5: 0,
      buys1h: t.buy1h || 0, sells1h: t.sell1h || 0,
      buys24: t.buy24h || 0, sells24: t.sell24h || 0,
      dex: '',
      age: 999
    };
  }

  // ═══════════════════════════════════════════════
  // SOURCE 4: Pump.fun (new launches)
  // ═══════════════════════════════════════════════
  async function scanPumpFun() {
    const tokens = [];

    if (canCall('pumpfun', 5)) {
      // King of the hill (graduated tokens)
      const data = await fetchJSON(`${PUMPFUN_BASE}/coins/king-of-the-hill?includeNsfw=false&limit=20`);
      if (Array.isArray(data)) {
        tokens.push(...data.map(normalizePumpFun));
      }
    }

    if (canCall('pumpfun', 5)) {
      // Recently graduated
      const data2 = await fetchJSON(`${PUMPFUN_BASE}/coins?offset=0&limit=20&sort=last_trade_timestamp&order=DESC&includeNsfw=false`);
      if (Array.isArray(data2)) {
        tokens.push(...data2.map(normalizePumpFun));
      }
    }

    log(`[PumpFun] ${tokens.length} tokens found`, 'SCAN');
    return tokens;
  }

  function normalizePumpFun(t) {
    return {
      source: 'pumpfun',
      sym: t.symbol || '?',
      addr: t.mint || '',
      pair: '',
      price: t.usd_market_cap && t.total_supply ? t.usd_market_cap / t.total_supply : 0,
      priceNative: 0,
      mcap: t.usd_market_cap || 0,
      liq: 0,  // Need to fetch from DEX
      vol24: 0,
      c5: 0, c1h: 0, c6h: 0, c24: 0,
      buys5: 0, sells5: 0,
      buys1h: 0, sells1h: 0,
      buys24: 0, sells24: 0,
      dex: 'pumpfun',
      age: t.created_timestamp ? (Date.now() - t.created_timestamp) / 3600000 : 999
    };
  }

  // ═══════════════════════════════════════════════
  // SOURCE 5: Jupiter Strict Token List (verified)
  // ═══════════════════════════════════════════════
  let jupiterVerified = new Set();
  let jupiterLastFetch = 0;

  async function refreshJupiterList() {
    if (Date.now() - jupiterLastFetch < 3600000) return; // 1hr cache
    try {
      const data = await fetchJSON('https://token.jup.ag/strict');
      if (Array.isArray(data)) {
        jupiterVerified = new Set(data.map(t => t.address));
        jupiterLastFetch = Date.now();
        log(`[Jupiter] Loaded ${jupiterVerified.size} verified tokens`, 'INFO');
      }
    } catch(e) {}
  }

  // ═══════════════════════════════════════════════
  // SMART SCORING ENGINE v2
  // ═══════════════════════════════════════════════
  function scoreToken(t) {
    let score = 0;

    // ── Buy/Sell Pressure (max 25) ──
    const total5 = t.buys5 + t.sells5;
    const total1h = t.buys1h + t.sells1h;
    if (total5 > 0) {
      const ratio5 = t.buys5 / total5;
      if (ratio5 > 0.75) score += 20;
      else if (ratio5 > 0.65) score += 14;
      else if (ratio5 > 0.55) score += 8;
      if (ratio5 < 0.35) score -= 15;
    }
    if (total1h > 0) {
      const ratio1h = t.buys1h / total1h;
      if (ratio1h > 0.65) score += 5;
    }

    // ── Momentum (max 25) ──
    if (t.c5 > 10) score += 15;
    else if (t.c5 > 5) score += 10;
    else if (t.c5 > 2) score += 6;
    if (t.c5 < -10) score -= 20;
    if (t.c5 < -5) score -= 10;

    if (t.c1h > 20) score += 10;
    else if (t.c1h > 10) score += 7;
    else if (t.c1h > 5) score += 4;
    if (t.c1h < -15) score -= 15;

    // ── Volume (max 15) ──
    const txns24 = t.buys24 + t.sells24;
    if (txns24 > 5000) score += 15;
    else if (txns24 > 1000) score += 10;
    else if (txns24 > 200) score += 6;

    // ── Liquidity Quality (max 10) ──
    if (t.liq > 500000) score += 10;
    else if (t.liq > 200000) score += 7;
    else if (t.liq > 100000) score += 4;

    // ── Volume/Liquidity Health (max 5) ──
    if (t.liq > 0) {
      const vlRatio = t.vol24 / t.liq;
      if (vlRatio > 2) score += 5;
      else if (vlRatio > 1) score += 3;
    }

    // ── Multi-source Bonus (max 10) ──
    if (t.sourceCount > 2) score += 10;
    else if (t.sourceCount > 1) score += 5;

    // ── Jupiter Verified Bonus (max 5) ──
    if (jupiterVerified.has(t.addr)) score += 5;

    // ── Freshness (max 5) ──
    if (t.age < 12 && t.c5 > 0) score += 5;
    else if (t.age < 48 && t.c5 > 0) score += 3;

    // ── Anti-patterns (penalties) ──
    if (t.c24 > 80 && t.c5 < -5) score -= 20;  // Pump & dump
    if (t.c24 < -40) score -= 15;  // Major decline
    if (t.liq < 50000 && t.mcap > 5000000) score -= 10;  // Low liq for cap

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  // ═══════════════════════════════════════════════
  // MERGE & DEDUPLICATE
  // ═══════════════════════════════════════════════
  function mergeTokens(allTokens) {
    const byAddr = {};

    for (const t of allTokens) {
      if (!t.addr || t.addr.length < 20) continue;
      if (BLACKLISTED.has(t.addr)) continue;
      if (BLACKLISTED_SYMS.has(t.sym)) continue;

      if (!byAddr[t.addr]) {
        byAddr[t.addr] = { ...t, sources: [t.source], sourceCount: 1 };
      } else {
        const existing = byAddr[t.addr];
        existing.sources.push(t.source);
        existing.sourceCount = existing.sources.length;

        // Merge best data (prefer non-zero values)
        if (t.liq > existing.liq) existing.liq = t.liq;
        if (t.vol24 > existing.vol24) existing.vol24 = t.vol24;
        if (t.mcap > existing.mcap) existing.mcap = t.mcap;
        if (t.price > 0 && existing.price === 0) existing.price = t.price;
        if (t.c5 !== 0 && existing.c5 === 0) existing.c5 = t.c5;
        if (t.c1h !== 0 && existing.c1h === 0) existing.c1h = t.c1h;
        if (t.c24 !== 0 && existing.c24 === 0) existing.c24 = t.c24;
        if (t.buys5 > existing.buys5) existing.buys5 = t.buys5;
        if (t.sells5 > existing.sells5) existing.sells5 = t.sells5;
        if (t.buys1h > existing.buys1h) existing.buys1h = t.buys1h;
        if (t.sells1h > existing.sells1h) existing.sells1h = t.sells1h;
        if (t.buys24 > existing.buys24) existing.buys24 = t.buys24;
        if (t.sells24 > existing.sells24) existing.sells24 = t.sells24;
        if (t.pair && !existing.pair) existing.pair = t.pair;
        if (t.dex && !existing.dex) existing.dex = t.dex;
        if (t.age < existing.age) existing.age = t.age;
      }
    }

    return Object.values(byAddr);
  }

  // ═══════════════════════════════════════════════
  // MAIN SCAN (orchestrator)
  // ═══════════════════════════════════════════════
  async function scan(existingPositions) {
    await refreshJupiterList();

    // Fetch from all sources in parallel
    const [dexTokens, geckoTokens, birdeyeTokens, pumpTokens] = await Promise.all([
      scanDexScreener().catch(e => { log('DexScreener error: ' + e.message, 'WARN'); return []; }),
      scanGeckoTerminal().catch(e => { log('GeckoTerminal error: ' + e.message, 'WARN'); return []; }),
      scanBirdeye().catch(e => { log('Birdeye error: ' + e.message, 'WARN'); return []; }),
      scanPumpFun().catch(e => { log('PumpFun error: ' + e.message, 'WARN'); return []; })
    ]);

    const totalRaw = dexTokens.length + geckoTokens.length + birdeyeTokens.length + pumpTokens.length;

    // Merge all sources
    const allTokens = [...dexTokens, ...geckoTokens, ...birdeyeTokens, ...pumpTokens];
    const merged = mergeTokens(allTokens);

    // Filter
    const posAddrs = new Set((existingPositions || []).map(p => p.addr));
    const filtered = merged.filter(t => {
      if (posAddrs.has(t.addr)) return false;
      if (t.mcap < SNIPER.minMcap || t.mcap > SNIPER.maxMcap) return false;
      if (t.liq < SNIPER.minLiquidity && t.source !== 'pumpfun') return false;
      if (t.vol24 < SNIPER.minVolume24h && t.source !== 'pumpfun') return false;
      return true;
    });

    // Score and sort
    for (const t of filtered) {
      t.score = scoreToken(t);
    }

    const results = filtered
      .filter(t => t.score >= SNIPER.minScore)
      .sort((a, b) => b.score - a.score);

    log(`[Scanner] Raw: ${totalRaw} | Merged: ${merged.length} | Filtered: ${filtered.length} | Qualified: ${results.length} (score >= ${SNIPER.minScore})`, 'SCAN');

    if (results.length > 0) {
      log(`  Top 5: ${results.slice(0,5).map(t => `${t.sym}(${t.score},${t.sources.join('+')})`).join(' | ')}`, 'INFO');
    }

    return results;
  }

  // ═══════════════════════════════════════════════
  // ENRICHMENT: Get full data for a token from DexScreener
  // (used before buying to confirm data is fresh)
  // ═══════════════════════════════════════════════
  async function enrichToken(token) {
    if (!token.addr) return token;

    const data = await fetchJSON(`${DEXSCREENER_BASE}/tokens/${token.addr}`);
    if (!data || !data.pairs || data.pairs.length === 0) return token;

    // Find best pair (highest liquidity)
    const best = data.pairs.reduce((a, b) => (a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b);

    token.price = parseFloat(best.priceUsd || token.price);
    token.priceNative = parseFloat(best.priceNative || token.priceNative);
    token.mcap = best.marketCap || best.fdv || token.mcap;
    token.liq = best.liquidity?.usd || token.liq;
    token.vol24 = best.volume?.h24 || token.vol24;
    token.c5 = best.priceChange?.m5 || token.c5;
    token.c1h = best.priceChange?.h1 || token.c1h;
    token.c24 = best.priceChange?.h24 || token.c24;
    token.pair = best.pairAddress || token.pair;
    token.dex = best.dexId || token.dex;

    return token;
  }

  return { scan, enrichToken, getJupiterVerified: () => jupiterVerified };
}

module.exports = { createScanner };

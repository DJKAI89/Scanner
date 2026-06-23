// ── Option scan service — F&O Options chain scan ─────────────────
// Extracted from OptionsPane.jsx so the pane only handles UI/state wiring.
// All calculation, scoring, and API-call logic for the Options tab lives here.

import { fetchQ, fetchOptions, fetchIntraday, fetchCandles } from './api';
import { getIST, sleep } from '../utils/marketTime';
import { INDEX_OPTS, TOP_FO_SYMBOLS, SECTOR_CTX_MAP, NIFTY50_FALLBACK } from '../constants/config';
import { calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain, applyFIIBias, applyAdaptWeights } from './technical';
import { logSignals, buildOptionSignal } from './github';
import { applyMlRanking } from './mlRanking';

export const VIX_KEY = 'NSE_INDEX|India VIX';

export function getChgPct(q) {
  if (!q) return 0;
  if (q.net_change_percentage != null) return +q.net_change_percentage;
  if (q.net_change != null && q.last_price > 0) {
    const pc = q.last_price - q.net_change;
    return pc > 0 ? (q.net_change / pc) * 100 : 0;
  }
  if (q.ohlc?.close && q.ohlc.close > 0) return ((q.last_price - q.ohlc.close) / q.ohlc.close) * 100;
  return 0;
}

export function getOptionKey(opt) {
  return opt?.instrument_key || opt?.instrumentKey || opt?.instrument_token || opt?.instrumentToken || '';
}

// Merges live WS option prices (OI/LTP) into a static chain snapshot
export function withLiveOI(chain = [], liveOptionPrices = {}) {
  return chain.map((row) => {
    const callKey = getOptionKey(row.call_options);
    const putKey = getOptionKey(row.put_options);
    const callLive = liveOptionPrices[callKey];
    const putLive = liveOptionPrices[putKey];
    return {
      ...row,
      call_options: row.call_options ? {
        ...row.call_options,
        market_data: {
          ...(row.call_options.market_data || {}),
          oi: callLive?.oi ?? row.call_options.market_data?.oi,
          ltp: callLive?.ltp ?? row.call_options.market_data?.ltp,
        },
      } : row.call_options,
      put_options: row.put_options ? {
        ...row.put_options,
        market_data: {
          ...(row.put_options.market_data || {}),
          oi: putLive?.oi ?? row.put_options.market_data?.oi,
          ltp: putLive?.ltp ?? row.put_options.market_data?.ltp,
        },
      } : row.put_options,
    };
  });
}

export function calcStructure(chain) {
  const maxPain = calcMaxPain(chain);
  const oiWalls = calcOIWalls(chain);
  const ceOI = chain.reduce((s, x) => s + (x.call_options?.market_data?.oi || 0), 0);
  const peOI = chain.reduce((s, x) => s + (x.put_options?.market_data?.oi  || 0), 0);
  const pcr = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1.0;
  return { maxPain, oiWalls, pcr };
}

// Builds the per-pick indicator snapshot used by adaptive-weights + ML ranking.
// Shared by both index-chain and stock-chain scoring passes below.
function buildIndicatorSnapshot(p) {
  return {
    trendAligned: p.trendAligned || false,
    emaBull: p.emaTrendBull === true,
    emaBearish: p.emaTrendBull === false,
    freshCross: p.emaCross === 'bullish_cross' || p.emaCross === 'bearish_cross',
    momentumFresh: p.momentumFresh || false,
    volSpike: (p.volRatio ?? 0) >= 1.5,
    lowVol: (p.volRatio ?? 1) < 0.7,
    nearPDH: p.priceZone === 'PDH_BREAK' || p.priceZone === 'NEAR_PDH',
    nearPDL: p.priceZone === 'PDL_BREAK' || p.priceZone === 'NEAR_PDL',
    oiBuildUp: p.oiBuildType === 'CE_BUILD' || p.oiBuildType === 'PE_BUILD',
    compositeHigh: Math.abs(p.compositeScore ?? 0) >= 2,
    compositeMed: Math.abs(p.compositeScore ?? 0) >= 1,
    atm: p.atm || false,
  };
}

// Applies FII bias + adaptive weights + ML ranking to a raw scanChain pick,
// then filters by confidence/capital thresholds. Shared by index + stock passes.
function scoreAndFilterPicks(picks, { fiiData, adaptWeights, mlModels, cfg, maxPain = 0, spot = 0 }) {
  return picks.map(p => {
    const indSnap = buildIndicatorSnapshot(p);
    let c = applyFIIBias(p.confidence, p.action === 'BUY', fiiData);
    c = applyAdaptWeights(c, adaptWeights?.option || null, indSnap);
    const mlRank = applyMlRanking(c, mlModels || null, { ...p, confidence: c, _indSnap: indSnap });
    return {
      ...p,
      confidence: Math.min(99, Math.max(1, Math.round(mlRank.confidence))),
      _indSnap: indSnap,
      _dte: p._dte ?? null,
      nearMaxPain: maxPain > 0 && spot > 0 && Math.abs(p.strike - maxPain) / spot < 0.01,
      mlProbability: mlRank.mlProbability,
      mlAdj: mlRank.mlAdj,
      mlExplain: mlRank.explanation,
      aiBlock: mlRank.aiBlock,
      aiModel: mlRank.servingLabel,
    };
  }).filter(p => {
    if (p.aiBlock) return false;
    if (p.confidence < (mlModels?.thresholds?.option?.minConfidence || cfg.minOptConf)) return false;
    const capLimit = mlModels?.thresholds?.option?.maxCapital || cfg.maxOptCapital;
    if (!capLimit || capLimit <= 0) return true; // no capital cap configured
    return p.amtRequired <= capLimit;
  });
}

// ── Main scan ────────────────────────────────────────────────────
// ctx: { accessToken, cfg, stocks, fiiData, adaptWeights, mlModels, gh, onTokenExpired, lg }
// caches: { prevAvgIVCache, prevPCRCache } — refs persisted across scans for trend deltas
// callbacks: { setProgress, setMarketCtxMap, setVix }
export async function runOptionsScan(ctx, caches, callbacks) {
  const { accessToken, cfg, stocks, fiiData, adaptWeights, mlModels, gh, onTokenExpired, lg } = ctx;
  const { prevAvgIVCache, prevPCRCache } = caches;
  const { setProgress, setMarketCtxMap, setVix } = callbacks;

  // ── F&O-eligible universe: prefer the live stocks.json list (all ~500 stocks,
  // each carrying its own lot/step) and fall back to the static NIFTY50 list only
  // if stocks.json hasn't loaded yet. Ranked by volume at scan time (Step 3). ──
  const eligibleFOStocks = (stocks && stocks.length > 0)
    ? stocks.filter(s => s.fo && s.lot > 0 && s.key)
    : NIFTY50_FALLBACK.filter(s => s.fo && TOP_FO_SYMBOLS.includes(s.s));
  const scanCount = Math.max(1, cfg.optStockScanCount || 20);
  const totalSteps = eligibleFOStocks.length > 0 ? 4 : 3;

  // ── Step 1: Market context (Nifty + VIX + PCR) ──────────
  setProgress(`Step 1/${totalSteps}: Fetching market context (Nifty + VIX)...`);
  const mktD = await fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|India VIX', accessToken, onTokenExpired);
  const nQ   = mktD['NSE_INDEX|Nifty 50'];
  const vQ   = mktD['NSE_INDEX|India VIX'];
  if (!nQ?.last_price) throw new Error('Nifty quote missing');
  const vixVal    = vQ?.last_price || 15;
  const nLtp      = nQ.last_price;
  const nNetChg   = nQ.net_change ?? (nQ.ohlc?.close ? nLtp - nQ.ohlc.close : 0);
  const nChgPct   = nLtp > 0 ? (nNetChg / nLtp) * 100 : 0;
  const niftyBull = nChgPct > -0.3;
  setVix(vixVal);

  // ── Step 1b: Intraday candles for each index ─────────────
  setProgress(`Step 1/${totalSteps}: Fetching intraday candles (${INDEX_OPTS.length} indices)...`);
  const INDEX_CANDLE_KEYS = [
    'NSE_INDEX|Nifty 50',
    'NSE_INDEX|Nifty Bank',
    'BSE_INDEX|SENSEX',
    'NSE_INDEX|Nifty Fin Service',
  ];
  const idxCandles = {};
  for (const [ci, key] of INDEX_CANDLE_KEYS.entries()) {
    setProgress(`Step 1/${totalSteps}: Candles ${ci+1}/${INDEX_CANDLE_KEYS.length} (${key.split('|')[1]})...`);
    try { idxCandles[key] = await fetchIntraday(key, '5minute', accessToken, onTokenExpired); }
    catch (e) { idxCandles[key] = []; }
    await sleep(400);
  }

  // Compute per-index marketCtx
  const ctxMap = {};
  for (const idx of INDEX_OPTS) {
    const candles = idxCandles[idx.key] || [];
    const q2      = await fetchQ(idx.key, accessToken, onTokenExpired).then(d => d[idx.key]).catch(() => null);
    if (!q2?.last_price) continue;
    const spotChg = getChgPct(q2);
    ctxMap[idx.name] = computeCtxFromCandles(candles, q2.last_price, spotChg, vixVal, null);
  }
  setMarketCtxMap(ctxMap);

  // ── Step 2: Scan index chains ────────────────────────────
  const built = [];
  for (const [ui, idx] of INDEX_OPTS.entries()) {
    setProgress(`Step 2/${totalSteps}: ${idx.name} option chain (${ui+1}/${INDEX_OPTS.length})...`);
    const q = await fetchQ(idx.key, accessToken, onTokenExpired).then(d => d[idx.key]).catch(() => null);
    if (!q?.last_price) continue;
    const spot    = q.last_price;
    const spotChg = getChgPct(q);
    const marketCtx = ctxMap[idx.name] || computeCtxFromCandles([], spot, spotChg, vixVal, null);

    // Expiry
    setProgress(`Step 2/${totalSteps}: ${idx.name} fetching expiry...`);
    let expiry = '';
    try {
      const cd = await fetch(
        `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(idx.key)}`,
        { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } }
      ).then(r => r.json());
      expiry = (cd?.data?.map(e => e.expiry).sort() || [])[0] || '';
    } catch (e) { lg('Contract ' + idx.name + ': ' + e.message, 'w'); }
    if (!expiry) continue;

    setProgress(`Step 2/${totalSteps}: ${idx.name} scanning ${spot} strikes...`);
    // Full chain
    const chain = await fetchOptions(idx.key, expiry, accessToken, onTokenExpired);
    if (!chain.length) { lg(idx.name + ': empty chain', 'w'); continue; }

    // Max Pain + OI Walls
    const maxPain = calcMaxPain(chain);
    const oiWalls = calcOIWalls(chain);

    // PCR
    const ceOI = chain.reduce((s, x) => s + (x.call_options?.market_data?.oi || 0), 0);
    const peOI = chain.reduce((s, x) => s + (x.put_options?.market_data?.oi  || 0), 0);
    const pcr  = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1.0;

    // PCR trend
    const prevPCR = prevPCRCache.current[idx.name] ?? pcr;
    prevPCRCache.current[idx.name] = pcr;
    const pcrTrend = +(pcr - prevPCR).toFixed(3);

    // IV trend
    const chainIVs = chain.flatMap(r => [r.call_options?.option_greeks?.iv, r.put_options?.option_greeks?.iv]).filter(v => v > 0);
    const avgIV    = chainIVs.length ? +(chainIVs.reduce((a, b) => a + b, 0) / chainIVs.length).toFixed(1) : null;
    const prevAvgIV = prevAvgIVCache.current[idx.name] ?? avgIV;
    if (avgIV != null) prevAvgIVCache.current[idx.name] = avgIV;
    const ivTrend = (avgIV != null && prevAvgIV != null) ? +(avgIV - prevAvgIV).toFixed(2) : 0;

    // Enrich marketCtx with PCR trend + IV trend
    const richCtx = { ...marketCtx, pcr, pcrTrend, ivTrend, avgIV, prevAvgIV };

    // ATM strike
    const atm  = Math.round(spot / idx.step) * idx.step;

    // Full scanChain — exact HTML port
    const picks = scanChain(chain, atm, spot, idx.name, expiry, idx.lot, niftyBull, vixVal, maxPain, pcr, richCtx, cfg);

    // Apply FII bias + adaptive weights + ML ranking, then filter
    const picksWithFII = scoreAndFilterPicks(picks, { fiiData, adaptWeights, mlModels, cfg, maxPain, spot });

    lg(`${idx.name}: ${chain.length} strikes → ${picks.length} raw → ${picksWithFII.length} ≥${cfg.minOptConf}% | composite=${richCtx.compositeScore} pcr=${pcr}`, 'o');
    built.push({ name: idx.name, spot, spotChg, picks: picksWithFII, expiry, chain, maxPain, oiWalls, pcr, pcrTrend, ivTrend });
  }

  // ── Step 3: Stock F&O options ────────────────────────────
  // Fetch quotes for the FULL eligible F&O universe (batched, 50/call),
  // rank by volume, then scan only the top `scanCount` to respect rate limits.
  let foStocks = [];
  const allSpots = {};
  if (eligibleFOStocks.length > 0) {
    const batches = Math.ceil(eligibleFOStocks.length / 50);
    for (let b = 0; b < batches; b++) {
      setProgress(`Step 3/${totalSteps}: Ranking F&O universe (${b + 1}/${batches} batches, ${eligibleFOStocks.length} stocks)...`);
      const batchKeys = eligibleFOStocks.slice(b * 50, (b + 1) * 50).map(s => s.key).join(',');
      try {
        Object.assign(allSpots, await fetchQ(batchKeys, accessToken, onTokenExpired));
      } catch (e) { lg('FO universe batch ' + b + ': ' + e.message, 'w'); }
      if (b + 1 < batches) await sleep(250);
    }
    foStocks = eligibleFOStocks
      .map(s => ({ ...s, _vol: allSpots[s.key]?.volume || 0, _hasQuote: !!allSpots[s.key]?.last_price }))
      .filter(s => s._hasQuote)
      .sort((a, b) => b._vol - a._vol)
      .slice(0, scanCount);
    lg(`F&O universe: ${eligibleFOStocks.length} eligible → ${foStocks.length} selected by volume (top ${scanCount})`, 'o');
  }
  if (foStocks.length > 0) {
    // Reuse quotes already fetched during ranking — no need to refetch.
    const foSpots2 = allSpots;

    for (let fi = 0; fi < foStocks.length; fi++) {
      const inst = foStocks[fi];
      setProgress(`Step 3/${totalSteps}: ${inst.s} options (${fi+1}/${foStocks.length})...`);
      try {
        const q = foSpots2[inst.key]; const spot = q?.last_price || 0;
        if (spot < 1) { lg(inst.s + ': no spot', 'w'); continue; }
        const spotChg = getChgPct(q);
        // Fetch both daily (for EMA50/200 context) AND 5-min intraday (for momentum/VWAP)
        let stkCandles = [];
        let stkDailyCandles = [];
        try {
          const today = new Date().toISOString().split('T')[0];
          const from365 = new Date(Date.now() - 365*86400000).toISOString().split('T')[0];
          [stkCandles, stkDailyCandles] = await Promise.all([
            fetchIntraday(inst.key, '5minute', accessToken, onTokenExpired).catch(() => []),
            fetchCandles(inst.key, from365, today, 'day', accessToken, onTokenExpired).catch(() => []),
          ]);
        } catch(_) {}
        // Use daily candles for EMA200 — intraday for momentum signals
        const candlesForCtx = stkDailyCandles.length >= 50 ? stkDailyCandles : stkCandles;
        const ctxKey = SECTOR_CTX_MAP[inst.s] || 'NIFTY';
        const baseCtx = ctxMap[ctxKey] || ctxMap['NIFTY'] || {};
        // Compute full context with real candles instead of empty array
        const stkCtx = { ...(computeCtxFromCandles(candlesForCtx, spot, spotChg, vixVal, null) || baseCtx) };
        stkCtx.spot = spot; stkCtx.dayChange = spotChg;
        stkCtx.bullish = stkCtx.compositeScore > 0;
        stkCtx.neutral = Math.abs(stkCtx.compositeScore || 0) < 0.5;
        let expiry = '';
        try { const cd = await fetch(`https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(inst.key)}`, { headers:{ Authorization:'Bearer '+accessToken, Accept:'application/json' } }).then(r=>r.json()); expiry = (cd?.data?.map(e=>e.expiry).sort()||[])[0]||''; } catch(e) {}
        if (!expiry) continue;
        await sleep(300);
        const chain = await fetchOptions(inst.key, expiry, accessToken, onTokenExpired);
        if (!chain.length) continue;
        const ceOI2 = chain.reduce((s,x)=>s+(x.call_options?.market_data?.oi||0),0), peOI2 = chain.reduce((s,x)=>s+(x.put_options?.market_data?.oi||0),0);
        const pcr2 = ceOI2 > 0 ? +(peOI2/ceOI2).toFixed(2) : 1;
        const prevPCR2 = prevPCRCache.current[inst.s] ?? pcr2; prevPCRCache.current[inst.s] = pcr2;
        const chainIVs2 = chain.flatMap(r=>[r.call_options?.option_greeks?.iv,r.put_options?.option_greeks?.iv]).filter(v=>v>0);
        const avgIV2 = chainIVs2.length ? +(chainIVs2.reduce((a,b)=>a+b,0)/chainIVs2.length).toFixed(1) : null;
        const prevAvgIV2 = prevAvgIVCache.current[inst.s] ?? avgIV2; if(avgIV2!=null) prevAvgIVCache.current[inst.s]=avgIV2;
        const ivTrend2 = avgIV2!=null&&prevAvgIV2!=null ? +(avgIV2-prevAvgIV2).toFixed(2) : 0;
        stkCtx.pcr=pcr2; stkCtx.pcrTrend=+(pcr2-prevPCR2).toFixed(3); stkCtx.ivTrend=ivTrend2; stkCtx.avgIV=avgIV2;
        const step2 = spot<200?5:spot<500?10:spot<2000?20:spot<5000?50:100;
        const atm2 = Math.round(spot/step2)*step2;
        const stkMaxPain = calcMaxPain(chain);
        const picks2 = scanChain(chain, atm2, spot, inst.s, expiry, inst.lot, niftyBull, vixVal, stkMaxPain, pcr2, stkCtx, cfg);
        const fPicks2 = scoreAndFilterPicks(picks2, { fiiData, adaptWeights, mlModels, cfg, maxPain: stkMaxPain, spot });
        if (fPicks2.length) { built.push({ name:inst.s, spot, spotChg, picks:fPicks2, expiry, chain, maxPain:stkMaxPain, oiWalls:calcOIWalls(chain), pcr:pcr2, pcrTrend:stkCtx.pcrTrend, ivTrend:ivTrend2, type:'stock', fullName:inst.n }); lg(`${inst.s}: ${chain.length} strikes → ${fPicks2.length} signals`, 'o'); }
      } catch(e) { lg(inst.s + ' opts: ' + e.message, 'w'); }
    }
  }

  // ── Step final: Sort + apply FII bias ───────────────────
  setProgress(`Step ${totalSteps}/${totalSteps}: Calculating signals + applying FII bias...`);
  const withTrend = built.reduce((s, g) => s + g.picks.filter(p => p.trendAligned).length, 0);
  const total     = built.reduce((s, g) => s + g.picks.length, 0);
  const scanId = Date.now();
  const nextGroups = built.map((group) => ({
    ...group,
    _scanId: scanId,
    picks: group.picks.map((pick, index) => ({ ...pick, _scanId: scanId, _scanIndex: index })),
  }));
  const allPicks = built.flatMap(g => g.picks);
  // Don't log WATCH options — no direction conviction, contaminates calibration
  const loggableOpts = allPicks.filter(p => p.action !== 'WATCH');
  if (loggableOpts.length && gh?.token) logSignals(gh, loggableOpts.map(p => buildOptionSignal(p, vixVal)), vixVal, lg);
  lg(`✅ Options: ${total} signals (${withTrend} with-trend)`, 'o');

  return { groups: nextGroups, scanId, vixVal, withTrend, total };
}

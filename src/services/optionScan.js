// ── Option scan service — F&O Options chain scan ─────────────────
// Extracted from OptionsPane.jsx so the pane only handles UI/state wiring.
// All calculation, scoring, and API-call logic for the Options tab lives here.

import { fetchQ, fetchOptions, fetchIntraday, fetchCandles } from './api.js';
import { getIST, sleep } from '../utils/marketTime.js';
import { INDEX_OPTS, TOP_FO_SYMBOLS, SECTOR_CTX_MAP, NIFTY50_FALLBACK } from '../constants/config.js';
import { calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain, applyAdaptWeights, applyCalibration, classifyMarketRegime, applyRegimeAdjustment, buildOptionConfluence, buildOptionIndSnap, candleOrder, interpretFIIDII, computeVixPercentile, vixRegimeShiftScore, calcIVRank } from './technical.js';
import { applyMlRanking, evaluateSignalGate } from './mlRanking.js';
import { pushShadow, drainShadow } from './shadowLog.js';
import { logSignals, logShadowSignals, buildOptionSignal } from './github.js';

export const VIX_KEY = 'NSE_INDEX|India VIX';

// Filters a sorted list of expiry date strings (YYYY-MM-DD) to those falling
// within the current calendar month (and not already past). Falls back to
// the nearest available expiry if none fall in the current month (e.g. last
// trading days of the month when only next-month expiries remain).
export function expiriesInCurrentMonth(allExpiries) {
  const unique = [...new Set(allExpiries)].sort();
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const todayStr = now.toISOString().slice(0, 10);
  const inMonth = unique.filter(e => {
    const d = new Date(e);
    return d.getFullYear() === y && d.getMonth() === m && e >= todayStr;
  });
  return inMonth.length ? inMonth : (unique[0] ? [unique[0]] : []);
}

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

// Applies calibration + regime + adaptive weights (learned) + ML ranking to a
// raw scanChain pick, then filters by confidence/capital thresholds. FII-bias
// and confluence-tier are no longer separate fixed-formula adjustments here —
// they're boolean flags (fiiAligned/fiiAgainst, confluenceStrong/Weak/Conflict)
// fed into applyAdaptWeights below, same as the stock scan path, so their
// actual confidence impact is learned from closed-signal win rates instead of
// a hardcoded magnitude.
function scoreAndFilterPicks(picks, { fiiData, fiiInterp: fiiInterpIn = null, adaptWeights, mlModels, confCalibration, regime, volRegimeShift = 0, cfg, maxPain = 0, spot = 0 }) {
  const fiiInterp = fiiInterpIn || interpretFIIDII(fiiData || null);
  return picks.map(p => {
    const base = p.confidence;
    let c = base;
    let prev = c;

    // IV Rank calculation against historical baseline
    const ivVal = p.iv || 20;
    const { ivr, regime: ivRegime, actionableBias } = calcIVRank(ivVal, 12, 45);

    c = applyCalibration(c, confCalibration || null);
    const calAdj = c - prev; prev = c;
    c = applyRegimeAdjustment(c, regime, cfg, mlModels?.thresholds?.option?.regimePenalties);
    
    // IVR Penalty / Bonus: protect against IV crush on expensive options
    let ivrAdj = 0;
    if (p.action === 'BUY' && ivr >= 65) ivrAdj = -18;
    else if (p.action === 'BUY' && ivr <= 30) ivrAdj = +8;
    c = Math.min(99, Math.max(1, c + ivrAdj));

    const regimeAdj = c - prev; prev = c;
    // Shared with lookupService.js (technical.js buildOptionConfluence) — see there.
    const confluence = buildOptionConfluence(p);
    const isBuyLean = p.action === 'BUY';
    const indSnap = buildOptionIndSnap(p, confluence, fiiInterp, isBuyLean);
    c = applyAdaptWeights(c, adaptWeights?.option || null, indSnap);
    const adaptAdj = c - prev;
    const mlRank = applyMlRanking(c, mlModels || null, { ...p, confidence: c, regime, volRegimeShift, _indSnap: indSnap });
    const finalConf = Math.min(99, Math.max(1, Math.round(mlRank.confidence)));
    return {
      ...p,
      confidence: finalConf,
      ivr,
      ivRegime,
      regime,
      volRegimeShift,
      confluence,
      confBreakdown: { base, calAdj, regimeAdj, adaptAdj, mlAdj: mlRank.mlAdj, final: finalConf },
      _indSnap: indSnap,
      _dte: p._dte ?? null,
      nearMaxPain: maxPain > 0 && spot > 0 && Math.abs(p.strike - maxPain) / spot < 0.01,
      mlProbability: mlRank.mlProbability,
      mlAdj: mlRank.mlAdj,
      mlSegment: mlRank.mlSegment,
      mlExplain: mlRank.explanation,
      aiBlock: mlRank.aiBlock,
      aiModel: mlRank.mlSegment,
    };
  }).filter(p => {
    // Completely block naked long option buying when IVR is extremely high (> 75) to avoid IV crush
    if (p.action === 'BUY' && (p.ivr ?? 50) >= 75) {
      pushShadow(p, 'iv_crush_risk_high_ivr', 'OPTION');
      return false;
    }
    const gate = evaluateSignalGate({
      type: 'OPTION', aiBlock: p.aiBlock, conf: p.confidence, rr: p.rr,
      amtRequired: p.amtRequired, mlModels, cfg, sigForThresholds: p,
    });
    if (!gate.passes) pushShadow(p, gate.reason, 'OPTION');
    return gate.passes;
  });
}

export function effectiveOptionCfg(cfgIn, mlModels) {
  const g = mlModels?.thresholds?.option;
  return g?.deltaGate != null ? { ...cfgIn, delta: g.deltaGate, iv: g.ivGate } : cfgIn;
}

// ── Shared per-stock option scan ─────────────────────────────────────────
// The F&O Options page and the Analyse Stock page each built a stock's option
// picks their own way, so the same stock showed different (or no) options on
// each page. Differences that were found: the Analyse Stock page passed the
// STOCK's own day-change as the market bias (Options page: NIFTY's), hard-coded
// VIX to 0 (Options page: real India VIX), built its context from 5-min candles
// only (empty before the open) instead of daily-with-5-min-fallback, scanned
// only the first expiry instead of every expiry this month, and skipped the
// learned delta/IV gates. One implementation now, called by both.
//
// Returns { ok:false, reason } when the stock can't be scanned (already logged),
// otherwise { ok:true, picks, rawCount, expiry, expiries, allExpiries, chain,
// maxPain, pcr, ivTrend, atm, stkCtx }. `expiries` may be passed in if the caller
// already has them.
export async function scanStockOptions({ inst, spot, spotChg, deps, env, expiries: preExpiries = null }) {
  const { accessToken, cfg, fiiData = null, fiiInterp = null, adaptWeights, mlModels, confCalibration, onTokenExpired, lg, vixHistorySeries } = deps;
  const { niftyBull, vixVal, ctxMap = {}, prevPCRCache = { current: {} }, prevAvgIVCache = { current: {} } } = env;

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
  } catch (_) {}
  // Use daily candles for EMA200 — intraday for momentum signals
  const candlesForCtx = stkDailyCandles.length >= 50 ? stkDailyCandles : stkCandles;
  const ctxKey = SECTOR_CTX_MAP[inst.s] || 'NIFTY';
  const baseCtx = ctxMap[ctxKey] || ctxMap['NIFTY'] || {};
  const stkCtx = { ...(computeCtxFromCandles(candlesForCtx, spot, spotChg, vixVal, null) || baseCtx) };
  stkCtx.spot = spot; stkCtx.dayChange = spotChg;
  stkCtx.bullish = stkCtx.compositeScore > 0;
  stkCtx.neutral = Math.abs(stkCtx.compositeScore || 0) < 0.5;

  let allExpiries = preExpiries;
  if (!allExpiries) {
    allExpiries = [];
    try {
      const cd = await fetch(`https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(inst.key)}`, { headers:{ Authorization:'Bearer '+accessToken, Accept:'application/json' } }).then(r=>r.json());
      allExpiries = (cd?.data?.map(e=>e.expiry).filter(Boolean)||[]);
    } catch(e) {}
  }
  if (!allExpiries.length) { lg(inst.s + ': no option expiries returned — skipped', 'w'); return { ok:false, reason:'no-expiries' }; }
  const expiriesToScan = expiriesInCurrentMonth(allExpiries);
  const expiry = expiriesToScan[0]; // nearest — drives structural stats below
  await sleep(300);
  const chain = await fetchOptions(inst.key, expiry, accessToken, onTokenExpired);
  if (!chain.length) { lg(inst.s + ': empty option chain — skipped', 'w'); return { ok:false, reason:'empty-chain', expiry }; }
  const ceOI = chain.reduce((s,x)=>s+(x.call_options?.market_data?.oi||0),0), peOI = chain.reduce((s,x)=>s+(x.put_options?.market_data?.oi||0),0);
  const pcr = ceOI > 0 ? +(peOI/ceOI).toFixed(2) : 1;
  const prevPCR = prevPCRCache.current[inst.s] ?? pcr; prevPCRCache.current[inst.s] = pcr;
  const chainIVs = chain.flatMap(r=>[r.call_options?.option_greeks?.iv,r.put_options?.option_greeks?.iv]).filter(v=>v>0);
  const avgIV = chainIVs.length ? +(chainIVs.reduce((a,b)=>a+b,0)/chainIVs.length).toFixed(1) : null;
  const prevAvgIV = prevAvgIVCache.current[inst.s] ?? avgIV; if (avgIV!=null) prevAvgIVCache.current[inst.s]=avgIV;
  const ivTrend = avgIV!=null&&prevAvgIV!=null ? +(avgIV-prevAvgIV).toFixed(2) : 0;
  stkCtx.pcr=pcr; stkCtx.pcrTrend=+(pcr-prevPCR).toFixed(3); stkCtx.ivTrend=ivTrend; stkCtx.avgIV=avgIV;
  const step = spot<200?5:spot<500?10:spot<2000?20:spot<5000?50:100;
  const atm = Math.round(spot/step)*step;
  const stkMaxPain = calcMaxPain(chain);

  // Scan every expiry in the current month, merging picks (each pick carries its own .expiry)
  const allStkPicks = [];
  for (const [ei, exp] of expiriesToScan.entries()) {
    const expChain = exp === expiry ? chain : await fetchOptions(inst.key, exp, accessToken, onTokenExpired).catch(() => []);
    if (!expChain.length) continue;
    const expMaxPain = exp === expiry ? stkMaxPain : calcMaxPain(expChain);
    allStkPicks.push(...scanChain(expChain, atm, spot, inst.s, exp, inst.lot, niftyBull, vixVal, expMaxPain, pcr, stkCtx, cfg));
    if (exp !== expiry) await sleep(300);
  }

  const stkRegime = classifyMarketRegime(Math.abs(stkCtx.compositeScore || 0) / 3.5, vixVal, computeVixPercentile(vixHistorySeries, vixVal));
  const stkVolRegimeShift = vixRegimeShiftScore(vixHistorySeries, vixVal);
  const picks = scoreAndFilterPicks(allStkPicks, { fiiData, fiiInterp, adaptWeights, mlModels, confCalibration, regime: stkRegime, volRegimeShift: stkVolRegimeShift, cfg, maxPain: stkMaxPain, spot });
  // Always report the raw → final count, so a stock whose picks were all filtered out
  // (RR / capital / confidence gate) is visible in the log instead of vanishing silently.
  if (!picks.length) lg(`${inst.s}: ${allStkPicks.length} raw → 0 signals (all filtered by gate/thresholds)`, 'w');
  return { ok:true, picks, rawCount: allStkPicks.length, expiry, expiries: expiriesToScan, allExpiries, chain, maxPain: stkMaxPain, pcr, ivTrend, atm, stkCtx };
}

export async function runOptionsScan(ctx, caches, callbacks) {
  const { accessToken, cfg: cfgIn, stocks, fiiData, adaptWeights, mlModels, confCalibration, gh, onTokenExpired, lg, vixHistorySeries } = ctx;
  // Learned delta/IV gates (mlRanking.optimizeThresholds) override the static
  // 0.40/15 defaults once enough logged option signals exist to sweep them.
  const cfg = effectiveOptionCfg(cfgIn, mlModels);
  const { prevAvgIVCache, prevPCRCache } = caches;
  const { setProgress, setMarketCtxMap, setVix } = callbacks;

  // ── F&O-eligible universe: prefer the live stocks.json list (all ~500 stocks,
  // each carrying its own lot/step) and fall back to the static NIFTY50 list only
  // if stocks.json hasn't loaded yet. Ranked by volume at scan time (Step 3). ──
  const foFromJson = (stocks || []).filter(s => s.fo && s.lot > 0 && s.key);
  const eligibleFOStocks = foFromJson.length > 0
    ? foFromJson
    : NIFTY50_FALLBACK.filter(s => s.fo && TOP_FO_SYMBOLS.includes(s.s));
  if (stocks?.length > 0 && foFromJson.length === 0) {
    lg(`⚠ stocks.json has ${stocks.length} stocks but none flagged fo:true — using static F&O fallback list instead. Check your stocks.json data.`, 'w');
  }
  const scanCount = Math.max(1, cfg.optStockScanCount || 50);
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

  // Show what order the API actually returns candles in (computeCtxFromCandles now normalises it).
  { const _k = INDEX_CANDLE_KEYS.find(k => (idxCandles[k] || []).length > 1); if (_k) lg(`Candle order from API: ${candleOrder(idxCandles[_k])} (${idxCandles[_k].length} candles) — normalised to chronological for market context`, 'o'); }
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

    // Expiries — scan every expiry falling within the current calendar month
    setProgress(`Step 2/${totalSteps}: ${idx.name} fetching expiries...`);
    let allExpiries = [];
    try {
      const cd = await fetch(
        `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(idx.key)}`,
        { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } }
      ).then(r => r.json());
      allExpiries = (cd?.data?.map(e => e.expiry).filter(Boolean) || []);
    } catch (e) { lg('Contract ' + idx.name + ': ' + e.message, 'w'); }
    if (!allExpiries.length) continue;
    const expiriesToScan = expiriesInCurrentMonth(allExpiries);
    const expiry = expiriesToScan[0]; // nearest — drives structural stats below

    setProgress(`Step 2/${totalSteps}: ${idx.name} scanning ${spot} strikes across ${expiriesToScan.length} expiry(s)...`);
    // Nearest-expiry chain drives structural stats (Max Pain/OI walls/PCR/IV trend)
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

    // Scan every expiry in the current month, merging picks (each pick carries its own .expiry)
    const allIdxPicks = [];
    for (const [ei, exp] of expiriesToScan.entries()) {
      setProgress(`Step 2/${totalSteps}: ${idx.name} expiry ${ei+1}/${expiriesToScan.length} (${exp})...`);
      const expChain = exp === expiry ? chain : await fetchOptions(idx.key, exp, accessToken, onTokenExpired).catch(() => []);
      if (!expChain.length) { lg(`${idx.name} ${exp}: empty chain`, 'w'); continue; }
      const expMaxPain = exp === expiry ? maxPain : calcMaxPain(expChain);
      allIdxPicks.push(...scanChain(expChain, atm, spot, idx.name, exp, idx.lot, niftyBull, vixVal, expMaxPain, pcr, richCtx, cfg));
      if (exp !== expiry) await sleep(300);
    }

    // Apply FII bias + adaptive weights + ML ranking, then filter
    const idxRegime = classifyMarketRegime(Math.abs(richCtx.compositeScore || 0) / 3.5, vixVal, computeVixPercentile(vixHistorySeries, vixVal));
    const idxVolRegimeShift = vixRegimeShiftScore(vixHistorySeries, vixVal);
    const picksWithFII = scoreAndFilterPicks(allIdxPicks, { fiiData, adaptWeights, mlModels, confCalibration, regime: idxRegime, volRegimeShift: idxVolRegimeShift, cfg, maxPain, spot });

    lg(`${idx.name}: ${expiriesToScan.length} expiry(s) → ${allIdxPicks.length} raw → ${picksWithFII.length} ≥${cfg.minOptConf}% | composite=${richCtx.compositeScore} pcr=${pcr}`, 'o');
    built.push({ name: idx.name, spot, spotChg, picks: picksWithFII, expiry, expiries: expiriesToScan, chain, maxPain, oiWalls, pcr, pcrTrend, ivTrend });
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
    // Rank by BOTH activity and movement, not raw share volume. Share volume alone
    // favours cheap, heavily traded stocks and ignores whether the stock is moving.
    //   activity   = turnover (volume x price) — money traded, comparable across prices
    //   volatility = the larger of today's high-low range and |change|, as % of prev close
    // Each is converted to a percentile among the F&O universe and averaged 50/50, so
    // a stock needs to be both liquid and active to rank high. Top `scanCount` are scanned.
    const ranked = eligibleFOStocks.map(s => {
      const q = allSpots[s.key]; const px = q?.last_price || 0; const vol = q?.volume || 0;
      const prev = q?.ohlc?.close || 0, hi = q?.ohlc?.high || 0, lo = q?.ohlc?.low || 0;
      const base = prev > 0 ? prev : px;
      const rangePct = base > 0 && hi > 0 && lo > 0 ? ((hi - lo) / base) * 100 : 0;
      return { ...s, _hasQuote: px > 0, _vol: vol, _turnover: vol * px, _volatility: Math.max(rangePct, Math.abs(getChgPct(q) || 0)) };
    }).filter(s => s._hasQuote);
    const pctRank = (key) => {
      const sorted = ranked.map(r => r[key]).sort((a, b) => a - b);
      return (v) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m; } return sorted.length ? lo / sorted.length : 0; };
    };
    const rTurn = pctRank('_turnover'), rVola = pctRank('_volatility');
    const noLiveVolume = ranked.length > 0 && ranked.every(r => r._turnover === 0);
    if (noLiveVolume) lg('⚠ No live volume in quotes (market closed / pre-open?) — ranking by volatility only this scan.', 'w');
    foStocks = ranked
      .map(r => ({ ...r, _score: noLiveVolume ? rVola(r._volatility) : 0.5 * rTurn(r._turnover) + 0.5 * rVola(r._volatility) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, scanCount);
    lg(`F&O universe: ${eligibleFOStocks.length} eligible → ${foStocks.length} selected by volume + volatility (top ${scanCount})`, 'o');
    if (foStocks.length) lg('Top picks: ' + foStocks.slice(0, 8).map(r => `${r.s} (${Math.round(r._score * 100)})`).join(', '), 'o');
    if (foStocks.length === 0) lg(`⚠ F&O stock options: 0 of ${eligibleFOStocks.length} eligible stocks returned a usable quote — stock options will be skipped this scan. Check the quote API / instrument keys.`, 'w');
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
        // Same scan the Analyse Stock page runs (scanStockOptions above) — one implementation.
        const r = await scanStockOptions({
          inst, spot, spotChg,
          deps: { accessToken, cfg, fiiData, adaptWeights, mlModels, confCalibration, onTokenExpired, lg, vixHistorySeries },
          env: { niftyBull, vixVal, ctxMap, prevPCRCache, prevAvgIVCache },
        });
        if (!r.ok) continue; // reason already logged
        if (r.picks.length) {
          built.push({ name:inst.s, spot, spotChg, picks:r.picks, expiry:r.expiry, expiries:r.expiries, chain:r.chain, maxPain:r.maxPain, oiWalls:calcOIWalls(r.chain), pcr:r.pcr, pcrTrend:r.stkCtx.pcrTrend, ivTrend:r.ivTrend, type:'stock', fullName:inst.n });
          lg(`${inst.s}: ${r.expiries.length} expiry(s) → ${r.rawCount} raw → ${r.picks.length} signals`, 'o');
        }
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
  if (gh?.token) logShadowSignals(gh, drainShadow(), vixVal, lg);
  lg(`✅ Options: ${total} signals (${withTrend} with-trend)`, 'o');

  return { groups: nextGroups, scanId, vixVal, withTrend, total };
}

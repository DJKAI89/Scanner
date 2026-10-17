// ── Option Analysis service — full chain view with per-strike confidence ──
// Shows every strike (not just trade candidates) with live LTP/OI, a
// confidence score, OI buildup classification, and an estimated margin —
// mirroring a broker's option-chain screen, with our own confidence model
// layered on top. Expiry list is selectable (weekly: top 5 nearest expiries;
// monthly-only: current + next month) and only ONE chain is fetched/rendered
// at a time, driven by the selected expiry.

import { fetchQ, fetchOptions, fetchOptionContracts, fetchIntraday } from './api';
import { calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChainAnalysis } from './technical';

export function getOptionKey(opt) {
  return opt?.instrKey || '';
}

// Classifies the full expiry list for an underlying:
// - "weekly": more than one expiry falls within a single calendar month
//   anywhere in the near future → show the 5 nearest expiries.
// - "monthly": exactly one expiry per month (stocks, SENSEX-style) →
//   show current month's + next month's expiry only.
export function classifyExpiries(allExpiries) {
  const unique = [...new Set(allExpiries)].filter(Boolean).sort();
  const todayStr = new Date().toISOString().slice(0, 10);
  const future = unique.filter(e => e >= todayStr);
  if (!future.length) return { mode: 'none', list: [] };

  const byMonth = {};
  future.forEach(e => { const ym = e.slice(0, 7); (byMonth[ym] = byMonth[ym] || []).push(e); });
  const isWeekly = Object.values(byMonth).some(list => list.length > 1);

  return isWeekly
    ? { mode: 'weekly', list: future.slice(0, 5) }
    : { mode: 'monthly', list: future.slice(0, 2) };
}

// Picks the `count` strikes closest to ATM from a strike-ascending row array,
// while preserving ascending order for display.
export function selectStrikesAroundATM(rows, atm, count) {
  if (!rows?.length) return rows;
  if (rows.length <= count) return rows;
  const withDist = rows.map((r, i) => ({ r, i, d: Math.abs(r.strike - atm) }));
  withDist.sort((a, b) => a.d - b.d || a.i - b.i);
  const picked = new Set(withDist.slice(0, count).map(x => x.i));
  return rows.filter((_, i) => picked.has(i));
}

const OI_BONUS = { LONG_BUILD: 15, SHORT_COVER: 5, SHORT_BUILD: -15, LONG_UNWIND: -8, NEUTRAL: 0 };

// Merges live WS prices (LTP/OI) into per-strike rows, recomputing margin
// AND confidence on every tick. Delta/IV/theta stay as of last full fetch
// (not in the WS tick payload) but OI buildup — the biggest confidence
// swing factor — recomputes live off prevOI + live OI, same thresholds
// used at scan time, layered back onto the cached baseConfidence.
export function mergeLiveIntoRows(rows, lastPrices, lot = 1, priceBull = null, priceBear = null, oiThresh = 15, liveGreeks = null) {
  if (!rows?.length || !lastPrices || Object.keys(lastPrices).length === 0) return rows;
  return rows.map((row) => {
    const next = { ...row };
    for (const side of ['CE', 'PE']) {
      const cell = row[side];
      if (!cell?.instrKey) continue;
      const live = lastPrices[cell.instrKey];
      if (!live) continue;
      const liveLtp = live.ltp ?? cell.ltp;
      const cp = live.cp || 0;
      const g = liveGreeks?.[cell.instrKey];
      const liveOi = g?.oi || live.oi || cell.oi;

      let oiBuildType = cell.oiBuildType, oiBuildBonus = cell.oiBuildBonus, confidence = cell.confidence;
      if (live.oi != null && cell.prevOI > 0 && priceBull != null) {
        const oiChg = (liveOi - cell.prevOI) / cell.prevOI * 100;
        const oiRising = oiChg >= oiThresh, oiFalling = oiChg <= -oiThresh;
        oiBuildType = 'NEUTRAL';
        if (cell.isCE) {
          if (priceBull && oiRising)  oiBuildType = 'LONG_BUILD';
          if (priceBull && oiFalling) oiBuildType = 'SHORT_COVER';
          if (priceBear && oiRising)  oiBuildType = 'SHORT_BUILD';
          if (priceBear && oiFalling) oiBuildType = 'LONG_UNWIND';
        } else {
          if (priceBear && oiRising)  oiBuildType = 'LONG_BUILD';
          if (priceBear && oiFalling) oiBuildType = 'SHORT_COVER';
          if (priceBull && oiRising)  oiBuildType = 'SHORT_BUILD';
          if (priceBull && oiFalling) oiBuildType = 'LONG_UNWIND';
        }
        oiBuildBonus = (oiRising || oiFalling) ? OI_BONUS[oiBuildType] : 0;
        confidence = Math.round(Math.min(100, Math.max(0, (cell.baseConfidence ?? cell.confidence) + oiBuildBonus)));
      }

      next[side] = {
        ...cell,
        ltp: liveLtp,
        ltpChgPct: cp > 0 ? +((liveLtp - cp) / cp * 100).toFixed(2) : cell.ltpChgPct,
        oi: liveOi,
        delta: g?.delta ?? cell.delta,
        iv: g?.iv != null ? +(g.iv * 100).toFixed(1) : cell.iv,
        theta: g?.theta ?? cell.theta,
        oiBuildType, oiBuildBonus, confidence,
        marginEst: +(liveLtp * lot).toFixed(0),
        isLive: true,
      };
    }
    return next;
  });
}

// ── Chain-level read ────────────────────────────────────────────────────────
// Everything here is derived from data the page already holds (no extra API
// calls): the walls / max pain / PCR computed in loadOneChain, plus each cell's
// ltp, iv, oi and prevOI. `rows` should be the FULL strike list, with live-merged
// rows substituted where available, so totals aren't limited to the visible strikes.
// Descriptive only — this reports where OI and price sit; it does not recommend a trade.
const pctOf = (a, b) => (b ? (a - b) / b * 100 : 0);
const avg = (xs) => { const v = xs.filter((x) => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };

export function summarizeChain(chain, spot, rows = chain?.rows || []) {
  if (!chain || !spot || !rows?.length) return null;
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const atmRow = sorted.find((r) => r.atm) || sorted.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a), sorted[0]);

  // PCR — same bands the confluence model uses (>1.2 bullish, <0.8 bearish)
  const pcr = chain.pcr ?? 1;
  const pcrLabel = pcr >= 1.2 ? 'Bullish' : pcr <= 0.8 ? 'Bearish' : 'Neutral';

  const { callWall = 0, putWall = 0, callWallOI = 0, putWallOI = 0 } = chain.oiWalls || {};
  const maxPain = chain.maxPain || 0;

  // ATM straddle: the market's own price for "how far, either way, by expiry"
  const ce = atmRow?.CE?.ltp || 0, pe = atmRow?.PE?.ltp || 0;
  const straddle = ce > 0 && pe > 0 ? +(ce + pe).toFixed(2) : 0;

  // IV level and skew (3 nearest OTM puts vs 3 nearest OTM calls)
  const atmIv = +avg([atmRow?.CE?.iv, atmRow?.PE?.iv]).toFixed(1);
  const otmPutIv  = avg(sorted.filter((r) => r.strike < atmRow.strike).slice(-3).map((r) => r.PE?.iv));
  const otmCallIv = avg(sorted.filter((r) => r.strike > atmRow.strike).slice(0, 3).map((r) => r.CE?.iv));
  const skew = otmPutIv > 0 && otmCallIv > 0 ? +(otmPutIv - otmCallIv).toFixed(1) : null;
  const skewLabel = skew == null ? '—' : skew > 0.5 ? 'Put skew' : skew < -0.5 ? 'Call skew' : 'Flat';

  // OI flow across the whole chain: where is new open interest being added?
  let ceOI = 0, peOI = 0, ceChg = 0, peChg = 0;
  for (const r of sorted) {
    ceOI += r.CE?.oi || 0; peOI += r.PE?.oi || 0;
    if (r.CE) ceChg += (r.CE.oi || 0) - (r.CE.prevOI || r.CE.oi || 0);
    if (r.PE) peChg += (r.PE.oi || 0) - (r.PE.prevOI || r.PE.oi || 0);
  }
  const totalOI = ceOI + peOI;
  const moved = Math.abs(ceChg) + Math.abs(peChg);
  let flowLabel = 'Balanced';
  if (totalOI > 0 && moved / totalOI < 0.005) flowLabel = 'No meaningful OI change yet';
  else if (peChg > 0 && peChg > ceChg * 1.15 + 1) flowLabel = 'Puts building faster — support strengthening';
  else if (ceChg > 0 && ceChg > peChg * 1.15 + 1) flowLabel = 'Calls building faster — resistance strengthening';

  const maxPainDistPct = +pctOf(maxPain, spot).toFixed(2);
  const callWallDistPct = +pctOf(callWall, spot).toFixed(2);
  const putWallDistPct = +pctOf(putWall, spot).toFixed(2);
  const expiryDt = chain.expiry ? new Date(chain.expiry + 'T15:30:00+05:30') : null;
  const dte = expiryDt ? Math.max(0, Math.round((expiryDt - Date.now()) / 86400000)) : null;

  // Plain-language facts — each stands alone and states what the data shows.
  const facts = [];
  if (maxPain) facts.push(`Spot is ${Math.abs(maxPainDistPct)}% ${maxPainDistPct <= 0 ? 'above' : 'below'} Max Pain (${maxPain.toLocaleString('en-IN')})`);
  if (callWall) facts.push(callWall >= spot
    ? `Call wall ${callWall.toLocaleString('en-IN')} is ${callWallDistPct}% above spot — nearest heavy resistance`
    : `Call wall ${callWall.toLocaleString('en-IN')} is already below spot — that resistance has been breached`);
  if (putWall) facts.push(putWall <= spot
    ? `Put wall ${putWall.toLocaleString('en-IN')} is ${Math.abs(putWallDistPct)}% below spot — nearest heavy support`
    : `Put wall ${putWall.toLocaleString('en-IN')} is already above spot — that support has been breached`);
  if (straddle) facts.push(`ATM straddle ₹${straddle} → options price roughly ±${(straddle / spot * 100).toFixed(1)}% by expiry (${Math.round(spot - straddle).toLocaleString('en-IN')} – ${Math.round(spot + straddle).toLocaleString('en-IN')})`);
  facts.push(flowLabel);

  return {
    pcr, pcrLabel, maxPain, maxPainDistPct,
    callWall, putWall, callWallOI, putWallOI, callWallDistPct, putWallDistPct,
    straddle, impliedMovePct: straddle ? +(straddle / spot * 100).toFixed(2) : 0,
    rangeLow: straddle ? spot - straddle : 0, rangeHigh: straddle ? spot + straddle : 0,
    atmIv, skew, skewLabel,
    ceOI, peOI, ceChg, peChg, flowLabel, dte, facts,
  };
}

async function loadOneChain(indexKey, expiry, spot, step, lot, niftyBullish, vixVal, marketCtx, cfg, token, onTokenExpired) {
  const chain = await fetchOptions(indexKey, expiry, token, onTokenExpired);
  if (!chain.length) return null;
  const maxPain = calcMaxPain(chain);
  const oiWalls = calcOIWalls(chain);
  const ceOI = chain.reduce((s, x) => s + (x.call_options?.market_data?.oi || 0), 0);
  const peOI = chain.reduce((s, x) => s + (x.put_options?.market_data?.oi  || 0), 0);
  const pcr  = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1;
  const atm  = Math.round(spot / step) * step;
  const rows = scanChainAnalysis(chain, atm, spot, niftyBullish, vixVal, maxPain, pcr, marketCtx, cfg, lot);
  return { expiry, rows, maxPain, oiWalls, pcr, atm };
}

// Fetches spot/VIX/expiry-list/market-context ONCE per index selection.
// Does NOT fetch any option chain — call loadChainForExpiry for that.
// ctx: { token, indexKey, step, lot, cfg, onTokenExpired, lg }
// Returns: { spot, spotChg, vixVal, niftyBullish, marketCtx, expiryMode, expiryList }
export async function loadOptionMeta(ctx, callbacks) {
  const { token, indexKey, cfg, onTokenExpired, lg } = ctx;
  const { setProgress } = callbacks;

  setProgress('Fetching spot + VIX...');
  const mktD = await fetchQ(`${indexKey},NSE_INDEX|India VIX`, token, onTokenExpired);
  const spotQ = mktD[indexKey];
  const vixQ  = mktD['NSE_INDEX|India VIX'];
  if (!spotQ?.last_price) throw new Error('Could not fetch spot price');
  const spot    = spotQ.last_price;
  const netChg  = spotQ.net_change ?? (spotQ.ohlc?.close ? spot - spotQ.ohlc.close : 0);
  const spotChg = spot > 0 ? +(netChg / spot * 100).toFixed(2) : 0;
  const vixVal  = vixQ?.last_price || 15;
  const niftyBullish = spotChg > -0.3;

  setProgress('Fetching expiries...');
  const contracts = await fetchOptionContracts(indexKey, token, onTokenExpired);
  const rawExpiries = contracts.map(c => c.expiry).filter(Boolean);
  const { mode, list } = classifyExpiries(rawExpiries);
  if (!list.length) throw new Error('No expiries available');

  setProgress('Fetching intraday context...');
  let marketCtx = null;
  try {
    const candles = await fetchIntraday(indexKey, '5minute', token, onTokenExpired);
    marketCtx = computeCtxFromCandles(candles, spot, spotChg, vixVal, null);
  } catch (e) { lg('Option analysis ctx: ' + e.message, 'w'); }

  return { spot, spotChg, vixVal, niftyBullish, marketCtx, expiryMode: mode, expiryList: list };
}

// Fetches ONE chain for the given expiry, reusing already-fetched spot/VIX/
// marketCtx (from loadOptionMeta) so switching expiry in the dropdown never
// re-fetches spot/VIX/contracts — only the chain itself.
// ctx: { token, indexKey, step, lot, cfg, onTokenExpired }
// meta: { spot, vixVal, niftyBullish, marketCtx }
export async function loadChainForExpiry(ctx, expiry, meta) {
  const { token, indexKey, step, lot, cfg, onTokenExpired } = ctx;
  const { spot, vixVal, niftyBullish, marketCtx } = meta;
  const chain = await loadOneChain(indexKey, expiry, spot, step, lot, niftyBullish, vixVal, marketCtx, cfg, token, onTokenExpired);
  if (!chain) throw new Error('Empty option chain for ' + expiry);
  return chain;
}

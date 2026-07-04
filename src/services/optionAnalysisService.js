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

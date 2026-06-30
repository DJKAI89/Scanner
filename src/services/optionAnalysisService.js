// ── Option Analysis service — full chain view with per-strike confidence ──
// Shows every strike (not just trade candidates) with live LTP/OI, a
// confidence score, OI buildup classification, and an estimated margin —
// mirroring a broker's option-chain screen, with our own confidence model
// layered on top. Loads BOTH the current month's nearest expiry ("in month")
// and the following month's nearest expiry ("out of month") side by side.

import { fetchQ, fetchOptions, fetchOptionContracts, fetchIntraday } from './api';
import { calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChainAnalysis } from './technical';

export function getOptionKey(opt) {
  return opt?.instrKey || '';
}

// Splits a sorted, deduped expiry list into "in month" (nearest expiry that
// falls within the current calendar month, or the nearest available if none
// remain this month) and "out of month" (nearest expiry strictly after the
// in-month one's calendar month).
export function splitExpiries(allExpiries) {
  const unique = [...new Set(allExpiries)].sort();
  if (!unique.length) return { inMonth: null, outOfMonth: null, all: [] };
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const todayStr = now.toISOString().slice(0, 10);
  const thisMonth = unique.filter(e => {
    const d = new Date(e);
    return d.getFullYear() === y && d.getMonth() === m && e >= todayStr;
  });
  const inMonth = thisMonth[0] || unique.find(e => e >= todayStr) || unique[0];
  const inDate = new Date(inMonth);
  const outOfMonth = unique.find(e => {
    const d = new Date(e);
    return (d.getFullYear() > inDate.getFullYear()) ||
           (d.getFullYear() === inDate.getFullYear() && d.getMonth() > inDate.getMonth());
  }) || null;
  return { inMonth, outOfMonth, all: unique };
}

// Picks the `count` strikes closest to ATM from an ATM-range-filtered,
// strike-ascending row array, while preserving ascending order for display.
export function selectStrikesAroundATM(rows, atm, count) {
  if (!rows?.length) return rows;
  if (rows.length <= count) return rows;
  const withDist = rows.map((r, i) => ({ r, i, d: Math.abs(r.strike - atm) }));
  withDist.sort((a, b) => a.d - b.d || a.i - b.i);
  const picked = new Set(withDist.slice(0, count).map(x => x.i));
  return rows.filter((_, i) => picked.has(i));
}

// Merges live WS prices (LTP/OI) into the static per-strike rows, recomputing
// margin (lot × LTP) on every tick so it tracks the live premium. Confidence/
// buildup are NOT recomputed on every tick — same pattern OptionsPane uses
// (a fresh scan recomputes scoring; only price-derived fields update live).
export function mergeLiveIntoRows(rows, lastPrices, lot = 1) {
  if (!rows?.length || !lastPrices || Object.keys(lastPrices).length === 0) return rows;
  return rows.map((row) => {
    const next = { ...row };
    for (const side of ['CE', 'PE']) {
      const cell = row[side];
      if (!cell?.instrKey) continue;
      const live = lastPrices[cell.instrKey];
      if (!live) continue;
      const liveLtp = live.ltp ?? cell.ltp;
      next[side] = {
        ...cell,
        ltp: liveLtp,
        oi: live.oi ?? cell.oi,
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

// ctx: { token, indexKey, step, lot, cfg, onTokenExpired, lg }
// callbacks: { setProgress }
// Returns both chains: { spot, spotChg, vixVal, expiries, inMonth: {...}, outOfMonth: {...}|null }
export async function loadOptionChainAnalysis(ctx, callbacks) {
  const { token, indexKey, step, lot, cfg, onTokenExpired, lg } = ctx;
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
  const { inMonth, outOfMonth, all } = splitExpiries(rawExpiries);
  if (!inMonth) throw new Error('No expiries available');

  setProgress('Fetching intraday context...');
  let marketCtx = null;
  try {
    const candles = await fetchIntraday(indexKey, '5minute', token, onTokenExpired);
    marketCtx = computeCtxFromCandles(candles, spot, spotChg, vixVal, null);
  } catch (e) { lg('Option analysis ctx: ' + e.message, 'w'); }

  setProgress(`Fetching in-month chain (${inMonth})...`);
  const inMonthChain = await loadOneChain(indexKey, inMonth, spot, step, lot, niftyBullish, vixVal, marketCtx, cfg, token, onTokenExpired);
  if (!inMonthChain) throw new Error('Empty option chain for ' + inMonth);

  let outOfMonthChain = null;
  if (outOfMonth) {
    setProgress(`Fetching out-of-month chain (${outOfMonth})...`);
    try { outOfMonthChain = await loadOneChain(indexKey, outOfMonth, spot, step, lot, niftyBullish, vixVal, marketCtx, cfg, token, onTokenExpired); }
    catch (e) { lg('Out-of-month chain: ' + e.message, 'w'); }
  }

  return { spot, spotChg, vixVal, expiries: all, inMonth: inMonthChain, outOfMonth: outOfMonthChain, marketCtx };
}

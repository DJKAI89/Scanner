// ── Option Analysis service — full chain view with per-strike confidence ──
// Extracted/built service for the new "Option Analysis" page: shows every
// strike (not just trade candidates) with live LTP/OI, a confidence score,
// OI buildup classification, and an estimated margin — mirroring a broker's
// option-chain screen, with our own confidence model layered on top.

import { fetchQ, fetchOptions, fetchOptionContracts, fetchIntraday } from './api';
import { calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChainAnalysis } from './technical';

export function getOptionKey(opt) {
  return opt?.instrKey || '';
}

// Merges live WS prices (LTP/OI) into the static per-strike rows. Confidence/
// buildup/margin are NOT recomputed on every tick — same pattern OptionsPane
// uses (withLiveOI only swaps ltp/oi; a fresh scan recomputes scoring).
export function mergeLiveIntoRows(rows, lastPrices) {
  if (!rows?.length || !lastPrices || Object.keys(lastPrices).length === 0) return rows;
  return rows.map((row) => {
    const next = { ...row };
    for (const side of ['CE', 'PE']) {
      const cell = row[side];
      if (!cell?.instrKey) continue;
      const live = lastPrices[cell.instrKey];
      if (!live) continue;
      next[side] = {
        ...cell,
        ltp: live.ltp ?? cell.ltp,
        oi: live.oi ?? cell.oi,
        isLive: true,
      };
    }
    return next;
  });
}


// ctx: { token, indexKey, step, lot, expiry (optional — defaults to nearest), cfg, onTokenExpired, lg }
// callbacks: { setProgress }
export async function loadOptionChainAnalysis(ctx, callbacks) {
  const { token, indexKey, step, lot, expiry: requestedExpiry, cfg, onTokenExpired, lg } = ctx;
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
  const expiries = [...new Set(contracts.map(c => c.expiry).filter(Boolean))].sort();
  if (!expiries.length) throw new Error('No expiries available');
  const expiry = requestedExpiry && expiries.includes(requestedExpiry) ? requestedExpiry : expiries[0];

  setProgress('Fetching intraday context...');
  let marketCtx = null;
  try {
    const candles = await fetchIntraday(indexKey, '5minute', token, onTokenExpired);
    marketCtx = computeCtxFromCandles(candles, spot, spotChg, vixVal, null);
  } catch (e) { lg('Option analysis ctx: ' + e.message, 'w'); }

  setProgress('Fetching option chain...');
  const chain = await fetchOptions(indexKey, expiry, token, onTokenExpired);
  if (!chain.length) throw new Error('Empty option chain for ' + expiry);

  const maxPain = calcMaxPain(chain);
  const oiWalls = calcOIWalls(chain);
  const ceOI = chain.reduce((s, x) => s + (x.call_options?.market_data?.oi || 0), 0);
  const peOI = chain.reduce((s, x) => s + (x.put_options?.market_data?.oi  || 0), 0);
  const pcr  = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1;
  const atm  = Math.round(spot / step) * step;

  setProgress('Scoring strikes...');
  const rows = scanChainAnalysis(chain, atm, spot, niftyBullish, vixVal, maxPain, pcr, marketCtx, cfg, lot);

  return { rows, spot, spotChg, vixVal, maxPain, oiWalls, pcr, atm, expiry, expiries, marketCtx };
}

// ── Heatmap service — batched base-price load + live enrichment ──
// Extracted from HeatmapPane.jsx so the pane only handles UI/state wiring.
// All calculation and API-call logic for the Heatmap tab lives here.

import { fetchQ } from './api';
import { getIST } from '../utils/marketTime';

// Loads REST base prices (ltp + previous close) for all instrument keys, batched 50/call.
// ctx: { accessToken, allKeys, onTokenExpired, lg, updateBadge }
export async function loadBasePrices(ctx) {
  const { accessToken, allKeys, onTokenExpired, lg, updateBadge } = ctx;
  if (!accessToken || !allKeys.length) return { results: {}, updTime: '' };

  lg(`Heatmap: loading ${allKeys.length} quotes…`, 'o');
  const BATCH = 50;
  const results = {};
  const batches = [];
  for (let i = 0; i < allKeys.length; i += BATCH)
    batches.push(allKeys.slice(i, i + BATCH));

  await Promise.allSettled(
    batches.map(batch =>
      fetchQ(batch.join(','), accessToken, onTokenExpired).then(raw => {
        for (const [k, q] of Object.entries(raw)) {
          const ltp = q.last_price || 0;
          const cp  = q.ohlc?.close || 0;
          if (ltp > 0) results[k] = { ltp, cp };
        }
      })
    )
  );

  const count = Object.keys(results).length;
  updateBadge('heatmap', String(count));
  lg(`Heatmap: ${count} base quotes loaded`, 'o');
  return { results, updTime: 'Updated: ' + getIST(), count };
}

// Merges REST base prices with live WS prices and computes change %/points per stock.
export function enrichHeatmapRows(stocks, basePrices, lastPrices) {
  return stocks.map(stock => {
    const key    = stock.key;
    const base   = basePrices[key];
    const live   = lastPrices[key];
    const ltp    = live?.ltp || base?.ltp || 0;
    const cp     = live?.cp  || base?.cp  || 0;
    const chgPct = (ltp > 0 && cp > 0) ? +((ltp - cp) / cp * 100).toFixed(2) : 0;
    const chgPt  = (ltp > 0 && cp > 0) ? +(ltp - cp).toFixed(2) : 0;
    return { ...stock, ltp, cp, chgPct, chgPt, isLive: !!live?.ltp };
  });
}

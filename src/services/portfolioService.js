// ── Portfolio service — positions/holdings enrichment + aggregation ──
// Extracted from PortfolioPane.jsx so the pane only handles UI/state wiring.
// All calculation and API-call logic for the Portfolio tab lives here.

import { fetchPortfolio } from './api';

export function getInstrumentKey(item) {
  return item.instrument_key || item.instrumentKey || item.instrument_token || item.instrumentToken || item.token || '';
}

// Returns the first finite candidate, treating a genuine 0 as a valid value —
// only skips values that are missing/NaN, not legitimate zeroes (e.g. breakeven P&L).
export function num(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export async function loadPortfolio(accessToken, onTokenExpired) {
  return fetchPortfolio(accessToken, onTokenExpired);
}

// Merges live WS prices into a raw positions/holdings array and computes
// per-row P&L, day P&L, and current value.
export function enrichPortfolioRows(arr, lastPrices) {
  return arr.map((item) => {
    const key       = getInstrumentKey(item);
    const live      = lastPrices[key];
    const ltp       = num(live?.ltp, item.last_price, item.ltp, item.close_price);
    const qty       = num(item.quantity, item.used_quantity, item.available_quantity, item.t1_quantity, item.qty);
    const avg       = num(item.average_price, item.average_cost, item.avg_price, item.buy_price);
    const prevClose = num(live?.cp, item.close_price, item.previous_close, item.prev_close, item.ohlc?.close);
    const pnl       = avg > 0 ? (ltp - avg) * qty : num(item.pnl, item.profit_and_loss);
    const pnlPct    = avg > 0 ? ((ltp - avg) / avg) * 100 : 0;
    const todayPnl  = prevClose > 0 ? (ltp - prevClose) * qty : num(item.day_pnl, item.dayPnl);
    const todayPct  = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
    const value     = ltp * qty;
    return { ...item, key, ltp, qty, avg, prevClose, pnl, pnlPct, todayPnl, todayPct, value, isLive: !!live };
  });
}

// Groups enriched rows by sector/exchange for the exposure chart.
export function computeSectorMap(enrichedRows) {
  const map = {};
  enrichedRows.forEach(item => {
    const sec = item.sector || item.exchange || 'Other';
    if (!map[sec]) map[sec] = { value: 0, pnl: 0, count: 0 };
    map[sec].value += item.value || 0;
    map[sec].pnl   += item.pnl   || 0;
    map[sec].count++;
  });
  return Object.entries(map).sort((a, b) => b[1].value - a[1].value);
}

// Flags sectors that exceed 40% of total portfolio value.
export function computeConcentrationWarnings(sectorMap, totalValue) {
  if (!totalValue) return [];
  return sectorMap
    .filter(([, v]) => v.value / totalValue > 0.4)
    .map(([sec, v]) => `⚠ ${sec} is ${((v.value / totalValue) * 100).toFixed(0)}% of portfolio`);
}

export function sortRows(rows, sortCol, sortDir) {
  const arr = [...rows];
  const dir = sortDir === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    switch (sortCol) {
      case 'sym':    return dir * ((a.tradingsymbol||a.symbol||'').localeCompare(b.tradingsymbol||b.symbol||''));
      case 'qty':    return dir * (a.qty - b.qty);
      case 'avg':    return dir * (a.avg - b.avg);
      case 'ltp':    return dir * (a.ltp - b.ltp);
      case 'value':  return dir * (a.value - b.value);
      case 'dayPnl': return dir * (a.todayPnl - b.todayPnl);
      case 'dayPct': return dir * (a.todayPct  - b.todayPct);
      case 'pnl':    return dir * (a.pnl - b.pnl);
      case 'pnlPct': return dir * (a.pnlPct - b.pnlPct);
      default: return 0;
    }
  });
  return arr;
}

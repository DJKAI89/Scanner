import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchQ } from '../services/api';

// Index instrument keys
const INDEX_KEYS = [
  'NSE_INDEX|Nifty 50',
  'NSE_INDEX|Nifty Bank',
  'NSE_INDEX|India VIX',
  'BSE_INDEX|SENSEX',
];

function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0;
  if (q.net_change != null && ltp > 0) return (q.net_change / ltp) * 100;
  const prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

// ── useIndexFeed — continuously refreshes index prices ────────
// Uses WebSocket via useMarketFeed if available, otherwise REST polling
// tickSecs: refresh interval in seconds (default from cfg.tick = 15)
export function useIndexFeed(token, onTokenExpired, tickSecs = 15, enabled = true) {
  const [prices, setPrices]   = useState({});
  const [loading, setLoading] = useState(false);
  const timerRef              = useRef(null);

  const refresh = useCallback(async () => {
    if (!token || !enabled) return;
    try {
      const d = await fetchQ(INDEX_KEYS.join(','), token, onTokenExpired);
      const next = {};
      for (const [key, q] of Object.entries(d)) {
        if (!q?.last_price) continue;
        const chgPct = getChgPct(q);
        next[key] = {
          ltp:    q.last_price,
          chgPct,
          pts:    q.net_change ?? (chgPct / 100 * q.last_price),
          volume: q.volume || 0,
        };
      }
      setPrices(next);
    } catch (e) { /* silent — show stale data */ }
  }, [token, onTokenExpired, enabled]);

  useEffect(() => {
    if (!enabled || !token) return;
    setLoading(true);
    refresh().finally(() => setLoading(false));

    // Set up polling interval
    timerRef.current = setInterval(refresh, tickSecs * 1000);
    return () => clearInterval(timerRef.current);
  }, [token, enabled, tickSecs, refresh]);

  const nifty     = prices['NSE_INDEX|Nifty 50']   || null;
  const banknifty = prices['NSE_INDEX|Nifty Bank']  || null;
  const vix       = prices['NSE_INDEX|India VIX']   || null;
  const sensex    = prices['BSE_INDEX|SENSEX']       || null;

  return { prices, nifty, banknifty, vix, sensex, loading, refresh };
}

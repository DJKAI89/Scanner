import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchQ } from '../services/api';

// Index keys — Upstox REST API (NSE_INDEX not reliably supported on WS)
const INDEX_KEYS = [
  'NSE_INDEX|Nifty 50',
  'NSE_INDEX|Nifty Bank',
  'NSE_INDEX|India VIX',
  'BSE_INDEX|SENSEX',
  'NSE_INDEX|Nifty Fin Service',
];

function parseQ(q) {
  if (!q?.last_price) return null;
  const ltp  = q.last_price;
  const prev = q.ohlc?.close || ltp;
  return {
    ltp,
    chgPct:  prev > 0 ? +((ltp - prev) / prev * 100).toFixed(2) : 0,
    pts:     prev > 0 ? +(ltp - prev).toFixed(2) : 0,
    volume:  q.volume || 0,
  };
}

// Poll every 5 seconds — matches HTML behaviour
const INTERVAL_MS = 5000;

export function useIndexFeed(token, onTokenExpired, _tickSecs, enabled = true) {
  const [prices, setPrices]   = useState({});
  const [loading, setLoading] = useState(false);
  const timerRef              = useRef(null);
  const tokenRef              = useRef(token);
  tokenRef.current = token;

  const refresh = useCallback(async () => {
    if (!tokenRef.current || !enabled) return;
    try {
      const d = await fetchQ(INDEX_KEYS.join(','), tokenRef.current, onTokenExpired);
      setPrices(prev => {
        const next = { ...prev };
        for (const [key, q] of Object.entries(d)) {
          const p = parseQ(q);
          if (p) next[key] = p;
        }
        return next;
      });
    } catch (e) { /* silent — keep stale prices */ }
  }, [enabled, onTokenExpired]);

  useEffect(() => {
    if (!enabled || !token) return;
    setLoading(true);
    refresh().finally(() => setLoading(false));
    timerRef.current = setInterval(refresh, INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [token, enabled, refresh]);

  const nifty     = prices['NSE_INDEX|Nifty 50']          || null;
  const banknifty = prices['NSE_INDEX|Nifty Bank']         || null;
  const vix       = prices['NSE_INDEX|India VIX']          || null;
  const sensex    = prices['BSE_INDEX|SENSEX']             || null;
  const finnifty  = prices['NSE_INDEX|Nifty Fin Service']  || null;

  return { prices, nifty, banknifty, vix, sensex, finnifty, loading };
}

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
  const ltp = q.last_price;
  // net_change is what the rest of this codebase already relies on for
  // index/stock % change (see getChgPct in stockScan.js) — ohlc.close isn't
  // reliably present on index quotes, which is why chgPct was stuck at 0.
  const prev = q.net_change != null ? ltp - q.net_change : (q.ohlc?.close || ltp);
  return {
    ltp,
    chgPct: prev > 0 ? +((ltp - prev) / prev * 100).toFixed(2) : 0,
    pts:    q.net_change != null ? +q.net_change.toFixed(2) : (prev > 0 ? +(ltp - prev).toFixed(2) : 0),
    volume: q.volume || 0,
  };
}

// Poll every 5 seconds — matches HTML behaviour
const INTERVAL_MS = 5000;

export function useIndexFeed(token, onTokenExpired, enabled = true, scanning = false) {
  const [prices, setPrices]   = useState({});
  const [loading, setLoading] = useState(false);
  const timerRef              = useRef(null);
  const tokenRef              = useRef(token);
  const scanningRef           = useRef(scanning);
  tokenRef.current = token;
  scanningRef.current = scanning;

  const refresh = useCallback(async () => {
    // A running scan fires hundreds of quote requests through the SAME
    // shared throttle (api.js THROTTLE_MS — one global 420ms-min-gap queue
    // for every API call in the app). Adding this ticker's own call to that
    // queue during a scan just delays both the scan and the ticker update
    // unpredictably. Skipping our own tick here means we don't contribute
    // to that contention — normal 5s updates resume immediately once the
    // scan ends, instead of queuing up behind it.
    if (!tokenRef.current || !enabled || scanningRef.current) return;
    try {
      const d = await fetchQ(INDEX_KEYS.join(','), tokenRef.current, onTokenExpired);
      setPrices(prev => {
        const next = { ...prev };
        for (const [key, q] of Object.entries(d)) {
          const parsed = parseQ(q);
          if (parsed) next[key] = parsed;
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

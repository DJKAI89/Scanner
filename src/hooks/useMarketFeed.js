import { useEffect, useRef, useCallback, useState } from 'react';

// ── Upstox WebSocket Market Feed ──────────────────────────────
// Step 1: GET /v3/feed/market-data-streamer/authorize → { authorized_redirect_uri }
// Step 2: new WebSocket(authorized_redirect_uri)  ← no auth headers needed
// Step 3: send subscribe message

const AUTHORIZE_URL = 'https://api.upstox.com/v3/feed/market-data-streamer/authorize';

export function useMarketFeed(token, instrumentKeys = [], enabled = true) {
  const ws         = useRef(null);
  const retryRef   = useRef(0);
  const retryTimer = useRef(null);
  const keysRef    = useRef([]);

  const [connected, setConnected]   = useState(false);
  const [lastPrices, setLastPrices] = useState({});

  const disconnect = useCallback(() => {
    clearTimeout(retryTimer.current);
    if (ws.current) {
      ws.current.onclose = null;
      try { ws.current.close(); } catch (e) {}
      ws.current = null;
    }
    setConnected(false);
  }, []);

  const subscribe = useCallback((keys) => {
    if (!keys?.length || ws.current?.readyState !== WebSocket.OPEN) return;
    ws.current.send(JSON.stringify({
      guid:   crypto.randomUUID(),
      method: 'sub',
      data:   { mode: 'ltpc', instrumentKeys: keys },
    }));
  }, []);

  const connect = useCallback(async () => {
    if (!token || !keysRef.current.length || !enabled) return;
    if (ws.current?.readyState === WebSocket.OPEN || ws.current?.readyState === WebSocket.CONNECTING) return;

    try {
      // Step 1: Get authorized WebSocket URL from Upstox
      const authRes = await fetch(AUTHORIZE_URL, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      if (!authRes.ok) {
        console.warn('WS authorize failed: HTTP', authRes.status);
        scheduleRetry();
        return;
      }
      const authData  = await authRes.json();
      const wsUrl     = authData?.data?.authorized_redirect_uri || authData?.authorized_redirect_uri;
      if (!wsUrl) { console.warn('No authorized_redirect_uri in response'); scheduleRetry(); return; }

      // Step 2: Connect to signed WebSocket URL (no headers needed)
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        retryRef.current = 0;
        setConnected(true);
        // Step 3: Subscribe to instrument keys
        socket.send(JSON.stringify({
          guid:   crypto.randomUUID(),
          method: 'sub',
          data:   { mode: 'ltpc', instrumentKeys: keysRef.current },
        }));
      };

      socket.onmessage = (evt) => {
        try {
          let data;
          if (typeof evt.data === 'string') {
            data = JSON.parse(evt.data);
          } else {
            // Binary frame — decode as UTF-8 JSON
            data = JSON.parse(new TextDecoder('utf-8').decode(evt.data));
          }

          // ltpc mode: { feeds: { "NSE_EQ|ISIN": { ltpc: { ltp, cp, chg, chgp } } } }
          const feeds = data?.feeds || {};
          if (!Object.keys(feeds).length) return;

          setLastPrices((prev) => {
            const next = { ...prev };
            for (const [key, val] of Object.entries(feeds)) {
              const ltpc = val?.ltpc
                || val?.ff?.marketFF?.ltpc
                || val?.ff?.indexFF?.ltpc;
              if (!ltpc) continue;
              const ltp    = ltpc.ltp  ?? ltpc.last_price ?? 0;
              const cp     = ltpc.cp   ?? ltpc.close_price ?? ltp;
              const chgPct = cp > 0 ? +((ltp - cp) / cp * 100).toFixed(2) : 0;
              next[key] = { ltp, chgPct, vol: ltpc.vol || 0 };
            }
            return next;
          });
        } catch (e) { /* ignore malformed frames */ }
      };

      socket.onerror = () => setConnected(false);

      socket.onclose = (e) => {
        setConnected(false);
        ws.current = null;
        if (e.code !== 1000) scheduleRetry(); // 1000 = normal close
      };

      ws.current = socket;
    } catch (e) {
      console.warn('WS connect error:', e.message);
      scheduleRetry();
    }
  }, [token, enabled]); // eslint-disable-line

  function scheduleRetry() {
    const delay = Math.min(30000, 2000 * Math.pow(2, retryRef.current));
    retryRef.current++;
    retryTimer.current = setTimeout(connect, delay);
  }

  // ── Connect / disconnect when enabled or keys change ──
  useEffect(() => {
    keysRef.current = instrumentKeys;
    if (!enabled || !token || !instrumentKeys.length) { disconnect(); return; }
    if (ws.current?.readyState === WebSocket.OPEN) {
      // Already connected — just subscribe to new keys
      subscribe(instrumentKeys);
    } else {
      connect();
    }
    return disconnect;
  }, [token, enabled, instrumentKeys.join(',')]); // eslint-disable-line

  return { connected, lastPrices, subscribe, disconnect };
}

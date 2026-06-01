import { useEffect, useRef, useCallback, useState } from 'react';
import { fetchQ, resolveAccessToken } from '../services/api';
import { sleep } from '../utils/marketTime';

// ── Minimal Protobuf binary reader for Upstox v3 ltpc feed ───
// Upstox v3 sends binary protobuf FeedResponse:
//   FeedResponse { Type type = 1; map<string, Feed> feeds = 2 }
//   Feed         { LTPC ltpc = 1 }
//   LTPC         { double ltp=1, int64 ltt=2, double ltq=3, double cp=4 }
// Wire types: 0=varint, 1=64-bit(double), 2=length-delimited

function _readVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7F) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { v: result, p: pos };
}
function _readDouble(buf, pos) {
  const view = new DataView(buf.buffer, buf.byteOffset + pos, 8);
  return { v: view.getFloat64(0, true), p: pos + 8 };
}
function _readBytes(buf, pos) {
  const { v: len, p } = _readVarint(buf, pos);
  return { v: buf.slice(p, p + len), p: p + len };
}
function _readStr(buf, pos) {
  const { v, p } = _readBytes(buf, pos);
  return { v: new TextDecoder().decode(v), p };
}
function _skip(buf, pos, wireType) {
  if (wireType === 0) return _readVarint(buf, pos).p;
  if (wireType === 1) return pos + 8;
  if (wireType === 2) return _readBytes(buf, pos).p;
  if (wireType === 5) return pos + 4;
  return buf.length; // unknown — stop
}

function _decodeLTPC(buf) {
  let ltp = 0, cp = 0, pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if (wt === 1) { // double
      const { v: dbl, p: p2 } = _readDouble(buf, pos); pos = p2;
      if (fn === 1) ltp = dbl;
      if (fn === 4) cp  = dbl;
    } else { pos = _skip(buf, pos, wt); }
  }
  return { ltp, cp };
}

function _decodeFeed(buf) {
  let ltpc = null, pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if (fn === 1 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; ltpc = _decodeLTPC(v); }
    else if (fn === 2 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; ltpc = _decodeFullFeed(v); }
    else if (fn === 3 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; ltpc = _decodeFirstLevelWithGreeks(v); }
    else { pos = _skip(buf, pos, wt); }
  }
  return ltpc;
}

function _decodeFullFeed(buf) {
  let result = null, pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if      (fn === 1 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; result = _decodeMarketFullFeed(v) || result; }
    else if (fn === 2 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; result = _decodeIndexFullFeed(v)  || result; }
    else { pos = _skip(buf, pos, wt); }
  }
  return result;
}

// ── OHLC entry: interval(1,str) open(2,dbl) high(3,dbl) low(4,dbl) close(5,dbl) vol(6,varint) ts(7,varint)
function _decodeOHLCEntry(buf) {
  let interval = '', open = 0, high = 0, low = 0, close = 0, vol = 0;
  let pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if      (fn === 1 && wt === 2) { const { v, p: p2 } = _readStr(buf, pos);    pos = p2; interval = v; }
    else if (fn === 2 && wt === 1) { const { v, p: p2 } = _readDouble(buf, pos); pos = p2; open  = v; }
    else if (fn === 3 && wt === 1) { const { v, p: p2 } = _readDouble(buf, pos); pos = p2; high  = v; }
    else if (fn === 4 && wt === 1) { const { v, p: p2 } = _readDouble(buf, pos); pos = p2; low   = v; }
    else if (fn === 5 && wt === 1) { const { v, p: p2 } = _readDouble(buf, pos); pos = p2; close = v; }
    else if (fn === 6 && wt === 0) { const { v, p: p2 } = _readVarint(buf, pos); pos = p2; vol   = v; }
    else { pos = _skip(buf, pos, wt); }
  }
  return { interval, open, high, low, close, vol };
}

// MarketOHLC: repeated OHLC ohlc = 1
function _decodeMarketOHLC(buf) {
  const ohlc = [];
  let pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if (fn === 1 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; ohlc.push(_decodeOHLCEntry(v)); }
    else { pos = _skip(buf, pos, wt); }
  }
  return ohlc; // array of { interval, open, high, low, close, vol }
}

// IndexFullFeed: ltpc(1) marketOHLC(2)
function _decodeIndexFullFeed(buf) {
  let ltpc = null, ohlcMap = {};
  let pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if      (fn === 1 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; ltpc = _decodeLTPC(v); }
    else if (fn === 2 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; _decodeMarketOHLC(v).forEach(o => { ohlcMap[o.interval] = o; }); }
    else { pos = _skip(buf, pos, wt); }
  }
  return ltpc ? { ...ltpc, ohlcMap } : null;
}

function _decodeMarketFullFeed(buf) {
  let out = {}, pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if      (fn === 1 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; Object.assign(out, _decodeLTPC(v)); }
    else if (fn === 4 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; const arr = _decodeMarketOHLC(v); arr.forEach(o => { out.ohlcMap = out.ohlcMap||{}; out.ohlcMap[o.interval] = o; }); }
    else if (fn === 5 && wt === 1) { const { v, p: p2 } = _readDouble(buf, pos); pos = p2; out.atp = v; }
    else if (fn === 6 && wt === 0) { const { v, p: p2 } = _readVarint(buf, pos); pos = p2; out.vtt = v; }
    else if (fn === 7 && wt === 1) { const { v, p: p2 } = _readDouble(buf, pos); pos = p2; out.oi  = v; }
    else { pos = _skip(buf, pos, wt); }
  }
  return Object.keys(out).length ? out : null;
}

function _decodeNestedLTPC(buf) {
  let ltpc = null, pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if (fn === 1 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; ltpc = _decodeLTPC(v); }
    else { pos = _skip(buf, pos, wt); }
  }
  return ltpc;
}

function _decodeFirstLevelWithGreeks(buf) {
  return _decodeNestedLTPC(buf);
}

function _decodeMapEntry(buf) {
  let key = '', value = null, pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if (fn === 1 && wt === 2) { const { v, p: p2 } = _readStr(buf, pos); pos = p2; key = v; }
    else if (fn === 2 && wt === 2) { const { v, p: p2 } = _readBytes(buf, pos); pos = p2; value = _decodeFeed(v); }
    else { pos = _skip(buf, pos, wt); }
  }
  return { key, value };
}

function decodeFeedResponse(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const feeds = {}, pos_ref = { p: 0 };
  let pos = 0;
  while (pos < buf.length) {
    const { v: tag, p } = _readVarint(buf, pos); pos = p;
    const fn = tag >> 3, wt = tag & 7;
    if (fn === 2 && wt === 2) {
      const { v: entryBuf, p: p2 } = _readBytes(buf, pos); pos = p2;
      const { key, value } = _decodeMapEntry(entryBuf);
      if (key && value) feeds[key] = value;
    } else { pos = _skip(buf, pos, wt); }
  }
  return feeds;
}

// ── REST polling fallback (15-sec intervals) ──────────────────
const AUTHORIZE_URLS = [
  'https://api.upstox.com/v3/feed/market-data-feed/authorize',
  'https://api.upstox.com/v3/feed/market-data-streamer/authorize',
];

function sendFeedRequest(socket, data) {
  socket.send(new TextEncoder().encode(JSON.stringify(data)));
}

// ── fetchScanQuotesViaWS — one-shot WebSocket quote fetch for scan ─
// Replaces batched fetchQ REST calls. Connects in 'full' mode,
// collects snapshot for all instrument keys, disconnects.
// Returns map: { [key]: { ltp, cp, vtt, atp, ohlcMap, high, low, open } }
export async function fetchScanQuotesViaWS(token, instrumentKeys, timeoutMs = 8000) {
  if (!token || !instrumentKeys?.length) return {};

  // Get authorized WS URL (one REST call total)
  let wsUrl = null;
  for (const url of AUTHORIZE_URLS) {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      if (r.ok) {
        const d = await r.json();
        wsUrl = d?.data?.authorized_redirect_uri || d?.data?.uri || d?.authorized_redirect_uri;
        if (wsUrl) break;
      }
    } catch (_) {}
  }
  if (!wsUrl) throw new Error('WS auth failed — cannot get scan quotes');

  return new Promise((resolve) => {
    const quotes = {};
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      try { ws.onclose = null; ws.close(1000); } catch (_) {}
      resolve(quotes);
    };

    const hardTimeout = setTimeout(finish, timeoutMs);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Subscribe all keys in full mode — one message covers all 500 stocks
      ws.send(new TextEncoder().encode(JSON.stringify({
        guid:   crypto.randomUUID(),
        method: 'sub',
        data:   { mode: 'full', instrumentKeys },
      })));
    };

    ws.onmessage = (evt) => {
      if (!(evt.data instanceof ArrayBuffer)) return;
      try {
        const feeds = decodeFeedResponse(evt.data);
        for (const [key, data] of Object.entries(feeds)) {
          if (!data) continue;
          const day = data.ohlcMap?.['1d'] || {};
          quotes[key] = {
            last_price:        data.ltp  || 0,
            volume:            data.vtt  || 0,
            atp:               data.atp  || 0,
            ohlc: {
              open:  day.open  || 0,
              high:  day.high  || 0,
              low:   day.low   || 0,
              close: data.cp   || day.close || 0,
            },
            // delivery_volume not available in WS feed
          };
        }
        // Finish early once we have 90 %+ of expected instruments
        if (Object.keys(quotes).length >= instrumentKeys.length * 0.9) finish();
      } catch (_) {}
    };

    ws.onerror = () => finish();
    ws.onclose = () => { if (!settled) finish(); };
  });
}

export function useMarketFeed(token, instrumentKeys = [], enabled = true, options = {}) {
  const mode = options.mode || 'ltpc';
  const pollFallback = options.pollFallback !== false;
  const ws          = useRef(null);
  const connectSeq  = useRef(0);
  const retryRef    = useRef(0);
  const retryTimer  = useRef(null);
  const pollTimer   = useRef(null);
  const keysRef     = useRef([]);
  const tokenRef    = useRef(token);

  const [connected,   setConnected]   = useState(false);
  const [lastPrices,  setLastPrices]  = useState({});
  const [wsMode,      setWsMode]      = useState('connecting'); // 'ws'|'poll'|'connecting'

  tokenRef.current = resolveAccessToken(token);

  // ── Price update helper ──
  const applyPrices = useCallback((map) => {
    setLastPrices(prev => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(map)) {
        if (v && v.ltp > 0) {
          const cp = v.cp || v.ltp;
          const day = v.ohlcMap?.['1d'] || {};
          next[k] = {
            ltp:       v.ltp,
            cp,
            oi:        v.oi,
            atp:       v.atp  || 0,
            vtt:       v.vtt  || 0,
            high:      day.high  || 0,
            low:       day.low   || 0,
            open:      day.open  || 0,
            ohlcMap:   v.ohlcMap || {},
            chgPct:    cp > 0 ? +((v.ltp - cp) / cp * 100).toFixed(2) : 0,
            changeAmt: (v.ltp - cp).toFixed(2),
          };
        }
      }
      return next;
    });
  }, []);

  // ── REST polling fallback ──────────────────────────────────
  const startPolling = useCallback(() => {
    if (!pollFallback) return;
    clearInterval(pollTimer.current);
    setWsMode('poll');
    setConnected(true);
    pollTimer.current = setInterval(async () => {
      const keys = keysRef.current;
      if (!keys.length || !tokenRef.current) return;
      try {
        const batches = [];
        for (let i = 0; i < keys.length; i += 50) batches.push(keys.slice(i, i + 50));
        for (const batch of batches) {
          const map = await fetchQ(batch.join(','), tokenRef.current, () => {});
          const priceMap = {};
          for (const [k, q] of Object.entries(map)) {
            const ltp = q.last_price || 0;
            const cp  = q.ohlc?.close || ltp;
            priceMap[k] = { ltp, cp };
          }
          applyPrices(priceMap);
        }
      } catch (e) { /* silent */ }
    }, 15000);
  }, [applyPrices, pollFallback]);

  const stopPolling = useCallback(() => {
    clearInterval(pollTimer.current);
  }, []);

  // ── WebSocket connect ────────────────────────────────────────
  const connect = useCallback(async () => {
    const accessToken = resolveAccessToken(token);
    if (!accessToken || !keysRef.current.length || !enabled) return;
    if (ws.current?.readyState === WebSocket.OPEN || ws.current?.readyState === WebSocket.CONNECTING) return;

    const seq = ++connectSeq.current;

    try {
      let authData = null;
      let authError = '';
      for (const url of AUTHORIZE_URLS) {
        const authRes = await fetch(url, {
          headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
        });
        if (authRes.ok) {
          authData = await authRes.json();
          break;
        }
        let detail = '';
        try { detail = await authRes.text(); } catch (e) { /* ignore */ }
        authError = 'Auth failed: ' + authRes.status + (detail ? ' ' + detail.slice(0, 120) : '');
        if (!detail.includes('UDAPI100012')) break;
      }
      if (!authData) throw new Error(authError || 'Auth failed');

      const wsUrl = authData?.data?.authorized_redirect_uri
        || authData?.authorized_redirect_uri
        || authData?.data?.uri
        || authData?.uri;
      if (!wsUrl || seq !== connectSeq.current) return;

      const socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      ws.current = socket;

      socket.onopen = () => {
        if (seq !== connectSeq.current || ws.current !== socket) {
          try { socket.close(1000); } catch (_) {}
          return;
        }
        retryRef.current = 0;
        setConnected(true);
        setWsMode('ws');
        stopPolling();
        sendFeedRequest(socket, {
          guid: crypto.randomUUID(),
          method: 'sub',
          data: { mode, instrumentKeys: keysRef.current },
        });
      };

      socket.onmessage = (evt) => {
        if (seq !== connectSeq.current || ws.current !== socket) return;
        try {
          if (evt.data instanceof ArrayBuffer) {
            const feeds = decodeFeedResponse(evt.data);
            if (Object.keys(feeds).length > 0) applyPrices(feeds);
          } else if (typeof evt.data === 'string') {
            const d = JSON.parse(evt.data);
            if (d?.feeds) applyPrices(d.feeds);
          }
        } catch (e) { /* ignore malformed frames */ }
      };

      socket.onerror = () => {
        if (seq !== connectSeq.current || ws.current !== socket) return;
        setConnected(false);
        setWsMode('poll');
        startPolling();
      };

      socket.onclose = (e) => {
        if (seq !== connectSeq.current || ws.current !== socket) return;
        setConnected(false);
        ws.current = null;
        if (e.code === 1000) return;
        startPolling();
        const delay = Math.min(30000, 2000 * Math.pow(2, retryRef.current));
        retryRef.current++;
        retryTimer.current = setTimeout(connect, delay);
      };
    } catch (e) {
      if (seq !== connectSeq.current) return;
      console.warn('WS init failed:', e.message, '- falling back to REST polling');
      startPolling();
      retryTimer.current = setTimeout(connect, 30000);
    }
  }, [token, enabled, mode, applyPrices, startPolling, stopPolling]);
  const disconnect = useCallback(() => {
    connectSeq.current++;
    clearTimeout(retryTimer.current);
    stopPolling();
    if (ws.current) {
      ws.current.onclose = null;
      try { ws.current.close(1000); } catch (e) {}
      ws.current = null;
    }
    setConnected(false);
    setWsMode('connecting');
  }, [stopPolling]);

  const subscribe = useCallback((keys) => {
    if (!keys?.length) return;
    if (ws.current?.readyState === WebSocket.OPEN) {
      sendFeedRequest(ws.current, {
        guid:   crypto.randomUUID(),
        method: 'sub',
        data:   { mode, instrumentKeys: keys },
      });
    }
  }, [mode]);

  useEffect(() => {
    const accessToken = resolveAccessToken(token);
    keysRef.current = instrumentKeys;
    if (!enabled || !accessToken || !instrumentKeys.length) { disconnect(); return; }
    if (ws.current?.readyState === WebSocket.OPEN) {
      subscribe(instrumentKeys);
    } else {
      connect();
    }
    return disconnect;
  }, [token, enabled, instrumentKeys.join(',')]); // eslint-disable-line

  return { connected, lastPrices, wsMode, subscribe, disconnect };
}


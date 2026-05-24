import { THROTTLE_MS } from '../constants/config';
import { sleep } from '../utils/marketTime';
import { localIsOpen } from '../utils/marketTime';

// ── Per-proxy cooldown registry ──
const _proxyCooldown = { corsproxy: 0 };
const PROXY_COOLDOWN_MS = 45000;
let _lastCallTs = 0;

export function normalizeAccessToken(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';

  try {
    const parsed = JSON.parse(v);
    v = String(parsed.access_token || parsed.token || v).trim();
  } catch (e) { /* plain token */ }

  const tokenMatch = v.match(/access_token["'\s:=]+([A-Za-z0-9._~+/=-]+)/i);
  if (tokenMatch) v = tokenMatch[1];

  return v
    .replace(/^Authorization:\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function getStoredAccessToken() {
  try {
    return normalizeAccessToken(localStorage.getItem('friday_token') || '');
  } catch (e) {
    return '';
  }
}

export function resolveAccessToken(token) {
  return normalizeAccessToken(token) || getStoredAccessToken();
}

function _proxyAvailable(name) {
  return !_proxyCooldown[name] || Date.now() > _proxyCooldown[name];
}
function _proxySetCooldown(name, ms = PROXY_COOLDOWN_MS) {
  _proxyCooldown[name] = Date.now() + ms;
}

async function throttle() {
  const now = Date.now(), gap = now - _lastCallTs;
  if (gap < THROTTLE_MS) await sleep(THROTTLE_MS - gap);
  _lastCallTs = Date.now();
}

function _parseUpstoxResponse(txt) {
  let d = JSON.parse(txt);
  if (d && typeof d.contents === 'string') {
    try { d = JSON.parse(d.contents); } catch (e) { /* ignore */ }
  }
  return d;
}

export async function withRetry(fn, label = '', retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await throttle();
      return await fn();
    } catch (e) {
      if (e.message === 'TOKEN_EXPIRED') throw e;
      if (e.message?.startsWith('HTTP 4')) throw e;
      if (attempt === retries) throw e;
      const wait = attempt * 1500 + Math.random() * 500;
      await sleep(wait);
    }
  }
}

// ── Core API GET with proxy rotation ──
export async function apiGet(url, token, onTokenExpired) {
  const full = 'https://api.upstox.com' + url;
  const hdrs = { Authorization: 'Bearer ' + resolveAccessToken(token), Accept: 'application/json' };

  const buildProxies = () => {
    const list = [];
    list.push({ n: 'direct', f: () => fetch(full, { headers: hdrs }) });
    if (_proxyAvailable('corsproxy'))
      list.push({ n: 'corsproxy', f: () => fetch('https://corsproxy.io/?' + encodeURIComponent(full), { headers: hdrs }) });
    if (list.length === 1)
      list.push({ n: 'corsproxy', f: () => fetch('https://corsproxy.io/?' + encodeURIComponent(full), { headers: hdrs }), forced: true });
    return list;
  };

  for (const p of buildProxies()) {
    try {
      const res = await p.f();
      if (res.status === 401) {
        if (onTokenExpired) onTokenExpired();
        throw new Error('TOKEN_EXPIRED');
      }
      if (res.status === 429) {
        if (!p.forced) _proxySetCooldown(p.n);
        await sleep(800 + Math.random() * 400);
        continue;
      }
      if (res.status === 503 || res.status === 502) continue;
      if (res.status === 400) throw new Error('HTTP 400 (data not available yet)');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const txt = await res.text();
      return _parseUpstoxResponse(txt);
    } catch (e) {
      if (e.message === 'TOKEN_EXPIRED') throw e;
      if (e.message?.startsWith('HTTP 4')) throw e;
    }
  }
  throw new Error('API failed for: ' + url.slice(0, 60));
}

// ── Normalized quote fetch ──
export async function fetchQ(keys, token, onTokenExpired) {
  const cleaned = [...new Set(
    String(keys || '').split(',').map((k) => k.trim()).filter(Boolean)
  )].join(',');
  if (!cleaned) return {};
  const d = await withRetry(
    () => apiGet('/v2/market-quote/quotes?instrument_key=' + encodeURIComponent(cleaned), token, onTokenExpired),
    'fetchQ'
  );
  const raw = d?.data || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k.replace(/:/g, '|')] = v;
  return out;
}

// ── Historical candles ──
export async function fetchCandles(key, from, to, interval = 'day', token, onTokenExpired) {
  const d = await withRetry(
    () => apiGet(
      '/v2/historical-candle/' + encodeURIComponent(key) + '/' + interval + '/' + to + '/' + from,
      token, onTokenExpired
    ),
    'candle:' + interval
  );
  return d?.data?.candles || [];
}

// ── Intraday candles ──
export async function fetchIntraday(key, interval = '30minute', token, onTokenExpired) {
  if (!localIsOpen()) return [];
  const d = await withRetry(
    () => apiGet('/v2/historical-candle/intraday/' + encodeURIComponent(key) + '/' + interval, token, onTokenExpired),
    'intraday:' + interval
  );
  return d?.data?.candles || [];
}

// ── Options chain ──
export async function fetchOptions(instrKey, expiry, token, onTokenExpired) {
  const d = await withRetry(
    () => apiGet(
      '/v2/option/chain?instrument_key=' + encodeURIComponent(instrKey) + '&expiry_date=' + expiry,
      token, onTokenExpired
    ),
    'options'
  );
  return d?.data || [];
}

export async function fetchOptionContracts(instrKey, token, onTokenExpired) {
  const d = await withRetry(
    () => apiGet('/v2/option/contract?instrument_key=' + encodeURIComponent(instrKey), token, onTokenExpired),
    'option-contracts'
  );
  return d?.data || [];
}

// ── Portfolio: positions & holdings ──
export async function fetchPortfolio(token, onTokenExpired) {
  const [posRes, holdRes] = await Promise.allSettled([
    withRetry(() => apiGet('/v2/portfolio/short-term-positions', token, onTokenExpired), 'positions'),
    withRetry(() => apiGet('/v2/portfolio/long-term-holdings', token, onTokenExpired), 'holdings'),
  ]);
  const positions = posRes.status === 'fulfilled' ? posRes.value?.data || [] : [];
  const holdings  = holdRes.status === 'fulfilled' ? holdRes.value?.data || [] : [];
  return { positions, holdings };
}

// ── User profile ──
export async function fetchUserProfile(token, onTokenExpired) {
  const d = await withRetry(() => apiGet('/v2/user/profile', token, onTokenExpired), 'profile');
  return d?.data || null;
}

// ── Market status ──
export async function fetchMarketStatus(token) {
  try {
    const url = 'https://api.upstox.com/v2/market/status/NSE';
    const hdrs = { Authorization: 'Bearer ' + resolveAccessToken(token), Accept: 'application/json' };
    for (const fetchUrl of [url, 'https://corsproxy.io/?' + encodeURIComponent(url)]) {
      try {
        const res = await fetch(fetchUrl, { headers: hdrs });
        if (!res.ok) continue;
        const txt = await res.text();
        let d = JSON.parse(txt);
        if (d.contents) d = JSON.parse(d.contents);
        const data = d?.data;
        if (!data) continue;
        const status   = (data.status || '').toLowerCase();
        const exStatus = (data.exchange_status || '').toLowerCase();
        const open = status === 'open' || status === 'normal_open' ||
                     status === 'market_open' || exStatus === 'market_open';
        return { open, status, exStatus };
      } catch (e) { /* try next */ }
    }
  } catch (e) { /* fallback */ }
  return null;
}

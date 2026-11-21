/**
 * LiveChart — scrollable live candlestick chart
 *
 * - Candles normalised (sorted oldest→newest, de-duplicated) for any source
 * - Upstox V3 candles for every interval (1m/5m/15m/30m/1H/1D) + today's intraday merge
 * - Live ticks update the forming candle AND open a new candle at each interval boundary
 * - Silent background refresh while market is open (no loading flicker, scroll kept)
 * - EMA 9/21/50/200 + SuperTrend computed on the FULL series, then sliced to the view
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken, fetchCandles, fetchCandlesV3, fetchIntradayV3 } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { localIsOpen } from '../utils/marketTime';

// ── Helpers ───────────────────────────────────────────────────
const IST = { timeZone: 'Asia/Kolkata' };
const istYmd = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', IST);
const istMidnight = (ms = Date.now()) => Date.parse(istYmd(ms) + 'T00:00:00+05:30');
const SESSION_OPEN_MS = (9 * 60 + 15) * 60000;

// Upstox candle rows → [tsMs, o, h, l, c, v], oldest first, unique by timestamp
function normalize(raw) {
  const m = new Map();
  for (const c of raw || []) {
    const t = typeof c?.[0] === 'number' ? c[0] : Date.parse(c?.[0]);
    const o = +c?.[1], h = +c?.[2], l = +c?.[3], cl = +c?.[4];
    if (!Number.isFinite(t) || !(h > 0) || !(l > 0) || !(cl > 0)) continue;
    m.set(t, [t, o, h, l, cl, +c[5] || 0]);
  }
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}

function ema(src, p) {
  const n = src.length;
  const out = new Array(n).fill(null);
  if (n < p) return out;
  const k = 2 / (p + 1);
  let v = 0;
  for (let i = 0; i < p; i++) v += src[i];
  v /= p;
  out[p - 1] = v;
  for (let i = p; i < n; i++) { v = src[i] * k + v * (1 - k); out[i] = v; }
  return out;
}

// Standard SuperTrend (Wilder ATR). Returns array aligned to candles: {st, bull} | null
function supertrend(c, period = 10, mult = 3) {
  const n = c.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(c[i][2] - c[i][3], Math.abs(c[i][2] - c[i - 1][4]), Math.abs(c[i][3] - c[i - 1][4]));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  let fu = 0, fl = 0, bull = true;
  for (let i = period; i < n; i++) {
    if (i > period) atr = (atr * (period - 1) + tr[i]) / period;
    const hl2 = (c[i][2] + c[i][3]) / 2;
    const bu = hl2 + mult * atr, bl = hl2 - mult * atr;
    if (i === period) { fu = bu; fl = bl; bull = c[i][4] > hl2; }
    else {
      const pc = c[i - 1][4];
      fu = (bu < fu || pc > fu) ? bu : fu;
      fl = (bl > fl || pc < fl) ? bl : fl;
      if (bull && c[i][4] < fl) bull = false;
      else if (!bull && c[i][4] > fu) bull = true;
    }
    out[i] = { st: bull ? fl : fu, bull };
  }
  return out;
}

function fmtP(p) {
  if (!p || isNaN(p)) return '—';
  if (p >= 100000) return (p / 100000).toFixed(2) + 'L';
  if (p >= 1000)   return p.toFixed(0);
  if (p >= 100)    return p.toFixed(1);
  return p.toFixed(2);
}

function fmtDate(ts, isIntraday, showDate) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  if (isIntraday && !showDate) return d.toLocaleTimeString('en-GB', { ...IST, hour: '2-digit', minute: '2-digit', hour12: false });
  const [y, m, dd] = istYmd(ts).split('-');
  return `${+dd}/${+m}`;
}

const INTERVALS = [
  { key: 'day',      label: '1D',  days: 730, isIntra: false, unit: 'days',    n: 1,  durMin: 1440, poll: 60000, v2: true  },
  { key: '1minute',  label: '1m',  days: 5,   isIntra: true,  unit: 'minutes', n: 1,  durMin: 1,    poll: 15000, v2: true  },
  { key: '5minute',  label: '5m',  days: 10,  isIntra: true,  unit: 'minutes', n: 5,  durMin: 5,    poll: 20000, v2: false },
  { key: '15minute', label: '15m', days: 30,  isIntra: true,  unit: 'minutes', n: 15, durMin: 15,   poll: 30000, v2: false },
  { key: '30minute', label: '30m', days: 60,  isIntra: true,  unit: 'minutes', n: 30, durMin: 30,   poll: 30000, v2: true  },
  { key: '60minute', label: '1H',  days: 85,  isIntra: true,  unit: 'hours',   n: 1,  durMin: 60,   poll: 45000, v2: false },
];

// ── Main component ────────────────────────────────────────────
export default function LiveChart({
  instrKey = '',
  candles: seedCandles = [],
  closes:  seedCloses  = [], // eslint-disable-line no-unused-vars
  entry  = 0,
  sl     = 0,
  target = 0,
  symbol = '',
  interval = 'day',
  style  = {},
  livePrice = null,    // fallback price when own live feed has no tick yet
  liveChgPct = null,   // fallback change % when own feed has no tick yet
}) {
  const { token, marketStatus } = useApp();
  const accessToken = resolveAccessToken(token);

  const containerRef = useRef(null);
  const dragRef      = useRef({ dragging: false, startX: 0, startOffset: 0 });
  const reqRef       = useRef(0);
  const seedRef      = useRef(seedCandles);
  seedRef.current = seedCandles;

  const [allCandles,   setAllCandles]   = useState(() => normalize(seedCandles));
  const [selInterval,  setSelInterval]  = useState(interval);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [viewOffset,   setViewOffset]   = useState(0);
  const [visibleCount, setVisibleCount] = useState(60);
  const [containerW,   setContainerW]   = useState(360);
  const [tickTime,     setTickTime]     = useState('');

  const intervalMeta = INTERVALS.find(i => i.key === selInterval) || INTERVALS[0];
  const marketOpen = !!marketStatus?.open;

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([e]) => setContainerW(Math.floor(e.contentRect.width)));
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Fetch candles (history + today's intraday, merged) ───────
  const fetchData = useCallback(async (silent = false) => {
    if (!instrKey || !accessToken) return;
    const meta  = INTERVALS.find(i => i.key === selInterval) || INTERVALS[0];
    const reqId = ++reqRef.current;
    if (!silent) { setLoading(true); setError(''); }
    try {
      const today = istYmd();
      const from  = istYmd(Date.now() - meta.days * 86400000);
      let hist = [];
      try { hist = await fetchCandlesV3(instrKey, meta.unit, meta.n, from, today, accessToken); } catch (_) {}
      if (!hist.length && meta.v2) {
        try { hist = await fetchCandles(instrKey, from, today, selInterval, accessToken); } catch (_) {}
      }
      let intra = [];
      if (localIsOpen()) {
        try { intra = await fetchIntradayV3(instrKey, meta.unit, meta.n, accessToken); } catch (_) {}
      }
      if (reqId !== reqRef.current) return; // stale (interval switched)
      const data = normalize([...hist, ...intra]);
      if (data.length) {
        setAllCandles(data);
        setError('');
        if (!silent) setViewOffset(0);
      } else if (!silent) {
        setError(`No ${meta.label} candle data available`);
        const seed = meta.key === 'day' ? normalize(seedRef.current) : [];
        setAllCandles(seed);
      }
    } catch (e) {
      if (reqId === reqRef.current && !silent) {
        setError('Fetch error: ' + e.message);
        setAllCandles(selInterval === 'day' ? normalize(seedRef.current) : []);
      }
    } finally {
      if (!silent && reqId === reqRef.current) setLoading(false);
    }
  }, [instrKey, selInterval, accessToken]);

  // Load on open / interval change
  useEffect(() => {
    if (instrKey) fetchData(false);
    else setAllCandles(normalize(seedRef.current));
  }, [fetchData, instrKey]);

  // Continuous refresh while market is open (silent: keeps scroll, no spinner)
  useEffect(() => {
    if (!instrKey || !marketOpen) return;
    const id = setInterval(() => { if (!document.hidden && localIsOpen()) fetchData(true); }, intervalMeta.poll);
    const onVis = () => { if (!document.hidden) fetchData(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [instrKey, marketOpen, intervalMeta.poll, fetchData]);

  // ── Live tick (own feed always; parent price only as fallback) ─
  const wsKeys = useMemo(() => (instrKey ? [instrKey] : []), [instrKey]);
  const { lastPrices, connected } = useMarketFeed(
    accessToken, wsKeys, wsKeys.length > 0 && marketOpen,
    { mode: 'ltpc', pollFallback: true }
  );
  const tick  = instrKey ? lastPrices[instrKey] : null;
  const price = tick?.ltp > 0 ? tick.ltp : (livePrice > 0 ? livePrice : 0);

  useEffect(() => {
    if (tick?.ltp) setTickTime(new Date().toLocaleTimeString('en-IN', { ...IST, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }, [tick?.ltp]);

  // Merge the live price into the series: update forming candle or open a new one
  const merged = useMemo(() => {
    if (!allCandles.length || !(price > 0) || !marketOpen || !localIsOpen()) return allCandles;
    const out  = allCandles.slice();
    const last = out[out.length - 1];
    const now  = Date.now();
    const meta = intervalMeta;
    const upd  = (c) => [c[0], c[1], Math.max(c[2], price), Math.min(c[3], price), price, c[5]];

    if (!meta.isIntra) {
      const dayStart = istMidnight(now);
      if (last[0] >= dayStart) out[out.length - 1] = upd(last);
      else {
        const o = tick?.open > 0 ? tick.open : price;
        out.push([dayStart, o, Math.max(o, price, tick?.high || 0), Math.min(o, price, tick?.low > 0 ? tick.low : price), price, 0]);
      }
      return out;
    }
    const open = istMidnight(now) + SESSION_OPEN_MS;
    if (now < open) return out;
    const dur = meta.durMin * 60000;
    const bucketT = open + Math.floor((now - open) / dur) * dur;
    if (last[0] >= bucketT) out[out.length - 1] = upd(last);
    else out.push([bucketT, last[4], Math.max(last[4], price), Math.min(last[4], price), price, 0]);
    return out;
  }, [allCandles, price, marketOpen, intervalMeta, tick?.open, tick?.high, tick?.low]);

  // ── Scroll / zoom ─────────────────────────────────────────────
  const maxOffset = Math.max(0, merged.length - visibleCount);

  const onPointerDown = e => {
    dragRef.current = { dragging: true, startX: e.clientX, startOffset: viewOffset };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = e => {
    if (!dragRef.current.dragging) return;
    const slot = (containerW - 52) / visibleCount;
    const deltaC = Math.round((e.clientX - dragRef.current.startX) / slot);
    setViewOffset(Math.max(0, Math.min(maxOffset, dragRef.current.startOffset + deltaC)));
  };
  const onPointerUp = () => { dragRef.current.dragging = false; };

  const zoomIn  = () => setVisibleCount(v => Math.max(10, v - 10));
  const zoomOut = () => setVisibleCount(v => Math.min(Math.min(300, merged.length), v + 10));
  const scrollLeft  = () => setViewOffset(v => Math.min(maxOffset, v + Math.floor(visibleCount / 3)));
  const scrollRight = () => setViewOffset(v => Math.max(0, v - Math.floor(visibleCount / 3)));

  // ── Indicators on FULL series, then slice to view ────────────
  const ind = useMemo(() => {
    const closes = merged.map(c => c[4]);
    return { e9: ema(closes, 9), e21: ema(closes, 21), e50: ema(closes, 50), e200: ema(closes, 200), st: supertrend(merged) };
  }, [merged]);

  const viewEnd   = merged.length - Math.min(viewOffset, maxOffset);
  const viewStart = Math.max(0, viewEnd - visibleCount);
  const display   = useMemo(() => merged.slice(viewStart, viewEnd), [merged, viewStart, viewEnd]);

  const ltp = price || display[display.length - 1]?.[4] || 0;
  const chgPct = tick?.chgPct != null ? tick.chgPct
    : liveChgPct != null ? liveChgPct
    : (() => { const pc = display[display.length - 2]?.[4] || ltp; return pc > 0 ? (ltp - pc) / pc * 100 : 0; })();
  const chgColor = chgPct >= 0 ? '#16a34a' : '#ef4444';

  // ── Chart dimensions ─────────────────────────────────────────
  const W        = containerW;
  const PRICE_AX = 52;
  const LEFT     = 2;
  const CW       = W - LEFT - PRICE_AX;
  const TOTAL_H  = Math.round(W * 0.85);
  const MAIN_H   = Math.round(TOTAL_H * 0.85);
  const VOL_H    = TOTAL_H - MAIN_H;
  const N = display.length;
  const slotW   = N > 0 ? CW / N : CW / 40;
  const candleW = Math.max(2, Math.min(slotW * 0.86, 22));
  const cx = i => LEFT + (i + 0.5) * slotW;

  // ── Price range ───────────────────────────────────────────────
  const { hi, lo } = useMemo(() => {
    if (!display.length) return { hi: 100, lo: 0 };
    let hi = Math.max(...display.map(c => c[2]));
    let lo = Math.min(...display.map(c => c[3]));
    [entry, sl, target, ltp].forEach(v => { if (v > 0) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
    const pad = (hi - lo) * 0.07;
    return { hi: hi + pad, lo: lo - pad };
  }, [display, entry, sl, target, ltp]);

  const range = hi - lo || 1;
  const py = p => MAIN_H * (1 - (p - lo) / range);
  const maxVol = Math.max(...display.map(c => c[5] || 0), 1);
  const pv = v => MAIN_H + VOL_H * (1 - v / maxVol);

  // ── Price axis ticks ─────────────────────────────────────────
  const priceTicks = useMemo(() => {
    const steps = [0.05,0.1,0.2,0.5,1,2,5,10,20,50,100,200,500,1000,2000,5000,10000];
    const step  = steps.find(s => s >= range / 5) || steps[steps.length - 1];
    const first = Math.ceil(lo / step) * step;
    const ticks = [];
    for (let p = first; p <= hi; p = +(p + step).toFixed(10)) {
      const y = py(p);
      if (y > 8 && y < MAIN_H - 6) ticks.push({ p, y });
    }
    return ticks;
  }, [hi, lo, range, MAIN_H]); // eslint-disable-line

  // ── EMA lines (from full-series values) ───────────────────────
  const emaLines = (() => {
    return [
      { v: ind.e9,   col: '#0d9488', sw: 1.2 },
      { v: ind.e21,  col: '#0ea5e9', sw: 1.2 },
      { v: ind.e50,  col: '#2563eb', sw: 1.5, dash: '5,3' },
      { v: ind.e200, col: '#9333ea', sw: 1.5, dash: '3,3' },
    ].map(({ v, col, sw, dash }) => {
      const pts = [];
      for (let i = 0; i < N; i++) {
        const val = v[viewStart + i];
        if (val != null) pts.push(`${cx(i).toFixed(1)},${py(val).toFixed(1)}`);
      }
      return pts.length > 1
        ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`
        : '';
    }).join('');
  })();

  // ── SuperTrend ────────────────────────────────────────────────
  const stSvg = (() => {
    const segs = [];
    let cur = [], bull = null;
    for (let i = 0; i < N; i++) {
      const s = ind.st[viewStart + i];
      if (!s) continue;
      const pt = `${cx(i).toFixed(1)},${py(s.st).toFixed(1)}`;
      if (bull !== null && bull !== s.bull) {
        if (cur.length > 1) segs.push({ pts: cur, bull });
        cur = [];
      }
      bull = s.bull;
      cur.push(pt);
    }
    if (cur.length > 1) segs.push({ pts: cur, bull });
    return segs.map(({ pts, bull: b }) =>
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${b ? '#16a34a' : '#ef4444'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    ).join('');
  })();

  // ── Date labels (IST) ─────────────────────────────────────────
  const dateLabels = (() => {
    if (!display.length) return '';
    const step = Math.max(1, Math.floor(N / 6));
    const idxs = [];
    for (let i = 0; i < N; i += step) idxs.push(i);
    if (idxs[idxs.length - 1] !== N - 1 && N - 1 - idxs[idxs.length - 1] >= step / 2) idxs.push(N - 1);
    let prevDay = '';
    return idxs.map(i => {
      const day = istYmd(display[i][0]);
      const lbl = fmtDate(display[i][0], intervalMeta.isIntra, day !== prevDay && prevDay !== '');
      prevDay = day;
      return `<text x="${cx(i).toFixed(1)}" y="${(MAIN_H - 3).toFixed(1)}" text-anchor="middle" font-size="7.5" fill="#94a3b8" font-family="system-ui">${lbl}</text>`;
    }).join('');
  })();

  // Candles, volume, levels SVGs
  const candleSvg = display.map((c, i) => {
    const [, o, h, l, cl] = c;
    const up  = cl >= o;
    const col = up ? '#16a34a' : '#ef4444';
    const bt  = py(Math.max(o, cl)), bb = py(Math.min(o, cl));
    const bh  = Math.max(1, bb - bt);
    return `<line x1="${cx(i).toFixed(1)}" y1="${py(h).toFixed(1)}" x2="${cx(i).toFixed(1)}" y2="${py(l).toFixed(1)}" stroke="${col}" stroke-width="1.1"/>` +
           `<rect x="${(cx(i)-candleW/2).toFixed(1)}" y="${bt.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" rx="0.5"/>`;
  }).join('');

  const volSvg = display.map((c, i) => {
    const up = c[4] >= c[1];
    const top = pv(c[5] || 0);
    const bh  = MAIN_H + VOL_H - top;
    return bh > 0.5
      ? `<rect x="${(cx(i)-candleW/2).toFixed(1)}" y="${top.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${up?'#16a34a':'#ef4444'}" opacity="0.3"/>`
      : '';
  }).join('');

  const levelSvg = [
    { p: target, col: '#16a34a', lbl: 'TGT',   dash: '' },
    { p: entry,  col: '#1d4ed8', lbl: 'ENTRY', dash: '5,3' },
    { p: sl,     col: '#ef4444', lbl: 'SL',    dash: '' },
    { p: ltp,    col: '#f59e0b', lbl: '',       dash: '2,2' },
  ].filter(x => x.p > 0).map(({ p, col, lbl, dash }) => {
    const y = py(p);
    if (y < 2 || y > MAIN_H - 2) return '';
    const yt = y.toFixed(1);
    return `<line x1="${LEFT}" y1="${yt}" x2="${W-PRICE_AX}" y2="${yt}" stroke="${col}" stroke-width="${!lbl?1.5:1}" stroke-dasharray="${dash}" opacity="0.9"/>` +
           `<rect x="${W-PRICE_AX+1}" y="${(y-7).toFixed(1)}" width="${PRICE_AX-2}" height="14" rx="3" fill="${col}"/>` +
           `<text x="${W-PRICE_AX+4}" y="${(y+4).toFixed(1)}" font-size="9" font-weight="800" fill="#fff" font-family="monospace,system-ui">${fmtP(p)}</text>` +
           (lbl ? `<rect x="${LEFT+1}" y="${(y-7).toFixed(1)}" width="30" height="12" rx="2" fill="${col}" opacity="0.85"/><text x="${LEFT+4}" y="${(y+3).toFixed(1)}" font-size="7.5" font-weight="700" fill="#fff" font-family="system-ui">${lbl}</text>` : '');
  }).join('');

  // ── Render ────────────────────────────────────────────────────
  return (
    <div ref={containerRef} style={{ width: '100%', userSelect: 'none', ...style }}>

      {/* Header: price + WS status */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6, padding:'0 2px' }}>
        <div style={{ display:'flex', alignItems:'baseline', gap:6 }}>
          {symbol && <span style={{ fontSize:12, fontWeight:800, color:'#0f172a' }}>{symbol}</span>}
          <span style={{ fontSize:17, fontWeight:900, color:'#0f172a' }}>₹{fmtP(ltp)}</span>
          <span style={{ fontSize:11, fontWeight:700, color:chgColor }}>{chgPct>=0?'+':''}{chgPct.toFixed(2)}%</span>
        </div>
        {marketOpen && (connected || !!tick) && (
          <div style={{ display:'flex', alignItems:'center', gap:3, fontSize:9, color:'#16a34a', fontWeight:700 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'#16a34a', animation:'pulse 1.5s infinite' }} />
            LIVE {tickTime}
          </div>
        )}
      </div>

      {/* Interval pills */}
      <div style={{ display:'flex', gap:4, marginBottom:8 }}>
        {INTERVALS.map(({ key, label }) => (
          <button key={key} onClick={() => { setSelInterval(key); setViewOffset(0); setAllCandles([]); }}
            style={{ padding:'3px 11px', fontSize:10, fontWeight:700, borderRadius:16, border:'none', cursor:'pointer', flexShrink:0,
              background: selInterval===key ? '#0f172a' : '#f1f5f9',
              color:      selInterval===key ? '#fff'    : '#64748b',
            }}>{label}</button>
        ))}
      </div>

      {/* Loading / Error */}
      {loading && (
        <div style={{ height:200, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8 }}>
          <div style={{ width:26,height:26,border:'3px solid #e2e8f0',borderTopColor:'#16a34a',borderRadius:'50%',animation:'spin .7s linear infinite' }}/>
          <span style={{ fontSize:11, color:'#94a3b8' }}>Loading {intervalMeta.label} candles…</span>
        </div>
      )}
      {!loading && error && !display.length && (
        <div style={{ height:80, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, color:'#ef4444' }}>{error}</div>
      )}

      {/* Chart SVG */}
      {!loading && display.length > 0 && (
        <>
          {/* Scroll + Zoom controls */}
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4, padding:'0 2px' }}>
            <div style={{ display:'flex', gap:4 }}>
              <button onClick={scrollLeft}  style={ctrlBtn}>‹ Older</button>
              <button onClick={scrollRight} style={ctrlBtn}>Newer ›</button>
            </div>
            <div style={{ fontSize:8, color:'#94a3b8', textAlign:'center' }}>
              {N} candles · drag to scroll
            </div>
            <div style={{ display:'flex', gap:4 }}>
              <button onClick={zoomIn}  style={ctrlBtn}>+ Zoom</button>
              <button onClick={zoomOut} style={ctrlBtn}>− Zoom</button>
            </div>
          </div>

          <svg
            viewBox={`0 0 ${W} ${TOTAL_H}`} width={W} height={TOTAL_H}
            xmlns="http://www.w3.org/2000/svg"
            style={{ display:'block', borderRadius:10, border:'1px solid #e2e8f0', background:'#fff', overflow:'hidden', touchAction:'none', cursor:'grab' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <defs>
              <clipPath id="lc-m"><rect x={LEFT} y={0} width={CW} height={MAIN_H}/></clipPath>
              <clipPath id="lc-v"><rect x={LEFT} y={MAIN_H} width={CW} height={VOL_H}/></clipPath>
            </defs>

            {/* Backgrounds */}
            <rect x={0} y={0} width={W} height={MAIN_H} fill="#fff"/>
            <rect x={0} y={MAIN_H} width={W} height={VOL_H} fill="#f8fafc"/>
            <line x1={LEFT} y1={MAIN_H} x2={W} y2={MAIN_H} stroke="#e2e8f0" strokeWidth="0.5"/>
            <line x1={W-PRICE_AX} y1={0} x2={W-PRICE_AX} y2={TOTAL_H} stroke="#e2e8f0" strokeWidth="0.5"/>

            {/* Price grid */}
            {priceTicks.map(({ p, y }, i) => (
              <g key={i}>
                <line x1={LEFT} y1={y} x2={W-PRICE_AX} y2={y} stroke="#f1f5f9" strokeWidth="0.8"/>
                <text x={W-PRICE_AX+3} y={y+3.5} fontSize="8.5" fill="#94a3b8" fontWeight="600" fontFamily="monospace,system-ui">{fmtP(p)}</text>
              </g>
            ))}

            {/* Volume */}
            <g clipPath="url(#lc-v)" dangerouslySetInnerHTML={{ __html: volSvg }}/>

            {/* EMA lines */}
            <g clipPath="url(#lc-m)" dangerouslySetInnerHTML={{ __html: emaLines }}/>

            {/* SuperTrend */}
            <g clipPath="url(#lc-m)" dangerouslySetInnerHTML={{ __html: stSvg }}/>

            {/* Candles */}
            <g clipPath="url(#lc-m)" dangerouslySetInnerHTML={{ __html: candleSvg }}/>

            {/* Level lines */}
            <g dangerouslySetInnerHTML={{ __html: levelSvg }}/>

            {/* Date labels */}
            <g dangerouslySetInnerHTML={{ __html: dateLabels }}/>

            {/* Scroll position indicator */}
            {maxOffset > 0 && (
              <rect
                x={LEFT + CW * (1 - (viewOffset + visibleCount) / merged.length)}
                y={TOTAL_H - 3}
                width={CW * visibleCount / merged.length}
                height={3}
                rx={1.5}
                fill="#0ea5e9"
                opacity="0.6"
              />
            )}

            {/* Legend */}
            {[
              { col:'#0d9488', lbl:'9' }, { col:'#0ea5e9', lbl:'21' },
              { col:'#2563eb', lbl:'50' }, { col:'#9333ea', lbl:'200' },
            ].map(({ col, lbl }, i) => (
              <g key={lbl}>
                <line x1={LEFT+4+i*30} y1={10} x2={LEFT+14+i*30} y2={10} stroke={col} strokeWidth="1.5"/>
                <text x={LEFT+16+i*30} y={13.5} fontSize="7.5" fill={col} fontFamily="system-ui" fontWeight="600">{lbl}</text>
              </g>
            ))}
          </svg>

          {/* Candle info on drag */}
          <div style={{ fontSize:9, color:'#94a3b8', marginTop:4, textAlign:'center' }}>
            {viewOffset > 0 ? `Showing ${N} candles · ${viewOffset} from latest (drag to scroll)` : `Latest ${N} of ${merged.length} candles`}
          </div>
        </>
      )}
    </div>
  );
}

const ctrlBtn = {
  padding:'3px 9px', fontSize:9, fontWeight:700, borderRadius:6,
  border:'1px solid #e2e8f0', background:'#f8fafc', color:'#64748b',
  cursor:'pointer', flexShrink:0,
};
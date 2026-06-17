/**
 * LiveChart — scrollable live candlestick chart like a trading platform
 *
 * Features:
 * - Scrollable: drag/swipe left to see older candles, right for newer
 * - Pinch/button zoom: more or fewer candles visible
 * - Auto-loads historical data for any interval
 * - Live WS ticks update the last candle in real time
 * - EMA 9/21/50/200 · SuperTrend · Volume bars · Price axis · Date labels
 * - Entry/SL/Target lines with price badges
 *
 * Props:
 *   instrKey  {string}  Upstox instrument key for WS + historical fetch
 *   candles   {array}   Seed candles (optional, [[ts,o,h,l,c,v]])
 *   closes    {array}   Seed closes for EMA (optional)
 *   entry     {number}  Entry price line
 *   sl        {number}  Stop loss line
 *   target    {number}  Target line
 *   symbol    {string}  Display name
 *   interval  {string}  Default interval ('day')
 *   style     {object}  Outer container style
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken, fetchCandles, fetchIntraday } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';

// ── Helpers ───────────────────────────────────────────────────
function ema(src, p) {
  if (!src || src.length < p) return new Array(src?.length || 0).fill(null);
  const k = 2 / (p + 1);
  let v = src.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const out = new Array(p - 1).fill(null);
  out.push(v);
  for (let i = p; i < src.length; i++) { v = src[i] * k + v * (1 - k); out.push(v); }
  return out;
}

function supertrend(nums, period = 10, mult = 3) {
  if (nums.length < period + 1) return [];
  const trs = [];
  for (let i = 1; i < nums.length; i++) {
    trs.push(Math.max(
      nums[i][2] - nums[i][3],
      Math.abs(nums[i][2] - nums[i - 1][4]),
      Math.abs(nums[i][3] - nums[i - 1][4])
    ));
  }
  const atrMA = ema(trs, period);
  const result = [];
  for (let i = period; i < nums.length; i++) {
    const a   = atrMA[i - 1] || 0;
    const hl2 = (nums[i][2] + nums[i][3]) / 2;
    const ub  = hl2 + mult * a, lb = hl2 - mult * a;
    const cl  = nums[i][4];
    const prev = result[result.length - 1];
    let st, bull;
    if (!prev) { bull = cl > hl2; st = bull ? lb : ub; }
    else {
      bull = prev.bull ? cl > Math.max(lb, prev.st) : cl > ub;
      st   = bull ? Math.max(lb, prev.bull ? prev.st : 0) : Math.min(ub, !prev.bull ? prev.st : 1e9);
    }
    result.push({ st, bull, i });
  }
  return result;
}

function fmtP(p) {
  if (!p || isNaN(p)) return '—';
  if (p >= 100000) return (p / 100000).toFixed(2) + 'L';
  if (p >= 1000)   return p.toFixed(0);
  if (p >= 100)    return p.toFixed(1);
  return p.toFixed(2);
}

function fmtDate(ts, isIntraday) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return isIntraday
    ? `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
    : `${d.getDate()}/${d.getMonth() + 1}`;
}

const INTERVALS = [
  { key: 'day',      label: '1D',  days: 365, isIntra: false },
  { key: '1minute',  label: '1m',  days: 1,   isIntra: true  },
  { key: '5minute',  label: '5m',  days: 5,   isIntra: true  },
  { key: '15minute', label: '15m', days: 7,   isIntra: true  },
  { key: '30minute', label: '30m', days: 15,  isIntra: true  },
  { key: '60minute', label: '1H',  days: 30,  isIntra: true  },
];

// ── Main component ────────────────────────────────────────────
export default function LiveChart({
  instrKey = '',
  candles: seedCandles = [],
  closes:  seedCloses  = [],
  entry  = 0,
  sl     = 0,
  target = 0,
  symbol = '',
  interval = 'day',
  style  = {},
  livePrice = null,    // optional: parent already has a live tick — avoids duplicate WS subscription
  liveChgPct = null,   // optional: parent's computed change % to keep header in sync with card
}) {
  const { token, marketStatus } = useApp();
  const accessToken = resolveAccessToken(token);

  const containerRef = useRef(null);
  const canvasRef    = useRef(null);
  const dragRef      = useRef({ dragging: false, startX: 0, startOffset: 0 });

  // State
  const [allCandles,   setAllCandles]   = useState(seedCandles);
  const [selInterval,  setSelInterval]  = useState(interval);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [viewOffset,   setViewOffset]   = useState(0);   // how many candles from right we've scrolled
  const [visibleCount, setVisibleCount] = useState(40);  // zoom: how many candles to show
  const [containerW,   setContainerW]   = useState(360);
  const [liveCandle,   setLiveCandle]   = useState(null);
  const [tickTime,     setTickTime]     = useState('');

  const intervalMeta = INTERVALS.find(i => i.key === selInterval) || INTERVALS[0];

  // Responsive width
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([e]) => setContainerW(Math.floor(e.contentRect.width)));
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Fetch candles ────────────────────────────────────────────
  const fetchData = useCallback(async (iKey, ivl) => {
    if (!iKey || !accessToken) return;
    setLoading(true); setError(''); setLiveCandle(null);
    try {
      const today   = new Date().toISOString().split('T')[0];
      const fromDate = d => new Date(Date.now() - d * 86400000).toISOString().split('T')[0];
      const meta    = INTERVALS.find(i => i.key === ivl) || INTERVALS[0];
      let raw = [];

      if (ivl === 'day') {
        raw = await fetchCandles(iKey, fromDate(365), today, 'day', accessToken);
      } else {
        // Try intraday first (live data today)
        if (marketStatus.open) {
          try { raw = await fetchIntraday(iKey, ivl, accessToken); } catch (_) {}
        }
        // Fallback: historical for the date range
        if (!raw?.length) {
          raw = await fetchCandles(iKey, fromDate(meta.days), today, ivl, accessToken);
        }
      }

      if (raw?.length) {
        // Upstox returns newest first — reverse to get chronological
        const sorted = [...raw].reverse();
        setAllCandles(sorted);
        setViewOffset(0); // reset scroll to latest
      } else {
        setError(`No ${meta.label} candle data available`);
        if (seedCandles?.length) setAllCandles(seedCandles);
      }
    } catch (e) {
      setError('Fetch error: ' + e.message);
      if (seedCandles?.length) setAllCandles(seedCandles);
    } finally {
      setLoading(false);
    }
  }, [accessToken, marketStatus.open, seedCandles]); // eslint-disable-line

  // Fetch on mount and interval change
  useEffect(() => {
    if (instrKey) fetchData(instrKey, selInterval);
    else if (seedCandles?.length) setAllCandles(seedCandles);
  }, [instrKey, selInterval]); // eslint-disable-line

  // ── Live WS tick ─────────────────────────────────────────────
  // Skip internal WS if parent already provides a live price — prevents duplicate
  // subscriptions to the same instrument disagreeing with the parent card's price
  const useOwnFeed = livePrice == null;
  const wsKeys = useMemo(() => (useOwnFeed && instrKey) ? [instrKey] : [], [instrKey, useOwnFeed]);
  const { lastPrices, connected } = useMarketFeed(
    accessToken, wsKeys, wsKeys.length > 0 && !!marketStatus.open,
    { mode: 'ltpc', pollFallback: true }
  );
  const tick = useOwnFeed ? (instrKey ? lastPrices[instrKey] : null) : { ltp: livePrice };

  useEffect(() => {
    if (!tick?.ltp || !allCandles.length) return;
    setTickTime(new Date().toLocaleTimeString('en-IN', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' }));
    const last = allCandles[allCandles.length - 1];
    if (!last) return;
    setLiveCandle([
      last[0], +last[1],
      Math.max(+last[2], tick.ltp),
      Math.min(+last[3], tick.ltp),
      tick.ltp, +last[5],
    ]);
  }, [tick?.ltp]); // eslint-disable-line

  // ── Scroll / zoom handlers ────────────────────────────────────
  const maxOffset = Math.max(0, allCandles.length - visibleCount);

  const onPointerDown = e => {
    dragRef.current = { dragging: true, startX: e.clientX, startOffset: viewOffset };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = e => {
    if (!dragRef.current.dragging) return;
    const PRICE_AX = 52, candleAreaW = containerW - PRICE_AX;
    const slotW  = candleAreaW / visibleCount;
    const deltaX = e.clientX - dragRef.current.startX;
    const deltaC = Math.round(-deltaX / slotW);
    setViewOffset(Math.max(0, Math.min(maxOffset, dragRef.current.startOffset + deltaC)));
  };
  const onPointerUp = () => { dragRef.current.dragging = false; };

  const zoomIn  = () => setVisibleCount(v => Math.max(10, v - 10));
  const zoomOut = () => setVisibleCount(v => Math.min(Math.min(200, allCandles.length), v + 10));
  const scrollLeft  = () => setViewOffset(v => Math.min(maxOffset, v + Math.floor(visibleCount / 3)));
  const scrollRight = () => setViewOffset(v => Math.max(0, v - Math.floor(visibleCount / 3)));

  // ── Compute visible candles ───────────────────────────────────
  const display = useMemo(() => {
    if (!allCandles.length) return [];
    const nums = allCandles.map(c => c.map(Number));
    // Apply live candle to last position
    if (liveCandle && viewOffset === 0) {
      nums[nums.length - 1] = liveCandle.map(Number);
    }
    // Slice visible window from right: offset=0 means latest candles
    const end   = nums.length - viewOffset;
    const start = Math.max(0, end - visibleCount);
    return nums.slice(start, end);
  }, [allCandles, liveCandle, viewOffset, visibleCount]);

  const ltp = (useOwnFeed ? tick?.ltp : livePrice) || display[display.length - 1]?.[4] || 0;
  const prevClose = display[display.length - 2]?.[4] || ltp;
  const chgPct = liveChgPct != null ? liveChgPct : (prevClose > 0 ? (ltp - prevClose) / prevClose * 100 : 0);
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
  const candleW = Math.max(1.5, Math.min(slotW * 0.72, 14));
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

  // ── EMA lines ────────────────────────────────────────────────
  const emaLines = useMemo(() => {
    const closes = display.map(c => c[4]);
    return [
      { p: 9,   col: '#0d9488', sw: 1.2 },
      { p: 21,  col: '#0ea5e9', sw: 1.2 },
      { p: 50,  col: '#2563eb', sw: 1.5, dash: '5,3' },
      { p: 200, col: '#9333ea', sw: 1.5, dash: '3,3' },
    ].map(({ p, col, sw, dash }) => {
      const vals = ema(closes, p);
      const pts  = vals.map((v, i) => v != null ? `${cx(i).toFixed(1)},${py(v).toFixed(1)}` : null).filter(Boolean);
      return pts.length > 1
        ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linejoin="round" ${dash?`stroke-dasharray="${dash}"`:''}/>`
        : '';
    }).join('');
  }, [display, hi, lo]); // eslint-disable-line

  // ── SuperTrend ────────────────────────────────────────────────
  const stSvg = useMemo(() => {
    const stData = supertrend(display);
    let segs = [], cur = [], bull = null;
    stData.forEach(({ st, bull: b, i }) => {
      if (i >= N) return;
      if (bull !== b && cur.length > 1) { segs.push({ pts: [...cur], bull }); cur = []; }
      bull = b;
      cur.push(`${cx(i).toFixed(1)},${py(st).toFixed(1)}`);
    });
    if (cur.length > 1) segs.push({ pts: cur, bull });
    return segs.map(({ pts, bull: b }) =>
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${b ? '#16a34a' : '#ef4444'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    ).join('');
  }, [display, hi, lo]); // eslint-disable-line

  // ── Date labels ───────────────────────────────────────────────
  const dateLabels = useMemo(() => {
    if (!display.length) return '';
    const step = Math.max(1, Math.floor(N / 6));
    const idxs = [];
    for (let i = 0; i < N; i += step) idxs.push(i);
    if (idxs[idxs.length - 1] !== N - 1) idxs.push(N - 1);
    return idxs.map(i => {
      const lbl = fmtDate(display[i][0], intervalMeta.isIntra);
      return `<text x="${cx(i).toFixed(1)}" y="${(MAIN_H - 3).toFixed(1)}" text-anchor="middle" font-size="7.5" fill="#94a3b8" font-family="system-ui">${lbl}</text>`;
    }).join('');
  }, [display, N, intervalMeta, MAIN_H]); // eslint-disable-line

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
        {useOwnFeed && connected && marketStatus.open && (
          <div style={{ display:'flex', alignItems:'center', gap:3, fontSize:9, color:'#16a34a', fontWeight:700 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'#16a34a', animation:'pulse 1.5s infinite' }} />
            LIVE {tickTime}
          </div>
        )}
      </div>

      {/* Interval pills */}
      <div style={{ display:'flex', gap:4, marginBottom:8 }}>
        {INTERVALS.map(({ key, label }) => (
          <button key={key} onClick={() => { setSelInterval(key); setViewOffset(0); }}
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
                x={LEFT + CW * (1 - (viewOffset + visibleCount) / allCandles.length)}
                y={TOTAL_H - 3}
                width={CW * visibleCount / allCandles.length}
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
            {viewOffset > 0 ? `Showing ${N} candles · ${viewOffset} from latest (drag to scroll)` : `Latest ${N} of ${allCandles.length} candles`}
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

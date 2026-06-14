/**
 * LiveChart — reusable live candlestick chart component
 *
 * Props:
 *   instrKey   {string}  Upstox instrument key for live WS ticks
 *   candles    {array}   Initial historical candles [[ts,o,h,l,c,v], ...]
 *   closes     {array}   Historical close prices for EMA calculation
 *   entry      {number}  Entry price line
 *   sl         {number}  Stop loss price line
 *   target     {number}  Target price line
 *   symbol     {string}  Display symbol name
 *   interval   {string}  '5minute' | '15minute' | 'day' (default: 'day')
 *
 * Displays: Candlesticks · EMA 9/21/50/200 · SuperTrend · Volume bars
 *           Live price line · Price axis with numbers · Date labels
 *           Auto-updates every tick via useMarketFeed when instrKey provided
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken, fetchIntraday } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';

// ── EMA ───────────────────────────────────────────────────────
function calcEMA(src, period) {
  if (!src || src.length < period) return [];
  const k = 2 / (period + 1);
  let val = src.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(val);
  for (let i = period; i < src.length; i++) {
    val = src[i] * k + val * (1 - k);
    out.push(val);
  }
  return out;
}

// ── SuperTrend (period 10, mult 3) ──────────────────────────
function calcSuperTrend(candles, period = 10, mult = 3) {
  if (candles.length < period + 1) return [];
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i][2] - candles[i][3],
      Math.abs(candles[i][2] - candles[i - 1][4]),
      Math.abs(candles[i][3] - candles[i - 1][4])
    );
    trs.push(tr);
  }
  const atrMA = calcEMA(trs, period);
  const result = [];
  for (let i = period; i < candles.length; i++) {
    const atrV = atrMA[i - 1] || 0;
    const hl2  = (candles[i][2] + candles[i][3]) / 2;
    const ub   = hl2 + mult * atrV;
    const lb   = hl2 - mult * atrV;
    const cl   = candles[i][4];
    const prev = result[result.length - 1];
    let st, bull;
    if (!prev) {
      bull = cl > hl2; st = bull ? lb : ub;
    } else {
      bull = prev.bull ? cl > Math.max(lb, prev.st) : cl > ub;
      st   = bull
        ? Math.max(lb, prev.bull ? prev.st : 0)
        : Math.min(ub, !prev.bull ? prev.st : 1e9);
    }
    result.push({ st, bull, idx: i });
  }
  return result;
}

// ── Format price for axis ─────────────────────────────────────
function fmtAxis(p) {
  if (p >= 100000) return (p / 1000).toFixed(0) + 'K';
  if (p >= 10000)  return p.toFixed(0);
  if (p >= 1000)   return p.toFixed(0);
  if (p >= 100)    return p.toFixed(1);
  return p.toFixed(2);
}

// ── Core SVG chart renderer ───────────────────────────────────
function renderChart({ candles, liveCandle, ltp, entry, sl, target, width, height }) {
  const W = width, H = height;
  if (!candles || candles.length < 3) return null;

  const PRICE_AX = 52;
  const LEFT     = 2;
  const CW       = W - LEFT - PRICE_AX;
  const MAIN_H   = Math.round(H * 0.82);
  const VOL_H    = H - MAIN_H;

  // Merge live candle into display candles
  const display = [...candles];
  if (liveCandle && ltp > 0) {
    const last = display[display.length - 1];
    if (last && Math.abs(liveCandle[0] - last[0]) < 60000) {
      display[display.length - 1] = [
        last[0], last[1],
        Math.max(last[2], ltp),
        Math.min(last[3], ltp),
        ltp, last[5],
      ];
    }
  }
  const raw = display.slice(-60); // last 60 candles
  const N   = raw.length;
  const nums = raw.map(c => c.map(Number));

  const slotW   = CW / N;
  const candleW = Math.max(1.5, Math.min(slotW * 0.72, 12));
  const cx = i => LEFT + (i + 0.5) * slotW;

  // Price range
  let hi = Math.max(...nums.map(c => c[2]));
  let lo = Math.min(...nums.map(c => c[3]));
  const livePx = ltp || nums[N - 1][4];
  [entry, sl, target, livePx].forEach(v => { if (v > 0) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
  const pad = (hi - lo) * 0.07;
  hi += pad; lo -= pad;
  const range = hi - lo || 1;
  const py = p => MAIN_H * (1 - (p - lo) / range);

  // Volume
  const maxVol = Math.max(...nums.map(c => c[5] || 0), 1);
  const pv = v => MAIN_H + VOL_H * (1 - v / maxVol);

  // Price ticks
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const approxStep = range / 5;
  const step  = steps.find(s => s >= approxStep) || steps[steps.length - 1];
  const first = Math.ceil(lo / step) * step;
  const priceTicks = [];
  for (let p = first; p <= hi; p = +(p + step).toFixed(10)) {
    const y = py(p);
    if (y > 8 && y < MAIN_H - 6) priceTicks.push({ p, y });
  }

  // Date ticks
  const dateIdxs = [0, Math.floor(N * 0.25), Math.floor(N * 0.5), Math.floor(N * 0.75), N - 1]
    .filter((v, i, a) => a.indexOf(v) === i && v >= 0 && v < N);

  // EMA lines
  const closePrices = nums.map(c => c[4]);
  const emas = [
    { period: 9,   color: '#0d9488', sw: 1.2 },
    { period: 21,  color: '#0ea5e9', sw: 1.2 },
    { period: 50,  color: '#2563eb', sw: 1.5, dash: '5,3' },
    { period: 200, color: '#9333ea', sw: 1.5, dash: '3,3' },
  ].map(({ period, color, sw, dash }) => {
    const vals = calcEMA(closePrices, period);
    const pts  = vals.map((v, i) => v != null ? `${cx(i).toFixed(1)},${py(v).toFixed(1)}` : null)
      .filter(Boolean).join(' ');
    return pts.length > 4
      ? `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linejoin="round" ${dash ? `stroke-dasharray="${dash}"` : ''}/>` 
      : '';
  }).join('');

  // SuperTrend
  const stData = calcSuperTrend(nums);
  let stSvg = '';
  let stSegs = []; let stCur = []; let stBull = null;
  stData.forEach(({ st, bull, idx }) => {
    if (idx >= N) return;
    if (stBull !== bull && stCur.length > 1) {
      stSegs.push({ pts: [...stCur], bull: stBull });
      stCur = [];
    }
    stBull = bull;
    stCur.push(`${cx(idx).toFixed(1)},${py(st).toFixed(1)}`);
  });
  if (stCur.length > 1) stSegs.push({ pts: stCur, bull: stBull });
  stSvg = stSegs.map(({ pts, bull }) =>
    `<polyline points="${pts.join(' ')}" fill="none" stroke="${bull ? '#16a34a' : '#ef4444'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
  ).join('');

  // Candles
  const candleSvg = nums.map((c, i) => {
    const [, o, h, l, cl] = c;
    const up  = cl >= o;
    const col = up ? '#16a34a' : '#ef4444';
    const bt  = py(Math.max(o, cl));
    const bb  = py(Math.min(o, cl));
    const bh  = Math.max(1, bb - bt);
    return [
      `<line x1="${cx(i).toFixed(1)}" y1="${py(h).toFixed(1)}" x2="${cx(i).toFixed(1)}" y2="${py(l).toFixed(1)}" stroke="${col}" stroke-width="1.1"/>`,
      `<rect x="${(cx(i) - candleW / 2).toFixed(1)}" y="${bt.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" rx="0.5"/>`,
    ].join('');
  }).join('');

  // Volume bars
  const volSvg = nums.map((c, i) => {
    const up = c[4] >= c[1];
    const top = pv(c[5] || 0);
    const bh  = MAIN_H + VOL_H - top;
    if (bh < 0.5) return '';
    return `<rect x="${(cx(i) - candleW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${up ? '#16a34a' : '#ef4444'}" opacity="0.3"/>`;
  }).join('');

  // Horizontal level lines
  const levels = [
    { p: target, color: '#16a34a', label: 'TGT',   dash: '' },
    { p: entry,  color: '#1d4ed8', label: 'ENTRY', dash: '5,3' },
    { p: sl,     color: '#ef4444', label: 'SL',    dash: '' },
    { p: livePx, color: '#f59e0b', label: 'LTP',   dash: '2,2' },
  ];
  const levelSvg = levels.filter(l => l.p > 0).map(({ p, color, label, dash }) => {
    const y = py(p);
    if (y < 2 || y > MAIN_H - 2) return '';
    const yt = y.toFixed(1);
    return [
      `<line x1="${LEFT}" y1="${yt}" x2="${W - PRICE_AX}" y2="${yt}" stroke="${color}" stroke-width="${label === 'LTP' ? 1.5 : 1}" stroke-dasharray="${dash}" opacity="0.9"/>`,
      `<rect x="${W - PRICE_AX + 1}" y="${(y - 7).toFixed(1)}" width="${PRICE_AX - 2}" height="14" rx="3" fill="${color}"/>`,
      `<text x="${W - PRICE_AX + 4}" y="${(y + 4).toFixed(1)}" font-size="9" font-weight="800" fill="#fff" font-family="monospace,system-ui">${fmtAxis(p)}</text>`,
      label !== 'LTP'
        ? `<rect x="${LEFT + 1}" y="${(y - 7).toFixed(1)}" width="30" height="12" rx="2" fill="${color}" opacity="0.85"/><text x="${LEFT + 4}" y="${(y + 3).toFixed(1)}" font-size="7.5" font-weight="700" fill="#fff" font-family="system-ui">${label}</text>`
        : '',
    ].join('');
  }).join('');

  return { candleSvg, volSvg, emas, stSvg, levelSvg, priceTicks, dateIdxs, cx, py, pv,
    MAIN_H, VOL_H, W, H, PRICE_AX, LEFT, CW, nums, N };
}

// ── Main component ────────────────────────────────────────────
export default function LiveChart({
  instrKey,
  candles: initCandles = [],
  closes  = [],
  entry   = 0,
  sl      = 0,
  target  = 0,
  symbol  = '',
  interval = 'day',
  style   = {},
}) {
  const { token, marketStatus } = useApp();
  const accessToken = resolveAccessToken(token);
  const containerRef = useRef(null);
  const [size, setSize]           = useState({ w: 320, h: 340 });
  const [candles, setCandles]     = useState(initCandles);
  const [liveCandle, setLiveCandle] = useState(null);
  const [fetchedIntraday, setFetchedIntraday] = useState(false);
  const [selectedInterval, setSelectedInterval] = useState(interval);
  const [lastTickTime, setLastTickTime]         = useState(null);

  // Responsive sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      const w = Math.floor(e.contentRect.width);
      setSize({ w, h: Math.max(260, Math.floor(w * 1.0)) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Fetch intraday candles when interval is intraday
  useEffect(() => {
    if (!instrKey || !accessToken || !marketStatus.open) return;
    if (selectedInterval === 'day') { setCandles(initCandles); return; }
    setFetchedIntraday(false);
    fetchIntraday(instrKey, selectedInterval, accessToken)
      .then(raw => {
        if (raw?.length) { setCandles(raw); setFetchedIntraday(true); }
      })
      .catch(() => {});
  }, [instrKey, selectedInterval, accessToken, marketStatus.open]); // eslint-disable-line

  // Keep daily candles in sync with prop
  useEffect(() => {
    if (selectedInterval === 'day') setCandles(initCandles);
  }, [initCandles, selectedInterval]);

  // Live WS tick — updates last candle price
  const wsKeys = useMemo(() => instrKey ? [instrKey] : [], [instrKey]);
  const { lastPrices, connected } = useMarketFeed(
    accessToken, wsKeys, wsKeys.length > 0 && marketStatus.open,
    { mode: 'ltpc', pollFallback: true }
  );

  const liveTick = instrKey ? lastPrices[instrKey] : null;
  const ltp = liveTick?.ltp || candles[candles.length - 1]?.[4] || 0;

  useEffect(() => {
    if (!liveTick?.ltp) return;
    setLastTickTime(new Date().toLocaleTimeString('en-IN', { hour12: false }));
    // Update the last candle with live price
    setLiveCandle(candles[candles.length - 1]
      ? [
          candles[candles.length - 1][0],
          candles[candles.length - 1][1],
          Math.max(candles[candles.length - 1][2], liveTick.ltp),
          Math.min(candles[candles.length - 1][3], liveTick.ltp),
          liveTick.ltp,
          candles[candles.length - 1][5],
        ]
      : null);
  }, [liveTick?.ltp]); // eslint-disable-line

  // Render
  const chart = useMemo(() => renderChart({
    candles, liveCandle, ltp, entry, sl, target,
    width: size.w, height: size.h,
  }), [candles, liveCandle, ltp, entry, sl, target, size]);

  if (!chart) {
    return (
      <div ref={containerRef} style={{ width: '100%', height: 200, background: '#f8fafc', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12, ...style }}>
        No candle data
      </div>
    );
  }

  const { candleSvg, volSvg, emas, stSvg, levelSvg, priceTicks, dateIdxs, cx, W, H, MAIN_H, VOL_H, PRICE_AX, LEFT, nums, N } = chart;
  const lastClose = nums[N - 1][4];
  const prevClose = nums[N - 2]?.[4] || lastClose;
  const chgPct    = prevClose > 0 ? ((ltp - prevClose) / prevClose * 100) : 0;
  const chgColor  = chgPct >= 0 ? '#16a34a' : '#ef4444';

  const INTERVALS = [
    { key: 'day',      label: '1D' },
    { key: '1minute',  label: '1m' },
    { key: '5minute',  label: '5m' },
    { key: '15minute', label: '15m' },
    { key: '30minute', label: '30m' },
    { key: '60minute', label: '1H' },
  ];

  return (
    <div ref={containerRef} style={{ width: '100%', ...style }}>
      {/* Top bar: price + change + WS status */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, padding: '0 2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          {symbol && <span style={{ fontSize: 12, fontWeight: 800, color: '#0f172a' }}>{symbol}</span>}
          <span style={{ fontSize: 16, fontWeight: 900, color: '#0f172a' }}>₹{fmtAxis(ltp)}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: chgColor }}>
            {chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {connected && marketStatus.open && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: '#16a34a', fontWeight: 700 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a', animation: 'pulse 1.5s infinite' }} />
              LIVE {lastTickTime}
            </div>
          )}
        </div>
      </div>

      {/* Interval selector */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, overflowX: 'auto', paddingBottom: 2 }}>
        {INTERVALS.map(({ key, label }) => (
          <button key={key} onClick={() => setSelectedInterval(key)} style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 700, borderRadius: 16,
            border: 'none', cursor: 'pointer', flexShrink: 0,
            background: selectedInterval === key ? '#0f172a' : '#f1f5f9',
            color:      selectedInterval === key ? '#fff'    : '#64748b',
          }}>{label}</button>
        ))}
      </div>

      {/* SVG Chart */}
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block', borderRadius: 10, border: '1px solid #e2e8f0', background: '#fff', overflow: 'hidden' }}>
        <defs>
          <clipPath id="lc-main"><rect x={LEFT} y={0} width={W - LEFT - PRICE_AX} height={MAIN_H}/></clipPath>
          <clipPath id="lc-vol"><rect x={LEFT} y={MAIN_H} width={W - LEFT - PRICE_AX} height={VOL_H}/></clipPath>
        </defs>

        {/* Panel backgrounds */}
        <rect x={0} y={0} width={W} height={MAIN_H} fill="#fff"/>
        <rect x={0} y={MAIN_H} width={W} height={VOL_H} fill="#f8fafc"/>

        {/* Price grid */}
        {priceTicks.map(({ p, y }, i) => (
          <g key={i}>
            <line x1={LEFT} y1={y} x2={W - PRICE_AX} y2={y} stroke="#f1f5f9" strokeWidth="1"/>
            <text x={W - PRICE_AX + 3} y={y + 3.5} fontSize="8.5" fill="#94a3b8" fontWeight="600" fontFamily="monospace,system-ui">{fmtAxis(p)}</text>
          </g>
        ))}

        {/* Separator */}
        <line x1={LEFT} y1={MAIN_H} x2={W} y2={MAIN_H} stroke="#e2e8f0" strokeWidth="0.5"/>
        <line x1={W - PRICE_AX} y1={0} x2={W - PRICE_AX} y2={H} stroke="#e2e8f0" strokeWidth="0.5"/>

        {/* Volume bars */}
        <g clipPath="url(#lc-vol)" dangerouslySetInnerHTML={{ __html: volSvg }} />

        {/* EMA lines */}
        <g clipPath="url(#lc-main)" dangerouslySetInnerHTML={{ __html: emas }} />

        {/* SuperTrend */}
        <g clipPath="url(#lc-main)" dangerouslySetInnerHTML={{ __html: stSvg }} />

        {/* Candles */}
        <g clipPath="url(#lc-main)" dangerouslySetInnerHTML={{ __html: candleSvg }} />

        {/* Level lines */}
        <g dangerouslySetInnerHTML={{ __html: levelSvg }} />

        {/* Date labels */}
        {dateIdxs.map(i => {
          const d = new Date(nums[i][0]);
          const lbl = isNaN(d) ? '' : selectedInterval === 'day'
            ? `${d.getDate()}/${d.getMonth() + 1}`
            : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
          return (
            <text key={i} x={cx(i)} y={MAIN_H - 3} textAnchor="middle" fontSize="7.5" fill="#94a3b8" fontFamily="system-ui">{lbl}</text>
          );
        })}

        {/* EMA legend */}
        {[
          { col: '#0d9488', lbl: 'EMA9' },
          { col: '#0ea5e9', lbl: '21' },
          { col: '#2563eb', lbl: '50' },
          { col: '#9333ea', lbl: '200' },
          { col: '#16a34a', lbl: 'ST↑', st: true },
          { col: '#ef4444', lbl: 'ST↓', st: true },
        ].map(({ col, lbl }, idx) => (
          <g key={lbl}>
            <line x1={LEFT + 4 + idx * 34} y1={10} x2={LEFT + 14 + idx * 34} y2={10} stroke={col} strokeWidth="1.8"/>
            <text x={LEFT + 16 + idx * 34} y={13.5} fontSize="7.5" fill={col} fontFamily="system-ui" fontWeight="600">{lbl}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

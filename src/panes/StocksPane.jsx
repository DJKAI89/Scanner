import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, MarketClosedBanner, LastUpdated, StatCard, EmptyState } from '../components/common.jsx';
import StockCard from '../components/StockCard.jsx';
import { fetchQ, fetchCandles, fetchOptions } from '../services/api';
import { fetchScanQuotesViaWS } from '../hooks/useMarketFeed';
import { logSignals, buildStockSignal } from '../services/github';
import {
  calcRSI, calcEMACrossover, calcATR, calcSupertrend, calcBBSqueeze, calcNR7, calcADX,
  detectPDHLBreakout, calc52WkBreakout, calcVolumeSurge, detectGap, calcWickRejection,
  calcRelativeStrength, calcMomentumConfluence, calcWeeklyMTF, boScore, boDirection,
  boSLTarget, getIntradayPhase, detectPatterns, calcRisk, calcPotential, calcSR,
  countIndicatorsEx, getRec, autoSLTarget, calcEntryTrigger, detectReversal,
  calcMACD, isNearSupport, calcRSIDivergence, getSector, calcConfidence, calcVWAP,
  calcVWAPBands, applyFIIBias, applyCalibration, applyAdaptWeights, calcEMA, calcIVPercentile,
  applyIntradayBoost,
} from '../services/technical';

// Delivery % from Upstox quote (same as HTML getDeliveryPct)
function getDeliveryPct(q) {
  if (!q) return null;
  if (q.delivery_volume != null && q.volume > 0) return +(q.delivery_volume / q.volume * 100).toFixed(1);
  if (q.delivery_quantity != null && q.volume > 0) return +(q.delivery_quantity / q.volume * 100).toFixed(1);
  return null;
}
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import LiveChart from '../components/LiveChart';
import { AccentCard, CardHeader, LevelsStrip, ProgressStat, SignalTags, WhyBox } from '../components/cardKit';
import { getIST, getISTDate, sleep } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed.js';
import { applyMlRanking } from '../services/mlRanking';

function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0;
  if (q.net_change != null && ltp > 0) return (q.net_change / ltp) * 100;
  const prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

function interpPCR(p) {
  if (p >= 1.5) return { txt:'Very Bullish', sc:80 };
  if (p >= 1.2) return { txt:'Bullish',      sc:70 };
  if (p >= 0.9) return { txt:'Neutral',       sc:50 };
  if (p >= 0.7) return { txt:'Bearish',        sc:35 };
  return            { txt:'Very Bearish',       sc:20 };
}

// ── Index keys for WebSocket (same as OptionsPane) ──
const INDEX_WS_KEYS = [
  'NSE_INDEX|Nifty 50',
  'NSE_INDEX|Nifty Bank',
  'NSE_INDEX|India VIX',
  'BSE_INDEX|SENSEX',
];

// ── Time-of-Day reliability banner ──────────────────────────
const BO_FILTERS = [
  {id:'all',label:'All'},{id:'bull',label:'📈 Bullish'},{id:'bear',label:'📉 Bearish'},
  {id:'ema',label:'⭐ EMA'},{id:'pdhl',label:'🚀 PDH/PDL'},{id:'st',label:'📈 ST'},
  {id:'vol',label:'🔥 Volume'},{id:'52wk',label:'🏆 52Wk'},{id:'gap',label:'⬆ Gap'},
  {id:'squeeze',label:'🗜 Squeeze'},{id:'rs',label:'🚀 RS'},
];


// ── BoChartPopup — full-screen popup with live chart + all values ──────────
function BoChartPopup({ r, onClose }) {
  if (!r) return null;
  const fmtV = v => v != null ? (+v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
  const isBull = r.dir === 'BULL';
  const t = r.trade || {};
  const dirColor = isBull ? '#16a34a' : '#dc2626';
  const chgColor = (r.chgPct || 0) >= 0 ? '#16a34a' : '#dc2626';


  // Metrics grid rows
  const metrics = [
    { label: 'LTP',         value: `₹${fmtV(r.ltp)}`,                     color: '#0f172a' },
    { label: 'Change',      value: `${(r.chgPct||0)>=0?'+':''}${(r.chgPct||0).toFixed(2)}%`, color: chgColor },
    { label: 'Entry',       value: `₹${fmtV(t.entry||r.ltp)}`,             color: '#1d4ed8' },
    { label: 'Stop Loss',   value: `₹${fmtV(t.sl)}`,                       color: '#dc2626' },
    { label: 'Target',      value: `₹${fmtV(t.target)}`,                   color: '#16a34a' },
    { label: 'R:R',         value: `${t.rr||0}:1`,                         color: '#7c3aed' },
    { label: 'SL %',        value: t.sl > 0 && r.ltp > 0 ? `${Math.abs(((t.sl-r.ltp)/r.ltp)*100).toFixed(1)}%` : '—', color: '#dc2626' },
    { label: 'Tgt %',       value: t.target > 0 && r.ltp > 0 ? `+${(((t.target-r.ltp)/r.ltp)*100).toFixed(1)}%` : '—', color: '#16a34a' },
    { label: 'Score',       value: `${r.score||0}/10`,                     color: r.score>=7?'#16a34a':r.score>=4?'#d97706':'#64748b' },
    { label: 'ATR',         value: r.atr ? `₹${fmtV(r.atr)}` : '—',       color: '#64748b' },
    { label: 'Vol Ratio',   value: r.vol?.ratio ? `${r.vol.ratio}×` : '—', color: r.vol?.strong?'#7c3aed':r.vol?.confirmed?'#1d4ed8':'#64748b' },
    { label: 'RS vs Nifty', value: r.rs?.rs != null ? `${r.rs.rs>0?'+':''}${r.rs.rs}%` : '—', color: r.rs?.outperforming?'#16a34a':r.rs?.underperforming?'#dc2626':'#64748b' },
  ];

  // EMA values
  const emaRows = [
    r.ema?.ema50  != null && { label: 'EMA 50',  value: `₹${fmtV(r.ema.ema50)}`,  color: '#2563eb' },
    r.ema?.ema200 != null && { label: 'EMA 200', value: `₹${fmtV(r.ema.ema200)}`, color: '#9333ea' },
    r.ema?.ema9   != null && { label: 'EMA 9',   value: `₹${fmtV(r.ema.ema9)}`,   color: '#0d9488' },
    r.ema?.ema21  != null && { label: 'EMA 21',  value: `₹${fmtV(r.ema.ema21)}`,  color: '#0ea5e9' },
  ].filter(Boolean);

  // 52-week range bar
  const rangePos = r.wk52?.rangePos || 0;

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 1000, display: 'flex', alignItems: 'flex-end',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div style={{
        background: '#fff', width: '100%', maxHeight: '92dvh',
        borderRadius: '18px 18px 0 0', overflowY: 'auto',
        padding: '0 0 24px', boxShadow: '0 -8px 32px rgba(0,0,0,0.2)',
        animation: 'slideUp .22s ease',
      }}>
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#e2e8f0' }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 16px 12px' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#0f172a', lineHeight: 1.1 }}>{r.s}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{r.n || r.s} · {r.sec || 'NSE'}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#0f172a' }}>₹{fmtV(r.ltp)}</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: chgColor }}>{(r.chgPct||0)>=0?'+':''}{(r.chgPct||0).toFixed(2)}%</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: dirColor }}>{isBull ? '▲ BULLISH' : '▼ BEARISH'} · {r.score||0}/10</div>
          </div>
        </div>

        {/* Live chart — auto-updates via WebSocket */}
        <div style={{ padding: '0 12px', marginBottom: 12 }}>
          <LiveChart
            instrKey={r.key || r.instrKey || ''}
            candles={r.recentCandles || []}
            closes={r.closes || []}
            entry={t.entry || r.ltp}
            sl={t.sl}
            target={t.target}
            symbol={r.s}
            livePrice={r.ltp}
            liveChgPct={r.chgPct}
          />
        </div>

        {/* Intraday confirmation badges */}
        {(r.intraConfirm || r.intraVolRatio >= 1.5 || r.intraMomentum || r.stockVWAP) && (
          <div style={{ display:'flex', gap:5, flexWrap:'wrap', padding:'0 12px', marginBottom:10 }}>
            {r.intraConfirm && (
              <span style={{ fontSize:9, fontWeight:800, background:'#f0fdf4', color:'#16a34a', border:'1px solid #86efac', borderRadius:6, padding:'3px 8px' }}>
                ✅ {r.intraConfirm === 'PDH_CONFIRMED' ? 'PDH Confirmed 5m' : 'PDL Confirmed 5m'}
              </span>
            )}
            {r.intraVolRatio >= 1.5 && (
              <span style={{ fontSize:9, fontWeight:800, background:'#fdf4ff', color:'#7c3aed', border:'1px solid #ddd6fe', borderRadius:6, padding:'3px 8px' }}>
                🔥 Intraday Vol {r.intraVolRatio}×
              </span>
            )}
            {r.intraMomentum?.bullish && r.isBull && (
              <span style={{ fontSize:9, fontWeight:700, background:'#eff6ff', color:'#1d4ed8', border:'1px solid #bfdbfe', borderRadius:6, padding:'3px 8px' }}>
                ⚡ 5m EMA Bullish
              </span>
            )}
            {r.intraMomentum?.accelerating && (
              <span style={{ fontSize:9, fontWeight:700, background:'#fff7ed', color:'#c2410c', border:'1px solid #fed7aa', borderRadius:6, padding:'3px 8px' }}>
                🚀 Momentum Accelerating
              </span>
            )}
            {r.stockVWAP && (
              <span style={{ fontSize:9, fontWeight:700, background: r.stockVWAP.aboveVWAP?'#f0fdf4':'#fef2f2', color: r.stockVWAP.aboveVWAP?'#16a34a':'#ef4444', border:`1px solid ${r.stockVWAP.aboveVWAP?'#86efac':'#fca5a5'}`, borderRadius:6, padding:'3px 8px' }}>
                {r.stockVWAP.aboveVWAP ? '↑ Above' : '↓ Below'} VWAP ₹{r.stockVWAP.vwap?.toFixed(1)}
              </span>
            )}
          </div>
        )}

        {/* Trade setup */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1, background: '#e2e8f0', margin: '0 12px 12px', borderRadius: 10, overflow: 'hidden' }}>
          {[
            { l: 'ENTRY',     v: `₹${fmtV(t.entry||r.ltp)}`, c: '#1d4ed8', bg: '#eff6ff' },
            { l: 'STOP LOSS', v: `₹${fmtV(t.sl)}`,           c: '#dc2626', bg: '#fef2f2' },
            { l: 'TARGET',    v: `₹${fmtV(t.target)}`,        c: '#16a34a', bg: '#f0fdf4' },
          ].map(x => (
            <div key={x.l} style={{ background: x.bg, padding: '10px 8px', textAlign: 'center' }}>
              <div style={{ fontSize: 8, color: '#64748b', marginBottom: 3 }}>{x.l}</div>
              <div style={{ fontSize: 15, fontWeight: 900, color: x.c }}>{x.v}</div>
            </div>
          ))}
        </div>

        {/* Metrics grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, padding: '0 12px', marginBottom: 12 }}>
          {metrics.map(m => (
            <div key={m.label} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 9px' }}>
              <div style={{ fontSize: 8, color: '#94a3b8', fontWeight: 700, marginBottom: 2 }}>{m.label}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: m.color }}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* EMA values */}
        {emaRows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, padding: '0 12px', marginBottom: 12, flexWrap: 'wrap' }}>
            {emaRows.map(e => (
              <div key={e.label} style={{ background: '#f8fafc', border: `1px solid ${e.color}44`, borderRadius: 8, padding: '6px 10px', flex: 1 }}>
                <div style={{ fontSize: 8, color: '#94a3b8', fontWeight: 700 }}>{e.label}</div>
                <div style={{ fontSize: 13, fontWeight: 800, color: e.color }}>{e.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* 52-week range */}
        {r.wk52 && (
          <div style={{ padding: '0 12px', marginBottom: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>52-WEEK RANGE</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 9, color: '#dc2626', fontWeight: 700 }}>₹{fmtV(r.wk52.lo52)}</span>
              <div style={{ flex: 1, position: 'relative', height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'visible' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${rangePos}%`, background: `linear-gradient(90deg, #dc2626, #16a34a)`, borderRadius: 4 }} />
                <div style={{ position: 'absolute', left: `${rangePos}%`, top: -3, width: 14, height: 14, borderRadius: '50%', background: '#1d4ed8', border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,.2)', transform: 'translateX(-50%)' }} />
              </div>
              <span style={{ fontSize: 9, color: '#16a34a', fontWeight: 700 }}>₹{fmtV(r.wk52.hi52)}</span>
            </div>
            <div style={{ textAlign: 'center', fontSize: 9, color: '#64748b', marginTop: 4 }}>At {rangePos}% of 52-week range</div>
          </div>
        )}

        {/* Strength bar */}
        <div style={{ padding: '0 12px', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: '#64748b' }}>SIGNAL STRENGTH</span>
            <span style={{ fontSize: 11, fontWeight: 900, color: r.score>=7?'#16a34a':r.score>=4?'#d97706':'#0ea5e9' }}>{r.score||0}/10</span>
          </div>
          <div style={{ height: 8, background: '#e2e8f0', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100,(r.score||0)*10)}%`, background: r.score>=7?'#16a34a':r.score>=4?'#d97706':'#0ea5e9', borderRadius: 4, transition: 'width .5s' }} />
          </div>
        </div>

        {/* Why */}
        {r._whyLines?.length > 0 && (
          <div style={{ margin: '0 12px', padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 800, color: '#64748b', marginBottom: 6 }}>SIGNAL ANALYSIS</div>
            {r._whyLines.map((w, i) => (
              <div key={i} style={{ fontSize: 10, color: '#475569', lineHeight: 1.7 }}>→ {w}</div>
            ))}
          </div>
        )}

        {/* Close button */}
        <div style={{ padding: '0 12px' }}>
          <button
            onClick={onClose}
            style={{ width: '100%', padding: '13px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: 'pointer' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}


// ── PickChartPopup — full-screen popup for Stock Picks (Professional Picks tab) ──
function PickChartPopup({ p, onClose }) {
  if (!p) return null;
  const fmtV = v => v != null ? (+v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
  const rec      = p.rec || p.signal || 'WATCH';
  const isBuy    = rec === 'BUY' || rec === 'STRONG BUY' || rec === 'MODERATE';
  const dirColor = isBuy ? '#16a34a' : '#dc2626';
  const ltp      = p.ltp || p.entry || 0;
  const chgColor = (p.chgPct || 0) >= 0 ? '#16a34a' : '#dc2626';
  const et       = p.entryTrigger;

  const metrics = [
    { label: 'LTP',         value: `₹${fmtV(ltp)}`,                         color: '#0f172a' },
    { label: 'Change',      value: `${(p.chgPct||0)>=0?'+':''}${(p.chgPct||0).toFixed(2)}%`, color: chgColor },
    { label: 'Entry',       value: `₹${fmtV(et?.trigger||ltp)}`,             color: '#1d4ed8' },
    { label: 'Stop Loss',   value: `₹${fmtV(p.sl)}`,                         color: '#dc2626' },
    { label: 'Target',      value: `₹${fmtV(p.target)}`,                     color: '#16a34a' },
    { label: 'R:R',         value: `${p.pot?.rr||0}:1`,                      color: '#7c3aed' },
    { label: 'Confidence',  value: `${p.conf||0}%`,                          color: (p.conf||0)>=70?'#16a34a':(p.conf||0)>=50?'#d97706':'#dc2626' },
    { label: 'Risk',        value: `${p.risk||0}%`,                          color: (p.risk||0)<30?'#16a34a':(p.risk||0)<50?'#d97706':'#dc2626' },
    { label: 'Win Rate',    value: `${p.pot?.wr||0}%`,                       color: '#0ea5e9' },
    { label: 'RSI(14)',     value: p.rsi!=null ? p.rsi.toFixed(1) : '—',     color: '#7c3aed' },
    { label: 'Volume',      value: p.vol ? fmtVolShort(p.vol) : '—',         color: '#64748b' },
    { label: 'Day H/L',     value: `₹${fmtV(p.high)} / ${fmtV(p.low)}`,      color: '#374151' },
  ];

  function fmtVolShort(v) {
    if (v >= 1e7) return (v/1e7).toFixed(2)+'Cr';
    if (v >= 1e5) return (v/1e5).toFixed(2)+'L';
    return v.toLocaleString('en-IN');
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', zIndex:1000, display:'flex', alignItems:'flex-end', backdropFilter:'blur(2px)' }}
    >
      <div style={{ background:'#fff', width:'100%', maxHeight:'92dvh', borderRadius:'18px 18px 0 0', overflowY:'auto', padding:'0 0 24px', boxShadow:'0 -8px 32px rgba(0,0,0,0.2)', animation:'slideUp .22s ease' }}>
        {/* Drag handle */}
        <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 4px' }}>
          <div style={{ width:36, height:4, borderRadius:2, background:'#e2e8f0' }} />
        </div>

        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', padding:'6px 16px 12px' }}>
          <div>
            <div style={{ fontSize:20, fontWeight:900, color:'#0f172a', lineHeight:1.1 }}>{p.s}</div>
            <div style={{ fontSize:11, color:'#64748b', marginTop:2 }}>{p.n || p.s} · {p.sec || 'NSE'}</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:22, fontWeight:900, color:'#0f172a' }}>₹{fmtV(ltp)}</div>
            <div style={{ fontSize:13, fontWeight:800, color:chgColor }}>{(p.chgPct||0)>=0?'+':''}{(p.chgPct||0).toFixed(2)}%</div>
            <div style={{ fontSize:10, fontWeight:800, color:dirColor }}>{rec} · {p.numInds||0}/7 ind</div>
          </div>
        </div>

        {/* Live chart */}
        <div style={{ padding:'0 12px', marginBottom:12 }}>
          <LiveChart
            instrKey={p.key || ''}
            candles={p.recentCandles || []}
            closes={p.closes || []}
            entry={et?.trigger || ltp}
            sl={p.sl}
            target={p.target}
            symbol={p.s}
            livePrice={ltp}
            liveChgPct={p.chgPct}
          />
        </div>

        {/* Intraday confirmation badges */}
        {(p.stockVWAP || p.intraVolRatio >= 1.5 || p.intraBull != null || p.intraAccel) && (
          <div style={{ display:'flex', gap:5, flexWrap:'wrap', padding:'0 12px', marginBottom:10 }}>
            {p.stockVWAP && (
              <span style={{ fontSize:9, fontWeight:800, background: p.stockVWAP.aboveVWAP?'#f0fdf4':'#fef2f2', color: p.stockVWAP.aboveVWAP?'#16a34a':'#ef4444', border:`1px solid ${p.stockVWAP.aboveVWAP?'#86efac':'#fca5a5'}`, borderRadius:6, padding:'3px 8px' }}>
                {p.stockVWAP.aboveVWAP?'↑ Above':'↓ Below'} VWAP ₹{p.stockVWAP.vwap?.toFixed(1)}
              </span>
            )}
            {p.intraVolRatio >= 1.5 && (
              <span style={{ fontSize:9, fontWeight:800, background:'#fdf4ff', color:'#7c3aed', border:'1px solid #ddd6fe', borderRadius:6, padding:'3px 8px' }}>
                🔥 Intraday Vol {p.intraVolRatio}×
              </span>
            )}
            {p.intraBull === true && (
              <span style={{ fontSize:9, fontWeight:700, background:'#eff6ff', color:'#1d4ed8', border:'1px solid #bfdbfe', borderRadius:6, padding:'3px 8px' }}>
                ⚡ 5m EMA Bullish
              </span>
            )}
            {p.intraAccel && (
              <span style={{ fontSize:9, fontWeight:700, background:'#fff7ed', color:'#c2410c', border:'1px solid #fed7aa', borderRadius:6, padding:'3px 8px' }}>
                🚀 Momentum Accelerating
              </span>
            )}
          </div>
        )}

        {/* Trade setup */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:1, background:'#e2e8f0', margin:'0 12px 12px', borderRadius:10, overflow:'hidden' }}>
          {[
            { l:'ENTRY',     v:`₹${fmtV(et?.trigger||ltp)}`, c:'#1d4ed8', bg:'#eff6ff' },
            { l:'STOP LOSS', v:`₹${fmtV(p.sl)}`,             c:'#dc2626', bg:'#fef2f2' },
            { l:'TARGET',    v:`₹${fmtV(p.target)}`,          c:'#16a34a', bg:'#f0fdf4' },
          ].map(x => (
            <div key={x.l} style={{ background:x.bg, padding:'10px 8px', textAlign:'center' }}>
              <div style={{ fontSize:8, color:'#64748b', marginBottom:3 }}>{x.l}</div>
              <div style={{ fontSize:15, fontWeight:900, color:x.c }}>{x.v}</div>
            </div>
          ))}
        </div>

        {/* Metrics grid */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, padding:'0 12px', marginBottom:12 }}>
          {metrics.map(m => (
            <div key={m.label} style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:8, padding:'7px 9px' }}>
              <div style={{ fontSize:8, color:'#94a3b8', fontWeight:700, marginBottom:2 }}>{m.label}</div>
              <div style={{ fontSize:13, fontWeight:800, color:m.color }}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* 3 Targets */}
        {p.pot && (
          <div style={{ display:'flex', gap:6, padding:'0 12px', marginBottom:12 }}>
            {[
              { l:'Conservative', v:p.pot.cons, c:'#16a34a', bg:'#f0fdf4', bd:'#bbf7d0' },
              { l:'Moderate',     v:p.pot.mod,  c:'#1d4ed8', bg:'#eff6ff', bd:'#bfdbfe' },
              { l:'Aggressive',   v:p.pot.agg,  c:'#7c3aed', bg:'#faf5ff', bd:'#ddd6fe' },
            ].map(t => (
              <div key={t.l} style={{ flex:1, background:t.bg, border:`1px solid ${t.bd}`, borderRadius:8, padding:'7px 6px', textAlign:'center' }}>
                <div style={{ fontSize:8, color:'#94a3b8' }}>{t.l}</div>
                <div style={{ fontSize:13, fontWeight:800, color:t.c }}>₹{fmtV(t.v)}</div>
              </div>
            ))}
          </div>
        )}

        {/* Signal strength */}
        <div style={{ padding:'0 12px', marginBottom:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5 }}>
            <span style={{ fontSize:9, fontWeight:700, color:'#64748b' }}>CONFIDENCE</span>
            <span style={{ fontSize:11, fontWeight:900, color:(p.conf||0)>=70?'#16a34a':(p.conf||0)>=50?'#d97706':'#dc2626' }}>{p.conf||0}%</span>
          </div>
          <div style={{ height:8, background:'#e2e8f0', borderRadius:4, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${Math.min(100,p.conf||0)}%`, background:(p.conf||0)>=70?'#16a34a':(p.conf||0)>=50?'#d97706':'#dc2626', borderRadius:4, transition:'width .5s' }} />
          </div>
        </div>

        {/* Reversal */}
        {p.reversal?.type && p.reversal.type !== 'NONE' && (
          <div style={{ margin:'0 12px 12px', padding:'10px 12px', background:p.reversal.type==='BULLISH_REVERSAL'?'#f0fdf4':'#fef2f2', border:`1px solid ${p.reversal.type==='BULLISH_REVERSAL'?'#86efac':'#fca5a5'}`, borderRadius:10 }}>
            <div style={{ fontWeight:800, fontSize:11, color:p.reversal.type==='BULLISH_REVERSAL'?'#15803d':'#dc2626', marginBottom:2 }}>
              {p.reversal.type==='BULLISH_REVERSAL'?'🔄📈 BULLISH':'🔄📉 BEARISH'} REVERSAL · {p.reversal.strength}
            </div>
            <div style={{ fontSize:10, color:'#475569' }}>{(p.reversal.signals||[]).join(' · ')}</div>
          </div>
        )}

        {/* Why */}
        <div style={{ margin:'0 12px', padding:'10px 12px', background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:10, marginBottom:12 }}>
          <div style={{ fontSize:9, fontWeight:800, color:'#64748b', marginBottom:6 }}>SIGNAL ANALYSIS</div>
          <div style={{ fontSize:10, color:'#475569', lineHeight:1.7 }}>
            {p.numInds||0}/7 indicators aligned · R:R {p.pot?.rr||0}:1 · Win rate ~{p.pot?.wr||0}%
            {et?.alreadyTriggered ? ' · ✅ Entry trigger hit' : ` · ⏳ Waiting for trigger at ₹${fmtV(et?.trigger||ltp)}`}
          </div>
        </div>

        {/* Close button */}
        <div style={{ padding:'0 12px' }}>
          <button onClick={onClose} style={{ width:'100%', padding:'13px', background:'#0f172a', color:'#fff', border:'none', borderRadius:12, fontSize:14, fontWeight:800, cursor:'pointer' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── BoCard — dedicated breakout card (port from index.html) ──
function BoCard({ r, rank, onPopup }) {
  const fmtV = v => v != null ? (+v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
  const isBull = r.dir === 'BULL';
  const dir = isBull ? 'bull' : 'bear';
  const t = r.trade || {};

  let _bull = 0, _bear = 0;
  if (r.ema) { if (r.ema.goldenCross) _bull+=3; else if (r.ema.deathCross) _bear+=3; else if (r.ema.uptrend) _bull+=1; else _bear+=1; }
  if (r.pdhl) { if (r.pdhl.bullBreakout) _bull+=3; else if (r.pdhl.bearBreakout) _bear+=3; else if (r.pdhl.nearPDH) _bull+=1; else if (r.pdhl.nearPDL) _bear+=1; }
  if (r.st) { r.st.crossed ? (r.st.trend==='UP'?_bull+=2:_bear+=2) : (r.st.trend==='UP'?_bull+=1:_bear+=1); }

  const tags = [];
  const tag = (label, tone) => tags.push({ label, tone });
  if (_bull>0&&_bear>0) tag('⚡ MIXED SIGNALS','amber');
  if (r.ema) {
    if (r.ema.goldenCross)       tag('⭐ GOLDEN CROSS','amber');
    else if (r.ema.deathCross)   tag('💀 DEATH CROSS','red');
    else if (r.ema.nearCross)    tag('⚡ EMA NEAR CROSS','amber');
    else if (r.ema.uptrend)      tag('📈 EMA UPTREND','green');
    else                          tag('📉 EMA DOWNTREND','red');
  }
  if (r.pdhl) {
    if (r.pdhl.bullBreakout)      tag(`🚀 PDH BREAK +${r.pdhl.pdHDist}%`,'green');
    else if (r.pdhl.bearBreakout) tag(`📉 PDL BREAK ${r.pdhl.pdLDist}%`,'red');
    else if (r.pdhl.nearPDH)      tag(`⚡ NEAR PDH ₹${fmtV(r.pdhl.pdh)}`,'green');
    else if (r.pdhl.nearPDL)      tag(`⚡ NEAR PDL ₹${fmtV(r.pdhl.pdl)}`,'amber');
  }
  if (r.st) {
    tag(r.st.crossed?(r.st.trend==='UP'?'📈 ST CROSSED UP':'📉 ST CROSSED DOWN'):(r.st.trend==='UP'?`📈 ST UP ₹${fmtV(r.st.value)}`:`📉 ST DOWN ₹${fmtV(r.st.value)}`), r.st.trend==='UP'?'blue':'purple');
  }
  if (r.vol) {
    if (r.vol.strong)         tag(`🔥 VOL ${r.vol.ratio}× AVG`,'purple');
    else if (r.vol.confirmed) tag(`📊 VOL ${r.vol.ratio}× AVG`,'purple');
    else if (r.vol.dry)       tag(`🔇 LOW VOL ${r.vol.ratio}×`,'slate');
  }
  if (r.wk52) {
    if (r.wk52.breakHigh)       tag('🏆 52WK HIGH BREAK','amber');
    else if (r.wk52.atHigh)     tag(`📍 AT 52WK HIGH ₹${fmtV(r.wk52.hi52)}`,'amber');
    if (r.wk52.breakLow)        tag('⚠ 52WK LOW BREAK','red');
    else if (r.wk52.atLow)      tag(`📍 AT 52WK LOW ₹${fmtV(r.wk52.lo52)}`,'amber');
  }
  if (r.gap) {
    if (r.gap.bigGapUp)        tag(`⬆ GAP UP +${r.gap.gapPct}%`,'green');
    else if (r.gap.gapUp)      tag(`↑ GAP UP +${r.gap.gapPct}%`,'green');
    if (r.gap.bigGapDown)      tag(`⬇ GAP DOWN ${r.gap.gapPct}%`,'red');
    else if (r.gap.gapDown)    tag(`↓ GAP DOWN ${r.gap.gapPct}%`,'red');
  }
  if (r.nr7?.isNR7||r.nr7?.isNR4) tag(`🎯 ${r.nr7.isNR7?'NR7':'NR4'} COILED`,'blue');
  if (r.bb?.extremeSqueeze)        tag('🗜 BB EXTREME SQUEEZE','blue');
  else if (r.bb?.squeeze)          tag('🗜 BB SQUEEZE','blue');
  if (r.mom?.bullConf)       tag('✅ RSI+MACD BULL','green');
  else if (r.mom?.bearConf)  tag('❌ RSI+MACD BEAR','red');
  else if (r.mom?.contra)    tag('⚡ MOMENTUM CONTRA','amber');
  if (r.wick?.bearRejected)  tag('🕯 WICK REJECTION ↑','red');
  else if (r.wick?.bullStrong) tag(`🕯 STRONG CLOSE ${Math.round((r.wick.closePos||0)*100)}%`,'green');
  if (r.adx?.strong)                           tag(`💪 ADX ${r.adx.adx} STRONG`,'green');
  else if (r.adx&&!r.adx.trending&&!r.adx.weakTrend) tag(`〰 ADX ${r.adx.adx} CHOPPY`,'slate');
  if (r.rs?.outperforming&&r.rs.strongly) tag(`🚀 RS +${r.rs.rs}% vs NIFTY`,'green');
  else if (r.rs?.underperforming&&r.rs.strongly) tag(`🐢 RS ${r.rs.rs}% vs NIFTY`,'red');
  if (r.ivPct?.cheap) tag(`📉 IV CHEAP ${r.ivPct.iv}% vs HV ${r.ivPct.hv20}%`,'green');
  else if (r.ivPct?.rich) tag(`📈 IV RICH ${r.ivPct.iv}% vs HV ${r.ivPct.hv20}%`,'red');
  if (r.stockVWAP?.aboveVWAP && r.stockVWAP?.strong) tag(`📊 ABOVE VWAP ₹${fmtV(r.stockVWAP.vwap)} (+${r.stockVWAP.distPct}%)`,'green');
  else if (!r.stockVWAP?.aboveVWAP && r.stockVWAP?.strong) tag(`📊 BELOW VWAP ₹${fmtV(r.stockVWAP.vwap)} (${r.stockVWAP.distPct}%)`,'red');
  else if (r.stockVWAP?.nearVWAP) tag(`📊 AT VWAP ₹${fmtV(r.stockVWAP.vwap)}`,'slate');
  if (r.wMTF?.confirms) tag('📅 WEEKLY CONFIRMS','purple');
  if (r.sectorScore>0)  tag(`🏭 ${r.sec||'NSE'} STRONG`,'green');
  else if (r.sectorScore<0) tag(`🏭 ${r.sec||'NSE'} WEAK`,'red');
  if (r.phase==='opening') tag('⏰ OPENING HOUR','amber');

  const emaGapPct = r.ema ? ((r.ema.ema50 - (r.ema.ema200||0)) / (r.ema.ema200||1) * 100).toFixed(1) : 0;
  const why = [];
  if (r.ema) {
    if (r.ema.goldenCross)       why.push(`EMA50(₹${fmtV(r.ema.ema50)}) crossed above EMA200(₹${fmtV(r.ema.ema200)}) — institutional uptrend`);
    else if (r.ema.deathCross)   why.push(`EMA50(₹${fmtV(r.ema.ema50)}) crossed below EMA200(₹${fmtV(r.ema.ema200)}) — major downtrend`);
    else if (r.ema.nearCross)    why.push(`EMA50 vs EMA200 gap only ${Math.abs(emaGapPct)}% — cross imminent`);
    else                          why.push(`EMA50(₹${fmtV(r.ema.ema50)}) ${r.ema.uptrend?'above':'below'} EMA200(₹${fmtV(r.ema.ema200)}) — ${(emaGapPct)>0?'uptrend':'downtrend'} (gap ${Math.abs(emaGapPct)}%)`);
  }
  if (r.pdhl?.bullBreakout)      why.push(`Price broke above PDH ₹${fmtV(r.pdhl.pdh)} (+${r.pdhl.pdHDist}%)`);
  else if (r.pdhl?.bearBreakout) why.push(`Price broke below PDL ₹${fmtV(r.pdhl.pdl)} (${r.pdhl.pdLDist}%)`);
  else if (r.pdhl?.nearPDH)      why.push(`Approaching PDH ₹${fmtV(r.pdhl.pdh)} — watching for breakout`);
  else if (r.pdhl?.nearPDL)      why.push(`Near PDL ₹${fmtV(r.pdhl.pdl)} — watch for breakdown`);
  if (r.st?.crossed) why.push(`Supertrend(7,3) flipped ${r.st.trend==='UP'?'bullish':'bearish'} at ₹${fmtV(r.st.value)} — momentum shift`);
  else if (r.st)     why.push(`Supertrend(7,3) ${r.st.trend==='UP'?'bullish':'bearish'} at ₹${fmtV(r.st.value)} (${r.st.dist>0?'+':''}${r.st.dist||0}% from line)`);
  if (r.vol?.strong)         why.push(`🔥 Volume surge ${r.vol.ratio}× avg (${((r.vol.todayVol||0)/1e5).toFixed(1)}L today vs ${((r.vol.avgVol||0)/1e5).toFixed(1)}L avg) — institutional activity`);
  else if (r.vol?.confirmed) why.push(`Volume ${r.vol.ratio}× 20-day avg — breakout has conviction`);
  else if (r.vol?.dry)       why.push(`⚠ Low volume (${r.vol.ratio}× avg) — treat with caution`);
  if (r.wk52?.breakHigh)    why.push(`🏆 Breaking 52-week high ₹${fmtV(r.wk52.hi52)} — strong institutional signal`);
  else if (r.wk52?.atHigh)  why.push(`Price at 52-week high ₹${fmtV(r.wk52.hi52)} — resistance test`);
  if (r.wk52?.breakLow)     why.push(`Breaking 52-week low ₹${fmtV(r.wk52.lo52)} — severe weakness`);
  else if (r.wk52&&!r.wk52.breakHigh&&!r.wk52.atHigh&&r.wk52.hi52) why.push(`In ${r.wk52.rangePos||0}% of 52wk range (H:₹${fmtV(r.wk52.hi52)} L:₹${fmtV(r.wk52.lo52)})`);
  if (r.gap?.gapUp||r.gap?.gapDown) why.push(`${r.gap.gapUp?'Gap up':'Gap down'} ${Math.abs(r.gap.gapPct||0)}% — prev close ₹${fmtV(r.gap.prevClose)}`);
  if (r.nr7?.isNR7) why.push(`NR7: narrowest range in 7 days (${(r.nr7.range||0).toFixed(1)} vs ${(r.nr7.avgRange||0).toFixed(1)} avg) — coiled spring`);
  if (r.bb?.squeeze) why.push(`Bollinger ${r.bb.extremeSqueeze?'extreme ':''}squeeze — volatile move imminent`);
  if (r.mom?.bullConf||r.mom?.bearConf) why.push(`RSI+MACD ${r.mom?.macdBull?'bullish':'bearish'} — momentum confirms direction`);
  else if (r.mom?.contra) why.push('⚠ Momentum diverges from price — not confirmed');
  if (r.wick?.bearRejected) why.push('⚠ Upper wick rejection — buying pressure failed');
  else if (r.wick?.bullStrong) why.push('Candle closed in top of range — strong conviction close');
  if (r.adx?.strong)                             why.push(`ADX ${r.adx.adx} — strong trending market, breakout has legs`);
  else if (r.adx&&!r.adx.trending&&!r.adx.weakTrend) why.push(`⚠ ADX ${r.adx.adx} — choppy, breakout may fail`);
  if (r.rs?.outperforming) why.push(`Outperforming Nifty by ${r.rs.rs}% — institutional accumulation`);
  else if (r.rs?.underperforming) why.push(`Underperforming Nifty by ${Math.abs(r.rs.rs||0)}% — relative weakness`);
  if (r.stockVWAP?.strong) why.push(`${r.stockVWAP.aboveVWAP?'Above':'Below'} intraday VWAP ₹${fmtV(r.stockVWAP.vwap)} by ${Math.abs(r.stockVWAP.distPct)}% — ${r.stockVWAP.aboveVWAP?'institutional support':'institutional resistance'}`);
  if (r.ivPct?.cheap) why.push(`IV ${r.ivPct.iv}% below HV ${r.ivPct.hv20}% (ratio ${r.ivPct.ivHvRatio}) — options underpriced, good for buying premium`);
  else if (r.ivPct?.rich) why.push(`⚠ IV ${r.ivPct.iv}% above HV ${r.ivPct.hv20}% (ratio ${r.ivPct.ivHvRatio}) — options expensive, prefer stock over options`);
  if (r.wMTF?.confirms) why.push(`Weekly candle ${r.wMTF.wBullish?'bullish':'bearish'} — higher timeframe aligned`);
  if (r.sectorScore>0)  why.push(`${r.sec||'NSE'} sector outperforming market — tailwind for this signal`);
  else if (r.sectorScore<0) why.push(`${r.sec||'NSE'} sector underperforming market — headwind for this signal`);

  const scoreColor = (r.score||0)>=7?'#16a34a':(r.score||0)>=4?'#d97706':'#0ea5e9';

  return (
    <AccentCard dir={dir}>
      <CardHeader
        rank={rank}
        symbol={r.s}
        sector={r.sec || 'NSE'}
        name={r.n || r.s}
        ltp={fmtV(r.ltp)}
        chgPct={r.chgPct || 0}
        rec={isBull ? 'BULLISH' : 'BEARISH'}
        dir={dir}
        onPopup={onPopup}
      />

      <SignalTags tags={tags} />

      <LevelsStrip
        entry={fmtV(t.entry||r.ltp)}
        sl={fmtV(t.sl)}
        target={fmtV(t.target)}
        slSub={t.sl>0&&(t.entry||r.ltp)>0?`${isBull?'-':'+'}${Math.abs((t.sl-(t.entry||r.ltp))/(t.entry||r.ltp)*100).toFixed(1)}%`:null}
        tgtSub={`R:R ${t.rr||0}:1`}
        entrySub={t.method || null}
      />

      <ProgressStat label="Strength" pct={Math.min(100,(r.score||0)*10)} color={scoreColor} valueLabel={`${r.score||0}/10`} />

      <WhyBox lines={why} />
    </AccentCard>
  );
}


// Exact port of HTML calcStockVWAPSignal
function calcStockVWAPSignal(ltp, intradayVWAP) {
  if (!intradayVWAP || !ltp) return null;
  const distPct = +((ltp - intradayVWAP) / intradayVWAP * 100).toFixed(2);
  const aboveVWAP = ltp >= intradayVWAP;
  const strong   = Math.abs(distPct) > 0.5;
  const nearVWAP = Math.abs(distPct) <= 0.2;
  return { vwap: intradayVWAP, distPct, aboveVWAP, strong, nearVWAP };
}

// ── Push notification helpers (exact HTML port) ─────────────
function sendNotification(title, body, key) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon:'/favicon.ico', tag: key });
    n.onclick = () => { window.focus(); n.close(); };
  } catch(_) {}
}
function checkPickAlerts(picks, cfg) {
  if (!picks?.length) return;
  const highConfThresh = (cfg?.minStockConf || 50) + 25; // 25pts above min = "high confidence"
  const today = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });
  const highConf = picks.filter(p => p.passes && p.conf >= highConfThresh);
  if (highConf.length) {
    const top = highConf.sort((a,b)=>b.conf-a.conf)[0];
    const k = 'high-conf-'+top.s+'-'+today;
    if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k,'1'); sendNotification(`🔥 High Confidence: ${top.s} (${top.conf}%)`, `${top.rec} · Entry ₹${top.ltp} · Target ₹${top.target} · R:R ${top.pot?.rr}:1`, k); }
  }
  picks.filter(p=>p.passes&&p.rsiDiv?.bullish).slice(0,1).forEach(d=>{
    const k='rsidiv-'+d.s+'-'+today;
    if(!sessionStorage.getItem(k)){sessionStorage.setItem(k,'1');sendNotification(`📊 RSI Divergence: ${d.s}`,`Bullish divergence · Conf ${d.conf}%`,k);}
  });
  picks.filter(p=>p.passes&&p.bb?.squeeze).slice(0,1).forEach(sq=>{
    const k='squeeze-'+sq.s+'-'+today;
    if(!sessionStorage.getItem(k)){sessionStorage.setItem(k,'1');sendNotification(`⚡ BB Squeeze: ${sq.s}`,`Bollinger squeeze — breakout imminent · Conf ${sq.conf}%`,k);}
  });
}
const _alertedBreakouts = new Set();
function fireBreakoutAlerts(results) {
  if (typeof Notification==='undefined'||Notification.permission!=='granted') return;
  results.filter(r=>r.score>=7).forEach(r=>{
    const sigType = r.ema?.goldenCross?'GOLDEN_CROSS':r.ema?.deathCross?'DEATH_CROSS':r.wk52?.breakHigh?'52WK_HIGH':r.wk52?.breakLow?'52WK_LOW':r.pdhl?.bullBreakout?'PDH_BREAK':r.pdhl?.bearBreakout?'PDL_BREAK':r.st?.crossed?(r.st.trend==='UP'?'ST_UP':'ST_DOWN'):'GENERIC';
    const k = r.s+'_'+sigType;
    if (_alertedBreakouts.has(k)) return; _alertedBreakouts.add(k);
    sendNotification(`${r.isBull?'📈':'📉'} Breakout: ${r.s} ${r.dir} (${r.score}/10)`, `${sigType.replace(/_/g,' ')} · ₹${r.ltp} → Target ₹${r.trade?.target} · SL ₹${r.trade?.sl}`, 'bo_'+k);
  });
}

export default function StocksPane() {
  const { token, cfg, marketStatus, lg, onTokenExpired, updateBadge, gh,
            setScanning, setStatusDot, setStatusTxt,
           stocks, fiiInterp, setTickerStats, confCalibration, adaptWeights, mlModels } = useApp();

  const [mode, setMode]               = useState('picks');
  const [picksLoading, setPicksLoading] = useState(false);
  const [picksError, setPicksError]     = useState('');
  const [picks, setPicks]               = useState([]);
  const [scanStats, setScanStats]       = useState(null);
  const [picksTime, setPicksTime]       = useState('');
  const [pickProgress, setPickProgress] = useState('');
  const [picksScanId, setPicksScanId]   = useState(0);
  const [boLoading, setBoLoading]     = useState(false);
  const [boError, setBoError]         = useState('');
  const [boCards, setBoCards]         = useState([]);
  const [boStats, setBoStats]         = useState(null);
  const [boTime, setBoTime]           = useState('');
  const [boProgress, setBoProgress]   = useState('');
  const [boFilter, setBoFilter]       = useState('all');
  const [popupStock, setPopupStock]   = useState(null); // breakout chart popup
  const [popupPick,  setPopupPick]    = useState(null); // stock picks chart popup
  const scanInProgress = useRef(false);

  // ── Index WebSocket ──────────────────────────────────────────
  const { lastPrices: liveIndexPrices, connected: idxConnected } = useMarketFeed(
    token, INDEX_WS_KEYS, !!token
  );

  // ── Closed-market fallback: fetch index prices when WS has no data ──
  const [closedIdxPrices, setClosedIdxPrices] = useState({});
  useEffect(() => {
    if (marketStatus.open || !token) return;
    if (Object.keys(liveIndexPrices).length > 0) return; // WS already has data
    fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|Nifty Bank,NSE_INDEX|India VIX', token, onTokenExpired)
      .then(q => {
        const out = {};
        ['NSE_INDEX|Nifty 50','NSE_INDEX|Nifty Bank','NSE_INDEX|India VIX'].forEach(k => {
          const d = q[k];
          if (d?.last_price > 0) out[k] = {
            ltp:     d.last_price,
            chgPct:  d.net_change ? +(d.net_change / (d.last_price - d.net_change) * 100).toFixed(2) : 0,
          };
        });
        if (Object.keys(out).length) setClosedIdxPrices(out);
      })
      .catch(() => {});
  }, [marketStatus.open, token]); // eslint-disable-line

  // Merge: WS prices take priority; closed-market REST prices as fallback
  const idxPrices = { ...closedIdxPrices, ...liveIndexPrices };

  // ── Derive live index values (idxPrices MUST be declared above this line) ──
  const niftyLTP    = idxPrices['NSE_INDEX|Nifty 50']?.ltp    || 0;
  const niftyChgPct = idxPrices['NSE_INDEX|Nifty 50']?.chgPct || 0;
  const niftyPts    = niftyLTP > 0 ? +(niftyChgPct / 100 * niftyLTP).toFixed(2) : 0;
  const bnkLTP      = idxPrices['NSE_INDEX|Nifty Bank']?.ltp    || 0;
  const bnkChgPct   = idxPrices['NSE_INDEX|Nifty Bank']?.chgPct || 0;
  const bnkPts      = bnkLTP > 0 ? +(bnkChgPct / 100 * bnkLTP).toFixed(2) : 0;
  const vixLTP      = idxPrices['NSE_INDEX|India VIX']?.ltp     || 0;

  // ── Stock picks WebSocket ──
  const topKeys = picks.slice(0, 20).map(p => p.key).filter(Boolean);
  const { lastPrices: stockPrices, connected: wsConnected, wsMode } = useMarketFeed(
    token, topKeys, marketStatus.open && picks.length > 0
  );

  useEffect(() => {
    const onScan = () => { mode==='breakout' ? runBreakoutScan() : runPicksScan(); };
    document.addEventListener('friday:scan', onScan);
    return () => document.removeEventListener('friday:scan', onScan);
  }, [mode]); // eslint-disable-line

  useEffect(() => {
    if (!token) return;
    if (marketStatus.open) setTimeout(() => runPicksScan(), 2000);
  }, [token]); // eslint-disable-line

  // ── PICKS SCAN ────────────────────────────────────────────────
  async function runPicksScan() {
    if (scanInProgress.current) return;
    if (!stocks?.length) { setPicksError('⚠ stocks.json not loaded — configure GitHub in ⚙ Settings first'); return; }
    scanInProgress.current = true;
    setScanning(true); setStatusDot('scan'); setStatusTxt('Scanning...');
    setPicksLoading(true); setPicksError('');
    setPickProgress('');
    setPicks([]);
    setPicksTime('');
    try {
      // Use live WS prices; if not yet populated, fetch via REST
      let nLtp    = niftyLTP;
      let nChgPct = niftyChgPct;
      let vixVal  = vixLTP;
      if (!nLtp) {
        const idxD = await fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|India VIX', token, onTokenExpired);
        const nQ = idxD['NSE_INDEX|Nifty 50'], vQ = idxD['NSE_INDEX|India VIX'];
        nLtp    = nQ?.last_price || 0;
        nChgPct = getChgPct(nQ);
        vixVal  = vQ?.last_price || 0;
      }
      const nBull = nChgPct > -0.3;
      const { sc: vixSc } = interpVIX(vixVal);

      // PCR
      setPickProgress('Step 2: Fetching PCR...');
      let pcr=1, pcrTxt='Neutral', pcrSc=50;
      try {
        const expRes = await fetch(
          `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent('NSE_INDEX|Nifty 50')}`,
          {headers:{Authorization:'Bearer '+token,Accept:'application/json'}}
        ).then(r=>r.json());
        const exps = (expRes?.data?.map(e=>e.expiry)||[]).sort();
        if (exps.length) {
          const chain = await fetchOptions('NSE_INDEX|Nifty 50',exps[0],token,onTokenExpired);
          const ceOI = chain.reduce((s,x)=>s+(x.call_options?.market_data?.oi||0),0);
          const peOI = chain.reduce((s,x)=>s+(x.put_options?.market_data?.oi||0),0);
          pcr = ceOI>0 ? +(peOI/ceOI).toFixed(2) : 1;
          const pi = interpPCR(pcr); pcrTxt=pi.txt; pcrSc=pi.sc;
        }
      } catch(e) { lg('PCR: '+e.message,'w'); }

      const sent   = nChgPct>0.5?'BULLISH':nChgPct<-0.5?'BEARISH':'NEUTRAL';
      const sentSc = Math.round(Math.min(Math.max((nChgPct+3)/6*10,1),10));

      // Step 3 — All stock quotes via WebSocket (one connection, all stocks at once)
      // Falls back to batched REST if WS fails
      setPickProgress('Step 3/5: Fetching quotes via WebSocket...');
      const scanList = stocks.filter(s=>s.scan!==false);
      let rawQ = {};
      try {
        rawQ = await fetchScanQuotesViaWS(token, scanList.map(s=>s.key));
        const wsCount = Object.keys(rawQ).filter(k=>rawQ[k]?.last_price>0).length;
        lg(`WS quotes: ${wsCount}/${scanList.length} stocks`,'o');
        // Fallback to REST for any missing keys
        const missing = scanList.filter(s=>!rawQ[s.key]?.last_price).map(s=>s.key);
        if (missing.length > 0) {
          lg(`REST fallback for ${missing.length} missing quotes`,'w');
          for (let b=0; b<Math.ceil(missing.length/50); b++) {
            const sl = missing.slice(b*50,(b+1)*50);
            Object.assign(rawQ, await fetchQ(sl.join(','),token,onTokenExpired).catch(()=>({})));
            if ((b+1)*50 < missing.length) await sleep(200);
          }
        }
      } catch(e) {
        lg(`WS quotes failed (${e.message}), falling back to REST`,'w');
        for (let b=0; b<Math.ceil(scanList.length/50); b++) {
          const sl = scanList.slice(b*50,(b+1)*50);
          setPickProgress(`Step 3/5: REST quotes ${Math.min((b+1)*50,scanList.length)}/${scanList.length}`);
          Object.assign(rawQ, await fetchQ(sl.map(s=>s.key).join(','),token,onTokenExpired).catch(()=>({})));
          if ((b+1)*50<scanList.length) await sleep(200);
        }
      }
      // All quoted stocks sorted by volume — same as HTML's `byVol = quoted`
      const byVol = scanList.map(s=>({...s,_q:rawQ[s.key]})).filter(s=>s._q?.last_price)
        .sort((a,b)=>(b._q.volume||0)-(a._q.volume||0));

      // Step 4 — Candles for TOP 20 only (exact HTML: staggered batches of 3, 220ms apart)
      setPickProgress('Step 4/5: Fetching candle history (staggered)...');
      const today  = getISTDate();
      const from60 = new Date(Date.now()-65*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
      const top20  = byVol.slice(0, Math.min(20, byVol.length));
      const tech   = {};
      let candleOK = 0;
      const CANDLE_BATCH = 3;
      for (let b=0; b<top20.length; b+=CANDLE_BATCH) {
        const batch = top20.slice(b, b+CANDLE_BATCH);
        setPickProgress(`Step 4/5: Candles ${b+1}–${Math.min(b+CANDLE_BATCH,top20.length)}/20...`);
        const fetched = await Promise.allSettled(
          batch.map((inst,idx) => sleep(idx*220).then(() =>
            fetchCandles(inst.key,from60,today,'day',token,onTokenExpired)
              .then(candles=>({inst,candles}))
          ))
        );
        for (const res of fetched) {
          if (res.status!=='fulfilled') { lg('Candle batch error: '+res.reason,'w'); continue; }
          const {inst, candles} = res.value;
          if (candles.length>=5) {
            const closes   = candles.map(c=>+c[4]).reverse();
            const rc       = candles.slice(0,20);
            const avgVol20 = rc.reduce((s,x)=>s+(+x[5]||0),0)/Math.max(1,rc.length);
            const _macd    = calcMACD(closes);
            const _bb      = calcBBSqueeze(closes);
            const _adx     = calcADX(candles);
            const _vwapB   = calcVWAPBands(candles);
            const _rsiDiv  = calcRSIDivergence(candles);   // HTML passes candles, not closes
            const instLtp = inst._q?.last_price || 0;
            const isAboveMA = (cls, p) => cls.length >= p ? cls[cls.length-1] > cls.slice(-p).reduce((a,b)=>a+b,0)/p : null;
            tech[inst.s] = {
              rsi:      calcRSI(closes),
              macdBull: _macd ? _macd.bullish : (closes.length>=35 ? (calcEMA(closes,12)-calcEMA(closes,26))>0 : null),
              macd:     _macd,
              bb:       _bb,
              adx:      _adx,
              vwapBands:_vwapB,
              rsiDiv:   _rsiDiv,
              a50:      isAboveMA(closes, 50),
              a200:     isAboveMA(closes, 200),
              atr:      calcATR(candles),
              patterns: detectPatterns(candles),
              avgVol20, sr: calcSR(candles), vwap: calcVWAP(candles),
              candles, closes,
            };
            candleOK++;
          }
        }
        if (b+CANDLE_BATCH<top20.length) await sleep(300);
      }
      lg(`✅ Candle data: ${candleOK}/${top20.length} stocks`,'o');

      // Step 5 — Pre-build secMap from ALL quoted (exact HTML)
      setPickProgress('Step 5/5: Calculating scores...');
      const secMap = {};
      for (const item of byVol) {
        const sec = getSector(item.s);
        if (!secMap[sec]) secMap[sec]={g:0,c:0};
        if (getChgPct(item._q)>0) secMap[sec].g++;
        secMap[sec].c++;
      }

      // Score ALL byVol stocks (exact HTML — stocks beyond top20 get empty tech={})
      const allScored=[], results=[];
      for (const item of byVol) {
        const q   = item._q;
        const ltp = q.last_price;
        const high= q.ohlc?.high||ltp, low=q.ohlc?.low||ltp, vol=q.volume||0;
        const chgPct = getChgPct(q);
        const t      = tech[item.s] || {};
        const patterns= t.patterns||{};
        const sr      = t.sr||{};
        const vwap    = t.vwap||0;
        const nearSupp= isNearSupport(ltp,sr,low);
        const delivPct= getDeliveryPct(q);
        const sec     = getSector(item.s);
        const secSc   = secMap[sec] ? Math.round(secMap[sec].g/secMap[sec].c*100) : 50;
        const aboveVWAP = vwap>0 ? ltp>=vwap : null;
        const vwapBands = t.vwapBands||null;
        const avgVol20  = t.avgVol20||0;
        const _isHoliday= getIntradayPhase()==='holiday'||!marketStatus.open;
        const effectiveVol = (_isHoliday&&vol===0) ? (avgVol20||1) : vol;
        const volOk    = avgVol20>0 ? effectiveVol>=avgVol20*(cfg.vol||1.2) : null;

        // preRec from R:R (exact HTML)
        const {sl,target:tgtMod,targets}=autoSLTarget(ltp,high,low,t.atr||0,sr,vixVal,t.rsi||null);
        const preRR  = (sl>0&&ltp>sl) ? (tgtMod-ltp)/(ltp-sl) : 2;
        const preRec = preRR>=2.0?'BUY':preRR>=1.5?'MODERATE':'WATCH';

        const numInds = countIndicatorsEx(t.rsi,t.macdBull,t.a50,t.a200,volOk,nearSupp,patterns,preRec,t.macd,t.bb,t.adx,t.rsiDiv);
        let conf = calcConfidence(null,vixSc,pcrSc,nBull,secSc,effectiveVol,avgVol20||effectiveVol,patterns,preRec,numInds);

        // Enhancements (exact HTML order)
        if(t.macd?.bullCross)                      conf=Math.min(99,conf+6);
        if(t.macd?.histRising&&t.macd?.bullish)    conf=Math.min(99,conf+3);
        if(t.macd?.bearCross)                      conf=Math.max(1, conf-8);
        if(t.bb?.squeeze)                          conf=Math.min(99,conf+5);
        if(t.bb?.nearLowerBand)                    conf=Math.min(99,conf+4);
        if(t.bb?.percentB>1.0)                     conf=Math.max(1, conf-5);
        if(t.adx?.bullTrend)                       conf=Math.min(99,conf+5);
        if(t.adx?.bearTrend)                       conf=Math.max(1, conf-6);
        if(t.adx&&!t.adx.trending&&!t.adx.weakTrend) conf=Math.max(1,conf-3);
        if(t.rsiDiv?.bullish)        conf=Math.min(99,conf+7+Math.min(5,t.rsiDiv.strength||0));
        if(t.rsiDiv?.hidden_bullish) conf=Math.min(99,conf+4);
        if(t.rsiDiv?.bearish)        conf=Math.max(1, conf-8);
        if(t.rsiDiv?.hidden_bearish) conf=Math.max(1, conf-4);
        if(vwapBands?.nearLowerBand)               conf=Math.min(99,conf+3);
        if(vwapBands?.position==='FAR_ABOVE'||vwapBands?.position==='ABOVE_1SD') conf=Math.max(1,conf-4);
        const delivBoost=delivPct!=null?(delivPct>=60?1:delivPct<=25?-1:0):0;
        conf=Math.min(100,Math.max(0,conf+delivBoost*5));
        conf=applyFIIBias(conf,preRec==='BUY'||preRec==='STRONG BUY',null);
        conf=applyCalibration(conf, confCalibration||null);
        // Layer 3: per-indicator learned adjustment from past signal outcomes
        const reversal = detectReversal(ltp,t.rsi,patterns,sr,vixVal,pcr,nBull,chgPct,t.atr||0,high,low);
        const _indSnap = {
          macdBull: t.macdBull===true, macdBullCross: t.macd?.bullCross===true,
          macdBearCross: t.macd?.bearCross===true, bbSqueeze: t.bb?.squeeze===true,
          bbNearLower: t.bb?.nearLowerBand===true, adxBull: t.adx?.bullTrend===true,
          adxBear: t.adx?.bearTrend===true, rsiDiv: t.rsiDiv?.bullish===true,
          rsiDivHidden: t.rsiDiv?.hidden_bullish===true, rsiBearDiv: t.rsiDiv?.bearish===true,
          a50: t.a50===true, a200: t.a200===true, nearSupp: !!nearSupp,
          aboveVWAP: aboveVWAP===true, vwapNearLower: vwapBands?.nearLowerBand===true,
          engulfing: patterns?.bullishEngulfing===true, hammer: patterns?.hammer===true,
          morningStar: patterns?.morningStar===true,
          reversalFired: (reversal?.type||'NONE')!=='NONE',
          delivHigh: (delivPct??0)>=60, delivLow: (delivPct??100)<=25,
        };
        conf=applyAdaptWeights(conf, adaptWeights?.stock||null, _indSnap);

        const risk2=(ltp-sl); const useS1=sl>0&&sr?.pivotS1>0&&Math.abs(sl-sr.pivotS1)<risk2*0.3;
        const slTargets={consMethod:useS1?'S1 support':'ATR+VIX',modMethod:'2:1 R:R'};
        const pot  = calcPotential(ltp,tgtMod,sl,numInds,preRec);
        const risk = calcRisk(ltp,sl,tgtMod,t.atr||0,vixVal);
        const mlRank = applyMlRanking(conf, mlModels || null, {
          type: 'STOCK',
          confidence: conf,
          numInds,
          risk,
          pot,
          rec: preRec,
          nearSupp,
          aboveVWAP,
          delivPct,
          reversal,
          _indSnap,
        });
        conf = mlRank.confidence;
        conf=Math.min(99,Math.max(1,Math.round(conf)));
        const rec  = getRec(conf,pot.base,risk,pot.rr);
        const aiThresholds = mlModels?.thresholds?.stock || null;
        // Raised minStockConf default 50→65 and excluded WATCH/AVOID — your data shows <30% WR below 65%
        const passes = !mlRank.aiBlock
          && conf >= (aiThresholds?.minConfidence || cfg.minStockConf || 65)
          && pot.base >= (cfg.pot || 3)
          && risk < (aiThresholds?.maxRisk || cfg.risk || 55)
          && pot.rr >= (aiThresholds?.minRR || cfg.rr || 1.2)
          && rec !== 'WATCH' && rec !== 'AVOID';

        const entryTrigger=calcEntryTrigger(ltp,high,sr,t.atr||0,rec,vwap,chgPct);
        const macd=t.macd||{}, macdBull=t.macdBull, bb=t.bb, adx=t.adx, rsiDiv=t.rsiDiv;
        const a50=t.a50, a200=t.a200, nearSuppF=nearSupp;
        const scored = {
          s:item.s, n:item.n, key:item.key, sec:item.sec||sec,
          ltp, chgPct, rsi:t.rsi, conf, rec, passes,
          sl, target:tgtMod, pot:{...targets,rr:pot.rr,wr:pot.wr||0,base:pot.base,adj:pot.adj||0,ev:pot.ev||0},
          risk, atr:t.atr||0, numInds, slTargets,
          macd, macdBull, bb, adx, rsiDiv,
          a50, a200, nearSupp:nearSuppF, patterns,
          vwap, aboveVWAP, vwapType:'daily', vwapBands,
          vol, avgVol20, high, low, delivPct,
          _indSnap,
          mlProbability: mlRank.mlProbability,
          mlAdj: mlRank.mlAdj,
          mlExplain: mlRank.explanation,
          aiBlock: mlRank.aiBlock,
          aiModel: mlRank.servingLabel,
          entryTrigger, reversal,
          recentCandles:(t.candles||[]).slice(0,20), closes:t.closes||[],
        };
        allScored.push(scored);
        if (passes && rec!=='AVOID') results.push(scored);
        secMap[sec].g+=rec==='BUY'||rec==='STRONG BUY'?1:0;
      }

      // Log score distribution (same as HTML)
      const confBuckets={0:0,30:0,40:0,50:0,60:0,70:0,80:0};
      allScored.forEach(s=>{ const b=Math.floor(s.conf/10)*10; const k=[0,30,40,50,60,70,80].reverse().find(k=>b>=k)||0; confBuckets[k]++; });
      lg(`Score dist: ${JSON.stringify(confBuckets)} (threshold: ${cfg.minStockConf||50}%)`);
      lg(`Passes: pot≥${cfg.pot||3}%=${allScored.filter(s=>s.pot.base>=(cfg.pot||3)).length} risk<${cfg.risk||55}%=${allScored.filter(s=>s.risk<(cfg.risk||55)).length} rr≥${cfg.rr||1.2}=${allScored.filter(s=>s.pot.rr>=(cfg.rr||1.2)).length} conf≥${cfg.minStockConf||50}%=${allScored.filter(s=>s.conf>=(cfg.minStockConf||50)).length}`);

      results.sort((a,b)=>b.conf-a.conf);

      // ── MTF 30-min boost for top 5 picks (exact HTML port) ──
      const today2=getISTDate();
      const from7d=new Date(Date.now()-10*864e5).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
      const top5=results.slice(0,5);
      await Promise.allSettled(top5.map(async(p,idx)=>{
        await sleep(idx*300);
        try{
          const c30=await fetchCandles(p.key,from7d,today2,'30minute',token,onTokenExpired);
          if(c30.length<8) return;
          const cl30=c30.map(c=>+c[4]).reverse();
          const macd30=calcMACD(cl30),adx30=calcADX(c30),rsi30=calcRSI(cl30);
          const trend30=cl30[cl30.length-1]>cl30[Math.max(0,cl30.length-8)]?'UP':'DOWN';
          let mtfBoost=0;
          const isBuyRec=p.rec==='BUY'||p.rec==='STRONG BUY';
          if(isBuyRec){
            if(trend30==='UP')            mtfBoost+=4;
            if(macd30?.bullish)           mtfBoost+=3;
            if(macd30?.bullCross)         mtfBoost+=4;
            if(adx30?.bullTrend)          mtfBoost+=3;
            if(rsi30&&rsi30>=45&&rsi30<=72) mtfBoost+=2;
          }
          if(mtfBoost>0){
            p.conf=Math.min(99,p.conf+mtfBoost);
            p.mtfBoost=mtfBoost;
            p.mtfNote=`30min:${trend30}${macd30?.bullCross?' MACD✕':''}${adx30?.bullTrend?' ADX':''}`;
            lg(`MTF ${p.s}: +${mtfBoost}pts (${p.mtfNote})`,'o');
          }
        }catch(e){ lg('MTF '+p.s+': '+e.message,'w'); }
      }));
      // Re-sort after MTF boost may change conf, cap at 12 like HTML
      results.sort((a,b)=>b.conf-a.conf);
      const cappedResults = results.slice(0, 12);

      // ── Fallback: if 0 picks pass all filters, show top-5 by conf (exact HTML)
      let finalPicks = cappedResults;
      if (!finalPicks.length && allScored.length > 0) {
        lg('⚠ 0 stocks passed all filters → showing top 5 by confidence. Relax thresholds in ⚙ Settings.','w');
        finalPicks = allScored
          .filter(s => s.conf >= (cfg.minStockConf||50))
          .sort((a,b) => b.conf - a.conf)
          .slice(0, 5)
          .map(s => ({...s, passes:false, _fallback:true}));
        if (!finalPicks.length)
          finalPicks = allScored.sort((a,b) => b.conf-a.conf).slice(0,5).map(s=>({...s,_fallback:true}));
      }

      const topSec=Object.entries(secMap).filter(([,v])=>v.c>0).sort((a,b)=>(b[1].g/b[1].c)-(a[1].g/a[1].c))[0]?.[0]||'Mixed';
      const scanId = Date.now();
      const nextPicks = finalPicks.map((pick) => ({ ...pick, _scanId: scanId }));
      setPicksScanId(scanId);
      setPicks(nextPicks);
      setScanStats({pcr,pcrTxt,sent,sentSc,topSec,cnt:finalPicks.length,totalScanned:byVol.length});
      setTickerStats({ vix:vixVal, pcr, sentiment:sent, sentSc, topSec });
      updateBadge('stocks',String(finalPicks.length));
      setPicksTime('Updated: ' + getIST());
      setStatusDot('live'); setStatusTxt('Live');
      lg(`✅ Picks: ${finalPicks.length} from ${byVol.length} stocks`,'o');
      if (!finalPicks.length) lg(`⚠ 0 picks — lower Conf(${cfg.minStockConf}%)/Pot(${cfg.pot}%)/Risk(${cfg.risk}%) in ⚙ Settings`,'w');
      // Don't log WATCH/AVOID — they have <15% WR and pollute calibration data
      const loggablePicks = finalPicks.filter(p=>!p._fallback && p.rec!=='WATCH' && p.rec!=='AVOID');
      if (loggablePicks.length&&gh?.token) logSignals(gh,loggablePicks.map(p=>buildStockSignal(p,vixVal)),vixVal,lg);
      checkPickAlerts(nextPicks, cfg);

      // ── Background intraday enrichment for picks ───────
      // Fetch 5-min candles for each pick → VWAP, intraday momentum, volume confirmation
      if (marketStatus.open && nextPicks.length > 0) {
        const topPicks = nextPicks.filter(p => !p._fallback).slice(0, 15);
        Promise.allSettled(topPicks.map(async (pick, idx) => {
          await sleep(idx * 250);
          try {
            const c5 = await fetchIntraday(pick.key, '5minute', resolvedToken, onTokenExpired);
            if (!c5 || c5.length < 5) return;
            const vwap5       = calcVWAP(c5);
            const vwapSig     = vwap5 ? calcStockVWAPSignal(pick.ltp, vwap5) : null;
            const closes5     = c5.map(c => +c[4]).reverse();
            const ema5v       = calcEMA(closes5, 5);
            const ema13v      = calcEMA(closes5, 13);
            const intraVolCur = +(c5[0]?.[5] || 0);
            const intraVolAvg = c5.length > 5
              ? c5.slice(1, Math.min(21,c5.length)).reduce((s,c)=>s+(+c[5]||0),0) / Math.min(20,c5.length-1)
              : 0;
            const intraVolRatio = intraVolAvg > 0 ? +(intraVolCur/intraVolAvg).toFixed(2) : null;
            const intraBull   = ema5v[ema5v.length-1] != null && ema13v[ema13v.length-1] != null
              ? ema5v[ema5v.length-1] > ema13v[ema13v.length-1] : null;
            const intraAccel  = ema5v.length >= 2 && ema5v[ema5v.length-1] > ema5v[ema5v.length-2];
            // Adjust confidence based on intraday signals
            let confBoost = 0;
            if (vwapSig?.aboveVWAP && (pick.rec==='BUY'||pick.rec==='STRONG BUY')) confBoost += 4;
            if (vwapSig?.aboveVWAP === false && pick.rec?.includes('SELL'))         confBoost += 4;
            if (intraVolRatio >= 2)   confBoost += 5;
            else if (intraVolRatio >= 1.5) confBoost += 3;
            else if (intraVolRatio < 0.5)  confBoost -= 4; // very low intraday volume
            if (intraBull !== null && intraBull === (pick.rec==='BUY'||pick.rec==='STRONG BUY')) confBoost += 3;
            if (intraAccel) confBoost += 2;
            setPicks(prev => prev.map(p => p.key === pick.key ? {
              ...p,
              stockVWAP: vwapSig,
              intraVolRatio,
              intraBull,
              intraAccel,
              conf: Math.min(99, Math.max(1, Math.round(p.conf + confBoost))),
            } : p));
          } catch(_) {}
        }));
      }
    } catch(e) {
      setPicksError(e.message); setStatusDot('err'); setStatusTxt('Error');
      lg('Scan error: '+e.message,'e');
    } finally {
      setPicksLoading(false); setScanning(false); scanInProgress.current=false;
    }
  }

  // ── BREAKOUT SCAN ─────────────────────────────────────────────
  async function runBreakoutScan() {
    if (boLoading) return;
    if (!stocks?.length) { setBoError('⚠ stocks.json not loaded — configure GitHub in ⚙ Settings first'); return; }
    setBoLoading(true); setBoError(''); setBoProgress('Fetching quotes...');
    try {
      const today=getISTDate();
      const from52=new Date(Date.now()-375*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
      let niftyCloses=[];
      try { niftyCloses=(await fetchCandles('NSE_INDEX|Nifty 50',from52,today,'day',token,onTokenExpired)).map(c=>+c[4]).reverse(); } catch(e){}
      const scanList=stocks.filter(s=>s.scan!==false);
      // WebSocket quotes — same as picks scan
      setBoProgress('Fetching quotes via WebSocket...');
      let rawQ={};
      try {
        rawQ = await fetchScanQuotesViaWS(token, scanList.map(s=>s.key));
        const missing=scanList.filter(s=>!rawQ[s.key]?.last_price).map(s=>s.key);
        if (missing.length>0) {
          for (let b=0;b<Math.ceil(missing.length/50);b++) {
            Object.assign(rawQ, await fetchQ(missing.slice(b*50,(b+1)*50).join(','),token,onTokenExpired).catch(()=>({})));
            if((b+1)*50<missing.length) await sleep(200);
          }
        }
      } catch(e) {
        lg(`BO WS quotes failed (${e.message}), falling back to REST`,'w');
        for (let b=0;b<Math.ceil(scanList.length/50);b++) {
          Object.assign(rawQ, await fetchQ(scanList.slice(b*50,(b+1)*50).map(s=>s.key).join(','),token,onTokenExpired).catch(()=>({})));
          if((b+1)*50<scanList.length) await sleep(200);
        }
      }
      const byVol=scanList.map(s=>({...s,_q:rawQ[s.key]})).filter(s=>s._q?.last_price)
        .sort((a,b)=>(b._q.volume||0)-(a._q.volume||0)).slice(0,80);
      const techB={};
      for (let b=0; b<byVol.length; b+=3) {
        setBoProgress(`Candles ${b+1}–${Math.min(b+3,byVol.length)} / ${byVol.length}`);
        await Promise.allSettled(byVol.slice(b,b+3).map(async(inst,idx)=>{
          await sleep(idx*200);
          try {
            const [daily,weekly]=await Promise.all([
              fetchCandles(inst.key,from52,today,'day',token,onTokenExpired),
              fetchCandles(inst.key,from52,today,'week',token,onTokenExpired).catch(()=>[]),
            ]);
            if (daily.length>=10) {
              const closes=daily.map(c=>+c[4]).reverse();
              techB[inst.s]={closes,candles:daily,weekly,atr:calcATR(daily),ema:calcEMACrossover(closes),st:calcSupertrend(daily)};
            }
          } catch(e){}
        }));
        if (b+3<byVol.length) await sleep(350);
      }
      setBoProgress('Computing signals...');
      const phase=getIntradayPhase(), results=[];
      for (const item of byVol) {
        const q=item._q, ltp=q.last_price, t=techB[item.s]; if(!t) continue;
        const ema=t.ema, st=t.st;
        const pdhl=detectPDHLBreakout(ltp,t.candles), vol=calcVolumeSurge(t.candles);
        const wk52=calc52WkBreakout(ltp,t.candles), nr7=calcNR7(t.candles), bb=calcBBSqueeze(t.closes);
        const gap=detectGap(t.candles), adx=calcADX(t.candles);
        const rs=calcRelativeStrength(t.closes,niftyCloses), wick=calcWickRejection(t.candles);
        const dir=boDirection(ema,pdhl,st), isBull=dir==='BULL';
        const mom=calcMomentumConfluence(t.closes,isBull), wMTF=calcWeeklyMTF(t.weekly,ltp,isBull);
        // sector score: use secMap from picks scan if available, else fallback to stock's own day change
        const sec=item.sec||item.s;
        const secChgPct=item._q && item._q.ohlc?.close > 0
          ? ((item._q.last_price - item._q.ohlc.close) / item._q.ohlc.close * 100) : 0;
        const secMapEntry = scanStats?.secMap?.[item.sec];
        const sectorScore = secMapEntry != null
          ? (secMapEntry > 0.5 ? 1 : secMapEntry < -0.5 ? -1 : 0)
          : (secChgPct > 1 ? 1 : secChgPct < -1 ? -1 : 0);
        const {score}=boScore(ema,pdhl,st,vol,wk52,mom,nr7,bb,wMTF,gap,adx,rs,wick,sectorScore,phase);
        const minScore=(phase==='holiday'||phase==='closed'||phase==='pre')?1:2;
        if (score<minScore) continue;
        const trade=boSLTarget(ltp,t.atr,isBull,pdhl?.pdh||0,pdhl?.pdl||0,ema?.ema200||0);
        const boVol=q.volume||0;
        // IV Percentile — ATR-based IV proxy, same as HTML
        const ivProxy=t.atr>0?(t.atr/ltp*100*Math.sqrt(252)):null;
        const ivPct=calcIVPercentile(ivProxy,t.closes);
        // Primary signal type for display/logging
        const primaryType=ema?.goldenCross?'GOLDEN_CROSS':ema?.deathCross?'DEATH_CROSS'
          :wk52?.breakHigh?'52WK_HIGH':wk52?.breakLow?'52WK_LOW'
          :pdhl?.bullBreakout?'PDH_BREAK':pdhl?.bearBreakout?'PDL_BREAK'
          :st?.crossed?(st.trend==='UP'?'ST_CROSS_UP':'ST_CROSS_DOWN'):'GENERIC';
        results.push({
          ...item, ltp, chgPct:getChgPct(q), ema, pdhl, st, vol, score, dir, wk52, mom, nr7, bb, gap, adx, rs, wMTF, wick,
          trade, atr:t.atr, isBull, phase, sectorScore, sec:item.sec||item.s||'NSE',
          ivPct, primaryType,
          rec:isBull?(score>=7?'STRONG BUY':'BUY'):(score>=7?'SELL':'WATCH'),
          conf:Math.min(95,score*10), sl:trade.sl, target:trade.target,
          pot:{cons:trade.sl,mod:trade.target,agg:trade.target,rr:trade.rr,wr:0,base:0,adj:0,ev:0},
          numInds:score, risk:50, rsi:null, high:q.ohlc?.high||ltp, low:q.ohlc?.low||ltp,
          rawVol:boVol, avgVol20:0, macd:{}, rsiDiv:null, patterns:{},
          a50:ema?.uptrend||false, a200:ltp>(ema?.ema200||0),
          nearSupp:false, vwap:0, aboveVWAP:null, vwapType:'daily',
          entryTrigger:{trigger:trade.sl,method:isBull?'Break above PDH':'Break below PDL',alreadyTriggered:false},
          reversal:{type:'NONE'}, recentCandles:t.candles.slice(0,20), closes:t.closes,
        });
      }
      results.sort((a,b)=>{
        const ap=(a.wk52?.breakHigh||a.wk52?.breakLow?2:0)+(a.ema?.goldenCross||a.ema?.deathCross?2:0);
        const bp=(b.wk52?.breakHigh||b.wk52?.breakLow?2:0)+(b.ema?.goldenCross||b.ema?.deathCross?2:0);
        return bp-ap||b.score-a.score;
      });
      const goldCross =results.filter(r=>r.ema?.goldenCross).length;
      const deathCross=results.filter(r=>r.ema?.deathCross).length;
      const pdhBreak  =results.filter(r=>r.pdhl?.bullBreakout).length;
      const pdlBreak  =results.filter(r=>r.pdhl?.bearBreakout).length;
      const stCrossed =results.filter(r=>r.st?.crossed).length;
      const wk52Hi    =results.filter(r=>r.wk52?.breakHigh||r.wk52?.atHigh).length;
      const volSurge  =results.filter(r=>r.vol?.confirmed||r.vol?.strong).length;
      // Attach _whyLines for popup signal analysis
      const resultsWithWhy = results.map(r => ({
        ...r,
        _whyLines: [
          r.pdhl?.bullBreakout   && 'PDH breakout — price breaking previous day high',
          r.pdhl?.bearBreakout   && 'PDL breakdown — price breaking previous day low',
          r.pdhl?.nearPDH        && 'Near PDH — approaching resistance zone',
          r.pdhl?.nearPDL        && 'Near PDL — approaching support zone',
          r.ema?.goldenCross     && 'Golden cross — EMA 50 crossed above EMA 200',
          r.ema?.deathCross      && 'Death cross — EMA 50 crossed below EMA 200',
          r.ema?.nearCross       && 'Near EMA cross — convergence in progress',
          r.ema?.aboveAll        && 'Price above EMA 9, 21, 50, 200 — strong trend',
          r.ema?.belowAll        && 'Price below all EMAs — strong downtrend',
          r.st?.crossed          && `Supertrend ${r.st.bull ? 'bullish' : 'bearish'} crossover`,
          r.vol?.strong          && `Strong volume surge ${r.vol.ratio}× above average`,
          r.vol?.confirmed       && `Volume confirmed breakout ${r.vol.ratio}× average`,
          r.wk52?.breakHigh      && '52-week high breakout — multi-year resistance cleared',
          r.wk52?.breakLow       && '52-week low breakdown — multi-year support broken',
          r.wk52?.atHigh         && 'At 52-week high — momentum peak zone',
          r.nr7?.isNR7           && 'NR7 — narrowest range in 7 days, volatility expansion expected',
          r.nr7?.isNR4           && 'NR4 — narrowest range in 4 days',
          r.bb?.extremeSqueeze   && 'Extreme Bollinger Band squeeze — major move imminent',
          r.bb?.squeeze          && 'Bollinger Band squeeze — range compression',
          r.gap?.gapUp           && `Gap up ${r.gap.pct?.toFixed(1)}% — bullish opening strength`,
          r.gap?.gapDown         && `Gap down ${r.gap.pct?.toFixed(1)}% — bearish opening weakness`,
          r.rs?.outperforming    && `Relative strength +${r.rs.rs}% vs Nifty — sector leader`,
          r.rs?.underperforming  && `Relative weakness ${r.rs.rs}% vs Nifty`,
          r.wick?.strongBull     && 'Strong wick rejection — buyers defending support',
          r.wick?.strongBear     && 'Strong bearish wick — sellers rejecting rally',
          r.mom?.accelerating    && 'Momentum accelerating — trend strengthening',
          r.adx?.strong          && `ADX ${r.adx.adx?.toFixed(0)} — strong trending market`,
        ].filter(Boolean),
      }));
      setBoCards(resultsWithWhy);
      setBoStats({
        total:results.length,
        bullCount:results.filter(r=>r.dir==='BULL').length,
        bearCount:results.filter(r=>r.dir==='BEAR').length,
        goldCross, deathCross, pdhBreak, pdlBreak, stCrossed, wk52Hi,
        volSurge,
      });

      // ── Background: fetch intraday data for top breakout stocks ──
      // Fetches 5-min candles to get intraday VWAP, intraday momentum,
      // current-candle volume vs average, and intraday breakout confirmation
      const todayI = getISTDate();
      const top20bo = resultsWithWhy.slice(0, 20);
      if (marketStatus.open) {
        lg(`BO: fetching intraday data for top ${top20bo.length} stocks…`, 'o');
        Promise.allSettled(top20bo.map(async (r, idx) => {
          await sleep(idx * 300);
          try {
            // 5-min candles give better signals than 1-min (less noise)
            const c5 = await fetchIntraday(r.key, '5minute', token, onTokenExpired);
            if (!c5 || c5.length < 5) return;

            // 1. Intraday VWAP
            const vwap5 = calcVWAP(c5);
            const vwapSignal = vwap5 ? calcStockVWAPSignal(r.ltp, vwap5) : null;

            // 2. Intraday volume surge — current candle vol vs avg of prior candles
            const intraCurVol  = c5[0]?.[5] || 0; // most recent candle (newest first)
            const intraAvgVol  = c5.length > 5
              ? c5.slice(1, Math.min(21, c5.length)).reduce((s, c) => s + (+c[5] || 0), 0) / Math.min(20, c5.length - 1)
              : 0;
            const intraVolRatio = intraAvgVol > 0 ? +(intraCurVol / intraAvgVol).toFixed(2) : null;

            // 3. Intraday momentum — is price accelerating in the breakout direction?
            const intraCloses = c5.map(c => +c[4]).reverse(); // chronological
            const intraEma5  = calcEMA(intraCloses, 5);
            const intraEma13 = calcEMA(intraCloses, 13);
            const intraMomentum = intraCloses.length >= 13 ? {
              bullish: intraEma5[intraEma5.length-1] > intraEma13[intraEma13.length-1],
              accelerating: intraEma5[intraEma5.length-1] > intraEma5[intraEma5.length-2],
            } : null;

            // 4. Intraday breakout confirmation — did price break key level intraday?
            const intraHigh = Math.max(...c5.map(c => +c[2]));
            const intraLow  = Math.min(...c5.map(c => +c[3]));
            const intraConfirm = r.pdhl?.pdh > 0 && intraHigh > r.pdhl.pdh ? 'PDH_CONFIRMED'
              : r.pdhl?.pdl > 0 && intraLow < r.pdhl.pdl ? 'PDL_CONFIRMED' : null;

            // 5. Intraday score boost — add to existing score
            let intraBoost = 0;
            if (intraConfirm) intraBoost += 2; // breakout confirmed intraday
            if (intraVolRatio >= 2) intraBoost += 2;      // volume surge intraday
            else if (intraVolRatio >= 1.5) intraBoost += 1;
            if (intraMomentum?.bullish && r.isBull)  intraBoost += 1;
            if (intraMomentum?.accelerating) intraBoost += 1;

            const newScore = Math.min(10, r.score + (intraBoost > 0 ? Math.floor(intraBoost / 2) : 0));
            const newConf  = Math.min(95, r.conf + intraBoost * 3);

            // 6. Build intraday _whyLines additions
            const intraWhy = [
              intraConfirm === 'PDH_CONFIRMED' && '✅ PDH breakout CONFIRMED on 5-min chart',
              intraConfirm === 'PDL_CONFIRMED' && '✅ PDL breakdown CONFIRMED on 5-min chart',
              intraVolRatio >= 2   && `🔥 Intraday volume surge ${intraVolRatio}× above average`,
              intraVolRatio >= 1.5 && intraVolRatio < 2 && `📊 Intraday volume elevated ${intraVolRatio}×`,
              intraMomentum?.bullish && r.isBull && '⚡ 5-min EMA bullish — intraday trend aligned',
              intraMomentum?.accelerating && '🚀 Intraday momentum accelerating',
              vwapSignal?.aboveVWAP && r.isBull && `📈 Above intraday VWAP ₹${vwapSignal.vwap?.toFixed(1)}`,
              vwapSignal?.aboveVWAP === false && !r.isBull && `📉 Below intraday VWAP ₹${vwapSignal.vwap?.toFixed(1)}`,
            ].filter(Boolean);

            setBoCards(prev => prev.map(x => x.s === r.s ? {
              ...x,
              stockVWAP:   vwapSignal,
              intraVolRatio,
              intraMomentum,
              intraConfirm,
              score:  newScore,
              conf:   newConf,
              _whyLines: [...(x._whyLines || []), ...intraWhy],
              rec: r.isBull ? (newScore >= 7 ? 'STRONG BUY' : 'BUY') : (newScore >= 7 ? 'SELL' : 'WATCH'),
            } : x));
          } catch (_) { /* intraday enrichment is optional */ }
        }));
      }
      setBoTime('Scanned: ' + getIST());
      updateBadge('stocks',results.length+' 🚀');
      lg(`✅ Breakout: ${results.length} signals`,'o');
      fireBreakoutAlerts(results);
    } catch(e) { setBoError(e.message); lg('Breakout error: '+e.message,'e'); }
    finally { setBoLoading(false); }
  }

  const filteredCards=boCards.filter(r=>{
    if(boFilter==='all')return true;if(boFilter==='bull')return r.dir==='BULL';if(boFilter==='bear')return r.dir==='BEAR';
    if(boFilter==='ema')return r.ema?.goldenCross||r.ema?.deathCross||r.ema?.nearCross;if(boFilter==='pdhl')return r.pdhl?.bullBreakout||r.pdhl?.bearBreakout||r.pdhl?.nearPDH||r.pdhl?.nearPDL;
    if(boFilter==='st')return r.st?.crossed;if(boFilter==='vol')return r.vol?.confirmed||r.vol?.strong;
    if(boFilter==='52wk')return r.wk52?.breakHigh||r.wk52?.atHigh||r.wk52?.breakLow||r.wk52?.atLow;if(boFilter==='gap')return r.gap?.gapUp||r.gap?.gapDown;
    if(boFilter==='squeeze')return(r.nr7?.isNR7||r.nr7?.isNR4)||r.bb?.squeeze||r.bb?.extremeSqueeze;if(boFilter==='rs')return (r.rs?.outperforming||r.rs?.underperforming)&&r.rs?.strongly;
    return true;
  });

  const sentColor={'BULLISH':'#16a34a','BEARISH':'#dc2626','NEUTRAL':'#d97706'}[scanStats?.sent||'NEUTRAL'];

  return (
    <div>
      {/* Mode tabs */}
      <div style={{display:'flex',gap:0,marginBottom:14,background:'#f1f5f9',borderRadius:10,padding:3}}>
        {[{id:'picks',label:'📊 Picks',color:'#1d4ed8'},{id:'breakout',label:'🚀 Breakout',color:'#7c3aed'}].map(m=>(
          <button key={m.id} onClick={()=>{
              setMode(m.id);
              if(m.id==='breakout'){
                const ageMs = boTime ? Date.now()-new Date(boTime.replace('Scanned: ','')).getTime() : Infinity;
                if(!boTime || ageMs > 15*60*1000) runBreakoutScan();
              }
            }}
            style={{flex:1,padding:'8px 0',borderRadius:8,border:'none',fontSize:12,fontWeight:700,cursor:'pointer',
              background:mode===m.id?'#fff':'transparent',color:mode===m.id?m.color:'#64748b',
              boxShadow:mode===m.id?'0 1px 4px rgba(0,0,0,.1)':'none'}}>
            {m.label}
          </button>
        ))}
      </div>

      {/* ── PICKS ── */}
      {mode==='picks'&&(
        <div>
          {!marketStatus.open&&<MarketClosedBanner msg={marketStatus.msg||'🔔 NSE Market Closed'}/>}
          {picksError&&<ErrorBanner title="⚠ Scan Error" message={picksError} onRetry={runPicksScan}/>}
          {picksLoading&&<div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:'10px 14px',marginBottom:10}}><div style={{fontSize:11,fontWeight:700,color:'#1d4ed8',marginBottom:4}}>⏳ Scanning... {pickProgress}</div><div style={{height:3,background:'#e2e8f0',borderRadius:3}}><div style={{height:'100%',background:'#3b82f6',borderRadius:3,width:'60%',animation:'pulse 1.5s ease-in-out infinite'}}/></div></div>}
          {!picksLoading||picks.length>0?(
            <div>
              {/* 6 stat cards — live via WebSocket */}
              <div className="stats-g">
                <div className="sc">
                  <div className="sc-lbl">NIFTY 50 {idxConnected?'⚡':''}</div>
                  <div className={`sc-val ${niftyChgPct>=0?'up':'dn'}`}>{niftyLTP?`₹${fmt(niftyLTP,0)}`:'—'}</div>
                  <div className={`sc-sub ${niftyChgPct>=0?'up':'dn'}`}>{niftyPts>=0?'+':''}{niftyPts.toFixed(2)} pts</div>
                </div>
                <div className="sc">
                  <div className="sc-lbl">BANK NIFTY {idxConnected?'⚡':''}</div>
                  <div className={`sc-val ${bnkChgPct>=0?'up':'dn'}`}>{bnkLTP?`₹${fmt(bnkLTP,0)}`:'—'}</div>
                  <div className={`sc-sub ${bnkChgPct>=0?'up':'dn'}`}>{bnkPts>=0?'+':''}{bnkPts.toFixed(2)} pts</div>
                </div>
                <div className="sc">
                  <div className="sc-lbl">INDIA VIX</div>
                  <div className={`sc-val ${vixLTP>20?'dn':vixLTP>15?'am':'up'}`}>{vixLTP?vixLTP.toFixed(2):'—'}</div>
                  <div className={`sc-sub ${vixLTP>20?'dn':vixLTP>15?'am':'up'}`}>{interpVIX(vixLTP).txt}</div>
                </div>
                <div className="sc">
                  <div className="sc-lbl">NIFTY PCR</div>
                  <div className={`sc-val ${(scanStats?.pcr||0)>1?'up':(scanStats?.pcr||0)>0.7?'am':'dn'}`}>{scanStats?.pcr!=null?scanStats.pcr.toFixed(2):'—'}</div>
                  <div className={`sc-sub ${(scanStats?.pcr||0)>1?'up':(scanStats?.pcr||0)>0.7?'am':'dn'}`}>{scanStats?.pcrTxt||'Run scan'}</div>
                </div>
                <div className="sc" style={{borderColor:(sentColor||'#d97706')+'22'}}>
                  <div className="sc-lbl">SENTIMENT</div>
                  <div className="sc-val" style={{color:sentColor||'#d97706'}}>{scanStats?.sent||'NEUTRAL'}</div>
                  <div style={{display:'flex',gap:2,marginTop:5}}>
                    {Array(10).fill(0).map((_,i)=><div key={i} style={{flex:1,height:4,borderRadius:2,background:i<(scanStats?.sentSc||5)?sentColor:'#e2e8f0'}}/>)}
                  </div>
                </div>
                <div className="sc">
                  <div className="sc-lbl">PICKS FOUND</div>
                  <div className="sc-val bl">{scanStats?.cnt??'—'}</div>
                  <div className="sc-sub" style={{color:'#64748b'}}>{scanStats?.topSec||'Run scan'} leads</div>
                </div>
              </div>

              {fiiInterp&&(
                <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:8,padding:'8px 14px',marginBottom:10}}>
                  <div style={{fontSize:9,color:'#94a3b8',marginBottom:3}}>FII/DII FLOW</div>
                  <div style={{fontWeight:800,fontSize:14,color:fiiInterp.color}}>{fiiInterp.label}</div>
                  <div style={{fontSize:9,color:'#64748b',marginTop:2}}>{fiiInterp.detail}</div>
                </div>
              )}

              {picksTime&&<LastUpdated time={picksTime}/>}
              <div className="sec-hdr">
                <h3>Professional Picks{picks.length>0?` · ${picks.length} signal${picks.length===1?'':'s'}`:''}</h3>
                <span>Conf≥{cfg.minStockConf||50}% · Pot≥{cfg.pot||3}% · Risk&lt;{cfg.risk||55}% · R:R≥{cfg.rr||1.2} · EV&gt;0 · Sorted by Confidence</span>
              </div>
              {wsConnected&&<div style={{fontSize:9,marginBottom:8,color:'#16a34a',fontWeight:600}}>⚡ Picks live via {wsMode==='ws'?'WebSocket':'REST polling'} — {topKeys.length} instruments</div>}
              {picks.length===0
                ?<EmptyState>
                  {!stocks?.length?'⚙ Configure stocks.json in GitHub Settings':marketStatus.open?'🔄 Click ▶ Scan to fetch picks':'📅 Market Closed'}
                  {scanStats&&<><br/><span style={{fontSize:11,color:'#64748b'}}>Conf≥{cfg.minStockConf||50}% · Pot≥{cfg.pot||3}% · Risk&lt;{cfg.risk||55}% · R:R≥{cfg.rr||1.2}</span><br/><span style={{fontSize:10}}>Scanned {scanStats.totalScanned||0} stocks · Lower thresholds in ⚙ Settings</span></>}
                </EmptyState>
                :<div className="cards-g">{picks.map((p,i)=>{const live=stockPrices[p.key];const pickData=live?{...p,ltp:live.ltp,chgPct:live.chgPct}:p;return(<StockCard key={`${p._scanId||picksScanId}-${p.key||p.s}-${i}`} pick={pickData} rank={i+1} cfg={cfg} onPopup={()=>setPopupPick(pickData)}/>);})}</div>
              }
              <div className="disc">⚠ Not SEBI advice. Always DYODD.</div>
            </div>
          ):null}
        </div>
      )}

      {/* ── BREAKOUT ── */}
      {mode==='breakout'&&(
        <div>
          {boError&&<ErrorBanner title="⚠ Breakout Error" message={boError} onRetry={runBreakoutScan}/>}
          {boLoading?<Spinner label="Breakout Scanner..." progress={boProgress} sub="EMA 50/200 · PDH/PDL · Supertrend · Vol · 52Wk · Gap · NR7 · BB · RS · Wick"/>:(
            <div>
              {/* Live index cards — same WebSocket */}
              <div className="stats-g" style={{marginBottom:10}}>
                <div className="sc"><div className="sc-lbl">NIFTY {idxConnected?'⚡':''}</div><div className={`sc-val ${niftyChgPct>=0?'up':'dn'}`}>{niftyLTP?`₹${fmt(niftyLTP,0)}`:'—'}</div><div className={`sc-sub ${niftyPts>=0?'up':'dn'}`}>{niftyPts>=0?'+':''}{niftyPts.toFixed(2)} pts</div></div>
                <div className="sc"><div className="sc-lbl">BANKNIFTY {idxConnected?'⚡':''}</div><div className={`sc-val ${bnkChgPct>=0?'up':'dn'}`}>{bnkLTP?`₹${fmt(bnkLTP,0)}`:'—'}</div><div className={`sc-sub ${bnkPts>=0?'up':'dn'}`}>{bnkPts>=0?'+':''}{bnkPts.toFixed(2)} pts</div></div>
                <div className="sc"><div className="sc-lbl">INDIA VIX</div><div className={`sc-val ${vixLTP>20?'dn':vixLTP>15?'am':'up'}`}>{vixLTP?vixLTP.toFixed(2):'—'}</div></div>
              </div>
              <div className="last-upd">
                <div className="upd-dot" style={{background:'#7c3aed'}}/>
                <span>{boTime||'Not scanned yet'}</span>
                <button onClick={runBreakoutScan} className="btn btn-s" style={{marginLeft:'auto',fontSize:10,padding:'4px 10px'}}>🔄 Re-scan</button>
              </div>
              {boStats&&<div className="stats-g">
                <StatCard label="TOTAL SIGNALS" value={boStats.total} sub={`from ${boCards.length} stocks`} valClass="bl"/>
                <StatCard label="BULLISH 📈" value={boStats.bullCount} sub={`${boStats.goldCross||0}GC · ${boStats.pdhBreak||0}PDH · ${boStats.wk52Hi||0}52wkH`} valClass="up"/>
                <StatCard label="BEARISH 📉" value={boStats.bearCount} sub={`${boStats.deathCross||0}DC · ${boStats.pdlBreak||0}PDL`} valClass="dn"/>
                <StatCard label="VOL SURGE 🔥" value={boStats.volSurge||0} sub={`${boStats.stCrossed||0} ST crossed`} valClass="am"/>
              </div>}
              <div className="bo-filter-row" style={{marginBottom:12}}>
                {BO_FILTERS.map(f=><button key={f.id} onClick={()=>setBoFilter(f.id)} style={{whiteSpace:'nowrap',padding:'6px 12px',borderRadius:20,border:boFilter===f.id?'none':'1px solid #e2e8f0',fontSize:11,fontWeight:700,cursor:'pointer',background:boFilter===f.id?'#7c3aed':'#fff',color:boFilter===f.id?'#fff':'#374151'}}>{f.label}</button>)}
              </div>
              {filteredCards.length===0
                ?<EmptyState>{!stocks?.length?'⚙ Configure stocks.json in GitHub Settings':'🔄 Click Re-scan to run breakout scanner'}</EmptyState>
                :<div className="cards-g">{filteredCards.map((c,i)=><BoCard key={c.s||i} r={c} rank={i+1} onPopup={()=>setPopupStock(c)}/>)}</div>
              }
              <div className="disc">⚠ Not SEBI advice. Always DYODD.</div>
            </div>
          )}
        </div>
      )}
      {/* Breakout stock popup */}
      {popupStock && <BoChartPopup r={popupStock} onClose={() => setPopupStock(null)} />}
      {popupPick  && <PickChartPopup p={popupPick} onClose={() => setPopupPick(null)} />}
    </div>
  );
}

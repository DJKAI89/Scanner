import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, MarketClosedBanner, LastUpdated, StatCard, EmptyState } from '../components/common.jsx';
import StockCard from '../components/StockCard.jsx';
import { fmt, interpVIX } from '../utils/formatters';
import LiveChart from '../components/LiveChart';
import { AccentCard, CardHeader, LevelsStrip, ProgressStat, SignalTags, WhyBox } from '../components/cardKit';
import { getIST } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed.js';
import { runPicksScan, runBreakoutScan, fetchClosedMarketIndexPrices } from '../services/stockScan';

// ── Index keys for WebSocket (same as OptionsPane) ──
const INDEX_WS_KEYS = [
  'NSE_INDEX|Nifty 50',
  'NSE_INDEX|Nifty Bank',
  'NSE_INDEX|India VIX',
  'BSE_INDEX|SENSEX',
];

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
  const regimeMap = {
    CHOPPY_HIGH_VOL: { txt: '🌊 CHOPPY + HIGH VIX', tone: 'red' },
    CHOPPY:          { txt: '🌊 CHOPPY', tone: 'amber' },
    TRENDING_CALM:   { txt: '📈 CALM TREND', tone: 'green' },
    TRENDING:        { txt: '📈 TRENDING', tone: 'green' },
  };
  if (r.regime && regimeMap[r.regime]) tag(regimeMap[r.regime].txt, regimeMap[r.regime].tone);
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
    fetchClosedMarketIndexPrices(token, onTokenExpired)
      .then(out => { if (Object.keys(out).length) setClosedIdxPrices(out); })
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
    const onScan = () => { mode==='breakout' ? runBreakout() : runPicks(); };
    document.addEventListener('friday:scan', onScan);
    return () => document.removeEventListener('friday:scan', onScan);
  }, [mode]); // eslint-disable-line

  useEffect(() => {
    if (!token) return;
    if (marketStatus.open) setTimeout(() => runPicks(), 2000);
  }, [token]); // eslint-disable-line

  // ── PICKS SCAN — thin wrapper around services/stockScan.runPicksScan ──
  async function runPicks() {
    if (scanInProgress.current) return;
    scanInProgress.current = true;
    setScanning(true); setStatusDot('scan'); setStatusTxt('Scanning...');
    setPicksLoading(true); setPicksError('');
    setPickProgress('');
    try {
      const ctx = {
        token, stocks, cfg, gh, niftyLTP, niftyChgPct, vixLTP, onTokenExpired, lg,
        marketStatus, confCalibration, adaptWeights, mlModels,
      };
      const callbacks = { setPickProgress, setPicks };
      const { picks: nextPicks, scanStats: stats, vixVal } = await runPicksScan(ctx, callbacks);
      setPicks(nextPicks);
      setPicksScanId(Date.now());
      setScanStats(stats);
      setTickerStats({ vix: vixVal, pcr: stats.pcr, sentiment: stats.sent, sentSc: stats.sentSc, topSec: stats.topSec });
      updateBadge('stocks', String(nextPicks.length));
      setPicksTime('Updated: ' + getIST());
      setStatusDot('live'); setStatusTxt('Live');
    } catch(e) {
      setPicksError(e.message); setStatusDot('err'); setStatusTxt('Error');
      lg('Scan error: '+e.message,'e');
    } finally {
      setPicksLoading(false); setScanning(false); scanInProgress.current=false;
    }
  }

  // ── BREAKOUT SCAN — thin wrapper around services/stockScan.runBreakoutScan ──
  async function runBreakout() {
    if (boLoading) return;
    setBoLoading(true); setBoError(''); setBoProgress('Fetching quotes...');
    try {
      const ctx = { token, stocks, cfg, onTokenExpired, lg, marketStatus, scanStats };
      const callbacks = { setBoProgress, setBoCards };
      const { boStats: stats } = await runBreakoutScan(ctx, callbacks);
      setBoStats(stats);
      setBoTime('Scanned: ' + getIST());
      updateBadge('stocks', stats.total+' 🚀');
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
                if(!boTime || ageMs > 15*60*1000) runBreakout();
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
          {picksError&&<ErrorBanner title="⚠ Scan Error" message={picksError} onRetry={runPicks}/>}
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
                  <div className={`sc-sub ${bnkPts>=0?'up':'dn'}`}>{bnkPts>=0?'+':''}{bnkPts.toFixed(2)} pts</div>
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
          {boError&&<ErrorBanner title="⚠ Breakout Error" message={boError} onRetry={runBreakout}/>}
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
                <button onClick={runBreakout} className="btn btn-s" style={{marginLeft:'auto',fontSize:10,padding:'4px 10px'}}>🔄 Re-scan</button>
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

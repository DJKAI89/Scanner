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
  calcVWAPBands, applyFIIBias, applyCalibration, calcEMA, calcIVPercentile,
} from '../services/technical';

// Delivery % from Upstox quote (same as HTML getDeliveryPct)
function getDeliveryPct(q) {
  if (!q) return null;
  if (q.delivery_volume != null && q.volume > 0) return +(q.delivery_volume / q.volume * 100).toFixed(1);
  if (q.delivery_quantity != null && q.volume > 0) return +(q.delivery_quantity / q.volume * 100).toFixed(1);
  return null;
}
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST, getISTDate, sleep } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed.js';

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

// ── Mini candlestick SVG chart (port from index.html) ────────
function drawMiniChart(candles, closes, opts = {}) {
  if (!candles || candles.length < 3) return null;
  const W = opts.width || 320, H = opts.height || 92;
  const PAD = { top: 6, right: 4, bottom: 14, left: 2 };
  const chartW = W - PAD.left - PAD.right, chartH = H - PAD.top - PAD.bottom;
  const raw = candles.slice(0, 20).reverse(), N = raw.length;
  if (N < 2) return null;
  let priceHigh = Math.max(...raw.map(c => +c[2]));
  let priceLow  = Math.min(...raw.map(c => +c[3]));
  if (opts.target > 0) priceHigh = Math.max(priceHigh, opts.target);
  if (opts.sl     > 0) priceLow  = Math.min(priceLow,  opts.sl);
  if (opts.entry  > 0) { priceHigh = Math.max(priceHigh, opts.entry); priceLow = Math.min(priceLow, opts.entry); }
  const range = priceHigh - priceLow; if (range <= 0) return null;
  const py = p => PAD.top + chartH * (1 - (p - priceLow) / range);
  const slotW = chartW / N, candleW = Math.max(2, slotW * 0.6);
  const cx = i => PAD.left + (i + 0.5) * slotW;
  let cs = '';
  for (let i = 0; i < N; i++) {
    const [,o,h,l,c] = raw[i].map(Number); const up = c >= o;
    const col = up ? '#16a34a' : '#dc2626';
    const bodyTop = py(Math.max(o,c)), bodyH = Math.max(1, py(Math.min(o,c)) - bodyTop);
    cs += `<line x1="${cx(i)}" y1="${py(h)}" x2="${cx(i)}" y2="${py(l)}" stroke="${col}" stroke-width="1" opacity="0.8"/>`;
    cs += `<rect x="${(cx(i)-candleW/2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${col}" rx="0.5"/>`;
  }
  let ema50L = '', ema200L = '';
  if (closes && closes.length >= 50) {
    const e50 = [], e200 = [];
    for (let i = 0; i < N; i++) {
      const sl2 = closes.slice(0, closes.length - (N - 1 - i));
      e50.push(sl2.length >= 50 ? calcEMA(sl2, 50) : null);
      e200.push(sl2.length >= 200 ? calcEMA(sl2, 200) : null);
    }
    const lp = (vals, col, dash = '') => {
      const pts = vals.map((v, i) => v != null ? `${cx(i).toFixed(1)},${py(v).toFixed(1)}` : null).filter(Boolean);
      return pts.length >= 2 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.2" opacity="0.75" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"/>` : '';
    };
    ema50L = lp(e50, '#2563eb'); ema200L = lp(e200, '#9333ea', '3,2');
  }
  const hLine = (price, col, lbl, dash = false) => {
    if (!price || price <= 0) return '';
    const y = py(price);
    if (y < PAD.top || y > H - PAD.bottom + 2) return '';
    return `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W-PAD.right}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="${dash?'1':'1.5'}" opacity="0.9" ${dash?'stroke-dasharray="4,3"':''}/>` +
      `<text x="${W-PAD.right-2}" y="${(y-2).toFixed(1)}" text-anchor="end" font-size="7" font-weight="700" fill="${col}" font-family="system-ui,sans-serif">${lbl}</text>`;
  };
  const dateL = (c2, xPos, anchor) => {
    if (!c2 || !c2[0]) return '';
    const d = new Date(c2[0]); const l = isNaN(d) ? '' : `${d.getDate()}/${d.getMonth()+1}`;
    return `<text x="${xPos}" y="${H-1}" text-anchor="${anchor}" font-size="7" fill="#94a3b8" font-family="system-ui,sans-serif">${l}</text>`;
  };
  const ema50Val  = closes && closes.length >= 50  ? calcEMA(closes, 50)  : null;
  const ema200Val = closes && closes.length >= 200 ? calcEMA(closes, 200) : null;
  const svgStr = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;border-radius:6px;background:#f8fafc;border:1px solid #e2e8f0;margin:8px 0 4px">
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${W-PAD.right}" y2="${PAD.top}" stroke="#e2e8f0" stroke-width="0.5"/>
    <line x1="${PAD.left}" y1="${(PAD.top+chartH/2).toFixed(1)}" x2="${W-PAD.right}" y2="${(PAD.top+chartH/2).toFixed(1)}" stroke="#e2e8f0" stroke-width="0.5" stroke-dasharray="2,2"/>
    <line x1="${PAD.left}" y1="${PAD.top+chartH}" x2="${W-PAD.right}" y2="${PAD.top+chartH}" stroke="#e2e8f0" stroke-width="0.5"/>
    ${ema200L}${ema50L}${cs}
    ${hLine(opts.target,'#16a34a','Tgt')}${hLine(opts.entry,'#1d4ed8','Entry',true)}${hLine(opts.sl,'#dc2626','SL')}
    ${dateL(raw[0], PAD.left+2, 'start')}${dateL(raw[N-1], W-PAD.right-2, 'end')}
    <line x1="${PAD.left+2}" y1="${H-8}" x2="${PAD.left+14}" y2="${H-8}" stroke="#2563eb" stroke-width="1.2"/>
    <text x="${PAD.left+16}" y="${H-5}" font-size="6.5" fill="#64748b" font-family="system-ui,sans-serif">EMA50</text>
    <line x1="${PAD.left+46}" y1="${H-8}" x2="${PAD.left+58}" y2="${H-8}" stroke="#9333ea" stroke-width="1.2" stroke-dasharray="3,2"/>
    <text x="${PAD.left+60}" y="${H-5}" font-size="6.5" fill="#64748b" font-family="system-ui,sans-serif">EMA200</text>
  </svg>`;
  return { svgStr, ema50Val, ema200Val };
}

// ── BoCard — dedicated breakout card (port from index.html) ──
function BoCard({ r, rank }) {
  const fmtV = v => v != null ? (+v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
  const isBull = r.dir === 'BULL';
  const cardBg = isBull ? '#f0fdf4' : '#fef2f2';
  const cardBorder = isBull ? '#16a34a' : '#dc2626';
  const dirColor = isBull ? '#16a34a' : '#dc2626';
  const chgColor = (r.chgPct || 0) >= 0 ? '#16a34a' : '#dc2626';
  const t = r.trade || {};

  let _bull = 0, _bear = 0;
  if (r.ema) { if (r.ema.goldenCross) _bull+=3; else if (r.ema.deathCross) _bear+=3; else if (r.ema.uptrend) _bull+=1; else _bear+=1; }
  if (r.pdhl) { if (r.pdhl.bullBreakout) _bull+=3; else if (r.pdhl.bearBreakout) _bear+=3; else if (r.pdhl.nearPDH) _bull+=1; else if (r.pdhl.nearPDL) _bear+=1; }
  if (r.st) { r.st.crossed ? (r.st.trend==='UP'?_bull+=2:_bear+=2) : (r.st.trend==='UP'?_bull+=1:_bear+=1); }

  const pills = [];
  const pill = (txt, bg, col, border) => pills.push(
    <span key={pills.length} style={{fontSize:8,fontWeight:800,background:bg,color:col,border:`1px solid ${border}`,borderRadius:10,padding:'2px 7px'}}>{txt}</span>
  );
  if (_bull>0&&_bear>0) pill('⚡ MIXED SIGNALS','#fff7ed','#9a3412','#fed7aa');
  if (r.ema) {
    if (r.ema.goldenCross)       pill('⭐ GOLDEN CROSS','#fef9c3','#854d0e','#fde68a');
    else if (r.ema.deathCross)   pill('💀 DEATH CROSS','#fee2e2','#991b1b','#fecaca');
    else if (r.ema.nearCross)    pill('⚡ EMA NEAR CROSS','#fffbeb','#92400e','#fde68a');
    else if (r.ema.uptrend)      pill('📈 EMA UPTREND','#f0fdf4','#15803d','#bbf7d0');
    else                          pill('📉 EMA DOWNTREND','#fef2f2','#991b1b','#fecaca');
  }
  if (r.pdhl) {
    if (r.pdhl.bullBreakout)      pill(`🚀 PDH BREAK +${r.pdhl.pdHDist}%`,'#dcfce7','#15803d','#86efac');
    else if (r.pdhl.bearBreakout) pill(`📉 PDL BREAK ${r.pdhl.pdLDist}%`,'#fef2f2','#b91c1c','#fecaca');
    else if (r.pdhl.nearPDH)      pill(`⚡ NEAR PDH ₹${fmtV(r.pdhl.pdh)}`,'#f0fdf4','#15803d','#bbf7d0');
    else if (r.pdhl.nearPDL)      pill(`⚡ NEAR PDL ₹${fmtV(r.pdhl.pdl)}`,'#fffbeb','#92400e','#fde68a');
  }
  if (r.st) {
    const sc=r.st.trend==='UP'?'#1e40af':'#6b21a8', sb=r.st.trend==='UP'?'#eff6ff':'#faf5ff', sbr=r.st.trend==='UP'?'#bfdbfe':'#ddd6fe';
    pill(r.st.crossed?(r.st.trend==='UP'?'📈 ST CROSSED UP':'📉 ST CROSSED DOWN'):(r.st.trend==='UP'?`📈 ST UP ₹${fmtV(r.st.value)}`:`📉 ST DOWN ₹${fmtV(r.st.value)}`),sb,sc,sbr);
  }
  if (r.vol) {
    if (r.vol.strong)         pill(`🔥 VOL ${r.vol.ratio}× AVG`,'#fdf4ff','#7e22ce','#e9d5ff');
    else if (r.vol.confirmed) pill(`📊 VOL ${r.vol.ratio}× AVG`,'#fdf4ff','#7e22ce','#e9d5ff');
    else if (r.vol.dry)       pill(`🔇 LOW VOL ${r.vol.ratio}×`,'#f8fafc','#94a3b8','#e2e8f0');
  }
  if (r.wk52) {
    if (r.wk52.breakHigh)       pill('🏆 52WK HIGH BREAK','#fef9c3','#854d0e','#fde68a');
    else if (r.wk52.atHigh)     pill(`📍 AT 52WK HIGH ₹${fmtV(r.wk52.hi52)}`,'#fef9c3','#854d0e','#fde68a');
    if (r.wk52.breakLow)        pill('⚠ 52WK LOW BREAK','#fef2f2','#991b1b','#fecaca');
    else if (r.wk52.atLow)      pill(`📍 AT 52WK LOW ₹${fmtV(r.wk52.lo52)}`,'#fff7ed','#9a3412','#fed7aa');
  }
  if (r.gap) {
    if (r.gap.bigGapUp)        pill(`⬆ GAP UP +${r.gap.gapPct}%`,'#dcfce7','#15803d','#86efac');
    else if (r.gap.gapUp)      pill(`↑ GAP UP +${r.gap.gapPct}%`,'#f0fdf4','#15803d','#bbf7d0');
    if (r.gap.bigGapDown)      pill(`⬇ GAP DOWN ${r.gap.gapPct}%`,'#fef2f2','#b91c1c','#fecaca');
    else if (r.gap.gapDown)    pill(`↓ GAP DOWN ${r.gap.gapPct}%`,'#fef2f2','#b91c1c','#fecaca');
  }
  if (r.nr7?.isNR7||r.nr7?.isNR4) pill(`🎯 ${r.nr7.isNR7?'NR7':'NR4'} COILED`,'#f0f9ff','#0c4a6e','#bae6fd');
  if (r.bb?.extremeSqueeze)        pill('🗜 BB EXTREME SQUEEZE','#f0f9ff','#0c4a6e','#bae6fd');
  else if (r.bb?.squeeze)          pill('🗜 BB SQUEEZE','#f0f9ff','#0c4a6e','#bae6fd');
  if (r.mom?.bullConf)       pill('✅ RSI+MACD BULL','#dcfce7','#15803d','#86efac');
  else if (r.mom?.bearConf)  pill('❌ RSI+MACD BEAR','#fef2f2','#991b1b','#fecaca');
  else if (r.mom?.contra)    pill('⚡ MOMENTUM CONTRA','#fff7ed','#9a3412','#fed7aa');
  if (r.wick?.bearRejected)  pill('🕯 WICK REJECTION ↑','#fef2f2','#991b1b','#fecaca');
  else if (r.wick?.bullStrong) pill(`🕯 STRONG CLOSE ${Math.round((r.wick.closePos||0)*100)}%`,'#f0fdf4','#15803d','#bbf7d0');
  if (r.adx?.strong)                           pill(`💪 ADX ${r.adx.adx} STRONG`,'#ecfdf5','#065f46','#a7f3d0');
  else if (r.adx&&!r.adx.trending&&!r.adx.weakTrend) pill(`〰 ADX ${r.adx.adx} CHOPPY`,'#f8fafc','#94a3b8','#e2e8f0');
  if (r.rs?.outperforming&&r.rs.strongly) pill(`🚀 RS +${r.rs.rs}% vs NIFTY`,'#ecfdf5','#065f46','#a7f3d0');
  else if (r.rs?.underperforming&&r.rs.strongly) pill(`🐢 RS ${r.rs.rs}% vs NIFTY`,'#fef2f2','#991b1b','#fecaca');
  if (r.ivPct?.cheap) pill(`📉 IV CHEAP ${r.ivPct.iv}% vs HV ${r.ivPct.hv20}%`,'#f0fdf4','#15803d','#bbf7d0');
  else if (r.ivPct?.rich) pill(`📈 IV RICH ${r.ivPct.iv}% vs HV ${r.ivPct.hv20}%`,'#fef2f2','#991b1b','#fecaca');
  if (r.stockVWAP?.aboveVWAP && r.stockVWAP?.strong) pill(`📊 ABOVE VWAP ₹${fmtV(r.stockVWAP.vwap)} (+${r.stockVWAP.distPct}%)`,'#ecfdf5','#065f46','#a7f3d0');
  else if (!r.stockVWAP?.aboveVWAP && r.stockVWAP?.strong) pill(`📊 BELOW VWAP ₹${fmtV(r.stockVWAP.vwap)} (${r.stockVWAP.distPct}%)`,'#fef2f2','#991b1b','#fecaca');
  else if (r.stockVWAP?.nearVWAP) pill(`📊 AT VWAP ₹${fmtV(r.stockVWAP.vwap)}`,'#f8fafc','#64748b','#e2e8f0');
  if (r.wMTF?.confirms) pill('📅 WEEKLY CONFIRMS','#f5f3ff','#5b21b6','#ddd6fe');
  if (r.sectorScore>0)  pill(`🏭 ${r.sec||'NSE'} STRONG`,'#f0fdf4','#15803d','#bbf7d0');
  else if (r.sectorScore<0) pill(`🏭 ${r.sec||'NSE'} WEAK`,'#fef2f2','#991b1b','#fecaca');
  if (r.phase==='opening') pill('⏰ OPENING HOUR','#fffbeb','#92400e','#fde68a');

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

  const chart = r.recentCandles?.length >= 3
    ? drawMiniChart(r.recentCandles, r.closes||[], {entry:r.ltp, target:t.target, sl:t.sl})
    : null;

  return (
    <div style={{background:cardBg,border:`2px solid ${cardBorder}`,borderRadius:11,padding:13,boxShadow:'0 2px 8px rgba(0,0,0,.05)',minWidth:0,overflow:'hidden',animation:'fadeIn .3s ease both'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
        <div>
          <div style={{fontSize:16,fontWeight:800,color:'#0f172a'}}>{r.s}</div>
          <div style={{fontSize:10,color:'#64748b'}}>{r.n||r.s} · {r.sec||'NSE'}</div>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:14,fontWeight:800,color:'#0f172a'}}>₹{fmtV(r.ltp)}</div>
          <div style={{fontSize:11,fontWeight:700,color:chgColor}}>{(r.chgPct||0)>=0?'+':''}{(r.chgPct||0).toFixed(2)}%</div>
          <div style={{fontSize:9,fontWeight:800,color:dirColor,marginTop:2}}>{isBull?'▲ BULLISH':'▼ BEARISH'}</div>
        </div>
      </div>
      <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:9}}>{pills}</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:1,background:'#e2e8f0',borderRadius:8,overflow:'hidden',marginBottom:8}}>
        <div style={{background:'#f8fafc',padding:8,textAlign:'center'}}>
          <div style={{fontSize:8,color:'#64748b',marginBottom:2}}>ENTRY</div>
          <div style={{fontSize:13,fontWeight:800,color:'#1d4ed8'}}>₹{fmtV(t.entry||r.ltp)}</div>
        </div>
        <div style={{background:'#fef2f2',padding:8,textAlign:'center'}}>
          <div style={{fontSize:8,color:'#64748b',marginBottom:2}}>STOP LOSS</div>
          <div style={{fontSize:13,fontWeight:800,color:'#dc2626'}}>₹{fmtV(t.sl)}</div>
          <div style={{fontSize:8,color:'#dc2626'}}>{isBull?'-':'+'}{t.sl>0&&(t.entry||r.ltp)>0?Math.abs((t.sl-(t.entry||r.ltp))/(t.entry||r.ltp)*100).toFixed(1):'—'}%</div>
        </div>
        <div style={{background:'#f0fdf4',padding:8,textAlign:'center'}}>
          <div style={{fontSize:8,color:'#64748b',marginBottom:2}}>TARGET</div>
          <div style={{fontSize:13,fontWeight:800,color:'#16a34a'}}>₹{fmtV(t.target)}</div>
          <div style={{fontSize:8,color:'#16a34a'}}>R:R {t.rr||0}:1</div>
        </div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:8}}>
        <span style={{fontSize:8,color:'#94a3b8',width:52}}>STRENGTH</span>
        <div style={{flex:1,height:4,background:'#e2e8f0',borderRadius:3}}>
          <div style={{width:`${Math.min(100,(r.score||0)*10)}%`,height:'100%',background:(r.score||0)>=7?'#16a34a':(r.score||0)>=4?'#d97706':'#0ea5e9',borderRadius:3}}/>
        </div>
        <span style={{fontSize:8,fontWeight:800,color:(r.score||0)>=7?'#16a34a':(r.score||0)>=4?'#d97706':'#0ea5e9'}}>{r.score||0}/10</span>
      </div>
      {chart&&(
        <div style={{marginBottom:6}}>
          <div style={{fontSize:8,fontWeight:700,color:'#94a3b8',marginBottom:2,letterSpacing:'.5px'}}>
            20-DAY CHART{chart.ema50Val?` · EMA50 ₹${fmtV(chart.ema50Val)}`:''}{chart.ema200Val?` · EMA200 ₹${fmtV(chart.ema200Val)}`:''}
          </div>
          <div dangerouslySetInnerHTML={{__html:chart.svgStr}}/>
        </div>
      )}
      {why.length>0&&(
        <div style={{marginTop:8,paddingTop:7,borderTop:`1px solid ${isBull?'#bbf7d0':'#fecaca'}`,fontSize:10,color:'#475569',lineHeight:1.6}}>
          {why.map((w,i)=><div key={i}>→ {w}</div>)}
        </div>
      )}
      {t.method&&<div style={{marginTop:4,fontSize:8,color:'#94a3b8'}}>{t.method}</div>}
    </div>
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
function checkPickAlerts(picks) {
  if (!picks?.length) return;
  const today = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });
  const highConf = picks.filter(p => p.passes && p.conf >= 80);
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
           stocks, fiiInterp, setTickerStats, confCalibration } = useApp();

  const [mode, setMode]               = useState('picks');
  const [picksLoading, setPicksLoading] = useState(false);
  const [picksError, setPicksError]     = useState('');
  const [picks, setPicks]               = useState([]);
  const [scanStats, setScanStats]       = useState(null);
  const [picksTime, setPicksTime]       = useState('');
  const [pickProgress, setPickProgress] = useState('');
  const [boLoading, setBoLoading]     = useState(false);
  const [boError, setBoError]         = useState('');
  const [boCards, setBoCards]         = useState([]);
  const [boStats, setBoStats]         = useState(null);
  const [boTime, setBoTime]           = useState('');
  const [boProgress, setBoProgress]   = useState('');
  const [boFilter, setBoFilter]       = useState('all');
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
        const volOk    = avgVol20>0 ? effectiveVol>=avgVol20*1.2 : null;

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

        const risk2=(ltp-sl); const useS1=sl>0&&sr?.pivotS1>0&&Math.abs(sl-sr.pivotS1)<risk2*0.3;
        const slTargets={consMethod:useS1?'S1 support':'ATR+VIX',modMethod:'2:1 R:R'};
        const pot  = calcPotential(ltp,tgtMod,sl,numInds,preRec);
        const risk = calcRisk(ltp,sl,tgtMod,t.atr||0,vixVal);
        const rec  = getRec(conf,pot.base,risk,pot.rr);
        const passes = conf>=(cfg.minStockConf||50) && pot.base>=(cfg.pot||3) && risk<(cfg.risk||55) && pot.rr>=(cfg.rr||1.2);

        const entryTrigger=calcEntryTrigger(ltp,high,sr,t.atr||0,rec,vwap,chgPct);
        const reversal=detectReversal(ltp,t.rsi,patterns,sr,vixVal,pcr,nBull,chgPct,t.atr||0,high,low);
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
      setPicks(finalPicks);
      setScanStats({pcr,pcrTxt,sent,sentSc,topSec,cnt:finalPicks.length,totalScanned:byVol.length});
      setTickerStats({ vix:vixVal, pcr, sentiment:sent, sentSc, topSec });
      updateBadge('stocks',String(finalPicks.length));
      setPicksTime('Updated: ' + getIST());
      setStatusDot('live'); setStatusTxt('Live');
      lg(`✅ Picks: ${finalPicks.length} from ${byVol.length} stocks`,'o');
      if (!finalPicks.length) lg(`⚠ 0 picks — lower Conf(${cfg.minStockConf}%)/Pot(${cfg.pot}%)/Risk(${cfg.risk}%) in ⚙ Settings`,'w');
      if (finalPicks.length&&gh?.token) logSignals(gh,finalPicks.filter(p=>!p._fallback).map(p=>buildStockSignal(p,vixVal)),vixVal,lg);
      checkPickAlerts(finalPicks);
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
        // sector score: +1 strong sector, -1 weak, 0 neutral (from secMap built during picks scan)
        const sec=item.sec||item.s;
        const secEntry=Object.entries({}).find(()=>false); // placeholder
        const secChgPct=item._q?((item._q.last_price-(item._q.ohlc?.close||item._q.last_price))/(item._q.ohlc?.close||item._q.last_price)*100):0;
        const sectorScore=secChgPct>1?1:secChgPct<-1?-1:0;
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
      setBoCards(results);
      setBoStats({
        total:results.length,
        bullCount:results.filter(r=>r.dir==='BULL').length,
        bearCount:results.filter(r=>r.dir==='BEAR').length,
        goldCross, deathCross, pdhBreak, pdlBreak, stCrossed, wk52Hi,
        volSurge,
      });

      // ── Background: fetch intraday VWAP for top 20 breakout stocks ──
      // Mirrors HTML's fetchStockIntradayVWAP background step
      const todayI = getISTDate();
      const top20bo = results.slice(0, 20);
      Promise.allSettled(top20bo.map(async (r, idx) => {
        await sleep(idx * 200);
        try {
          const c1 = await fetchCandles(r.key, todayI, todayI, '1minute', token, onTokenExpired);
          if (!c1 || c1.length < 5) return;
          const vwap1 = calcVWAP(c1);
          if (!vwap1) return;
          r.stockVWAP = calcStockVWAPSignal(r.ltp, vwap1);
          // Trigger re-render by replacing the array shallowly
          setBoCards(prev => prev.map(x => x.s === r.s ? { ...x, stockVWAP: r.stockVWAP } : x));
        } catch (_) { /* intraday VWAP is optional — silently skip on error */ }
      }));
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
          <button key={m.id} onClick={()=>{setMode(m.id);if(m.id==='breakout'&&!boTime)runBreakoutScan();}}
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
                :<div className="cards-g">{picks.map((p,i)=>{const live=stockPrices[p.key];return(<StockCard key={p.s} pick={live?{...p,ltp:live.ltp,chgPct:live.chgPct}:p} rank={i+1} cfg={cfg}/>);})}</div>
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
              <div style={{display:'flex',gap:6,marginBottom:12,overflowX:'auto',paddingBottom:4}}>
                {BO_FILTERS.map(f=><button key={f.id} onClick={()=>setBoFilter(f.id)} style={{whiteSpace:'nowrap',padding:'6px 12px',borderRadius:20,border:boFilter===f.id?'none':'1px solid #e2e8f0',fontSize:11,fontWeight:700,cursor:'pointer',background:boFilter===f.id?'#7c3aed':'#fff',color:boFilter===f.id?'#fff':'#374151'}}>{f.label}</button>)}
              </div>
              {filteredCards.length===0
                ?<EmptyState>{!stocks?.length?'⚙ Configure stocks.json in GitHub Settings':'🔄 Click Re-scan to run breakout scanner'}</EmptyState>
                :<div className="cards-g">{filteredCards.map((c,i)=><BoCard key={c.s||i} r={c} rank={i+1}/>)}</div>
              }
              <div className="disc">⚠ Not SEBI advice. Always DYODD.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

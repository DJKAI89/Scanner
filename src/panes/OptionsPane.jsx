import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, MarketClosedBanner, LastUpdated, StatCard, EmptyState } from '../components/common.jsx';
import { TimeOfDayBanner } from './StocksPane';
import { fetchQ, fetchOptions, fetchIntraday, resolveAccessToken } from '../services/api';
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST, sleep } from '../utils/marketTime';
import { INDEX_OPTS, TOP_FO_SYMBOLS, SECTOR_CTX_MAP, NIFTY50_FALLBACK, isWeeklyExpiryDay, getTimeOfDayPenalty } from '../constants/config';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain, applyFIIBias } from '../services/technical';
import { useIndexFeed } from '../hooks/useIndexFeed.js';
import { logSignals, buildOptionSignal } from '../services/github';

function getChgPct(q) {
  if (!q) return 0;
  if (q.net_change_percentage != null) return +q.net_change_percentage;
  if (q.net_change != null && q.last_price > 0) {
    const pc = q.last_price - q.net_change;
    return pc > 0 ? (q.net_change / pc) * 100 : 0;
  }
  if (q.ohlc?.open && q.ohlc.open > 0) return ((q.last_price - q.ohlc.open) / q.ohlc.open) * 100;
  return 0;
}

const OPT_FILTERS = [
  { id:'all',label:'All' },{ id:'nifty',label:'Nifty' },{ id:'banknifty',label:'BankNifty' },
  { id:'sensex',label:'Sensex' },{ id:'finnifty',label:'FinNifty' },{ id:'stocks',label:'📊 Stocks' },
  { id:'buy',label:'📈 BUY' },{ id:'sell',label:'📉 SELL' },
  { id:'aligned',label:'✅ With-Trend' },{ id:'counter',label:'⚠ Counter-Trend' },
];

const VIX_KEY = 'NSE_INDEX|India VIX';

function IndexLiveCard({ group, live, ctx }) {
  const spot = live?.ltp || group.spot || 0;
  const cp = live?.cp || (group.spotChg != null ? group.spot / (1 + group.spotChg / 100) : group.spot) || spot;
  const pts = spot - cp;
  const pct = cp > 0 ? (pts / cp) * 100 : group.spotChg || 0;
  const positive = pts >= 0;
  return (
    <div style={{ background:'#fff', border:'1px solid #dbe3ee', borderRadius:8, padding:'11px 13px', boxShadow:'0 1px 3px rgba(15,23,42,.06)' }}>
      <div style={{ fontSize:9, color:'#94a3b8', letterSpacing:.7, marginBottom:5 }}>{group.name} SPOT · LIVE</div>
      <div style={{ fontSize:20, lineHeight:1, fontWeight:850, color:positive ? '#16a34a' : '#dc2626' }}>₹{fmt(spot, 0)}</div>
      <div style={{ fontSize:10, color:positive ? '#16a34a' : '#dc2626', marginTop:5 }}>{positive ? '+' : ''}{pts.toFixed(2)} pts</div>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center', fontSize:9, marginTop:7 }}>
        <span>PCR <b>{group.pcr?.toFixed(2) || '—'}</b></span>
        <span style={{ color:positive ? '#16a34a' : '#dc2626' }}>{fmtC(pct)}</span>
        {live && <span style={{ color:'#16a34a', fontWeight:700 }}>LIVE</span>}
      </div>
      <div style={{ fontSize:9, color:'#64748b', marginTop:4 }}>
        🎯₹{fmt(group.maxPain || 0, 0)} · 📉₹{fmt(group.oiWalls?.callWall || 0, 0)} · 📈₹{fmt(group.oiWalls?.putWall || 0, 0)}
      </div>
      <div style={{ fontSize:9, color:ctx?.neutral ? '#d97706' : ctx?.bullish ? '#16a34a' : '#dc2626', marginTop:4, fontWeight:700 }}>
        {ctx?.neutral ? 'Neutral' : ctx?.bullish ? 'With-trend' : 'Weak trend'} · cap≤₹10K · WS
      </div>
    </div>
  );
}

function getOptionKey(opt) {
  return opt?.instrument_key || opt?.instrumentKey || opt?.instrument_token || opt?.instrumentToken || '';
}

function withLiveOI(chain = [], liveOptionPrices = {}) {
  return chain.map((row) => {
    const callKey = getOptionKey(row.call_options);
    const putKey = getOptionKey(row.put_options);
    const callLive = liveOptionPrices[callKey];
    const putLive = liveOptionPrices[putKey];
    return {
      ...row,
      call_options: row.call_options ? {
        ...row.call_options,
        market_data: {
          ...(row.call_options.market_data || {}),
          oi: callLive?.oi ?? row.call_options.market_data?.oi,
          ltp: callLive?.ltp ?? row.call_options.market_data?.ltp,
        },
      } : row.call_options,
      put_options: row.put_options ? {
        ...row.put_options,
        market_data: {
          ...(row.put_options.market_data || {}),
          oi: putLive?.oi ?? row.put_options.market_data?.oi,
          ltp: putLive?.ltp ?? row.put_options.market_data?.ltp,
        },
      } : row.put_options,
    };
  });
}

function calcStructure(chain) {
  const maxPain = calcMaxPain(chain);
  const oiWalls = calcOIWalls(chain);
  const ceOI = chain.reduce((s, x) => s + (x.call_options?.market_data?.oi || 0), 0);
  const peOI = chain.reduce((s, x) => s + (x.put_options?.market_data?.oi  || 0), 0);
  const pcr = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1.0;
  return { maxPain, oiWalls, pcr };
}

function OptionCard({ pick, cfg: cardCfg }) {
  const isBuy   = pick.action === 'BUY';
  const bg      = isBuy ? '#f0fdf4' : '#fef2f2';
  const bdr     = isBuy ? '#16a34a' : '#dc2626';
  const rc      = isBuy ? 'buy' : pick.action === 'SELL' ? 'sell' : 'watch';
  const dc      = Math.abs(pick.delta || 0) >= 0.5 ? 'up' : Math.abs(pick.delta || 0) >= 0.3 ? 'am' : 'dn';
  const ivc     = (pick.iv || 0) >= 35 ? 'dn' : (pick.iv || 0) >= 20 ? 'am' : 'up';
  const minConf = cardCfg?.minOptConf || 65;
  const confC   = pick.confidence >= minConf ? 'up' : pick.confidence >= minConf - 15 ? 'am' : 'dn';
  const slPct   = pick.entry > 0 ? ((pick.entry - pick.sl) / pick.entry * 100).toFixed(2) : 0;
  const tgtPct  = pick.entry > 0 ? ((pick.tgt - pick.entry) / pick.entry * 100).toFixed(2) : 0;
  const vix_    = pick.vix || 15;
  const ivRatio = pick.iv > 0 && vix_ > 0 ? +(pick.iv / vix_).toFixed(2) : null;
  const ivCheap = ivRatio != null && ivRatio < 0.80;
  const ivRich  = ivRatio != null && ivRatio > 1.40;
  const ivLabel = ivCheap ? `💡 IV CHEAP (${ivRatio}× VIX)` : ivRich ? `🔥 IV RICH (${ivRatio}× VIX)` : null;
  const ivLabelCol = ivCheap ? '#065f46' : ivRich ? '#991b1b' : '#374151';
  const isExpiry = isWeeklyExpiryDay();
  const isOpening = (() => { const d = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'})); const m = d.getHours()*60+d.getMinutes(); return m>=555&&m<=585; })();
  const portSz = cardCfg?.portSize || 500000, riskPct2 = cardCfg?.riskPct || 2;
  const maxRisk = portSz * riskPct2 / 100;
  const lossPerLot = pick.maxLoss || 0;
  const recLots = lossPerLot > 0 ? Math.max(1, Math.floor(maxRisk / lossPerLot)) : 0;
  const recCapital = recLots > 0 ? recLots * (pick.entry || 0) * (pick.lot || 1) : 0;
  const sizeColor = recLots <= 1 ? '#92400e' : recLots >= 3 ? '#15803d' : '#1d4ed8';
  const sizeBg    = recLots <= 1 ? '#fffbeb' : recLots >= 3 ? '#f0fdf4' : '#eff6ff';
  const delta_ = Math.abs(pick.delta || 0.4), theta_ = Math.abs(pick.theta || 0);
  const spot_  = pick.spot || 0;
  const isCE_  = pick.type === 'CE';
  const beSpot = spot_ > 0 ? (isCE_ ? pick.strike + (pick.entry||0) : pick.strike - (pick.entry||0)) : 0;
  const bePct  = spot_ > 0 ? ((beSpot - spot_) / spot_ * 100).toFixed(2) : '?';
  const oiMap  = { LONG_BUILD:{txt:'📈 Long Build-up',bg:'#f0fdf4',br:'#86efac',c:'#15803d'}, SHORT_COVER:{txt:'↩ Short Covering',bg:'#f0fdf4',br:'#bbf7d0',c:'#166534'}, SHORT_BUILD:{txt:'📉 Short Build-up',bg:'#fef2f2',br:'#fca5a5',c:'#dc2626'}, LONG_UNWIND:{txt:'↪ Long Unwinding',bg:'#fef2f2',br:'#fecaca',c:'#991b1b'} };
  const ivEnvMap = { EXPANDING:{txt:'🔥 IV Expanding',bg:'#fff7ed',br:'#fed7aa',c:'#c2410c'}, RISING:{txt:'↑ IV Rising',bg:'#fffbeb',br:'#fde68a',c:'#92400e'}, CONTRACTING:{txt:'❄ IV Contracting',bg:'#eff6ff',br:'#bfdbfe',c:'#1d4ed8'}, FALLING:{txt:'↓ IV Falling',bg:'#f0f9ff',br:'#bae6fd',c:'#0369a1'} };
  const pzoneColor = pick.priceZone === 'abovePDH' || pick.priceZone === 'nearPDH' ? '#15803d' : pick.priceZone === 'belowPDL' || pick.priceZone === 'nearPDL' ? '#991b1b' : '#92400e';
  const pzoneBg = pick.priceZone === 'abovePDH' || pick.priceZone === 'nearPDH' ? '#f0fdf4' : pick.priceZone === 'belowPDL' || pick.priceZone === 'nearPDL' ? '#fef2f2' : '#fffbeb';
  const pzoneLabel = pick.priceZone === 'abovePDH' ? `📈 Above PDH ₹${pick.pdh||''} — breakout zone (+10 conf)` : pick.priceZone === 'nearPDH' ? `📈 Near PDH ₹${pick.pdh||''} — approaching breakout (+5 conf)` : pick.priceZone === 'belowPDL' ? `📉 Below PDL ₹${pick.pdl||''} — breakdown zone (+10 conf)` : pick.priceZone === 'nearPDL' ? `📉 Near PDL ₹${pick.pdl||''} — approaching breakdown (+5 conf)` : `⚠ Mid-range (PDH ₹${pick.pdh||'?'} / PDL ₹${pick.pdl||'?'}) — caution (-18 conf)`;

  const scenarios = [-2,-1,0,1,2].map(pct => {
    const dSpot = spot_ * pct / 100, dPrem = delta_ * dSpot * (isCE_ ? 1 : -1);
    const newPrem = Math.max(0, (pick.entry||0) + dPrem), pnl = newPrem - (pick.entry||0);
    return { pct, newPrem:+newPrem.toFixed(2), pnl:+pnl.toFixed(2), pnlPct:pick.entry>0?(pnl/pick.entry*100).toFixed(0):0 };
  });

  return (
    <div className={`card ${rc}`}>
      <span className={`c-rec ${rc}`}>{pick.action}</span>
      {pick.atm && <span style={{position:'absolute',top:11,right:72,background:'#eff6ff',color:'#1d4ed8',fontSize:8,fontWeight:700,padding:'2px 6px',borderRadius:10}}>ATM</span>}

      {/* Counter-trend warning */}
      {!pick.trendAligned && (
        <div style={{background:'#fef3c7',border:'1px solid #fcd34d',borderRadius:6,padding:'4px 10px',marginBottom:8,fontSize:9,fontWeight:700,color:'#92400e'}}>
          ⚠ AGAINST TREND — Market: {pick.trendDir}{pick.compositeScore!=null?` (score ${pick.compositeScore})`:''} · Counter-directional. Lower confidence applied.
        </div>
      )}

      {/* Header */}
      <div className="c-head" style={{paddingRight:80}}>
        <div className="c-sym">
          {pick.und} {pick.strike} {pick.type}
          <span style={{fontSize:10,fontWeight:700,color:pick.confidence>=minConf?'#16a34a':pick.confidence>=minConf-15?'#d97706':'#dc2626',marginLeft:6}}>{pick.confidence}% conf</span>
        </div>
        <div className="c-name">{pick.type==='CE'?'📈 Call':'📉 Put'} · Lot {pick.lot} · Spot ₹{fmt(pick.spot,0)} · Exp {pick.expiry}</div>
      </div>

      {/* Capital required */}
      <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'8px 10px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div>
          <div style={{fontSize:7,color:'#64748b',marginBottom:2}}>CAPITAL REQUIRED</div>
          <div style={{fontSize:16,fontWeight:800,color:'#0f172a'}}>₹{fmt(pick.amtRequired||0,0)}</div>
          <div style={{fontSize:9,color:'#64748b'}}>{pick.lot} qty × ₹{fmt(pick.entry)} premium</div>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:7,color:'#64748b',marginBottom:2}}>MAX PROFIT</div>
          <div style={{fontSize:13,fontWeight:700,color:'#16a34a'}}>+₹{fmt(pick.maxProfit||0,0)}</div>
          <div style={{fontSize:9,color:'#dc2626'}}>Max Loss: −₹{fmt(Math.abs(pick.maxLoss||0),0)}</div>
        </div>
      </div>

      {/* Trade setup */}
      <div className="trade-setup">
        <div className="ts-box"><div className="ts-l">ENTRY</div><div className="ts-v bl">₹{fmt(pick.entry||0)}</div><div className="ts-s" style={{color:'#64748b'}}>LTP</div></div>
        <div className="ts-box"><div className="ts-l">{pick.action==='SELL'?'SL (ABOVE)':'STOP LOSS'}</div><div className="ts-v dn">₹{fmt(pick.sl||0)}</div><div className="ts-s dn">{pick.action==='BUY'?'-':'+'}{ slPct}%</div></div>
        <div className="ts-box"><div className="ts-l">TARGET</div><div className="ts-v up">₹{fmt(pick.tgt||0)}</div><div className="ts-s up">{pick.action==='BUY'?'+':'-'}{tgtPct}% · R:R {(pick.rr||0).toFixed?pick.rr.toFixed(1):pick.rr}</div></div>
      </div>
      {pick.slTgtMethod && <div style={{fontSize:8,color:'#94a3b8',marginTop:3,padding:'0 2px'}}>📐 {pick.slTgtMethod}{isExpiry?' · ⚡ EXPIRY DAY':''}</div>}

      {/* Expiry day banner */}
      {isExpiry && <div style={{background:'#fef3c7',border:'1px solid #fcd34d',borderRadius:6,padding:'3px 8px',marginTop:4,marginBottom:6,fontSize:9,fontWeight:700,color:'#92400e'}}>⚡ EXPIRY DAY — Gamma elevated · ATM moves 3-5× normal · Tight SL applied</div>}
      {isOpening && <div style={{background:'#f0fdf4',border:'1px solid #86efac',borderRadius:6,padding:'3px 8px',marginBottom:6,fontSize:9,fontWeight:700,color:'#15803d'}}>⏰ OPENING HOUR (9:15–9:45) — Best historical win rate · +5 conf bonus applied</div>}

      {/* EMA + Volume badges */}
      {(pick.emaCross || pick.volRatio >= 1.5 || pick.momentumFresh) && (
        <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:6}}>
          {pick.emaCross==='bullish_cross'&&pick.type==='CE'&&<span style={{background:'#dcfce7',color:'#15803d',border:'1px solid #86efac',fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>📶 EMA CROSS ↑ {(pick.emaCrossCandles||0)<=1?'FRESH':pick.emaCrossCandles+'c ago'}</span>}
          {pick.emaCross==='bearish_cross'&&pick.type==='PE'&&<span style={{background:'#fef2f2',color:'#991b1b',border:'1px solid #fecaca',fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>📶 EMA CROSS ↓ {(pick.emaCrossCandles||0)<=1?'FRESH':pick.emaCrossCandles+'c ago'}</span>}
          {!pick.emaCross&&pick.emaTrendBull===true&&pick.type==='CE'&&<span style={{background:'#f0fdf4',color:'#15803d',border:'1px solid #bbf7d0',fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>📶 EMA Bull</span>}
          {!pick.emaCross&&pick.emaTrendBull===false&&pick.type==='PE'&&<span style={{background:'#fef2f2',color:'#991b1b',border:'1px solid #fecaca',fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>📶 EMA Bear</span>}
          {(pick.volRatio||0)>=2.0&&<span style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>📊 VOL {pick.volRatio}× surge</span>}
          {(pick.volRatio||0)>=1.5&&(pick.volRatio||0)<2.0&&<span style={{background:'#eff6ff',color:'#1d4ed8',border:'1px solid #bfdbfe',fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>📊 VOL {pick.volRatio}× avg</span>}
          {pick.momentumFresh&&<span style={{background:'#fefce8',color:'#854d0e',border:'1px solid #fde68a',fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>⚡ FRESH momentum</span>}
        </div>
      )}

      {/* PDH/PDL zone */}
      {pick.priceZone && <div style={{fontSize:9,fontWeight:700,padding:'3px 8px',borderRadius:5,marginBottom:5,background:pzoneBg,color:pzoneColor}}>{pzoneLabel}{pick.dirFlipPenalty?' · ⚠ Direction flipped ('+pick.dirFlipPenalty+' conf)':''}</div>}

      {/* Confidence bar */}
      <div>
        <span className="bar-lbl">Confidence</span>
        <div className="bar-track"><div className="bar-fill" style={{width:pick.confidence+'%',background:pick.confidence>=minConf?'#16a34a':pick.confidence>=minConf-15?'#d97706':'#dc2626'}}/></div>
        <span className={`bar-val ${confC}`}>{pick.confidence}%</span>
      </div>

      {/* Greeks */}
      <div className="c-metrics cm4" style={{gap:1,marginBottom:7}}>
        <div className={`cbox ${rc}`}><div className="cb-l">DELTA Δ</div><div className={`cb-v ${dc}`} style={{fontSize:13}}>{(pick.delta||0).toFixed(2)}</div></div>
        <div className={`cbox ${rc}`} style={ivLabel?{background:ivCheap?'#ecfdf5':ivRich?'#fef2f2':'',border:`1px solid ${ivCheap?'#a7f3d0':ivRich?'#fecaca':'#e2e8f0'}`}:{}}><div className="cb-l">IV %</div><div className={`cb-v ${ivc}`} style={{fontSize:13}}>{(pick.iv||0).toFixed(1)}</div>{ivLabel&&<div className="cb-s" style={{color:ivLabelCol,fontWeight:700,fontSize:7}}>{ivLabel}</div>}</div>
        <div className={`cbox ${rc}`}><div className="cb-l">THETA Θ</div><div className="cb-v dn" style={{fontSize:13}}>{(pick.theta||0).toFixed(2)}</div></div>
        <div className={`cbox ${rc}`}><div className="cb-l">OI CHG</div><div className={`cb-v ${(pick.oiChg||0)>=0?'up':'dn'}`} style={{fontSize:13}}>{(pick.oiChg||0).toFixed(0)}%</div></div>
      </div>
      <div className="c-metrics cm2" style={{gap:1,marginBottom:8}}>
        <div className="cbox neutral"><div className="cb-l">OPEN INTEREST</div><div className="cb-v" style={{color:'#374151',fontSize:12}}>{(pick.oi||0).toLocaleString('en-IN')}</div><div className="cb-s" style={{color:'#64748b'}}>{(pick.oiChg||0)>10?'Buildup':(pick.oiChg||0)<-10?'Unwinding':'Stable'}</div></div>
        <div className="cbox neutral"><div className="cb-l">SIGNAL SCORE</div><div className="cb-v am">{pick.score||0}/9</div><div className="cb-s" style={{color:'#64748b'}}>{(pick.signals||[]).length} triggers</div></div>
      </div>

      {/* OI Build + IV Env */}
      {(pick.oiBuildType&&pick.oiBuildType!=='NEUTRAL'&&oiMap[pick.oiBuildType]||pick.ivEnv&&ivEnvMap[pick.ivEnv]) && (
        <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:8}}>
          {pick.oiBuildType&&pick.oiBuildType!=='NEUTRAL'&&oiMap[pick.oiBuildType]&&(()=>{const b=oiMap[pick.oiBuildType];return<span style={{background:b.bg,color:b.c,border:`1px solid ${b.br}`,fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>{b.txt}{(pick.oiBuildBonus||0)>0?' +'+pick.oiBuildBonus:''+pick.oiBuildBonus} conf</span>;})()}
          {pick.ivEnv&&ivEnvMap[pick.ivEnv]&&(()=>{const b=ivEnvMap[pick.ivEnv];return<span style={{background:b.bg,color:b.c,border:`1px solid ${b.br}`,fontSize:8,fontWeight:700,padding:'2px 7px',borderRadius:10}}>{b.txt}</span>;})()}
        </div>
      )}

      {/* Signal indicators */}
      <div className="c-inds">{(pick.signals||[]).map((s,i)=><span key={i} className="ind ok">{s.l}</span>)}</div>

      {/* Position sizing */}
      {recLots > 0 && (
        <div style={{background:sizeBg,border:'1px solid #e2e8f0',borderRadius:8,padding:'8px 10px',marginBottom:8,marginTop:4}}>
          <div style={{fontSize:8,color:'#64748b',fontWeight:700,marginBottom:4}}>💰 POSITION SIZING (₹{(portSz/100000).toFixed(1)}L portfolio · {riskPct2}% risk = ₹{fmt(maxRisk,0)} max loss)</div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div><span style={{fontSize:18,fontWeight:800,color:sizeColor}}>{recLots} lot{recLots>1?'s':''}</span><span style={{fontSize:9,color:'#64748b',marginLeft:6}}>recommended</span></div>
            <div style={{textAlign:'right',fontSize:9,color:'#64748b'}}>Capital: ₹{fmt(recCapital,0)}<br/>Max loss: ₹{fmt(recLots*lossPerLot,0)}</div>
          </div>
          {recLots>3&&<div style={{fontSize:8,color:'#64748b',marginTop:3}}>⚠ Consider max {Math.min(recLots,3)} lots to diversify</div>}
        </div>
      )}

      {/* Payoff calculator */}
      {spot_ > 0 && (pick.entry||0) > 0 && (
        <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:8,padding:'8px 10px',marginBottom:8}}>
          <div style={{fontSize:8,color:'#64748b',fontWeight:700,marginBottom:6}}>📊 PAYOFF CALCULATOR (delta approx · underlying moves)</div>
          {scenarios.map(s=>(
            <div key={s.pct} style={{display:'flex',justifyContent:'space-between',padding:'3px 6px',borderRadius:4,background:s.pnl>0?'#f0fdf4':s.pnl<0?'#fef2f2':'#f8fafc'}}>
              <span style={{fontSize:9,color:'#374151',fontWeight:600}}>{s.pct>0?'+':''}{s.pct}% (₹{fmt(spot_*(1+s.pct/100),0)})</span>
              <span style={{fontSize:9,fontWeight:700,color:s.pnl>0?'#16a34a':s.pnl<0?'#dc2626':'#64748b'}}>₹{fmt(s.newPrem)} {s.pnlPct!=='0'?`(${s.pnlPct>0?'+':''}${s.pnlPct}%)`:''}</span>
            </div>
          ))}
          <div style={{display:'flex',gap:6,marginTop:6,paddingTop:6,borderTop:'1px solid #e2e8f0'}}>
            <div style={{flex:1,textAlign:'center'}}>
              <div style={{fontSize:7,color:'#64748b'}}>BREAK-EVEN</div>
              <div style={{fontSize:10,fontWeight:700,color:'#374151'}}>₹{fmt(beSpot,0)}</div>
              <div style={{fontSize:8,color:parseFloat(bePct)>0?'#dc2626':'#16a34a'}}>{parseFloat(bePct)>0?'+':''}{bePct}% move needed</div>
            </div>
            <div style={{flex:1,textAlign:'center'}}>
              <div style={{fontSize:7,color:'#64748b'}}>THETA DECAY</div>
              <div style={{fontSize:9,color:'#64748b'}}>1d: <b>₹{Math.max(0,(pick.entry||0)-theta_).toFixed(2)}</b> · 3d: <b>₹{Math.max(0,(pick.entry||0)-theta_*3).toFixed(2)}</b></div>
              <div style={{fontSize:7,color:'#dc2626'}}>-₹{theta_.toFixed(2)}/day</div>
            </div>
          </div>
        </div>
      )}

      {/* Mini intraday chart */}
      {pick.candles?.length >= 5 && (()=>{
        const ch = pick.candles, W=320, H=100, pad={t:6,r:4,b:14,l:2};
        const cw=W-pad.l-pad.r, ch2=H-pad.t-pad.b;
        const hi=Math.max(...ch.map(c=>+c[2])), lo=Math.min(...ch.map(c=>+c[3]));
        const range=hi-lo; if(range<=0) return null;
        const py=p=>pad.t+ch2*(1-(p-lo)/range);
        const sw=cw/ch.length, bw=Math.max(2,sw*0.6);
        let cs='';
        ch.forEach((c,i)=>{const [,o,h,l,cl]=c.map(Number);const up=cl>=o;const col=up?'#16a34a':'#dc2626';const bt=py(Math.max(o,cl));const bh=Math.max(1,py(Math.min(o,cl))-bt);const x=pad.l+(i+0.5)*sw;cs+=`<line x1="${x}" y1="${py(h)}" x2="${x}" y2="${py(l)}" stroke="${col}" stroke-width="1" opacity="0.8"/><rect x="${(x-bw/2).toFixed(1)}" y="${bt.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" rx="0.5"/>`;});
        return(
          <div style={{marginBottom:8}}>
            <div style={{fontSize:8,color:'#64748b',fontWeight:700,marginBottom:3}}>📈 {pick.und} INTRADAY (5-min · last {Math.min(20,ch.length)} candles)</div>
            <div dangerouslySetInnerHTML={{__html:`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;border-radius:6px;background:#f8fafc;border:1px solid #e2e8f0">${cs}</svg>`}}/>
          </div>
        );
      })()}

      <div className={`c-why ${rc}`}>{pick.type==='CE'?'📈 Call':'📉 Put'} on {pick.und} · Strike {pick.strike}. Capital: ₹{fmt(pick.amtRequired||0,0)} for {pick.lot} qty. Max profit ₹{fmt(pick.maxProfit||0,0)} if target hit.</div>
    </div>
  );
}

export default function OptionsPane() {
  const {
    token, cfg, marketStatus, lg, onTokenExpired, updateBadge, fiiInterp, fiiData, gh,
    activeTab, setScanning, setStatusDot, setStatusTxt,
  } = useApp();
  const accessToken = resolveAccessToken(token);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [groups, setGroups]     = useState([]);
  const [vix, setVix]           = useState(0);
  const [filter, setFilter]     = useState('all');
  const [progress, setProgress] = useState('');
  const [updTime, setUpdTime]   = useState('');
  const [marketCtxMap, setMarketCtxMap] = useState({});
  const loadingRef = useRef(false);
  const prevAvgIVCache = useRef({}), prevPCRCache = useRef({});
  const liveKeys = useMemo(() => [...INDEX_OPTS.map((idx) => idx.key), VIX_KEY], []);
  const { lastPrices: liveIndexPrices } = useMarketFeed(
    accessToken, liveKeys, liveKeys.length > 0, { pollFallback: false }
  );
  const optionLiveKeys = useMemo(() => {
    const keys = [];
    for (const g of groups) {
      for (const row of g.chain || []) {
        const callKey = getOptionKey(row.call_options);
        const putKey = getOptionKey(row.put_options);
        if (callKey) keys.push(callKey);
        if (putKey) keys.push(putKey);
      }
    }
    return [...new Set(keys)].slice(0, 1200);
  }, [groups]);
  const { lastPrices: liveOptionPrices } = useMarketFeed(
    accessToken, optionLiveKeys, optionLiveKeys.length > 0, { pollFallback: false, mode: 'full' }
  );
  const liveGroups = useMemo(() => groups.map((g) => {
    if (!g.chain?.length || Object.keys(liveOptionPrices).length === 0) return g;
    const chain = withLiveOI(g.chain, liveOptionPrices);
    return { ...g, chain, ...calcStructure(chain) };
  }), [groups, liveOptionPrices]);

  useEffect(() => { if (accessToken && marketStatus.open) loadOptions(); }, [accessToken]); // eslint-disable-line
  useEffect(() => {
    const onScan = () => {
      if (activeTab === 'options') loadOptions(true);
    };
    document.addEventListener('friday:scan', onScan);
    return () => document.removeEventListener('friday:scan', onScan);
  }, [activeTab, accessToken]); // eslint-disable-line
  useEffect(() => {
    const liveVix = liveIndexPrices[VIX_KEY]?.ltp;
    if (liveVix > 0) setVix(liveVix);
    if (Object.keys(liveIndexPrices).length > 0) setUpdTime('Live: ' + getIST());
  }, [liveIndexPrices]);

  async function loadOptions() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setScanning(true); setStatusDot('scan'); setStatusTxt('Scanning options...');
    setLoading(false); setError(''); setProgress('Step 1: Fetching Nifty direction + VIX...');
    try {
      // Step 1: index quotes + VIX
      const mktD = await fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|India VIX', accessToken, onTokenExpired);
      const nQ   = mktD['NSE_INDEX|Nifty 50'];
      const vQ   = mktD['NSE_INDEX|India VIX'];
      if (!nQ?.last_price) throw new Error('Nifty quote missing');
      const vixVal    = vQ?.last_price || 15;
      const nLtp      = nQ.last_price;
      const nNetChg   = nQ.net_change ?? (nQ.ohlc?.open ? nLtp - nQ.ohlc.open : 0);
      const nChgPct   = nLtp > 0 ? (nNetChg / nLtp) * 100 : 0;
      const niftyBull = nChgPct > -0.3;
      setVix(vixVal);

      // Step 1b: Per-index intraday candles SEQUENTIALLY (same as HTML — 400ms gaps)
      setProgress('Step 1b: Fetching intraday candles...');
      const INDEX_CANDLE_KEYS = [
        'NSE_INDEX|Nifty 50',
        'NSE_INDEX|Nifty Bank',
        'BSE_INDEX|SENSEX',
        'NSE_INDEX|Nifty Fin Service',
      ];
      const idxCandles = {};
      for (const key of INDEX_CANDLE_KEYS) {
        try { idxCandles[key] = await fetchIntraday(key, '5minute', accessToken, onTokenExpired); }
        catch (e) { idxCandles[key] = []; }
        await sleep(400);
      }

      // Compute per-index marketCtx
      const ctxMap = {};
      for (const idx of INDEX_OPTS) {
        const candles = idxCandles[idx.key] || [];
        const q2      = await fetchQ(idx.key, accessToken, onTokenExpired).then(d => d[idx.key]).catch(() => null);
        if (!q2?.last_price) continue;
        const spotChg = getChgPct(q2);
        ctxMap[idx.name] = computeCtxFromCandles(candles, q2.last_price, spotChg, vixVal, null);
      }
      setMarketCtxMap(ctxMap);

      // Step 2: Scan each index
      const built = [];
      for (const [ui, idx] of INDEX_OPTS.entries()) {
        const q = await fetchQ(idx.key, accessToken, onTokenExpired).then(d => d[idx.key]).catch(() => null);
        if (!q?.last_price) continue;
        setProgress(`Step 2: Scanning ${idx.name} chain (${ui+1}/${INDEX_OPTS.length})...`);
        const spot    = q.last_price;
        const spotChg = getChgPct(q);
        const marketCtx = ctxMap[idx.name] || computeCtxFromCandles([], spot, spotChg, vixVal, null);

        // Expiry
        let expiry = '';
        try {
          const cd = await fetch(
            `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(idx.key)}`,
            { headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' } }
          ).then(r => r.json());
          expiry = (cd?.data?.map(e => e.expiry).sort() || [])[0] || '';
        } catch (e) { lg('Contract ' + idx.name + ': ' + e.message, 'w'); }
        if (!expiry) continue;

        // Full chain
        const chain = await fetchOptions(idx.key, expiry, accessToken, onTokenExpired);
        if (!chain.length) { lg(idx.name + ': empty chain', 'w'); continue; }

        // Max Pain + OI Walls
        const maxPain = calcMaxPain(chain);
        const oiWalls = calcOIWalls(chain);

        // PCR
        const ceOI = chain.reduce((s, x) => s + (x.call_options?.market_data?.oi || 0), 0);
        const peOI = chain.reduce((s, x) => s + (x.put_options?.market_data?.oi  || 0), 0);
        const pcr  = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1.0;

        // PCR trend
        const prevPCR = prevPCRCache.current[idx.name] ?? pcr;
        prevPCRCache.current[idx.name] = pcr;
        const pcrTrend = +(pcr - prevPCR).toFixed(3);

        // IV trend
        const chainIVs = chain.flatMap(r => [r.call_options?.option_greeks?.iv, r.put_options?.option_greeks?.iv]).filter(v => v > 0);
        const avgIV    = chainIVs.length ? +(chainIVs.reduce((a, b) => a + b, 0) / chainIVs.length).toFixed(1) : null;
        const prevAvgIV = prevAvgIVCache.current[idx.name] ?? avgIV;
        if (avgIV != null) prevAvgIVCache.current[idx.name] = avgIV;
        const ivTrend = (avgIV != null && prevAvgIV != null) ? +(avgIV - prevAvgIV).toFixed(2) : 0;

        // Enrich marketCtx with PCR trend + IV trend
        const richCtx = { ...marketCtx, pcr, pcrTrend, ivTrend, avgIV, prevAvgIV };

        // ATM strike
        const atm  = Math.round(spot / idx.step) * idx.step;

        // Full scanChain — exact HTML port
        const picks = scanChain(chain, atm, spot, idx.name, expiry, idx.lot, niftyBull, vixVal, maxPain, pcr, richCtx, cfg);

        // Apply FII bias to each pick's confidence
        const picksWithFII = picks.map(p => ({
          ...p,
          confidence: applyFIIBias(p.confidence, p.action === 'BUY', fiiData),
          _dte: p._dte ?? null,
          nearMaxPain: maxPain > 0 && Math.abs(p.strike - maxPain) / spot < 0.01,
        })).filter(p => p.confidence >= cfg.minOptConf && (cfg.maxOptCapital <= 0 || p.amtRequired <= cfg.maxOptCapital));

        lg(`${idx.name}: ${chain.length} strikes → ${picks.length} raw → ${picksWithFII.length} ≥${cfg.minOptConf}% | composite=${richCtx.compositeScore} pcr=${pcr}`, 'o');
        built.push({ name: idx.name, spot, spotChg, picks: picksWithFII, expiry, chain, maxPain, oiWalls, pcr, pcrTrend, ivTrend });
      }

      // Step 3: Stock F&O options (same as HTML — top F&O stocks)
      const foStocks = NIFTY50_FALLBACK.filter(s => s.fo && TOP_FO_SYMBOLS.includes(s.s));
      const foKeys = foStocks.map(s => s.key).join(',');
      let foSpots = {};
      try { foSpots = await fetchQ(foKeys, accessToken, onTokenExpired); lg(`FO spots: ${Object.keys(foSpots).length}`, 'o'); }
      catch(e) { lg('FO spots: ' + e.message, 'w'); }

      for (let fi = 0; fi < foStocks.length; fi++) {
        const inst = foStocks[fi];
        setProgress(`Step 3: Stock options ${fi+1}/${foStocks.length}: ${inst.s}...`);
        try {
          const q = foSpots[inst.key]; const spot = q?.last_price || 0;
          if (spot < 1) { lg(inst.s + ': no spot', 'w'); continue; }
          const spotChg = getChgPct(q);
          // Sector-aware context — banking stocks use BankNifty ctx
          const ctxKey = SECTOR_CTX_MAP[inst.s] || 'NIFTY';
          const baseCtx = ctxMap[ctxKey] || ctxMap['NIFTY'] || computeCtxFromCandles([], spot, spotChg, vixVal, null);
          const dayScore = spotChg > 1 ? 2 : spotChg > 0.3 ? 1 : spotChg < -1 ? -2 : spotChg < -0.3 ? -1 : 0;
          const stkCtx = { ...baseCtx, spot, dayChange: spotChg, dayScore };
          stkCtx.compositeScore = +((stkCtx.momentumScore||0)*1.0 + dayScore*0.3 + (stkCtx.vwapScore||0)*1.5 + ((stkCtx.emaScore||0))*2.0).toFixed(2);
          stkCtx.bullish = stkCtx.compositeScore > 0;
          stkCtx.neutral = Math.abs(stkCtx.compositeScore) < 0.5;
          // PCR + IV trend
          let expiry = '';
          try { const cd = await fetch(`https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(inst.key)}`, { headers:{ Authorization:'Bearer '+accessToken, Accept:'application/json' } }).then(r=>r.json()); expiry = (cd?.data?.map(e=>e.expiry).sort()||[])[0]||''; } catch(e) {}
          if (!expiry) continue;
          await sleep(300);
          const chain = await fetchOptions(inst.key, expiry, accessToken, onTokenExpired);
          if (!chain.length) continue;
          const ceOI2 = chain.reduce((s,x)=>s+(x.call_options?.market_data?.oi||0),0), peOI2 = chain.reduce((s,x)=>s+(x.put_options?.market_data?.oi||0),0);
          const pcr2 = ceOI2 > 0 ? +(peOI2/ceOI2).toFixed(2) : 1;
          const prevPCR2 = prevPCRCache.current[inst.s] ?? pcr2; prevPCRCache.current[inst.s] = pcr2;
          const chainIVs2 = chain.flatMap(r=>[r.call_options?.option_greeks?.iv,r.put_options?.option_greeks?.iv]).filter(v=>v>0);
          const avgIV2 = chainIVs2.length ? +(chainIVs2.reduce((a,b)=>a+b,0)/chainIVs2.length).toFixed(1) : null;
          const prevAvgIV2 = prevAvgIVCache.current[inst.s] ?? avgIV2; if(avgIV2!=null) prevAvgIVCache.current[inst.s]=avgIV2;
          const ivTrend2 = avgIV2!=null&&prevAvgIV2!=null ? +(avgIV2-prevAvgIV2).toFixed(2) : 0;
          stkCtx.pcr=pcr2; stkCtx.pcrTrend=+(pcr2-prevPCR2).toFixed(3); stkCtx.ivTrend=ivTrend2; stkCtx.avgIV=avgIV2;
          const step2 = spot<200?5:spot<500?10:spot<2000?20:spot<5000?50:100;
          const atm2 = Math.round(spot/step2)*step2;
          const stkMaxPain = calcMaxPain(chain);
          const picks2 = scanChain(chain, atm2, spot, inst.s, expiry, inst.lot, niftyBull, vixVal, stkMaxPain, pcr2, stkCtx, cfg);
          const fPicks2 = picks2.map(p=>({...p, confidence:applyFIIBias(p.confidence, p.action==='BUY', fiiData)})).filter(p=>p.confidence>=cfg.minOptConf&&(cfg.maxOptCapital<=0||p.amtRequired<=cfg.maxOptCapital));
          if (fPicks2.length) { built.push({ name:inst.s, spot, spotChg, picks:fPicks2, expiry, chain, maxPain:stkMaxPain, oiWalls:calcOIWalls(chain), pcr:pcr2, pcrTrend:stkCtx.pcrTrend, ivTrend:ivTrend2, type:'stock', fullName:inst.n }); lg(`${inst.s}: ${chain.length} strikes → ${fPicks2.length} signals`, 'o'); }
        } catch(e) { lg(inst.s + ' opts: ' + e.message, 'w'); }
      }
      const withTrend = built.reduce((s, g) => s + g.picks.filter(p => p.trendAligned).length, 0);
      const total     = built.reduce((s, g) => s + g.picks.length, 0);
      updateBadge('options', withTrend > 0 ? withTrend + ' signals' : '—');
      setUpdTime('Updated: ' + getIST());
      setStatusDot('live'); setStatusTxt('Live');
      const allPicks = built.flatMap(g => g.picks);
      if (allPicks.length && gh?.token) logSignals(gh, allPicks.map(p => buildOptionSignal(p, vixVal)), vixVal, lg);
      lg(`✅ Options: ${total} signals (${withTrend} with-trend)`, 'o');
    } catch (e) {
      setError(e.message); setStatusDot('err'); setStatusTxt('Error'); lg('Options error: ' + e.message, 'e');
    } finally { setLoading(false); setScanning(false); loadingRef.current = false; }
  }

  const { txt: vixTxt } = interpVIX(vix);
  const filtered = liveGroups.map(g => ({
    ...g,
    picks: g.picks.filter(p => {
      if (filter === 'all')       return true;
      if (filter === 'nifty')     return g.name === 'NIFTY';
      if (filter === 'banknifty') return g.name === 'BANKNIFTY';
      if (filter === 'sensex')    return g.name === 'SENSEX';
      if (filter === 'finnifty')  return g.name === 'FINNIFTY';
      if (filter === 'buy')       return p.action === 'BUY';
      if (filter === 'sell')      return p.action === 'SELL';
      if (filter === 'stocks')    return g.type === 'stock';
      if (filter === 'counter')   return !p.trendAligned;
      return true;
    }),
  })).filter(g => g.picks.length > 0);

  return (
    <div>
      {!marketStatus.open && <MarketClosedBanner msg={marketStatus.msg || '🔔 NSE Market Closed'} />}
      {marketStatus.open && Object.keys(marketCtxMap).length > 0 && (() => {
        const niftyCtx = marketCtxMap['NIFTY']; if (!niftyCtx) return null;
        return <TimeOfDayBanner niftyChgPct={niftyCtx.dayChange||0} vix={niftyCtx.vix||15} />;
      })()}
      {error && <ErrorBanner title="⚠ Options Error" message={error} onRetry={() => loadOptions(true)} />}
      {loading ? (
        <Spinner label="Scanning F&O options..." progress={progress}
          sub="5-min intraday · EMA 9/21 · Composite Score · PCR trend · IV trend · Max Pain · OI Walls · Smart SL/Target" />
      ) : (
        <div>
          {updTime && <LastUpdated time={updTime} />}

          {/* FII/DII bias */}
          {fiiInterp && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:9, padding:'10px 14px', marginBottom:12 }}>
              <div style={{ fontSize:9, color:'#94a3b8', marginBottom:3 }}>FII/DII BIAS</div>
              <div style={{ fontSize:13, fontWeight:800, color:fiiInterp.color }}>{fiiInterp.label}</div>
              <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{fiiInterp.detail}</div>
            </div>
          )}

          {/* Composite momentum per index */}
          {Object.keys(marketCtxMap).length > 0 && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:9, padding:'10px 14px', marginBottom:12 }}>
              <div style={{ fontSize:9, color:'#94a3b8', marginBottom:6 }}>INTRADAY COMPOSITE MOMENTUM</div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                {Object.entries(marketCtxMap).map(([name, ctx]) => (
                  <div key={name} style={{ fontSize:10, fontWeight:700, color: ctx.neutral ? '#d97706' : ctx.bullish ? '#16a34a' : '#dc2626', background: ctx.neutral ? '#fffbeb' : ctx.bullish ? '#f0fdf4' : '#fef2f2', border:`1px solid ${ctx.neutral?'#fde68a':ctx.bullish?'#bbf7d0':'#fecaca'}`, borderRadius:6, padding:'3px 8px' }}>
                    {name}: {ctx.neutral ? '↔ NEUTRAL' : ctx.bullish ? '📈 BULL' : '📉 BEAR'} ({ctx.compositeScore > 0 ? '+' : ''}{ctx.compositeScore})
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Index stats */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(205px,1fr))', gap:12, marginBottom:12 }}>
            {liveGroups.map(g => {
              const idx = INDEX_OPTS.find((item) => item.name === g.name);
              return (
                <IndexLiveCard
                  key={g.name}
                  group={g}
                  live={idx ? liveIndexPrices[idx.key] : null}
                  ctx={marketCtxMap[g.name]}
                />
              );
            })}
            {vix > 0 && (
              <div style={{ background:'#fff', border:'1px solid #dbe3ee', borderRadius:8, padding:'11px 13px', boxShadow:'0 1px 3px rgba(15,23,42,.06)' }}>
                <div style={{ fontSize:9, color:'#94a3b8', letterSpacing:.7, marginBottom:5 }}>INDIA VIX · LIVE</div>
                <div style={{ fontSize:20, lineHeight:1, fontWeight:850, color:vix < 16 ? '#16a34a' : vix > 22 ? '#dc2626' : '#d97706' }}>{vix.toFixed(2)}</div>
                <div style={{ fontSize:10, color:'#64748b', marginTop:6 }}>{vixTxt}</div>
                {liveIndexPrices[VIX_KEY] && <div style={{ fontSize:9, color:'#16a34a', fontWeight:700, marginTop:7 }}>LIVE</div>}
              </div>
            )}
          </div>

          <div className="stats-g" style={{ display:'none' }}>
            {groups.map(g => (
              <StatCard key={g.name} label={g.name} value={`₹${fmt(g.spot)}`} sub={fmtC(g.spotChg)} valClass={g.spotChg >= 0 ? 'up' : 'dn'} />
            ))}
            {vix > 0 && <StatCard label="INDIA VIX" value={vix.toFixed(2)} sub={vixTxt} valClass={vix < 16 ? 'up' : vix > 22 ? 'dn' : 'am'} />}
          </div>

          {/* Max Pain + OI Walls */}
          {false && groups.filter(g => g.maxPain > 0).map(g => (
            <div key={g.name+'-mp'} style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:8, padding:'8px 12px', marginBottom:8, display:'flex', gap:16, flexWrap:'wrap', fontSize:10, alignItems:'center' }}>
              <span style={{ fontWeight:700 }}>{g.name}</span>
              <span>🎯 Max Pain: <b style={{ color:'#7c3aed' }}>₹{fmt(g.maxPain)}</b></span>
              {g.oiWalls?.callWall > 0 && <span>📉 Call Wall: <b style={{ color:'#dc2626' }}>₹{fmt(g.oiWalls.callWall)}</b></span>}
              {g.oiWalls?.putWall  > 0 && <span>📈 Put Wall: <b style={{ color:'#16a34a' }}>₹{fmt(g.oiWalls.putWall)}</b></span>}
              <span style={{ color:'#64748b' }}>PCR: {g.pcr?.toFixed(2)} {g.pcrTrend > 0 ? '↑' : g.pcrTrend < 0 ? '↓' : '—'}</span>
              {g.ivTrend !== 0 && <span style={{ color: g.ivTrend > 0 ? '#dc2626' : '#16a34a' }}>IV Trend: {g.ivTrend > 0 ? '+' : ''}{g.ivTrend}</span>}
            </div>
          ))}

          {/* Filters */}
          <div style={{ display:'flex', gap:6, marginBottom:12, overflowX:'auto', paddingBottom:4 }}>
            {OPT_FILTERS.map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{
                whiteSpace:'nowrap', padding:'6px 12px', borderRadius:20,
                border: filter===f.id ? 'none' : '1px solid #e2e8f0',
                fontSize:11, fontWeight:700, cursor:'pointer',
                background: filter===f.id ? '#16a34a' : '#fff',
                color:      filter===f.id ? '#fff' : '#374151',
              }}>{f.label}</button>
            ))}
          </div>

          {filtered.length === 0
            ? <EmptyState>{marketStatus.open ? '🔄 No signals meet confidence ≥' + cfg.minOptConf + '% · Try lowering in ⚙ Settings' : '📅 NSE Market Closed · Mon–Fri 9:15–15:30 IST'}</EmptyState>
            : filtered.map(g => (
              <div key={g.name}>
                <div className="opt-group-hdr">{g.fullName||g.name}{g.type==='stock'?' 📊':''} — ₹{fmt(g.spot)} ({fmtC(g.spotChg)}) · Exp: {g.expiry} · {g.picks.filter(p=>p.trendAligned).length} with-trend · {g.picks.length} total</div>
                {/* With-trend first */}
                {g.picks.filter(p=>p.trendAligned).length > 0 && (
                  <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:6, padding:'6px 10px', marginBottom:8, fontSize:10, fontWeight:700, color:'#15803d' }}>
                    ✅ {g.picks.filter(p=>p.trendAligned).length} WITH-TREND signals
                  </div>
                )}
                <div className="cards-g" style={{ marginBottom:8 }}>
                  {g.picks.filter(p=>p.trendAligned).map((p,i) => <OptionCard key={i} pick={p} cfg={cfg} />)}
                </div>
                {/* Counter-trend */}
                {g.picks.filter(p=>!p.trendAligned).length > 0 && (
                  <>
                    <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:6, padding:'6px 10px', marginBottom:8, fontSize:10, fontWeight:700, color:'#92400e' }}>
                      ⚠ {g.picks.filter(p=>!p.trendAligned).length} COUNTER-TREND — against market direction
                    </div>
                    <div className="cards-g" style={{ marginBottom:16 }}>
                      {g.picks.filter(p=>!p.trendAligned).map((p,i) => <OptionCard key={i} pick={p} cfg={cfg} />)}
                    </div>
                  </>
                )}
              </div>
            ))
          }
          <div className="disc">⚠ SL/Target: IV+DTE+Delta model · Confidence: EMA 9/21 cross + VWAP + Momentum + PCR trend + IV trend + Zone + OI build · Not SEBI advice · Always DYODD.</div>
        </div>
      )}
    </div>
  );
}

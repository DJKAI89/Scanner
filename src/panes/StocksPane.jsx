import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, MarketClosedBanner, LastUpdated, StatCard, EmptyState } from '../components/common.jsx';
import StockCard from '../components/StockCard.jsx';
import { fetchQ, fetchCandles, fetchOptions } from '../services/api';
import { logSignals, buildStockSignal } from '../services/github';
import {
  calcRSI, calcEMACrossover, calcATR, calcSupertrend, calcBBSqueeze,
  calcNR7, calcADX, detectPDHLBreakout, calc52WkBreakout, calcVolumeSurge,
  detectGap, calcWickRejection, calcRelativeStrength, calcMomentumConfluence,
  calcWeeklyMTF, boScore, boDirection, boSLTarget, getIntradayPhase,
  detectPatterns, calcRisk, calcPotential, calcSR,
  countIndicatorsEx, getRec, autoSLTarget, calcEntryTrigger, detectReversal,
  calcMACD, isNearSupport, calcRSIDivergence, getSector, calcConfidence, calcVWAP,
} from '../services/technical';
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST, getISTDate, sleep } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed.js';
import { useIndexFeed } from '../hooks/useIndexFeed.js';

function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0;
  if (q.net_change != null && ltp > 0) return (q.net_change / ltp) * 100;
  const prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

function interpPCR(p) {
  if (p >= 1.5) return { txt: 'Very Bullish' };
  if (p >= 1.2) return { txt: 'Bullish' };
  if (p >= 0.9) return { txt: 'Neutral' };
  if (p >= 0.7) return { txt: 'Bearish' };
  return            { txt: 'Very Bearish' };
}

// ── Time-of-Day reliability banner — exact HTML port ──────────
function TimeOfDayBanner({ niftyChgPct, vix }) {
  const now  = new Date();
  const istH = parseInt(now.toLocaleString('en-US', { timeZone:'Asia/Kolkata', hour:'2-digit', hour12:false })) % 24;
  const istM = parseInt(now.toLocaleString('en-US', { timeZone:'Asia/Kolkata', minute:'2-digit' }));
  const t = istH * 60 + istM;
  if (t < 9*60+15 || t > 15*60+30) return null;

  let base, label, msg;
  if      (t <= 9*60+45)  { base=35; label='Opening (9:15–9:45 AM)';        msg='Early volatility — gap fills, stop hunts common. Best to wait.'; }
  else if (t <= 10*60+30) { base=60; label='Early Session (9:45–10:30 AM)';  msg='Market finding direction. Monitor for trend confirmation.'; }
  else if (t <= 14*60)    { base=85; label='Mid Session (10:30 AM–2:00 PM)'; msg='Most reliable window. Trend established, cleanest signals.'; }
  else if (t <= 15*60)    { base=65; label='Pre-Close (2:00–3:00 PM)';       msg='Watch for reversals as positions unwind.'; }
  else                     { base=25; label='Closing (3:00–3:30 PM)';         msg='High noise near close. Avoid new intraday entries.'; }

  const lv=vix||15, nc=niftyChgPct||0; let adj=0; const conds=[];
  if      (lv>25){ adj-=20; conds.push(`⚠ VIX ${lv.toFixed(1)} (Panic)`); }
  else if (lv>20){ adj-=12; conds.push(`⚠ VIX ${lv.toFixed(1)} (High fear)`); }
  else if (lv>17){ adj-=5;  conds.push(`VIX ${lv.toFixed(1)} (Slightly elevated)`); }
  else if (lv<13){ adj+=5;  conds.push(`✅ VIX ${lv.toFixed(1)} (Low vol)`); }
  else            {          conds.push(`✅ VIX ${lv.toFixed(1)} (Normal)`); }
  const ac=Math.abs(nc);
  if      (ac>2.0){ adj-=15; conds.push(`⚠ Nifty ${nc>=0?'+':''}${nc.toFixed(2)}% (Extreme)`); }
  else if (ac>1.2){ adj+=5;  conds.push(`📈 Nifty ${nc>=0?'+':''}${nc.toFixed(2)}% (Strong trend)`); }
  else if (ac<0.3){ adj-=8;  conds.push(`📊 Nifty ${nc>=0?'+':''}${nc.toFixed(2)}% (Sideways)`); }
  else             {          conds.push(`Nifty ${nc>=0?'+':''}${nc.toFixed(2)}%`); }

  const rel=Math.max(10,Math.min(95,base+adj));
  const col=rel>=75?'#15803d':rel>=50?'#d97706':'#dc2626';
  const bg=rel>=75?'#f0fdf4':rel>=50?'#fffbeb':'#fef2f2';
  const bdr=rel>=75?'#86efac':rel>=50?'#fcd34d':'#fca5a5';
  const icon=rel>=75?'✅':rel>=50?'⚡':'⚠';
  const override = lv>25&&ac>1.5 ? '🚨 Panic conditions — signals very unreliable.' : ac>2&&nc<0 ? '📉 Strong sell-off — only PUT/short signals aligned.' : ac>2&&nc>0 ? '📈 Strong rally — only CALL/long signals aligned.' : '';

  return (
    <div style={{ background:bg, border:`1px solid ${bdr}`, borderRadius:8, padding:'10px 13px', marginBottom:12 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
        <span style={{ fontWeight:800, color:col, fontSize:11 }}>{icon} {label}</span>
        <span style={{ fontSize:10, fontWeight:800, color:col }}>{rel}% reliable</span>
      </div>
      <div style={{ color:col, opacity:.9, fontSize:10, marginBottom:5 }}>{override||msg}</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
        {conds.map((c,i)=><span key={i} style={{ fontSize:9, color:'#475569', background:'#f1f5f9', borderRadius:10, padding:'2px 7px' }}>{c}</span>)}
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <span style={{ fontSize:9, color:'#64748b', fontWeight:600, whiteSpace:'nowrap' }}>SIGNAL RELIABILITY</span>
        <div style={{ flex:1, height:5, background:'#e2e8f0', borderRadius:3 }}>
          <div style={{ width:`${rel}%`, height:'100%', borderRadius:3, background:col, transition:'width .5s' }} />
        </div>
        <span style={{ fontSize:9, fontWeight:800, color:col }}>{rel}%</span>
      </div>
    </div>
  );
}

const BO_FILTERS = [
  {id:'all',label:'All'},{id:'bull',label:'📈 Bullish'},{id:'bear',label:'📉 Bearish'},
  {id:'ema',label:'⭐ EMA'},{id:'pdhl',label:'🚀 PDH/PDL'},{id:'st',label:'📈 ST'},
  {id:'vol',label:'🔥 Volume'},{id:'52wk',label:'🏆 52Wk'},{id:'gap',label:'⬆ Gap'},
  {id:'squeeze',label:'🗜 Squeeze'},{id:'rs',label:'🚀 RS'},
];

export default function StocksPane() {
  const { token, cfg, marketStatus, lg, onTokenExpired, updateBadge, gh,
          setScanning, setStatusDot, setStatusTxt, setScanSecs,
          stocks, fiiInterp } = useApp();

  const [mode, setMode]             = useState('picks');
  const [picksLoading, setPicksLoading] = useState(false);
  const [picksError, setPicksError]     = useState('');
  const [picks, setPicks]               = useState([]);
  const [scanStats, setScanStats]       = useState(null); // pcr, sent, sentSc, topSec, cnt
  const [picksTime, setPicksTime]       = useState('');
  const [pickProgress, setPickProgress] = useState('');
  const [boLoading, setBoLoading]   = useState(false);
  const [boError, setBoError]       = useState('');
  const [boCards, setBoCards]       = useState([]);
  const [boStats, setBoStats]       = useState(null);
  const [boTime, setBoTime]         = useState('');
  const [boProgress, setBoProgress] = useState('');
  const [boFilter, setBoFilter]     = useState('all');
  const scanInProgress = useRef(false);

  // ── Continuous index price feed (always live, independent of scan) ──
  const { nifty, banknifty, vix: vixFeed } = useIndexFeed(
    token, onTokenExpired, cfg.tick || 15, !!token
  );

  // ── WebSocket live prices for top picks ──
  const topKeys = picks.slice(0, 20).map(p => p.key).filter(Boolean);
  const { connected: wsConnected, lastPrices, wsMode } = useMarketFeed(
    token, topKeys, marketStatus.open && picks.length > 0
  );

  useEffect(() => {
    const onScan = () => { mode === 'breakout' ? runBreakoutScan() : runPicksScan(); };
    document.addEventListener('friday:scan', onScan);
    return () => document.removeEventListener('friday:scan', onScan);
  }, [mode]); // eslint-disable-line

  // Auto-scan on boot if market open
  useEffect(() => {
    if (!token) return;
    if (marketStatus.open) setTimeout(() => runPicksScan(), 2000);
  }, [token]); // eslint-disable-line

  // Auto-scan countdown
  useEffect(() => {
    if (!token || !marketStatus.open || !setScanSecs) return;
    setScanSecs((cfg.scanStocks || 15) * 60);
    const id = setInterval(() => {
      setScanSecs(s => {
        if (s <= 1) { runPicksScan(); return (cfg.scanStocks || 15) * 60; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [token, marketStatus.open]); // eslint-disable-line

  // ── PICKS SCAN ────────────────────────────────────────────────
  async function runPicksScan() {
    if (scanInProgress.current) return;
    if (!stocks?.length) { setPicksError('⚠ stocks.json not loaded — configure GitHub in ⚙ Settings first'); return; }
    scanInProgress.current = true;
    setScanning(true); setStatusDot('scan'); setStatusTxt('Scanning...');
    setPicksLoading(true); setPicksError(''); setPicks([]);
    setPickProgress('Step 1: Fetching index data...');
    try {
      // Live index values
      const nLtp    = nifty?.ltp    || 0;
      const nChgPct = nifty?.chgPct || 0;
      const vixVal  = vixFeed?.ltp  || 0;
      const nBull   = nChgPct > -0.3;

      // PCR from Nifty options chain
      setPickProgress('Step 2: Fetching PCR...');
      let pcr = 1, pcrTxt = 'Neutral';
      try {
        const expRes = await fetch(
          `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent('NSE_INDEX|Nifty 50')}`,
          { headers: { Authorization:'Bearer '+token, Accept:'application/json' } }
        ).then(r => r.json());
        const exps = (expRes?.data?.map(e => e.expiry)||[]).sort();
        if (exps.length) {
          const chain = await fetchOptions('NSE_INDEX|Nifty 50', exps[0], token, onTokenExpired);
          const ceOI = chain.reduce((s,x)=>s+(x.call_options?.market_data?.oi||0),0);
          const peOI = chain.reduce((s,x)=>s+(x.put_options?.market_data?.oi||0),0);
          pcr = ceOI>0 ? +(peOI/ceOI).toFixed(2) : 1;
          pcrTxt = interpPCR(pcr).txt;
        }
      } catch(e) { lg('PCR skipped: '+e.message,'w'); }

      const sent   = nChgPct > 0.5 ? 'BULLISH' : nChgPct < -0.5 ? 'BEARISH' : 'NEUTRAL';
      const sentSc = Math.round(Math.min(Math.max((nChgPct+3)/6*10, 1), 10));

      // Stock quotes — batches of 50
      setPickProgress('Step 3: Loading stock quotes...');
      const scanList = stocks.filter(s => s.scan !== false);
      const rawQ = {};
      for (let b=0; b<Math.ceil(scanList.length/50); b++) {
        const sl = scanList.slice(b*50,(b+1)*50);
        setPickProgress(`Step 3: Quotes ${Math.min((b+1)*50,scanList.length)}/${scanList.length}`);
        const qd = await fetchQ(sl.map(s=>s.key).join(','), token, onTokenExpired).catch(()=>({}));
        Object.assign(rawQ, qd);
        if ((b+1)*50 < scanList.length) await sleep(200);
      }

      const byVol = scanList.map(s=>({...s,_q:rawQ[s.key]})).filter(s=>s._q?.last_price)
        .sort((a,b)=>(b._q.volume||0)-(a._q.volume||0));

      const today  = getISTDate();
      const from90 = new Date(Date.now()-95*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
      const results=[]; const secMap={};
      const BATCH=5;

      for (let b=0; b<byVol.length; b+=BATCH) {
        setPickProgress(`Step 4: Analysing ${b+1}–${Math.min(b+BATCH,byVol.length)} / ${byVol.length}`);
        await Promise.allSettled(byVol.slice(b,b+BATCH).map(async(inst,idx)=>{
          await sleep(idx*120);
          const q=inst._q; if(!q?.last_price) return;
          const ltp=q.last_price, chgPct=getChgPct(q), high=q.ohlc?.high||ltp, low=q.ohlc?.low||ltp, vol=q.volume||0;
          let candles=[];
          try { candles=await fetchCandles(inst.key,from90,today,'day',token,onTokenExpired); } catch(e){}
          if (candles.length<5) return;
          const closes=candles.map(c=>+c[4]).reverse();
          const rsi=calcRSI(closes), ema=calcEMACrossover(closes), macd=calcMACD(closes);
          const atr=calcATR(candles), bb=calcBBSqueeze(closes), adx=calcADX(candles);
          const sr=calcSR(candles), volObj=calcVolumeSurge(candles);
          const patterns=detectPatterns(candles), rsiDiv=calcRSIDivergence(closes);
          const vwap=calcVWAP(candles), avgVol20=volObj?.avgVol||1;
          const a50=closes.length>=50?ltp>(ema?.e50||0):null;
          const a200=closes.length>=200?ltp>(ema?.e200||0):null;
          const macdBull=macd.bull, volOk=vol>avgVol20*(cfg.vol||1.2);
          const nearSupp=isNearSupport(ltp,sr,Math.min(...candles.slice(0,5).map(c=>+c[3])));
          const aboveVWAP=vwap>0?ltp>=vwap:null;
          const sector=getSector(inst.s);
          const numInds=countIndicatorsEx(rsi,macdBull,a50,a200,volOk,nearSupp,patterns,'BUY',macd,bb,adx,rsiDiv);
          const initRec=numInds>=4?'BUY':numInds>=3?'MODERATE':numInds>=2?'WATCH':'AVOID';
          const conf=calcConfidence(null,0,0,nBull,0,vol,avgVol20,patterns,initRec,numInds);
          if (conf<(cfg.minStockConf||50)) return;
          const {sl,target:tgtMod,targets}=autoSLTarget(ltp,high,low,atr,sr,vixVal,rsi);
          const pot=calcPotential(ltp,tgtMod,sl,numInds,initRec);
          const risk=calcRisk(ltp,sl,tgtMod,atr,vixVal);
          if (pot.base<(cfg.pot||3)||pot.rr<(cfg.rr||1.2)||risk>(cfg.risk||55)) return;
          const rec=getRec(conf,pot.base,risk,pot.rr); if(rec==='AVOID') return;
          const entryTrigger=calcEntryTrigger(ltp,high,sr,atr,rec,vwap,chgPct);
          const reversal=detectReversal(ltp,rsi,patterns,sr,vixVal,pcr,nBull,chgPct,atr,high,low);
          if (!secMap[sector]) secMap[sector]={g:0,c:0};
          secMap[sector].g+=rec==='BUY'||rec==='STRONG BUY'?1:0; secMap[sector].c++;
          results.push({
            s:inst.s, n:inst.n, key:inst.key, sec:inst.sec||sector,
            ltp, chgPct, rsi, conf, rec,
            sl, target:tgtMod, pot:{...targets,rr:pot.rr,wr:pot.wr||0,base:pot.base,adj:pot.adj||0,ev:pot.ev||0},
            risk, atr, numInds,
            macd, macdBull, bb, adx, rsiDiv,
            a50, a200, nearSupp, patterns,
            vwap, aboveVWAP, vwapType:'daily',
            vol, avgVol20, high, low,
            entryTrigger, reversal,
            recentCandles: candles.slice(0,20), closes,
          });
        }));
        if (b+BATCH<byVol.length) await sleep(300);
      }

      results.sort((a,b)=>b.conf-a.conf);
      const topSec=Object.entries(secMap).sort((a,b)=>(b[1].g/b[1].c)-(a[1].g/a[1].c))[0]?.[0]||'Mixed';
      setPicks(results);
      setScanStats({pcr,pcrTxt,sent,sentSc,topSec,cnt:results.length});
      updateBadge('stocks',String(results.length));
      setPicksTime('Updated: '+getIST());
      setStatusDot('live'); setStatusTxt('Live');
      lg(`✅ Picks: ${results.length} from ${byVol.length} stocks`,'o');
      if (!results.length) lg(`⚠ 0 picks — lower Conf(${cfg.minStockConf}%)/Pot(${cfg.pot}%)/Risk(${cfg.risk}%) in ⚙ Settings`,'w');
      if (results.length&&gh?.token) logSignals(gh,results.map(p=>buildStockSignal(p,vixVal)),vixVal,lg);
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
      const rawQ={};
      for (let b=0; b<Math.ceil(scanList.length/50); b++) {
        const keys=scanList.slice(b*50,(b+1)*50).map(s=>s.key).join(',');
        const qd=await fetchQ(keys,token,onTokenExpired).catch(()=>({}));
        Object.assign(rawQ,qd);
        if ((b+1)*50<scanList.length) await sleep(200);
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
        const {score}=boScore(ema,pdhl,st,vol,wk52,mom,nr7,bb,wMTF,gap,adx,rs,wick,0,phase);
        const minScore=(phase==='holiday'||phase==='closed'||phase==='pre')?1:2;
        if (score<minScore) continue;
        const trade=boSLTarget(ltp,t.atr,isBull,pdhl?.pdh||0,pdhl?.pdl||0,ema?.ema200||0);
        const boVol=q.volume||0;
        results.push({
          ...item, ltp, chgPct:getChgPct(q), ema, pdhl, st, score, dir, vol, wk52, mom, nr7, bb, gap, adx, rs, wMTF, wick,
          trade, atr:t.atr, isBull, phase,
          rec:isBull?(score>=7?'STRONG BUY':'BUY'):(score>=7?'SELL':'WATCH'),
          conf:Math.min(95,score*10), sl:trade.sl, target:trade.target,
          pot:{cons:trade.sl,mod:trade.target,agg:trade.target,rr:trade.rr,wr:0,base:0,adj:0,ev:0},
          why:`Score ${score}/10 · ${dir} · ${ema?.goldenCross?'Golden Cross':ema?.deathCross?'Death Cross':ema?.uptrend?'EMA Up':'EMA Down'} · ${(vol?.ratio||1).toFixed(1)}× Vol`,
          numInds:score, risk:50, rsi:null, high:q.ohlc?.high||ltp, low:q.ohlc?.low||ltp,
          vol:boVol, avgVol20:0, macd:{}, rsiDiv:null, patterns:{},
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
      setBoCards(results);
      setBoStats({total:results.length,bullCount:results.filter(r=>r.dir==='BULL').length,bearCount:results.filter(r=>r.dir==='BEAR').length,goldCross:results.filter(r=>r.ema?.goldenCross).length,volSurge:results.filter(r=>r.vol?.confirmed).length});
      setBoTime('Scanned: '+getIST()); updateBadge('stocks',results.length+' 🚀');
      lg(`✅ Breakout: ${results.length} signals`,'o');
    } catch(e) { setBoError(e.message); lg('Breakout error: '+e.message,'e'); }
    finally { setBoLoading(false); }
  }

  const filteredCards=boCards.filter(r=>{
    if(boFilter==='all')return true;if(boFilter==='bull')return r.dir==='BULL';if(boFilter==='bear')return r.dir==='BEAR';
    if(boFilter==='ema')return r.ema?.goldenCross||r.ema?.deathCross||r.ema?.nearCross;
    if(boFilter==='pdhl')return r.pdhl?.bullBreakout||r.pdhl?.bearBreakout||r.pdhl?.nearPDH||r.pdhl?.nearPDL;
    if(boFilter==='st')return r.st?.crossed;if(boFilter==='vol')return r.vol?.confirmed||r.vol?.strong;
    if(boFilter==='52wk')return r.wk52?.breakHigh||r.wk52?.atHigh||r.wk52?.breakLow||r.wk52?.atLow;
    if(boFilter==='gap')return r.gap?.gapUp||r.gap?.gapDown;
    if(boFilter==='squeeze')return(r.nr7?.isNR7||r.nr7?.isNR4)||(r.bb?.squeeze||r.bb?.extremeSqueeze);
    if(boFilter==='rs')return (r.rs?.outperforming||r.rs?.underperforming)&&r.rs?.strongly;
    return true;
  });

  const vixVal    = vixFeed?.ltp || 0;
  const nChgPct   = nifty?.chgPct || 0;
  const sentColor = {'BULLISH':'#16a34a','BEARISH':'#dc2626','NEUTRAL':'#d97706'}[scanStats?.sent||'NEUTRAL'];

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
      {mode==='picks' && (
        <div>
          {!marketStatus.open&&<MarketClosedBanner msg={marketStatus.msg||'🔔 NSE Market Closed'}/>}
          {picksError&&<ErrorBanner title="⚠ Scan Error" message={picksError} onRetry={runPicksScan}/>}
          {picksLoading ? <Spinner label="Professional analysis..." progress={pickProgress} sub="RSI · EMA · MACD · ATR · BB · ADX · RSI Div · Entry Trigger · Reversal"/> : (
            <div>
              {/* Time-of-day banner — always shown during market hours */}
              {marketStatus.open && <TimeOfDayBanner niftyChgPct={nChgPct} vix={vixVal}/>}

              {/* 6 stat cards — always live via useIndexFeed ── */}
              <div className="stats-g">
                <div className="sc">
                  <div className="sc-lbl">NIFTY 50 · LIVE</div>
                  <div className={`sc-val ${nChgPct>=0?'up':'dn'}`}>₹{fmt(nifty?.ltp,0)}</div>
                  <div className={`sc-sub ${nChgPct>=0?'up':'dn'}`}>{nifty?.pts>=0?'+':''}{(nifty?.pts||0).toFixed(2)} pts</div>
                  {/* <div className="sc-note">↻ {cfg.tick||15}s tick</div> */}
                </div>
                <div className="sc">
                  <div className="sc-lbl">BANK NIFTY · LIVE</div>
                  <div className={`sc-val ${(banknifty?.chgPct||0)>=0?'up':'dn'}`}>₹{fmt(banknifty?.ltp,0)}</div>
                  <div className={`sc-sub ${(banknifty?.chgPct||0)>=0?'up':'dn'}`}>{(banknifty?.pts||0)>=0?'+':''}{(banknifty?.pts||0).toFixed(2)} pts</div>
                  {/* <div className="sc-note">↻ {cfg.tick||15}s tick</div> */}
                </div>
                <div className="sc">
                  <div className="sc-lbl">INDIA VIX</div>
                  <div className={`sc-val ${vixVal>20?'dn':vixVal>15?'am':'up'}`}>{vixVal?.toFixed(2)||'—'}</div>
                  <div className={`sc-sub ${vixVal>20?'dn':vixVal>15?'am':'up'}`}>{interpVIX(vixVal).txt}</div>
                </div>
                <div className="sc">
                  <div className="sc-lbl">NIFTY PCR</div>
                  <div className={`sc-val ${scanStats?.pcr>1?'up':scanStats?.pcr>0.7?'am':'dn'}`}>{scanStats?.pcr!=null?scanStats.pcr.toFixed(2):'—'}</div>
                  <div className={`sc-sub ${scanStats?.pcr>1?'up':scanStats?.pcr>0.7?'am':'dn'}`}>{scanStats?.pcrTxt||'Run scan'}</div>
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

              {/* FII/DII */}
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

              {wsConnected&&<div style={{fontSize:9,marginBottom:8,color:'#16a34a',fontWeight:600}}>⚡ Live {wsMode==='ws'?'WebSocket':'REST polling'} — {topKeys.length} instruments</div>}

              {picks.length===0
                ?<EmptyState>{!stocks?.length?'⚙ Configure stocks.json in GitHub Settings first':marketStatus.open?'🔄 Click ▶ Scan to fetch picks':'📅 NSE Market Closed · Auto-starts Mon–Fri 9:15 AM IST'}</EmptyState>
                :<div className="cards-g">{picks.map((p,i)=>{const live=lastPrices[p.key];return(<StockCard key={p.s} pick={live?{...p,ltp:live.ltp,chgPct:live.chgPct}:p} rank={i+1} cfg={cfg}/>);})}</div>
              }
              <div className="disc">⚠ Not SEBI advice. Always DYODD.</div>
            </div>
          )}
        </div>
      )}

      {/* ── BREAKOUT ── */}
      {mode==='breakout'&&(
        <div>
          {boError&&<ErrorBanner title="⚠ Breakout Error" message={boError} onRetry={runBreakoutScan}/>}
          {boLoading?<Spinner label="Breakout Scanner..." progress={boProgress} sub="EMA 50/200 · PDH/PDL · Supertrend · Vol · 52Wk · Gap · NR7 · BB · RS · Wick · Weekly MTF"/>:(
            <div>
              {/* Always-live index stats for Breakout tab too */}
              <div className="stats-g" style={{marginBottom:10}}>
                <div className="sc">
                  <div className="sc-lbl">NIFTY · LIVE</div>
                  <div className={`sc-val ${nChgPct>=0?'up':'dn'}`}>₹{fmt(nifty?.ltp,0)}</div>
                  <div className={`sc-sub ${nChgPct>=0?'up':'dn'}`}>{nifty?.pts>=0?'+':'-'}{(nifty?.pts||0).toFixed(2)} pts</div>
                  {/* <div className="sc-note">↻ {cfg.tick||15}s</div> */}
                </div>
                <div className="sc">
                  <div className="sc-lbl">BANKNIFTY · LIVE</div>
                  <div className={`sc-val ${(banknifty?.chgPct||0)>=0?'up':'dn'}`}>₹{fmt(banknifty?.ltp,0)}</div>
                  <div className={`sc-sub ${banknifty?.chgPct>=0?'up':'dn'}`}>{banknifty?.pts>=0?'+':'-'}{(banknifty?.pts||0).toFixed(2)} pts</div>
                  {/* <div className="sc-note">↻ {cfg.tick||15}s</div> */}
                </div>
                <div className="sc">
                  <div className="sc-lbl">INDIA VIX</div>
                  <div className={`sc-val ${vixVal>20?'dn':vixVal>15?'am':'up'}`}>{vixVal?.toFixed(2)||'—'}</div>
                </div>
              </div>
              <div className="last-upd">
                <div className="upd-dot" style={{background:'#7c3aed'}}/>
                <span>{boTime||'Not scanned yet'}</span>
                <button onClick={runBreakoutScan} className="btn btn-s" style={{marginLeft:'auto',fontSize:10,padding:'4px 10px'}}>🔄 Re-scan</button>
              </div>
              {boStats&&<div className="stats-g">
                <StatCard label="TOTAL"        value={boStats.total}     sub="signals"                    valClass="bl"/>
                <StatCard label="BULLISH 📈"   value={boStats.bullCount} sub={`${boStats.goldCross} Golden Cross`} valClass="up"/>
                <StatCard label="BEARISH 📉"   value={boStats.bearCount} valClass="dn"/>
                <StatCard label="VOL SURGE 🔥" value={boStats.volSurge}  valClass="am"/>
              </div>}
              <div style={{display:'flex',gap:6,marginBottom:12,overflowX:'auto',paddingBottom:4}}>
                {BO_FILTERS.map(f=><button key={f.id} onClick={()=>setBoFilter(f.id)} style={{whiteSpace:'nowrap',padding:'6px 12px',borderRadius:20,border:boFilter===f.id?'none':'1px solid #e2e8f0',fontSize:11,fontWeight:700,cursor:'pointer',background:boFilter===f.id?'#7c3aed':'#fff',color:boFilter===f.id?'#fff':'#374151'}}>{f.label}</button>)}
              </div>
              {filteredCards.length===0
                ?<EmptyState>{!stocks?.length?'⚙ Configure stocks.json in GitHub Settings':'🔄 Click Re-scan to run the breakout scanner'}</EmptyState>
                :<div className="cards-g">{filteredCards.map((c,i)=><StockCard key={c.s||i} pick={c} rank={i+1} cfg={cfg}/>)}</div>
              }
              <div className="disc">⚠ Not SEBI advice. Always DYODD.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

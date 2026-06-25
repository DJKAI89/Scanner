// ── Stock scan service — Picks scan + Breakout scan ──────────────
// Extracted from StocksPane.jsx so the pane only handles UI/state wiring.
// All calculation, scoring, and API-call logic for the Stocks tab lives here.

import { fetchQ, fetchCandles, fetchOptions } from './api';
import { fetchScanQuotesViaWS } from '../hooks/useMarketFeed';
import { logSignals, buildStockSignal } from './github';
import {
  calcRSI, calcEMACrossover, calcATR, calcSupertrend, calcBBSqueeze, calcNR7, calcADX,
  detectPDHLBreakout, calc52WkBreakout, calcVolumeSurge, detectGap, calcWickRejection,
  calcRelativeStrength, calcMomentumConfluence, calcWeeklyMTF, boScore, boDirection,
  boSLTarget, getIntradayPhase, detectPatterns, calcRisk, calcPotential, calcSR,
  countIndicatorsEx, getRec, autoSLTarget, calcEntryTrigger, detectReversal,
  calcMACD, isNearSupport, calcRSIDivergence, getSector, calcConfidence, calcVWAP,
  calcVWAPBands, applyFIIBias, applyCalibration, applyAdaptWeights, calcEMA, calcIVPercentile,
  applyIntradayBoost,
} from './technical';
import { applyMlRanking } from './mlRanking';
import { getIST, getISTDate, sleep } from '../utils/marketTime';
import { fetchIntraday } from './api';

// ── Pure helpers ──────────────────────────────────────────────
export function getDeliveryPct(q) {
  if (!q) return null;
  if (q.delivery_volume != null && q.volume > 0) return +(q.delivery_volume / q.volume * 100).toFixed(1);
  if (q.delivery_quantity != null && q.volume > 0) return +(q.delivery_quantity / q.volume * 100).toFixed(1);
  return null;
}

export function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0;
  if (q.net_change != null && ltp > 0) return (q.net_change / ltp) * 100;
  const prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

export function interpPCR(p) {
  if (p >= 1.5) return { txt:'Very Bullish', sc:80 };
  if (p >= 1.2) return { txt:'Bullish',      sc:70 };
  if (p >= 0.9) return { txt:'Neutral',       sc:50 };
  if (p >= 0.7) return { txt:'Bearish',        sc:35 };
  return            { txt:'Very Bearish',       sc:20 };
}

// Exact port of HTML calcStockVWAPSignal
export function calcStockVWAPSignal(ltp, intradayVWAP) {
  if (!intradayVWAP || !ltp) return null;
  const distPct = +((ltp - intradayVWAP) / intradayVWAP * 100).toFixed(2);
  const aboveVWAP = ltp >= intradayVWAP;
  const strong   = Math.abs(distPct) > 0.5;
  const nearVWAP = Math.abs(distPct) <= 0.2;
  return { vwap: intradayVWAP, distPct, aboveVWAP, strong, nearVWAP };
}

// ── Push notification helpers (exact HTML port) ─────────────
export function sendNotification(title, body, key) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon:'/favicon.ico', tag: key });
    n.onclick = () => { window.focus(); n.close(); };
  } catch(_) {}
}

export function checkPickAlerts(picks, cfg) {
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
export function fireBreakoutAlerts(results) {
  if (typeof Notification==='undefined'||Notification.permission!=='granted') return;
  results.filter(r=>r.score>=7).forEach(r=>{
    const sigType = r.ema?.goldenCross?'GOLDEN_CROSS':r.ema?.deathCross?'DEATH_CROSS':r.wk52?.breakHigh?'52WK_HIGH':r.wk52?.breakLow?'52WK_LOW':r.pdhl?.bullBreakout?'PDH_BREAK':r.pdhl?.bearBreakout?'PDL_BREAK':r.st?.crossed?(r.st.trend==='UP'?'ST_UP':'ST_DOWN'):'GENERIC';
    const k = r.s+'_'+sigType;
    if (_alertedBreakouts.has(k)) return; _alertedBreakouts.add(k);
    sendNotification(`${r.isBull?'📈':'📉'} Breakout: ${r.s} ${r.dir} (${r.score}/10)`, `${sigType.replace(/_/g,' ')} · ₹${r.ltp} → Target ₹${r.trade?.target} · SL ₹${r.trade?.sl}`, 'bo_'+k);
  });
}

// ── Closed-market index price fallback (used when WS has no data yet) ──
export async function fetchClosedMarketIndexPrices(token, onTokenExpired) {
  const q = await fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|Nifty Bank,NSE_INDEX|India VIX', token, onTokenExpired);
  const out = {};
  ['NSE_INDEX|Nifty 50','NSE_INDEX|Nifty Bank','NSE_INDEX|India VIX'].forEach(k => {
    const d = q[k];
    if (d?.last_price > 0) out[k] = {
      ltp:     d.last_price,
      chgPct:  d.net_change ? +(d.net_change / (d.last_price - d.net_change) * 100).toFixed(2) : 0,
    };
  });
  return out;
}

// ── PICKS SCAN ──────────────────────────────────────────────────
// ctx: { token, stocks, cfg, gh, niftyLTP, niftyChgPct, vixLTP, onTokenExpired, lg }
// callbacks: { setPickProgress, setPicks }  (setPicks used for the late background enrichment patch)
export async function runPicksScan(ctx, callbacks) {
  const { token, stocks, cfg, gh, niftyLTP, niftyChgPct, vixLTP, onTokenExpired, lg,
          marketStatus, confCalibration, adaptWeights, mlModels } = ctx;
  const { setPickProgress, setPicks } = callbacks;

  if (!stocks?.length) {
    throw new Error('⚠ stocks.json not loaded — configure GitHub in ⚙ Settings first');
  }

  setPickProgress('');
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
  const { sc: vixSc } = interpVIXSc(vixVal);

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
  const secMapNormalized = {};
  for (const [sec, v] of Object.entries(secMap)) {
    if (v.c > 0) secMapNormalized[sec] = +(((v.g / v.c) - 0.5) * 2).toFixed(2);
  }
  const scanStats = {pcr,pcrTxt,sent,sentSc,topSec,cnt:finalPicks.length,totalScanned:byVol.length,secMap:secMapNormalized};

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
        const c5 = await fetchIntraday(pick.key, '5minute', token, onTokenExpired);
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
        // calcEMA returns a single scalar (not a series) — compare latest values directly
        const intraBull   = ema5v != null && ema13v != null ? ema5v > ema13v : null;
        // "Accelerating" needs a prior-bar EMA to compare against; recompute EMA(5) one bar back
        const ema5vPrev   = closes5.length > 1 ? calcEMA(closes5.slice(0, -1), 5) : null;
        const intraAccel  = ema5v != null && ema5vPrev != null && ema5v > ema5vPrev;
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

  return { picks: nextPicks, scanStats, scanId, vixVal, pcr, sent, sentSc, topSec };
}

// Local VIX-score interpreter (mirrors formatters.interpVIX's `sc` field without UI text)
export function interpVIXSc(vix) {
  if (vix >= 25) return { sc: 20 };
  if (vix >= 20) return { sc: 35 };
  if (vix >= 15) return { sc: 60 };
  if (vix >= 12) return { sc: 80 };
  return { sc: 90 };
}

// ── BREAKOUT SCAN ───────────────────────────────────────────────
// ctx: { token, stocks, cfg, scanStats, onTokenExpired, lg, marketStatus }
// callbacks: { setBoProgress, setBoCards }
export async function runBreakoutScan(ctx, callbacks) {
  const { token, stocks, onTokenExpired, lg, marketStatus, scanStats } = ctx;
  const { setBoProgress, setBoCards } = callbacks;

  if (!stocks?.length) {
    throw new Error('⚠ stocks.json not loaded — configure GitHub in ⚙ Settings first');
  }
  setBoProgress('Fetching quotes...');

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
    const {bullScore,bearScore,score}=boScore(ema,pdhl,st,vol,wk52,mom,nr7,bb,wMTF,gap,adx,rs,wick,sectorScore,phase);
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
      ...item, ltp, chgPct:getChgPct(q), ema, pdhl, st, vol, score, bullScore, bearScore, dir, wk52, mom, nr7, bb, gap, adx, rs, wMTF, wick,
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
      r.ema?.uptrend         && 'Price above EMA50/200 — trend intact',
      r.st?.crossed          && `Supertrend ${r.st.trend === 'UP' ? 'bullish' : 'bearish'} crossover`,
      r.vol?.strong          && `Strong volume surge ${r.vol.ratio}× above average`,
      r.vol?.confirmed       && `Volume confirmed breakout ${r.vol.ratio}× average`,
      r.wk52?.breakHigh      && '52-week high breakout — multi-year resistance cleared',
      r.wk52?.breakLow       && '52-week low breakdown — multi-year support broken',
      r.wk52?.atHigh         && 'At 52-week high — momentum peak zone',
      r.nr7?.isNR7           && 'NR7 — narrowest range in 7 days, volatility expansion expected',
      r.nr7?.isNR4           && 'NR4 — narrowest range in 4 days',
      r.bb?.extremeSqueeze   && 'Extreme Bollinger Band squeeze — major move imminent',
      r.bb?.squeeze          && 'Bollinger Band squeeze — range compression',
      r.gap?.gapUp           && `Gap up ${r.gap.gapPct?.toFixed?.(1) ?? r.gap.gapPct}% — bullish opening strength`,
      r.gap?.gapDown         && `Gap down ${r.gap.gapPct?.toFixed?.(1) ?? r.gap.gapPct}% — bearish opening weakness`,
      r.rs?.outperforming    && `Relative strength +${r.rs.rs}% vs Nifty — sector leader`,
      r.rs?.underperforming  && `Relative weakness ${r.rs.rs}% vs Nifty`,
      r.wick?.bullRejected    && 'Strong wick rejection — buyers defending support',
      r.wick?.bearRejected    && 'Strong bearish wick — sellers rejecting rally',
      (r.mom?.bullConf || r.mom?.bearConf) && 'Momentum confirming — RSI+MACD aligned with direction',
      r.adx?.strong          && `ADX ${r.adx.adx?.toFixed(0)} — strong trending market`,
    ].filter(Boolean),
  }));
  setBoCards(resultsWithWhy);
  const boStats = {
    total:results.length,
    bullCount:results.filter(r=>r.dir==='BULL').length,
    bearCount:results.filter(r=>r.dir==='BEAR').length,
    goldCross, deathCross, pdhBreak, pdlBreak, stCrossed, wk52Hi,
    volSurge,
  };

  // ── Background: fetch intraday data for top breakout stocks ──
  // Fetches 5-min candles to get intraday VWAP, intraday momentum,
  // current-candle volume vs average, and intraday breakout confirmation
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
        // calcEMA returns a single scalar — compare against a one-bar-back recompute for "accelerating"
        const intraEma5Prev = intraCloses.length > 1 ? calcEMA(intraCloses.slice(0, -1), 5) : null;
        const intraMomentum = intraCloses.length >= 13 ? {
          bullish: intraEma5 != null && intraEma13 != null && intraEma5 > intraEma13,
          accelerating: intraEma5 != null && intraEma5Prev != null && intraEma5 > intraEma5Prev,
        } : null;

        // 4. Intraday breakout confirmation — did price break key level intraday?
        const intraHigh = Math.max(...c5.map(c => +c[2]));
        const intraLow  = Math.min(...c5.map(c => +c[3]));
        const intraConfirm = r.pdhl?.pdh > 0 && intraHigh > r.pdhl.pdh ? 'PDH_CONFIRMED'
          : r.pdhl?.pdl > 0 && intraLow < r.pdhl.pdl ? 'PDL_CONFIRMED' : null;

        // 5. Intraday score boost — via shared applyIntradayBoost (was duplicated inline before)
        const boosted = applyIntradayBoost(
          { bullScore: r.bullScore, bearScore: r.bearScore, score: r.score },
          { confirm: !!intraConfirm, volRatio: intraVolRatio, emaBull: intraMomentum?.bullish, accelerating: intraMomentum?.accelerating, aboveVWAP: vwapSignal?.aboveVWAP }
        );
        const newScore = boosted.score;
        const newConf  = Math.min(95, r.conf + (boosted.intraBoost || 0) * 3);

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

  fireBreakoutAlerts(results);
  lg(`✅ Breakout: ${results.length} signals`,'o');

  return { boCards: resultsWithWhy, boStats };
}

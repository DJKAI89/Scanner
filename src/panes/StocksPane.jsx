import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, MarketClosedBanner, LastUpdated, StatCard, EmptyState } from '../components/common.jsx';
import StockCard from '../components/StockCard.jsx';
import { fetchQ, fetchCandles } from '../services/api';
import { logSignals, buildStockSignal } from '../services/github';
import {
  calcRSI, calcEMACrossover, calcATR, calcSupertrend, calcBBSqueeze,
  calcNR7, calcADX, detectPDHLBreakout, calc52WkBreakout, calcVolumeSurge,
  detectGap, calcWickRejection, calcRelativeStrength, calcMomentumConfluence,
  calcWeeklyMTF, boScore, boDirection, boSLTarget, getIntradayPhase,
  detectPatterns, calcRisk, calcPotential, calcConfidence, calcSR,
  countIndicatorsEx, getRec, autoSLTarget, calcEntryTrigger, detectReversal,
  calcMACD, isNearSupport, calcRSIDivergence, getTimeOfDayPenalty, getSector,
} from '../services/technical';
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST, getISTDate, sleep, localIsOpen } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed';

function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0, prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

const BO_FILTERS = [
  { id:'all',label:'All' },{ id:'bull',label:'📈 Bullish' },{ id:'bear',label:'📉 Bearish' },
  { id:'ema',label:'⭐ EMA' },{ id:'pdhl',label:'🚀 PDH/PDL' },{ id:'st',label:'📈 ST' },
  { id:'vol',label:'🔥 Volume' },{ id:'52wk',label:'🏆 52Wk' },{ id:'gap',label:'⬆ Gap' },
  { id:'squeeze',label:'🗜 Squeeze' },{ id:'rs',label:'🚀 RS' },
];

export default function StocksPane() {
  const { token, cfg, marketStatus, lg, onTokenExpired, updateBadge, gh,
          activeTab,
          setScanning, setStatusDot, setStatusTxt,
          stocks, fiiInterp } = useApp();

  const [mode, setMode]             = useState('picks');
  const [picksLoading, setPicksLoading] = useState(false);
  const [picksError, setPicksError]     = useState('');
  const [picks, setPicks]               = useState([]);
  const [pickStats, setPickStats]       = useState(null);
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
  const boScanInProgress = useRef(false);

  // WebSocket live prices for top picks
  const topKeys = picks.slice(0, 20).map(p => p.key).filter(Boolean);
  const { connected: wsConnected, lastPrices } = useMarketFeed(token, topKeys, marketStatus.open && picks.length > 0);

  useEffect(() => {
    const onScan = () => {
      if (activeTab !== 'stocks') return;
      mode === 'breakout' ? runBreakoutScan() : runPicksScan();
    };
    document.addEventListener('friday:scan', onScan);
    return () => document.removeEventListener('friday:scan', onScan);
  }, [activeTab, mode]); // eslint-disable-line

  // Auto-load stats always; auto-scan if market open (same as HTML boot())
  useEffect(() => {
    if (!token) return;
    loadClosedStats();
    if (marketStatus.open) setTimeout(() => runPicksScan(), 1500);
  }, [token]); // eslint-disable-line

  async function loadClosedStats() {
    try {
      const d = await fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|Nifty Bank,NSE_INDEX|India VIX', token, onTokenExpired);
      const nQ = d['NSE_INDEX|Nifty 50'], bQ = d['NSE_INDEX|Nifty Bank'], vQ = d['NSE_INDEX|India VIX'];
      const vix = vQ?.last_price || 0;
      setPickStats({ nifty:{ ltp:nQ?.last_price||0, chgPct:getChgPct(nQ) }, banknifty:{ ltp:bQ?.last_price||0, chgPct:getChgPct(bQ) }, vix, vixTxt:interpVIX(vix).txt });
    } catch(e) {}
  }

  // ── PICKS SCAN — exact port of HTML scanStocksRound ──────────
  async function runPicksScan() {
    if (scanInProgress.current) return;
    if (!stocks?.length) { setPicksError('⚠ stocks.json not loaded yet — configure GitHub in ⚙ Settings first'); return; }
    scanInProgress.current = true;
    setScanning(true); setStatusDot('scan'); setStatusTxt('Scanning...');
    setPicksLoading(false); setPicksError('');
    setPickProgress('Fetching index data...');
    try {
      // Step 1: index + VIX
      const idxData = await fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|Nifty Bank,NSE_INDEX|India VIX', token, onTokenExpired);
      const nQ = idxData['NSE_INDEX|Nifty 50'], bQ = idxData['NSE_INDEX|Nifty Bank'], vQ = idxData['NSE_INDEX|India VIX'];
      const vix = vQ?.last_price || 0;
      const niftyChgPct = getChgPct(nQ);
      const niftyBull   = niftyChgPct > 0;
      setPickStats({ nifty:{ ltp:nQ?.last_price||0, chgPct:niftyChgPct }, banknifty:{ ltp:bQ?.last_price||0, chgPct:getChgPct(bQ) }, vix, vixTxt:interpVIX(vix).txt });

      // Step 2: FII/DII sector score (simplified from fiiInterp.bias)
      const fiiScore = (fiiInterp?.bias || 0) * 5; // scale -50..+50

      // Step 3: Batch quote fetch (HTML does batch of 50)
      const scanList = stocks.filter(s => s.scan !== false); // HTML scans ALL configured stocks.
      setPickProgress(`Fetching quotes for ${scanList.length} stocks...`);

      const today = getISTDate();
      const from90 = new Date(Date.now() - 95 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      // Batch quotes 50 at a time
      const allQuotes = {};
      for (let b = 0; b < scanList.length; b += 50) {
        const keys = scanList.slice(b, b + 50).map(s => s.key).join(',');
        const qd   = await fetchQ(keys, token, onTokenExpired).catch(() => ({}));
        Object.assign(allQuotes, qd);
        if (b + 50 < scanList.length) await sleep(200);
      }

      // Sort by volume desc (same as HTML) then pick top scanList
      const byVol = scanList
        .map(s => ({ ...s, _q: allQuotes[s.key] }))
        .filter(s => s._q?.last_price)
        .sort((a, b) => (b._q.volume || 0) - (a._q.volume || 0));

      setPickProgress(`Analysing ${byVol.length} stocks...`);

      const results = [];
      const BATCH = 5;
      for (let b = 0; b < byVol.length; b += BATCH) {
        const batch = byVol.slice(b, b + BATCH);
        setPickProgress(`Analysing ${b + 1}–${Math.min(b + BATCH, byVol.length)} / ${byVol.length}`);

        await Promise.allSettled(batch.map(async (inst, idx) => {
          await sleep(idx * 120);
          const q = inst._q;
          const ltp     = q.last_price;
          const chgPct  = getChgPct(q);
          const high    = q.ohlc?.high || ltp;
          const low     = q.ohlc?.low  || ltp;
          const vol     = q.volume || 0;

          // Candles
          let candles = [];
          try { candles = await fetchCandles(inst.key, from90, today, 'day', token, onTokenExpired); } catch(e) {}
          if (candles.length < 5) return;

          const closes  = candles.map(c => +c[4]).reverse();
          const highs   = candles.map(c => +c[2]);
          const lows    = candles.map(c => +c[3]);

          // Technical indicators — EXACT same as HTML
          const rsi     = calcRSI(closes);
          const ema     = calcEMACrossover(closes);
          const macd    = calcMACD(closes);
          const atr     = calcATR(candles);
          const bb      = calcBBSqueeze(closes);
          const adx     = calcADX(candles);
          const sr      = calcSR(candles);
          const volObj  = calcVolumeSurge(candles);
          const patterns = detectPatterns(candles);
          const rsiDiv  = calcRSIDivergence(closes);

          const avgVol20 = volObj?.avgVol || 1;
          const a50  = closes.length >= 50  ? ltp > (ema?.e50  || 0) : null;
          const a200 = closes.length >= 200 ? ltp > (ema?.e200 || 0) : null;
          const macdBull  = macd.bull;
          const volOk     = vol > avgVol20 * (cfg.vol || 1.2);
          const nearSupp  = isNearSupport(ltp, sr, lows[lows.length - 1]);

          // Sector score
          const sector    = getSector(inst.s);
          const secScore  = sector !== 'OTHER' ? fiiScore * 0.5 : 0;

          // countIndicatorsEx — EXACT port
          const numInds = countIndicatorsEx(rsi, macdBull, a50, a200, volOk, nearSupp, patterns, 'BUY', macd, bb, adx, rsiDiv);

          // Initial rec based on indicators (for passing to calcConfidence)
          const initRec = numInds >= 4 ? 'BUY' : numInds >= 3 ? 'MODERATE' : numInds >= 2 ? 'WATCH' : 'AVOID';

          // calcConfidence — EXACT port
          const conf = calcConfidence(null, 0, 0, niftyBull, secScore, vol, avgVol20, patterns, initRec, numInds);

          if (conf < cfg.minStockConf) return;

          // autoSLTarget — EXACT port
          const { sl, target: tgtMod, targets } = autoSLTarget(ltp, high, low, atr, sr, vix, rsi);
          const pot = calcPotential(ltp, tgtMod, sl, numInds, initRec);
          const risk = calcRisk(ltp, sl, tgtMod, atr, vix);

          if (pot.base < cfg.pot)  return;
          if (pot.rr   < cfg.rr)   return;
          if (risk     > cfg.risk)  return;

          // Final rec — EXACT port using getRec
          const rec = getRec(conf, pot.base, risk, pot.rr);
          if (rec === 'AVOID') return;

          // Entry trigger
          const vwap = 0; // intraday VWAP requires intraday candles; skip for daily scan
          const entryTrigger = calcEntryTrigger(ltp, high, sr, atr, rec, vwap, chgPct);

          // Reversal
          const reversal = detectReversal(ltp, rsi, patterns, sr, vix, 1.0, niftyBull, chgPct, atr, high, low);

          // Build indicator pills object
          const inds = {
            RSI:  rsi < 45 ? 1 : rsi > 65 ? -1 : 0,
            MA50: a50 !== null ? (a50 ? 1 : -1) : 0,
            MA200: a200 !== null ? (a200 ? 1 : -1) : 0,
            MACD: macdBull ? 1 : macdBull === false ? -1 : 0,
            VOL:  volOk ? 1 : 0,
            SUPP: nearSupp ? 1 : 0,
            PAT:  (patterns?.bullishEngulfing || patterns?.hammer || patterns?.morningStar) ? 1 : 0,
          };

          const why = [
            rsi < 35 ? `RSI oversold (${rsi.toFixed(0)})` : rsi > 70 ? `RSI overbought (${rsi.toFixed(0)})` : `RSI ${rsi.toFixed(0)}`,
            macdBull === true ? 'MACD bullish' : macdBull === false ? 'MACD bearish' : '',
            a50 === true ? 'Above MA50' : a50 === false ? 'Below MA50' : '',
            a200 === true ? 'Above MA200' : a200 === false ? 'Below MA200' : '',
            volOk ? `Vol ${volObj?.ratio?.toFixed(1)}× avg` : '',
            nearSupp ? 'Near support' : '',
            patterns?.bullishEngulfing ? 'Bullish Engulfing' : patterns?.hammer ? 'Hammer' : patterns?.morningStar ? 'Morning Star' : '',
            reversal?.type !== 'NONE' ? reversal?.type?.replace('_', ' ') : '',
          ].filter(Boolean).join(' · ');

          results.push({
            s: inst.s, n: inst.n, key: inst.key, sec: inst.sec,
            ltp, chgPct, rsi, conf, rec,
            sl, target: tgtMod, pot: { ...targets, rr: pot.rr, base: pot.base },
            risk, atr, numInds,
            entryTrigger,
            reversal,
            inds, why,
            sr,
            patterns,
            bars: [
              { label: 'Confidence', pct: conf,          val: conf.toFixed(0) + '%',          color: conf >= 70 ? '#16a34a' : conf >= 50 ? '#3b82f6' : '#d97706' },
              { label: 'Potential',  pct: Math.min(100, pot.base * 5), val: pot.base.toFixed(1) + '%', color: '#7c3aed' },
              { label: 'Risk',       pct: risk,           val: risk.toFixed(0) + '%',           color: risk <= 30 ? '#16a34a' : risk <= 55 ? '#d97706' : '#dc2626' },
            ],
          });
        }));

        if (b + BATCH < byVol.length) await sleep(300);
      }

      results.sort((a, b) => b.conf - a.conf);
      setPicks(results);
      updateBadge('stocks', String(results.length));
      setPicksTime('Updated: ' + getIST());
      setStatusDot('live'); setStatusTxt('Live');
      lg(`✅ Picks: ${results.length} from ${byVol.length} stocks (conf≥${cfg.minStockConf}% pot≥${cfg.pot}% risk<${cfg.risk}%)`, 'o');
      if (!results.length) lg(`⚠ 0 picks from ${byVol.length} stocks — lower Conf(${cfg.minStockConf}%)/Pot(${cfg.pot}%)/Risk(${cfg.risk}%) in ⚙ Settings`, 'w');
      // Log signals to GitHub
      if (results.length && gh?.token) logSignals(gh, results.map(p => buildStockSignal(p, vix)), vix, lg);
    } catch(e) {
      setPicksError(e.message); setStatusDot('err'); setStatusTxt('Error');
      lg('Scan error: ' + e.message, 'e');
    } finally {
      setPicksLoading(false); setScanning(false); scanInProgress.current = false;
    }
  }

  // ── BREAKOUT SCAN — exact port of HTML breakoutScan ──────────
  async function runBreakoutScan() {
    if (boScanInProgress.current) return;
    if (!stocks?.length) { setBoError('⚠ stocks.json not loaded — configure GitHub in ⚙ Settings first'); return; }
    boScanInProgress.current = true;
    setScanning(true); setStatusDot('scan'); setStatusTxt('Scanning breakout...');
    setBoLoading(false); setBoError(''); setBoProgress('Fetching quotes...');
    try {
      const today  = getISTDate();
      const from52 = new Date(Date.now() - 375 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      // Nifty closes for RS calculation
      let niftyCloses = [];
      try { niftyCloses = (await fetchCandles('NSE_INDEX|Nifty 50', from52, today, 'day', token, onTokenExpired)).map(c => +c[4]).reverse(); } catch(e) {}

      // Quotes
      const scanList = stocks.filter(s => s.scan !== false).slice(0, 80);
      const allQ = {};
      for (let b = 0; b < scanList.length; b += 50) {
        const keys = scanList.slice(b, b+50).map(s => s.key).join(',');
        const qd   = await fetchQ(keys, token, onTokenExpired).catch(() => ({}));
        Object.assign(allQ, qd);
        if (b + 50 < scanList.length) await sleep(200);
      }

      const byVol = scanList.map(s => ({ ...s, _q: allQ[s.key] })).filter(s => s._q?.last_price)
        .sort((a, b) => (b._q.volume || 0) - (a._q.volume || 0)).slice(0, 60);

      // Candles in batches
      const techB = {};
      for (let b = 0; b < byVol.length; b += 3) {
        setBoProgress(`Candles ${b+1}–${Math.min(b+3, byVol.length)} / ${byVol.length}`);
        await Promise.allSettled(byVol.slice(b, b+3).map(async (inst, idx) => {
          await sleep(idx * 200);
          try {
            const [daily, weekly] = await Promise.all([
              fetchCandles(inst.key, from52, today, 'day',  token, onTokenExpired),
              fetchCandles(inst.key, from52, today, 'week', token, onTokenExpired).catch(() => []),
            ]);
            if (daily.length >= 10) {
              const closes = daily.map(c => +c[4]).reverse();
              techB[inst.s] = { closes, candles: daily, weekly, atr: calcATR(daily), ema: calcEMACrossover(closes), st: calcSupertrend(daily) };
            }
          } catch(e) {}
        }));
        if (b + 3 < byVol.length) await sleep(350);
      }

      setBoProgress('Computing signals...');
      const phase = getIntradayPhase(), results = [];

      for (const item of byVol) {
        const q = item._q, ltp = q.last_price, t = techB[item.s]; if (!t) continue;
        const ema = t.ema, st = t.st;
        const pdhl = detectPDHLBreakout(ltp, t.candles);
        const vol  = calcVolumeSurge(t.candles);
        const wk52 = calc52WkBreakout(ltp, t.candles);
        const nr7  = calcNR7(t.candles);
        const bb   = calcBBSqueeze(t.closes);
        const gap  = detectGap(t.candles);
        const adx  = calcADX(t.candles);
        const rs   = calcRelativeStrength(t.closes, niftyCloses);
        const wick = calcWickRejection(t.candles);
        const dir  = boDirection(ema, pdhl, st), isBull = dir === 'BULL';
        const mom  = calcMomentumConfluence(t.closes, isBull);
        const wMTF = calcWeeklyMTF(t.weekly, ltp, isBull);
        const { score } = boScore(ema, pdhl, st, vol, wk52, mom, nr7, bb, wMTF, gap, adx, rs, wick, 0, phase);
        const minScore = (phase === 'holiday' || phase === 'closed' || phase === 'pre') ? 1 : 2;
        if (score < minScore) continue;
        const trade = boSLTarget(ltp, t.atr, isBull, pdhl?.pdh || 0, pdhl?.pdl || 0, ema?.ema200 || 0);
        results.push({
          ...item, ltp, chgPct: getChgPct(q), ema, pdhl, st, score, dir, vol, wk52, mom, nr7, bb, gap, adx, rs, wMTF, wick,
          trade, atr: t.atr, isBull, phase,
          rec: isBull ? (score >= 7 ? 'STRONG BUY' : 'BUY') : (score >= 7 ? 'SELL' : 'WATCH'),
          conf: Math.min(95, score * 10), sl: trade.sl, target: trade.target,
          pot: { cons: trade.sl, mod: trade.target, agg: trade.target, rr: trade.rr },
          why: `Score ${score}/10 · ${dir} · ${ema?.goldenCross ? 'Golden Cross' : ema?.deathCross ? 'Death Cross' : ema?.uptrend ? 'EMA Up' : 'EMA Down'} · ${vol?.ratio || 1}× Vol`,
        });
      }

      results.sort((a, b) => {
        const ap = (a.wk52?.breakHigh||a.wk52?.breakLow ? 2 : 0) + (a.ema?.goldenCross||a.ema?.deathCross ? 2 : 0);
        const bp = (b.wk52?.breakHigh||b.wk52?.breakLow ? 2 : 0) + (b.ema?.goldenCross||b.ema?.deathCross ? 2 : 0);
        return bp - ap || b.score - a.score;
      });

      setBoCards(results);
      setBoStats({ total:results.length, bullCount:results.filter(r=>r.dir==='BULL').length, bearCount:results.filter(r=>r.dir==='BEAR').length, goldCross:results.filter(r=>r.ema?.goldenCross).length, volSurge:results.filter(r=>r.vol?.confirmed).length });
      setBoTime('Scanned: ' + getIST());
      setStatusDot('live'); setStatusTxt('Live');
      updateBadge('stocks', results.length + ' 🚀');
      lg(`✅ Breakout: ${results.length} signals from ${byVol.length} stocks`, 'o');
    } catch(e) { setBoError(e.message); setStatusDot('err'); setStatusTxt('Error'); lg('Breakout error: ' + e.message, 'e'); }
    finally { setBoLoading(false); setScanning(false); boScanInProgress.current = false; }
  }

  const filteredCards = boCards.filter(r => {
    if (boFilter==='all')     return true; if (boFilter==='bull') return r.dir==='BULL'; if (boFilter==='bear') return r.dir==='BEAR';
    if (boFilter==='ema')     return r.ema?.goldenCross||r.ema?.deathCross; if (boFilter==='pdhl') return r.pdhl?.bullBreakout||r.pdhl?.bearBreakout;
    if (boFilter==='st')      return r.st?.crossed; if (boFilter==='vol') return r.vol?.confirmed||r.vol?.strong;
    if (boFilter==='52wk')    return r.wk52?.breakHigh||r.wk52?.atHigh; if (boFilter==='gap') return r.gap?.gapUp||r.gap?.gapDown;
    if (boFilter==='squeeze') return (r.nr7?.isNR7||r.nr7?.isNR4)||r.bb?.squeeze; if (boFilter==='rs') return r.rs?.outperforming||r.rs?.underperforming;
    return true;
  });

  return (
    <div>
      {/* Mode toggle */}
      <div style={{ display:'flex',gap:0,marginBottom:14,background:'#f1f5f9',borderRadius:10,padding:3 }}>
        {[{id:'picks',label:'📊 Picks',color:'#1d4ed8'},{id:'breakout',label:'🚀 Breakout',color:'#7c3aed'}].map(m=>(
          <button key={m.id} onClick={()=>{setMode(m.id);if(m.id==='breakout'&&!boTime)runBreakoutScan();}}
            style={{ flex:1,padding:'8px 0',borderRadius:8,border:'none',fontSize:12,fontWeight:700,cursor:'pointer',transition:'all .2s',
              background:mode===m.id?'#fff':'transparent',color:mode===m.id?m.color:'#64748b',boxShadow:mode===m.id?'0 1px 4px rgba(0,0,0,.1)':'none'}}>
            {m.label}
          </button>
        ))}
      </div>

      {/* PICKS */}
      {mode==='picks' && (
        <div>
          {!marketStatus.open && <MarketClosedBanner msg={marketStatus.msg||'🔔 NSE Market Closed'} />}
          {picksError && <ErrorBanner title="⚠ Scan Error" message={picksError} onRetry={runPicksScan} />}
          {picksLoading ? (
            <Spinner label="Professional analysis..." progress={pickProgress}
              sub="RSI · EMA · MACD · ATR · SR · BB · ADX · RSI Div · Reversal · Entry Trigger" />
          ) : (
            <div>
              {pickStats && (
                <div className="stats-g">
                  <StatCard label="NIFTY 50"   value={`₹${fmt(pickStats.nifty.ltp)}`}     sub={fmtC(pickStats.nifty.chgPct)}     valClass={pickStats.nifty.chgPct>=0?'up':'dn'} />
                  <StatCard label="BANK NIFTY" value={`₹${fmt(pickStats.banknifty.ltp)}`} sub={fmtC(pickStats.banknifty.chgPct)} valClass={pickStats.banknifty.chgPct>=0?'up':'dn'} />
                  <StatCard label="INDIA VIX"  value={(pickStats.vix||0).toFixed(2)}       sub={pickStats.vixTxt}                 valClass={pickStats.vix<16?'up':pickStats.vix>22?'dn':'am'} />
                  {wsConnected && <StatCard label="LIVE FEED" value="⚡ WS" sub="WebSocket" valClass="up" />}
                </div>
              )}
              {fiiInterp && (
                <div style={{ background:'#fff',border:'1px solid #e2e8f0',borderRadius:8,padding:'8px 12px',marginBottom:10,fontSize:10 }}>
                  <span style={{ color:'#94a3b8' }}>FII/DII: </span>
                  <span style={{ fontWeight:800,color:fiiInterp.color }}>{fiiInterp.label}</span>
                  <span style={{ color:'#64748b',marginLeft:8 }}>{fiiInterp.detail}</span>
                </div>
              )}
              {picksTime && <LastUpdated time={picksTime} />}
              <div className="sec-hdr">
                <h3>Professional Picks</h3>
                <span>Conf≥{cfg.minStockConf}% · Pot≥{cfg.pot}% · Risk&lt;{cfg.risk}%</span>
              </div>
              {picks.length===0 ? (
                <EmptyState>
                  {!stocks?.length
                    ? '⚙ Configure stocks.json in GitHub Settings first'
                    : marketStatus.open
                      ? '🔄 Click ▶ Scan to fetch picks'
                      : '📅 NSE Market Closed · Auto-starts Mon–Fri 9:15 AM IST'}
                </EmptyState>
              ) : (
                <div className="cards-g">
                  {picks.map((p,i) => {
                    const live = lastPrices[p.key];
                    return (
                      <div key={p.s} style={{position:'relative'}}>
                        {live && <div style={{position:'absolute',top:35,right:11,background:live.chgPct>=0?'#dcfce7':'#fee2e2',color:live.chgPct>=0?'#16a34a':'#dc2626',fontSize:9,fontWeight:800,padding:'2px 6px',borderRadius:8,border:`1px solid ${live.chgPct>=0?'#86efac':'#fca5a5'}`,zIndex:10}}>₹{fmt(live.ltp)} ⚡</div>}
                        <StockCard pick={live?{...p,ltp:live.ltp,chgPct:live.chgPct}:p} rank={i+1} />
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="disc">⚠ Analysis via RSI · EMA · MACD · ATR · SR · BB · ADX · RSI Divergence · Reversal Detection. Not SEBI-registered advice. Always DYODD.</div>
            </div>
          )}
        </div>
      )}

      {/* BREAKOUT */}
      {mode==='breakout' && (
        <div>
          {boError && <ErrorBanner title="⚠ Breakout Error" message={boError} onRetry={runBreakoutScan} />}
          {boLoading ? (
            <Spinner label="Breakout Scanner..." progress={boProgress}
              sub="EMA 50/200 · PDH/PDL · Supertrend · Vol · 52Wk · Gap · NR7 · BB · RS · Wick · Weekly MTF" />
          ) : (
            <div>
              <div className="last-upd">
                <div className="upd-dot" style={{background:'#7c3aed'}} />
                <span>{boTime||'Not scanned yet'}</span>
                <button onClick={runBreakoutScan} className="btn btn-s" style={{marginLeft:'auto',fontSize:10,padding:'4px 10px'}}>🔄 Re-scan</button>
              </div>
              {boStats && (
                <div className="stats-g">
                  <StatCard label="TOTAL"        value={boStats.total}     sub="signals"             valClass="bl" />
                  <StatCard label="BULLISH 📈"   value={boStats.bullCount} sub={`${boStats.goldCross} Golden Cross`} valClass="up" />
                  <StatCard label="BEARISH 📉"   value={boStats.bearCount} valClass="dn" />
                  <StatCard label="VOL SURGE 🔥" value={boStats.volSurge}  valClass="am" />
                </div>
              )}
              <div style={{display:'flex',gap:6,marginBottom:12,overflowX:'auto',paddingBottom:4}}>
                {BO_FILTERS.map(f=>(
                  <button key={f.id} onClick={()=>setBoFilter(f.id)} style={{
                    whiteSpace:'nowrap',padding:'6px 12px',borderRadius:20,
                    border:boFilter===f.id?'none':'1px solid #e2e8f0',fontSize:11,fontWeight:700,cursor:'pointer',
                    background:boFilter===f.id?'#7c3aed':'#fff',color:boFilter===f.id?'#fff':'#374151',
                  }}>{f.label}</button>
                ))}
              </div>
              {filteredCards.length===0
                ? <EmptyState>{!stocks?.length ? '⚙ Configure stocks.json in GitHub Settings' : '🔄 Click Re-scan to run the breakout scanner'}</EmptyState>
                : <div className="cards-g">{filteredCards.map((c,i)=><StockCard key={c.s||i} pick={c} rank={i+1}/>)}</div>
              }
              <div className="disc">⚠ Breakout: EMA 50/200 · PDH/PDL · Supertrend(7,3) · Vol · 52-Wk · Gap · NR7 · BB Squeeze · RS vs Nifty · Wick · Weekly MTF. Not SEBI advice.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

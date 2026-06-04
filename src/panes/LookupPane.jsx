import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, EmptyState } from '../components/common.jsx';
import { fetchQ, fetchCandles, fetchIntraday, fetchOptions, fetchOptionContracts } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';
import {
  calcRSI, calcEMACrossover, calcATR, calcBBSqueeze, calcSR, calcVWAP,
  detectPatterns, calcRisk, calcPotential, calcConfidence, countIndicatorsEx,
  getRec, autoSLTarget, calcEntryTrigger, detectReversal, calcMACD,
  isNearSupport, calcRSIDivergence, getSignalStrength,
  calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain,
  applyFIIBias, calcVolumeSurge,
} from '../services/technical';
import { fmt, fmtVol } from '../utils/formatters';
import { getIST, getISTDate, sleep, localIsOpen } from '../utils/marketTime';
import { QUICK_STOCKS } from '../constants/config';

function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0;
  const prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

function PayoffCalc({ pick }) {
  const { entry, strike, delta, theta, spot, type } = pick;
  if (!spot || !entry) return null;
  const absD = Math.abs(delta || 0.4);
  const thetaAbs = Math.abs(theta || 0);
  const isCE = type === 'CE';
  const beSpot = isCE ? strike + entry : strike - entry;
  const bePct = spot > 0 ? ((beSpot - spot) / spot * 100).toFixed(2) : '?';
  const scenarios = [-2, -1, 0, 1, 2].map((pct) => {
    const dSpot = spot * pct / 100;
    const dPrem = absD * dSpot * (isCE ? 1 : -1);
    const newPrem = Math.max(0, entry + dPrem);
    const pnl = newPrem - entry;
    return { pct, newPrem: +newPrem.toFixed(2), pnlPct: entry > 0 ? +(pnl / entry * 100).toFixed(0) : 0 };
  });

  return (
    <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
      <div style={{ fontSize:8, color:'#64748b', fontWeight:700, marginBottom:6 }}>PAYOFF CALCULATOR</div>
      {scenarios.map((s) => (
        <div key={s.pct} style={{ display:'flex', justifyContent:'space-between', padding:'3px 6px' }}>
          <span style={{ fontSize:9, color:'#374151', fontWeight:600 }}>{s.pct > 0 ? '+' : ''}{s.pct}%</span>
          <span style={{ fontSize:9, fontWeight:700, color:s.pnlPct >= 0 ? '#16a34a' : '#dc2626' }}>
            Rs {fmt(s.newPrem)} {s.pnlPct !== 0 ? `(${s.pnlPct > 0 ? '+' : ''}${s.pnlPct}%)` : ''}
          </span>
        </div>
      ))}
      <div style={{ display:'flex', justifyContent:'space-between', marginTop:6, paddingTop:6, borderTop:'1px solid #e2e8f0', fontSize:8, color:'#64748b' }}>
        <span>Break-even Rs {fmt(beSpot, 0)}</span>
        <span>{bePct}% move needed</span>
        <span>Theta -Rs {thetaAbs.toFixed(2)}/day</span>
      </div>
    </div>
  );
}

function PositionSizing({ pick, portSize, riskPct }) {
  const maxRisk = (portSize || 500000) * (riskPct || 2) / 100;
  const lossPerLot = pick.maxLoss || 0;
  if (lossPerLot <= 0) return null;
  const recLots = Math.max(1, Math.floor(maxRisk / lossPerLot));
  const recCapital = recLots * pick.entry * pick.lot;
  return (
    <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
      <div style={{ fontSize:8, color:'#64748b', fontWeight:700, marginBottom:4 }}>POSITION SIZING</div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ fontSize:16, fontWeight:800, color:'#1d4ed8' }}>{recLots} lot{recLots > 1 ? 's' : ''}</div>
        <div style={{ textAlign:'right', fontSize:9, color:'#64748b' }}>
          Capital: Rs {fmt(recCapital, 0)}<br />
          Risk cap: Rs {fmt(maxRisk, 0)}
        </div>
      </div>
    </div>
  );
}

function OptionSuggestionCard({ pick, cfg, showTools = true }) {
  return (
    <div style={{ marginBottom:12 }}>
      <div style={{ background: pick.type === 'CE' ? '#f0fdf4' : '#fef2f2', border:`1px solid ${pick.type === 'CE' ? '#86efac' : '#fca5a5'}`, borderRadius:10, padding:12, marginBottom:6 }}>
        <div style={{ fontWeight:800, fontSize:14, marginBottom:6 }}>{pick.und} {pick.strike} {pick.type} · Rs {fmt(pick.entry)} · {pick.confidence}% conf</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4, background:'#e2e8f0', borderRadius:7, padding:1, marginBottom:8 }}>
          {[{ l:'ENTRY', v:`Rs ${fmt(pick.entry)}`, c:'#1d4ed8' }, { l:'SL', v:`Rs ${fmt(pick.sl)}`, c:'#dc2626' }, { l:'TARGET', v:`Rs ${fmt(pick.tgt)}`, c:'#16a34a' }].map((b) => (
            <div key={b.l} style={{ background:'#f8fafc', padding:'6px 8px', textAlign:'center' }}>
              <div style={{ fontSize:7, color:'#64748b' }}>{b.l}</div>
              <div style={{ fontSize:13, fontWeight:800, color:b.c }}>{b.v}</div>
            </div>
          ))}
        </div>
        {showTools && <PositionSizing pick={pick} portSize={cfg.portSize} riskPct={cfg.riskPct} />}
        {showTools && <PayoffCalc pick={pick} />}
      </div>
    </div>
  );
}

export default function LookupPane() {
  const { token, cfg, onTokenExpired, lg, stocks, fiiData, fiiInterp } = useApp();
  const [sym, setSym] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState('');
  const [ddOpen, setDdOpen] = useState(false);
  const [ddItems, setDdItems] = useState([]);

  const activeKey = result?.inst?.key ? [result.inst.key] : [];
  const { connected: liveConnected, lastPrices: livePrices, wsMode: liveMode } = useMarketFeed(
    token,
    activeKey,
    Boolean(token && activeKey.length)
  );

  useEffect(() => {
    if (!sym) {
      setDdItems([]);
      setDdOpen(false);
      return;
    }
    const q = sym.toUpperCase();
    const matches = (stocks || []).filter((s) => s.s.startsWith(q) || s.n?.toUpperCase().includes(q)).slice(0, 12);
    setDdItems(matches);
    setDdOpen(matches.length > 0);
  }, [sym, stocks]);

  useEffect(() => {
    const key = result?.inst?.key;
    const live = key ? livePrices[key] : null;
    if (!key || !live?.ltp) return;
    setResult((prev) => {
      if (!prev?.inst?.key || prev.inst.key !== key) return prev;
      const prevClose = prev.q?.ohlc?.close || live.cp || live.ltp;
      return {
        ...prev,
        q: { ...prev.q, last_price: live.ltp },
        ltp: live.ltp,
        chgPct: prevClose > 0 ? ((live.ltp - prevClose) / prevClose) * 100 : 0,
        time: getIST(),
      };
    });
  }, [livePrices, result?.inst?.key]);

  async function lookup(symbol) {
    const s = (symbol || sym).trim().toUpperCase();
    if (!s) return;

    setSym(s);
    setDdOpen(false);
    setLoading(true);
    setError('');
    setResult(null);
    setProgress('Searching for ' + s + '...');

    try {
      let inst = (stocks || []).find((i) => i.s === s);
      let q = null;

      if (inst) {
        const d = await fetchQ(inst.key, token, onTokenExpired);
        q = d[inst.key] || Object.values(d)[0];
      }

      if (!q?.last_price) {
        for (const tk of ['NSE_EQ|' + s, 'BSE_EQ|' + s]) {
          try {
            const d = await fetchQ(tk, token, onTokenExpired);
            const v = Object.values(d)[0];
            if (v?.last_price) {
              q = v;
              inst = inst || { key: tk, s, n: s, sec: 'NSE', fo: false, lot: 0 };
              break;
            }
          } catch (e) {}
        }
      }

      if (!q?.last_price) throw new Error(s + ' not found. Verify symbol or refresh token in settings.');

      const ltp = q.last_price;
      const chgPct = getChgPct(q);
      const today = getISTDate();
      const from90 = new Date(Date.now() - 95 * 86400000).toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });
      const from7 = new Date(Date.now() - 10 * 86400000).toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });

      setProgress('Loading 90-day candles...');
      let tech = {};
      try {
        const candles = await fetchCandles(inst.key, from90, today, 'day', token, onTokenExpired);
        if (candles.length >= 5) {
          const closes = candles.map((c) => +c[4]).reverse();
          const volObj = calcVolumeSurge(candles);
          const rsi = calcRSI(closes);
          const ema = calcEMACrossover(closes);
          const macd = calcMACD(closes);
          const bb = calcBBSqueeze(closes);
          const atr = calcATR(candles);
          const adx = candles.length >= 16 ? (await import('../services/technical')).calcADX(candles) : null;
          const sr = calcSR(candles);
          const pats = detectPatterns(candles);
          const rsiDiv = calcRSIDivergence(closes);
          const a50 = closes.length >= 50 ? ltp > (ema?.e50 || 0) : null;
          const a200 = closes.length >= 200 ? ltp > (ema?.e200 || 0) : null;
          const volOk = (q.volume || 0) > (volObj?.avgVol || 1) * cfg.vol;
          const nearS = isNearSupport(ltp, sr, candles[candles.length - 1]?.[3]);
          const { sl, target, targets } = autoSLTarget(ltp, q.ohlc?.high || ltp, q.ohlc?.low || ltp, atr, sr, 0, rsi);
          const preRR  = (sl>0&&ltp>sl) ? (target-ltp)/(ltp-sl) : 2;
          const preRec = preRR>=2.0?'BUY':preRR>=1.5?'MODERATE':'WATCH';
          const numInds = countIndicatorsEx(rsi, macd.bull, a50, a200, volOk, nearS, pats, preRec, macd, bb, adx, rsiDiv);
          const rec = numInds >= 4 ? 'BUY' : numInds >= 3 ? 'MODERATE' : numInds >= 2 ? 'WATCH' : 'AVOID';
          const conf = calcConfidence(null, 0, 0, chgPct > 0, 0, q.volume || 0, volObj?.avgVol || 1, pats, preRec, numInds);
          const risk = calcRisk(ltp, sl, target, atr, 0);
          const pot = calcPotential(ltp, target, sl, numInds, rec);
          const finalRec = getRec(conf, pot.base, risk, pot.rr);
          const strength = getSignalStrength(numInds, conf, { type:'NONE' });
          const vwap = calcVWAP(candles);
          const entry = calcEntryTrigger(ltp, q.ohlc?.high || ltp, sr, atr, finalRec, vwap, chgPct);
          const reversal = detectReversal(ltp, rsi, pats, sr, 0, 1.0, chgPct > 0, chgPct, atr, q.ohlc?.high || ltp, q.ohlc?.low || ltp);
          tech = { rsi, ema, macd, bb, atr, adx, sr, pats, rsiDiv, a50, a200, volOk, nearS, numInds, rec: finalRec, conf, sl, target, targets, pot, risk, strength, vwap, entry, reversal, avgVol: volObj?.avgVol || 0, volRatio: volObj?.ratio || 1 };
        }
      } catch (e) {
        lg('Daily candles: ' + e.message, 'w');
      }

      setProgress('Loading 30-min candles...');
      let tf30 = {};
      try {
        const c30 = await fetchCandles(inst.key, from7, today, '30minute', token, onTokenExpired);
        if (c30.length >= 4) {
          const cl30 = c30.map((c) => +c[4]).reverse();
          tf30 = { rsi: calcRSI(cl30), trend: cl30.at(-1) > cl30[0] ? 'UP' : 'DOWN', vwap: calcVWAP(c30) };
        }
      } catch (e) {}

      let tf5 = {};
      let marketCtx = null;
      if (localIsOpen()) {
        setProgress('Loading 5-min intraday candles...');
        try {
          const c5 = await fetchIntraday(inst.key, '5minute', token, onTokenExpired);
          if (c5.length >= 3) {
            const cl5 = c5.map((c) => +c[4]).reverse();
            tf5 = { rsi: calcRSI(cl5), vwap: calcVWAP(c5), trend: cl5.at(-1) > cl5[0] ? 'UP' : 'DOWN' };
            marketCtx = computeCtxFromCandles(c5, ltp, chgPct, 0, null);
          }
        } catch (e) {}
      }

      setProgress('Checking option contracts...');
      let foData = { unsupported: true, picks: [] };
      try {
        const contracts = await fetchOptionContracts(inst.key, token, onTokenExpired);
        const expiries = [...new Set(contracts.map((c) => c.expiry).filter(Boolean))].sort();
        if (expiries.length) {
          const lotFromApi = contracts.find((c) => c.lot_size)?.lot_size || contracts[0]?.lot_size || inst.lot || 1;
          inst = { ...inst, fo: true, lot: lotFromApi };
          const expiry = expiries[0];
          const nextExp = expiries[1] || '';
          setProgress('Loading options chain...');
          await sleep(400);
          const chain = await fetchOptions(inst.key, expiry, token, onTokenExpired);

          if (!chain.length) {
            foData = { empty: true, expiry, picks: [] };
          } else {
            const maxPain = calcMaxPain(chain);
            const oiWalls = calcOIWalls(chain);
            const ceOI = chain.reduce((sum, x) => sum + (x.call_options?.market_data?.oi || 0), 0);
            const peOI = chain.reduce((sum, x) => sum + (x.put_options?.market_data?.oi || 0), 0);
            const pcr = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1.0;
            const step = inst.step || (ltp < 200 ? 5 : ltp < 500 ? 10 : ltp < 2000 ? 20 : ltp < 5000 ? 50 : 100);
            const atm = Math.round(ltp / step) * step;
            const ctx = marketCtx || computeCtxFromCandles([], ltp, chgPct, 0, null);
            const picks = scanChain(chain, atm, ltp, s, expiry, inst.lot, chgPct > 0, 0, maxPain, pcr, ctx, cfg);
            const filteredPicks = picks
              .map((p) => ({ ...p, confidence: applyFIIBias(p.confidence, p.action === 'BUY', fiiData) }))
              .filter((p) => p.confidence >= cfg.minOptConf);

            let multiExpiry = null;
            if (nextExp) {
              try {
                await sleep(400);
                const nextChain = await fetchOptions(inst.key, nextExp, token, onTokenExpired);
                if (nextChain.length) {
                  const findATM = (ch, side) => {
                    const row = ch.find((r) => r.strike_price === atm) || ch.reduce((a, b) => Math.abs(b.strike_price - atm) < Math.abs(a.strike_price - atm) ? b : a, ch[0]);
                    const opt = side === 'CE' ? row?.call_options : row?.put_options;
                    return { ltp: opt?.market_data?.ltp || 0, iv: opt?.option_greeks?.iv || 0, delta: opt?.option_greeks?.delta || 0, theta: opt?.option_greeks?.theta || 0 };
                  };
                  const dteCur = Math.max(0, Math.round((new Date(expiry) - new Date()) / 86400000));
                  const dteNxt = Math.max(0, Math.round((new Date(nextExp) - new Date()) / 86400000));
                  multiExpiry = {
                    expiry,
                    nextExp,
                    dteCur,
                    dteNxt,
                    atm,
                    ce: { cur: findATM(chain, 'CE'), nxt: findATM(nextChain, 'CE') },
                    pe: { cur: findATM(chain, 'PE'), nxt: findATM(nextChain, 'PE') },
                  };
                }
              } catch (e) {
                lg('Multi-expiry: ' + e.message, 'w');
              }
            }

            foData = { chain, picks: filteredPicks, maxPain, oiWalls, pcr, expiry, nextExp, atm, multiExpiry };
          }
        }
      } catch (e) {
        lg(s + ' F&O: ' + e.message, 'e');
        foData = { error: e.message, picks: [] };
      }

      setResult({ inst, q, ltp, chgPct, tech, tf30, tf5, marketCtx, foData, time:getIST() });
      setProgress('');
    } catch (e) {
      setError(e.message);
      lg('Lookup: ' + e.message, 'e');
    } finally {
      setLoading(false);
    }
  }

  const r = result;
  const recColors = { 'STRONG BUY':'#16a34a', BUY:'#22c55e', MODERATE:'#0ea5e9', WATCH:'#d97706', AVOID:'#dc2626' };
  const recBg = { 'STRONG BUY':'#f0fdf4', BUY:'#f0fdf4', MODERATE:'#f0f9ff', WATCH:'#fffbeb', AVOID:'#fef2f2' };

  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
        <div className="lkp-wrap">
          <input
            type="text"
            value={sym}
            onChange={(e) => setSym(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') lookup(); if (e.key === 'Escape') setDdOpen(false); }}
            placeholder="Symbol e.g. RELIANCE, HDFCBANK..."
            style={{ width:'100%', border:'1.5px solid #e2e8f0', borderRadius:8, padding:'9px 12px', fontSize:13, outline:'none' }}
            onFocus={(e) => { e.target.style.borderColor = '#16a34a'; }}
            onBlur={(e) => { e.target.style.borderColor = '#e2e8f0'; setTimeout(() => setDdOpen(false), 200); }}
          />
          {ddOpen && ddItems.length > 0 && (
            <div className="lkp-dd open">
              {ddItems.map((item) => (
                <div key={item.s} className="lkp-dd-item" onMouseDown={() => lookup(item.s)}>
                  <span className="lkp-dd-sym">{item.s}</span>
                  <span className="lkp-dd-name">{item.n}</span>
                  <span className="lkp-dd-sec">{item.fo ? 'F&O' : item.sec}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn-g" onClick={() => lookup()} disabled={loading} style={{ padding:'9px 18px', fontSize:13 }}>
          {loading ? '...' : 'Analyse'}
        </button>
      </div>

      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:14 }}>
        {QUICK_STOCKS.map((s) => <button key={s} className="lkp-q" onClick={() => lookup(s)}>{s}</button>)}
      </div>

      {error && <ErrorBanner title="Lookup Error" message={error} onRetry={() => lookup()} />}
      {loading && <Spinner label={'Analysing ' + sym + '...'} progress={progress} sub="Quote · Candles · Intraday · Indicators · Options chain" />}

      {r && !loading && (
        <div>
          <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:11, padding:16, marginBottom:12 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:8 }}>
              <div>
                <div style={{ fontSize:20, fontWeight:800 }}>{r.inst?.s}</div>
                <div style={{ fontSize:11, color:'#64748b' }}>{r.inst?.n} · {r.inst?.sec} {r.inst?.fo ? '· F&O' : ''}</div>
                <div style={{ fontSize:9, color:'#94a3b8', marginTop:4 }}>
                  Updated: {r.time}{activeKey.length ? ` · ${liveConnected ? (liveMode === 'ws' ? 'Live WS' : 'Live Poll') : 'Static'}` : ''}
                </div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:24, fontWeight:800, color:r.chgPct >= 0 ? '#16a34a' : '#dc2626' }}>Rs {fmt(r.ltp)}</div>
                <div style={{ fontSize:12, fontWeight:600, color:r.chgPct >= 0 ? '#16a34a' : '#dc2626' }}>{r.chgPct >= 0 ? '+' : ''}{r.chgPct.toFixed(2)}%</div>
              </div>
            </div>
            {r.q.volume > 0 && (
              <div style={{ fontSize:9, color:'#94a3b8', marginTop:6 }}>
                Vol: {fmtVol(r.q.volume)} · Avg20: {fmtVol(r.tech?.avgVol || 0)} · {(r.tech?.volRatio || 1).toFixed(1)}x avg
              </div>
            )}
          </div>

          {r.tech?.rec && (
            <div style={{ background:recBg[r.tech.rec] || '#fffbeb', border:`1.5px solid ${recColors[r.tech.rec] || '#d97706'}`, borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:6 }}>
                <div style={{ fontWeight:800, fontSize:18, color:recColors[r.tech.rec] || '#d97706' }}>{r.tech.rec}</div>
                <div style={{ fontSize:11, fontWeight:700, color:r.tech.strength?.color }}>{r.tech.strength?.label} · {r.tech.numInds} indicators · {r.tech.conf?.toFixed(0)}% conf</div>
              </div>
              <div style={{ fontSize:11, color:'#475569', lineHeight:1.6, marginTop:8 }}>
                {[
                  r.tech.rsi < (cfg.rsiOS||35) ? `RSI oversold (${r.tech.rsi?.toFixed(0)})` : r.tech.rsi > (cfg.rsiOB||65) ? `RSI overbought (${r.tech.rsi?.toFixed(0)})` : `RSI ${r.tech.rsi?.toFixed(0)}`,
                  r.tech.macd?.bull === true ? 'MACD bullish' : r.tech.macd?.bull === false ? 'MACD bearish' : null,
                  r.tech.a50 === true ? 'Above MA50' : r.tech.a50 === false ? 'Below MA50' : null,
                  r.tech.a200 === true ? 'Above MA200' : r.tech.a200 === false ? 'Below MA200' : null,
                  r.tech.ema?.goldenCross ? 'Golden Cross' : r.tech.ema?.deathCross ? 'Death Cross' : null,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}

          <div className="stats-g">
            <StatCard label="RSI (14)" value={r.tech.rsi?.toFixed(1) || '—'} sub={r.tech.rsi < (cfg.rsiOS||35) ? 'Oversold' : r.tech.rsi > (cfg.rsiOB||65) ? 'Overbought' : 'Neutral'} valClass={r.tech.rsi < (cfg.rsiOS||35) ? 'up' : r.tech.rsi > (cfg.rsiOB||65) ? 'dn' : 'bl'} />
            <StatCard label="ATR" value={`Rs ${fmt(r.tech.atr || 0)}`} sub="14-day volatility" valClass="am" />
            <StatCard label="MA50" value={r.tech.ema?.e50 ? `Rs ${fmt(r.tech.ema.e50)}` : '—'} sub={r.tech.a50 ? 'Above' : r.tech.a50 === false ? 'Below' : 'N/A'} valClass={r.tech.a50 ? 'up' : 'dn'} />
            <StatCard label="MA200" value={r.tech.ema?.e200 ? `Rs ${fmt(r.tech.ema.e200)}` : '—'} sub={r.tech.a200 ? 'Above' : r.tech.a200 === false ? 'Below' : 'Need 200d'} valClass={r.tech.a200 ? 'up' : 'dn'} />
            <StatCard label="SUPPORT" value={r.tech.sr?.pivotS1 ? `Rs ${fmt(r.tech.sr.pivotS1)}` : '—'} sub="Pivot S1" valClass="up" />
            <StatCard label="RESISTANCE" value={r.tech.sr?.pivotR1 ? `Rs ${fmt(r.tech.sr.pivotR1)}` : '—'} sub="Pivot R1" valClass="dn" />
          </div>

          {r.tech.sl && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, marginBottom:10 }}>Trade Setup</div>
              <div className="trade-setup">
                <div className="ts-box"><div className="ts-l">ENTRY</div><div className="ts-v" style={{ color:'#1d4ed8' }}>Rs {fmt(r.tech.entry?.trigger || r.ltp)}</div><div className="ts-s" style={{ color:'#64748b', fontSize:8 }}>{r.tech.entry?.method}</div></div>
                <div className="ts-box"><div className="ts-l">STOP LOSS</div><div className="ts-v" style={{ color:'#dc2626' }}>Rs {fmt(r.tech.sl)}</div></div>
                <div className="ts-box"><div className="ts-l">TARGET</div><div className="ts-v" style={{ color:'#16a34a' }}>Rs {fmt(r.tech.target)}</div><div className="ts-s" style={{ color:'#16a34a' }}>R:R {r.tech.pot?.rr?.toFixed(1)}</div></div>
              </div>
            </div>
          )}

          {(r.tf30?.rsi || r.tf5?.rsi) && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, marginBottom:10 }}>Multi-Timeframe</div>
              <div className="stats-g">
                {r.tech.rsi && <StatCard label="DAILY RSI" value={r.tech.rsi?.toFixed(1)} sub="Daily" valClass={r.tech.rsi < (cfg.rsiOS||35) ? 'up' : r.tech.rsi > (cfg.rsiOB||65) ? 'dn' : 'bl'} />}
                {r.tf30?.rsi && <StatCard label="30-MIN RSI" value={r.tf30.rsi.toFixed(1)} sub={`30-min · ${r.tf30.trend}`} valClass={r.tf30.trend === 'UP' ? 'up' : 'dn'} />}
                {r.tf5?.rsi && <StatCard label="5-MIN RSI" value={r.tf5.rsi.toFixed(1)} sub={`5-min · ${r.tf5.trend}`} valClass={r.tf5.trend === 'UP' ? 'up' : 'dn'} />}
                {r.tf5?.vwap && <StatCard label="INTRA VWAP" value={`Rs ${fmt(r.tf5.vwap)}`} sub={r.ltp >= r.tf5.vwap ? 'Above VWAP' : 'Below VWAP'} valClass={r.ltp >= r.tf5.vwap ? 'up' : 'dn'} />}
              </div>
            </div>
          )}

          {fiiInterp && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:9, padding:'10px 14px', marginBottom:12 }}>
              <div style={{ fontSize:9, color:'#94a3b8', marginBottom:3 }}>FII/DII BIAS</div>
              <div style={{ fontSize:13, fontWeight:800, color:fiiInterp.color }}>{fiiInterp.label}</div>
              <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{fiiInterp.detail}</div>
            </div>
          )}

          {r.foData && !r.foData.error && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, marginBottom:10 }}>
                {r.foData.unsupported
                  ? 'Options Suggestions · No NSE option contracts'
                  : r.foData.empty
                    ? `Options Suggestions · Exp ${r.foData.expiry} · No chain data`
                    : `Options Suggestions · ${r.foData.picks.filter((p) => p.trendAligned).length} with-trend · ${r.foData.picks.length} total · Exp ${r.foData.expiry}`}
              </div>

              {r.foData.unsupported && (
                <div style={{ fontSize:11, color:'#64748b', padding:8 }}>No options contracts found for {r.inst?.s} on NSE.</div>
              )}

              {r.foData.empty && (
                <div style={{ fontSize:11, color:'#64748b', padding:8 }}>Options chain is empty for {r.inst?.s}. Market may be closed or chain data is not populated yet.</div>
              )}

              {!r.foData.unsupported && !r.foData.empty && (
                <>
                  <div className="stats-g" style={{ marginBottom:10 }}>
                    {r.foData.maxPain > 0 && <StatCard label="MAX PAIN" value={`Rs ${fmt(r.foData.maxPain)}`} valClass="pu" />}
                    {r.foData.oiWalls?.callWall > 0 && <StatCard label="CALL WALL" value={`Rs ${fmt(r.foData.oiWalls.callWall)}`} valClass="dn" />}
                    {r.foData.oiWalls?.putWall > 0 && <StatCard label="PUT WALL" value={`Rs ${fmt(r.foData.oiWalls.putWall)}`} valClass="up" />}
                    <StatCard label="PCR" value={(r.foData.pcr || 0).toFixed(2)} sub={r.foData.pcr > 1.2 ? 'Bearish hedging' : 'Put-Call ratio'} valClass={r.foData.pcr > 1.2 ? 'dn' : 'up'} />
                  </div>

                  {r.foData.picks.filter((p) => p.trendAligned).length > 0 && (
                    <>
                      <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:6, padding:'6px 10px', marginBottom:8, fontSize:10, fontWeight:700, color:'#15803d' }}>
                        {r.foData.picks.filter((p) => p.trendAligned).length} WITH-TREND signals
                      </div>
                      {r.foData.picks.filter((p) => p.trendAligned).slice(0, 3).map((pick, i) => <OptionSuggestionCard key={`wt-${i}`} pick={pick} cfg={cfg} />)}
                    </>
                  )}

                  {r.foData.picks.filter((p) => !p.trendAligned).length > 0 && (
                    <>
                      <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:6, padding:'6px 10px', marginBottom:8, fontSize:10, fontWeight:700, color:'#92400e' }}>
                        {r.foData.picks.filter((p) => !p.trendAligned).length} COUNTER-TREND signals
                      </div>
                      {r.foData.picks.filter((p) => !p.trendAligned).slice(0, 3).map((pick, i) => <OptionSuggestionCard key={`ct-${i}`} pick={pick} cfg={cfg} />)}
                    </>
                  )}

                  {r.foData.picks.length === 0 && (
                    <div style={{ fontSize:11, color:'#64748b', padding:8 }}>No signals meet confidence ≥ {cfg.minOptConf}%. Lower Options Min Confidence in settings.</div>
                  )}

                  {r.foData.multiExpiry && (
                    <div style={{ marginTop:12, background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:12 }}>
                      <div style={{ fontSize:10, fontWeight:800, marginBottom:8 }}>MULTI-EXPIRY COMPARISON · ATM {r.foData.multiExpiry.atm}</div>
                      {['CE', 'PE'].map((side) => {
                        const me = r.foData.multiExpiry;
                        const cur = me[side.toLowerCase()].cur;
                        const nxt = me[side.toLowerCase()].nxt;
                        const costDiff = nxt.ltp > 0 && cur.ltp > 0 ? +((nxt.ltp - cur.ltp) / cur.ltp * 100).toFixed(0) : null;
                        return (
                          <div key={side} style={{ marginBottom:8 }}>
                            <div style={{ fontSize:9, fontWeight:700, color:'#374151', marginBottom:4 }}>{side} ATM {me.atm}</div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
                              <div style={{ background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:6, padding:'6px 8px' }}>
                                <div style={{ fontSize:7, color:'#0369a1', fontWeight:700 }}>CURRENT · {me.expiry} · {me.dteCur}d</div>
                                <div style={{ fontSize:14, fontWeight:800, color:'#1e40af' }}>Rs {fmt(cur.ltp)}</div>
                              </div>
                              <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:6, padding:'6px 8px' }}>
                                <div style={{ fontSize:7, color:'#64748b', fontWeight:700 }}>NEXT · {me.nextExp} · {me.dteNxt}d</div>
                                <div style={{ fontSize:14, fontWeight:800, color:'#374151' }}>Rs {fmt(nxt.ltp)}</div>
                                {costDiff !== null && <div style={{ fontSize:7, color:costDiff > 0 ? '#dc2626' : '#16a34a', fontWeight:600 }}>{costDiff > 0 ? '+' : ''}{costDiff}% vs current</div>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {r.foData?.error && (
            <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, padding:10, marginBottom:12, fontSize:11, color:'#dc2626' }}>
              Options error: {r.foData.error}
            </div>
          )}

          <div className="disc">Analysis for educational purposes only. Not SEBI-registered advice. Always DYODD.</div>
        </div>
      )}

      {!r && !loading && !error && (
        <EmptyState>Enter a stock symbol above to get full analysis including option suggestions where available.</EmptyState>
      )}
    </div>
  );
}

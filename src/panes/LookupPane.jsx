import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, EmptyState } from '../components/common.jsx';
import { fetchQ, fetchCandles, fetchIntraday, fetchOptions, resolveAccessToken, withRetry } from '../services/api';
import {
  calcRSI, calcEMACrossover, calcATR, calcBBSqueeze, calcSR, calcVWAP,
  detectPatterns, calcRisk, calcPotential, calcConfidence, countIndicatorsEx,
  getRec, autoSLTarget, calcEntryTrigger, detectReversal, calcMACD,
  isNearSupport, calcRSIDivergence, getSignalStrength, getTimeOfDayPenalty,
  calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain,
  applyFIIBias, calcVolumeSurge, getSector,
} from '../services/technical';
import { fmt, fmtC, fmtVol } from '../utils/formatters';
import { getIST, getISTDate, sleep, localIsOpen } from '../utils/marketTime';
import { QUICK_STOCKS } from '../constants/config';

function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0, prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

// ── Payoff Calculator (delta approximation) — EXACT port from HTML ──
function PayoffCalc({ pick }) {
  const { entry, sl, tgt: target, strike, delta, theta, spot, type, lot, maxLoss, maxProfit } = pick;
  if (!spot || !entry) return null;
  const absD = Math.abs(delta || 0.4), thetaAbs = Math.abs(theta || 0);
  const isCE = type === 'CE';
  const beSpot = isCE ? strike + entry : strike - entry;
  const bePct  = spot > 0 ? ((beSpot - spot) / spot * 100).toFixed(2) : '?';
  const scenarios = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3].map(pct => {
    const dSpot = spot * pct / 100;
    const dPrem = absD * dSpot * (isCE ? 1 : -1);
    const newPrem = Math.max(0, entry + dPrem);
    const pnl = newPrem - entry;
    return { pct, newPrem: +newPrem.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: entry > 0 ? +(pnl / entry * 100).toFixed(0) : 0 };
  });
  const d1 = Math.max(0, +(entry - thetaAbs * 1).toFixed(2));
  const d2 = Math.max(0, +(entry - thetaAbs * 2).toFixed(2));
  const d3 = Math.max(0, +(entry - thetaAbs * 3).toFixed(2));
  const filtered = scenarios.filter(s => [-2, -1, 0, 1, 2].includes(s.pct));
  return (
    <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
      <div style={{ fontSize:8, color:'#64748b', fontWeight:700, marginBottom:6 }}>📊 PAYOFF CALCULATOR (delta approx · underlying moves)</div>
      {filtered.map(s => (
        <div key={s.pct} style={{ display:'flex', justifyContent:'space-between', padding:'3px 6px', borderRadius:4, background: s.pnl > 0 ? '#f0fdf4' : s.pnl < 0 ? '#fef2f2' : '#f8fafc' }}>
          <span style={{ fontSize:9, color:'#374151', fontWeight:600 }}>{s.pct > 0 ? '+' : ''}{s.pct}% (₹{fmt(spot * (1 + s.pct / 100), 0)})</span>
          <span style={{ fontSize:9, fontWeight:700, color: s.pnl > 0 ? '#16a34a' : s.pnl < 0 ? '#dc2626' : '#64748b' }}>
            ₹{fmt(s.newPrem)} {s.pnlPct !== 0 ? `(${s.pnlPct > 0 ? '+' : ''}${s.pnlPct}%)` : ''}
          </span>
        </div>
      ))}
      <div style={{ display:'flex', gap:6, marginTop:6, paddingTop:6, borderTop:'1px solid #e2e8f0' }}>
        <div style={{ flex:1, textAlign:'center' }}>
          <div style={{ fontSize:7, color:'#64748b' }}>BREAK-EVEN</div>
          <div style={{ fontSize:10, fontWeight:700, color:'#374151' }}>₹{fmt(beSpot, 0)}</div>
          <div style={{ fontSize:8, color: +bePct > 0 ? '#dc2626' : '#16a34a' }}>{+bePct > 0 ? '+' : ''}{bePct}% move needed</div>
        </div>
        <div style={{ flex:1, textAlign:'center' }}>
          <div style={{ fontSize:7, color:'#64748b' }}>THETA DECAY</div>
          <div style={{ fontSize:9, color:'#64748b' }}>1d: <b>₹{d1}</b> · 2d: <b>₹{d2}</b> · 3d: <b>₹{d3}</b></div>
          <div style={{ fontSize:7, color:'#dc2626' }}>-₹{thetaAbs.toFixed(2)}/day</div>
        </div>
      </div>
    </div>
  );
}

// ── Position Sizing — EXACT port from HTML ──
function PositionSizing({ pick, portSize, riskPct }) {
  const maxRisk    = (portSize || 500000) * (riskPct || 2) / 100;
  const lossPerLot = pick.maxLoss || 0;
  if (lossPerLot <= 0) return null;
  const recLots    = Math.max(1, Math.floor(maxRisk / lossPerLot));
  const recCapital = recLots * pick.entry * pick.lot;
  const recLoss    = recLots * lossPerLot;
  const color = recLots <= 1 ? '#92400e' : recLots >= 3 ? '#15803d' : '#1d4ed8';
  const bg    = recLots <= 1 ? '#fffbeb' : recLots >= 3 ? '#f0fdf4' : '#eff6ff';
  return (
    <div style={{ background:bg, border:'1px solid #e2e8f0', borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
      <div style={{ fontSize:8, color:'#64748b', fontWeight:700, marginBottom:4 }}>
        💰 POSITION SIZING (₹{((portSize || 500000) / 100000).toFixed(1)}L portfolio · {riskPct || 2}% risk = ₹{fmt(maxRisk, 0)} max loss)
      </div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <span style={{ fontSize:18, fontWeight:800, color }}>{recLots} lot{recLots > 1 ? 's' : ''}</span>
          <span style={{ fontSize:9, color:'#64748b', marginLeft:6 }}>recommended</span>
        </div>
        <div style={{ textAlign:'right', fontSize:9, color:'#64748b' }}>
          Capital: ₹{fmt(recCapital, 0)}<br />Max loss: ₹{fmt(recLoss, 0)}
        </div>
      </div>
      {recLots > 3 && <div style={{ fontSize:8, color:'#64748b', marginTop:3 }}>⚠ Capped — consider {Math.min(recLots, 3)} lots to diversify</div>}
    </div>
  );
}

export default function LookupPane() {
  const { token, cfg, onTokenExpired, lg, stocks, fiiData, fiiInterp } = useApp();
  const [sym, setSym]         = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [result, setResult]   = useState(null);
  const [progress, setProgress] = useState('');
  const [ddOpen, setDdOpen]   = useState(false);
  const [ddItems, setDdItems] = useState([]);

  useEffect(() => {
    if (!sym) { setDdItems([]); setDdOpen(false); return; }
    const q = sym.toUpperCase();
    const matches = (stocks || []).filter(s => s.s.startsWith(q) || s.n?.toUpperCase().includes(q)).slice(0, 12);
    setDdItems(matches); setDdOpen(matches.length > 0);
  }, [sym, stocks]);

  async function lookup(symbol) {
    const s = (symbol || sym).trim().toUpperCase();
    if (!s) return;
    setSym(s); setDdOpen(false);
    setLoading(true); setError(''); setResult(null);
    setProgress('Searching for ' + s + '...');
    try {
      // Resolve instrument key
      let inst = (stocks || []).find(i => i.s === s);
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
            if (v?.last_price) { q = v; inst = inst || { key: tk, s, n: s, sec: 'NSE', fo: false, lot: 0 }; break; }
          } catch (e) {}
        }
      }
      if (!q?.last_price) throw new Error(s + ' not found — verify symbol or paste token in ⚙ Settings');

      const ltp = q.last_price, chgPct = getChgPct(q);
      const today  = getISTDate();
      const from90 = new Date(Date.now() - 95 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const from7  = new Date(Date.now() - 10 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

      // Step 2: Daily candles
      setProgress('Loading 90-day candles...');
      let candles = [], tech = {};
      try {
        candles = await fetchCandles(inst.key, from90, today, 'day', token, onTokenExpired);
        if (candles.length >= 5) {
          const closes  = candles.map(c => +c[4]).reverse();
          const volObj  = calcVolumeSurge(candles);
          const rsi     = calcRSI(closes);
          const ema     = calcEMACrossover(closes);
          const macd    = calcMACD(closes);
          const bb      = calcBBSqueeze(closes);
          const atr     = calcATR(candles);
          const adx     = candles.length >= 16 ? (await import('../services/technical')).calcADX(candles) : null;
          const sr      = calcSR(candles);
          const pats    = detectPatterns(candles);
          const rsiDiv  = calcRSIDivergence(closes);
          const a50     = closes.length >= 50  ? ltp > (ema?.e50  || 0) : null;
          const a200    = closes.length >= 200 ? ltp > (ema?.e200 || 0) : null;
          const volOk   = (q.volume || 0) > (volObj?.avgVol || 1) * cfg.vol;
          const nearS   = isNearSupport(ltp, sr, candles[candles.length - 1]?.[3]);
          const numInds = countIndicatorsEx(rsi, macd.bull, a50, a200, volOk, nearS, pats, 'BUY', macd, bb, adx, rsiDiv);
          const rec     = numInds >= 4 ? 'BUY' : numInds >= 3 ? 'MODERATE' : numInds >= 2 ? 'WATCH' : 'AVOID';
          const conf    = calcConfidence(null, 0, 0, chgPct > 0, 0, q.volume || 0, volObj?.avgVol || 1, pats, rec, numInds);
          const { sl, target, targets } = autoSLTarget(ltp, q.ohlc?.high || ltp, q.ohlc?.low || ltp, atr, sr, 0, rsi);
          const pot     = calcPotential(ltp, target, sl, numInds, rec);
          const risk    = calcRisk(ltp, sl, target, atr, 0);
          const finalRec = getRec(conf, pot.base, risk, pot.rr);
          const strength = getSignalStrength(numInds, conf, { type: 'NONE' });
          const vwap    = calcVWAP(candles);
          const entry   = calcEntryTrigger(ltp, q.ohlc?.high || ltp, sr, atr, finalRec, vwap, chgPct);
          const reversal = detectReversal(ltp, rsi, pats, sr, 0, 1.0, chgPct > 0, chgPct, atr, q.ohlc?.high || ltp, q.ohlc?.low || ltp);
          tech = { rsi, ema, macd, bb, atr, adx, sr, pats, rsiDiv, a50, a200, volOk, nearS, numInds, rec: finalRec, conf, sl, target, targets, pot, risk, strength, vwap, entry, reversal, avgVol: volObj?.avgVol || 0, volRatio: volObj?.ratio || 1 };
        }
      } catch (e) { lg('Daily candles: ' + e.message, 'w'); }

      // Step 3: 30-min candles
      setProgress('Loading 30-min candles...');
      let tf30 = {};
      try {
        const c30 = await fetchCandles(inst.key, from7, today, '30minute', token, onTokenExpired);
        if (c30.length >= 4) {
          const cl30 = c30.map(c => +c[4]).reverse();
          tf30 = { rsi: calcRSI(cl30), trend: cl30.at(-1) > cl30[0] ? 'UP' : 'DOWN', vwap: calcVWAP(c30) };
        }
      } catch (e) {}

      // Step 4: Intraday 5-min (for market context)
      let tf5 = {}, marketCtx = null;
      if (localIsOpen()) {
        setProgress('Loading 5-min intraday candles...');
        try {
          const c5 = await fetchIntraday(inst.key, '5minute', token, onTokenExpired);
          if (c5.length >= 3) {
            const cl5 = c5.map(c => +c[4]).reverse();
            tf5 = { rsi: calcRSI(cl5), vwap: calcVWAP(c5), trend: cl5.at(-1) > cl5[0] ? 'UP' : 'DOWN' };
            marketCtx = computeCtxFromCandles(c5, ltp, chgPct, 0, null);
          }
        } catch (e) {}
      }

      // Step 5: F&O Analysis (if F&O stock)
      let foData = null;
      if (inst.fo && inst.lot > 0) {
        setProgress('Loading options chain...');
        try {
          const cd = await fetch(
            `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(inst.key)}`,
            { headers: { Authorization: 'Bearer ' + resolveAccessToken(token), Accept: 'application/json' } }
          ).then(r => r.json());
          const expiries = (cd?.data?.map(e => e.expiry).sort() || []);
          const expiry   = expiries[0] || '';
          const nextExp  = expiries[1] || '';
          if (expiry) {
            await sleep(400);
            const chain = await fetchOptions(inst.key, expiry, token, onTokenExpired);
            const maxPain = calcMaxPain(chain);
            const oiWalls = calcOIWalls(chain);
            const ceOI = chain.reduce((s, x) => s + (x.call_options?.market_data?.oi || 0), 0);
            const peOI = chain.reduce((s, x) => s + (x.put_options?.market_data?.oi  || 0), 0);
            const pcr  = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1.0;
            const atm  = Math.round(ltp / (inst.step || 50)) * (inst.step || 50);
            const ctx  = marketCtx || computeCtxFromCandles([], ltp, chgPct, 0, null);
            const picks = scanChain(chain, atm, ltp, s, expiry, inst.lot, chgPct > 0, 0, maxPain, pcr, ctx, cfg);
            const picksWithFII = picks.map(p => ({ ...p, confidence: applyFIIBias(p.confidence, p.action === 'BUY', fiiData) }))
              .filter(p => p.confidence >= cfg.minOptConf);

            // Multi-expiry comparison
            let multiExpiry = null;
            if (nextExp && chain.length) {
              try {
                await sleep(400);
                const nextChain = await fetchOptions(inst.key, nextExp, token, onTokenExpired);
                if (nextChain.length) {
                  const findATM = (ch, side) => {
                    const row = ch.find(r => r.strike_price === atm) || ch.reduce((a, b) => Math.abs(b.strike_price - atm) < Math.abs(a.strike_price - atm) ? b : a, ch[0]);
                    const opt = side === 'CE' ? row?.call_options : row?.put_options;
                    return { ltp: opt?.market_data?.ltp || 0, iv: opt?.option_greeks?.iv || 0, delta: opt?.option_greeks?.delta || 0, theta: opt?.option_greeks?.theta || 0 };
                  };
                  const dteCur = Math.max(0, Math.round((new Date(expiry) - new Date()) / 86400000));
                  const dteNxt = Math.max(0, Math.round((new Date(nextExp) - new Date()) / 86400000));
                  multiExpiry = { expiry, nextExp, dteCur, dteNxt, atm, ce: { cur: findATM(chain, 'CE'), nxt: findATM(nextChain, 'CE') }, pe: { cur: findATM(chain, 'PE'), nxt: findATM(nextChain, 'PE') } };
                }
              } catch (e) { lg('Multi-expiry: ' + e.message, 'w'); }
            }
            foData = { chain, picks: picksWithFII, maxPain, oiWalls, pcr, expiry, nextExp, atm, multiExpiry };
          }
        } catch (e) { lg(s + ' F&O: ' + e.message, 'e'); foData = { error: e.message }; }
      }

      setResult({ inst, q, ltp, chgPct, tech, tf30, tf5, marketCtx, foData, time: getIST() });
      setProgress('');
    } catch (e) {
      setError(e.message); lg('Lookup: ' + e.message, 'e');
    } finally { setLoading(false); }
  }

  const r = result;
  const recColors = { 'STRONG BUY': '#16a34a', BUY: '#22c55e', MODERATE: '#0ea5e9', WATCH: '#d97706', AVOID: '#dc2626' };
  const recBg     = { 'STRONG BUY': '#f0fdf4', BUY: '#f0fdf4', MODERATE: '#f0f9ff', WATCH: '#fffbeb', AVOID: '#fef2f2' };

  return (
    <div>
      {/* Search */}
      <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap' }}>
        <div className="lkp-wrap">
          <input type="text" value={sym}
            onChange={e => setSym(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === 'Enter') lookup(); if (e.key === 'Escape') setDdOpen(false); }}
            placeholder="Symbol e.g. RELIANCE, HDFCBANK..."
            style={{ width:'100%', border:'1.5px solid #e2e8f0', borderRadius:8, padding:'9px 12px', fontSize:13, outline:'none' }}
            onFocus={e => { e.target.style.borderColor='#16a34a'; }}
            onBlur={e  => { e.target.style.borderColor='#e2e8f0'; setTimeout(() => setDdOpen(false), 200); }}
          />
          {ddOpen && ddItems.length > 0 && (
            <div className="lkp-dd open">
              {ddItems.map(item => (
                <div key={item.s} className="lkp-dd-item" onMouseDown={() => lookup(item.s)}>
                  <span className="lkp-dd-sym">{item.s}</span>
                  <span className="lkp-dd-name">{item.n}</span>
                  <span className="lkp-dd-sec">{item.fo ? '📦 F&O' : item.sec}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn-g" onClick={() => lookup()} disabled={loading} style={{ padding:'9px 18px', fontSize:13 }}>
          {loading ? '⏳' : '🔍 Analyse'}
        </button>
      </div>

      {/* Quick stocks */}
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:14 }}>
        {QUICK_STOCKS.map(s => <button key={s} className="lkp-q" onClick={() => lookup(s)}>{s}</button>)}
      </div>

      {error   && <ErrorBanner title="⚠ Lookup Error" message={error} onRetry={() => lookup()} />}
      {loading && <Spinner label={'Analysing ' + sym + '...'} progress={progress} sub="Quote · 90d Candles · 30-min · 5-min Intraday · RSI · EMA · MACD · SR · BB · ADX · F&O Chain" />}

      {r && !loading && (
        <div>
          {/* Header */}
          <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:11, padding:16, marginBottom:12 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:8 }}>
              <div>
                <div style={{ fontSize:20, fontWeight:800 }}>{r.inst?.s}</div>
                <div style={{ fontSize:11, color:'#64748b' }}>{r.inst?.n} · {r.inst?.sec} {r.inst?.fo ? '· 📦 F&O' : ''}</div>
                <div style={{ fontSize:9, color:'#94a3b8', marginTop:4 }}>Updated: {r.time}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:24, fontWeight:800, color: r.chgPct >= 0 ? '#16a34a' : '#dc2626' }}>₹{fmt(r.ltp)}</div>
                <div style={{ fontSize:12, fontWeight:600, color: r.chgPct >= 0 ? '#16a34a' : '#dc2626' }}>{r.chgPct >= 0 ? '+' : ''}{r.chgPct.toFixed(2)}%</div>
              </div>
            </div>
            {/* Volume */}
            {r.q.volume > 0 && (
              <div style={{ fontSize:9, color:'#94a3b8', marginTop:6 }}>
                Vol: {fmtVol(r.q.volume)} · Avg20: {fmtVol(r.tech?.avgVol || 0)} · {r.tech?.volRatio > 1.2 ? '🔥 ' : ''}{(r.tech?.volRatio || 1).toFixed(1)}× avg
              </div>
            )}
          </div>

          {/* Recommendation */}
          {r.tech?.rec && (
            <div style={{ background: recBg[r.tech.rec] || '#fffbeb', border: `1.5px solid ${recColors[r.tech.rec] || '#d97706'}`, borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:6 }}>
                <div style={{ fontWeight:800, fontSize:18, color: recColors[r.tech.rec] || '#d97706' }}>
                  {r.tech.rec === 'STRONG BUY' ? '📈' : r.tech.rec === 'BUY' ? '📈' : r.tech.rec === 'AVOID' ? '📉' : '👁'} {r.tech.rec}
                </div>
                <div style={{ fontSize:11, fontWeight:700, color: r.tech.strength?.color }}>
                  {r.tech.strength?.label} · {r.tech.numInds} indicators · {r.tech.conf?.toFixed(0)}% conf
                </div>
              </div>
              {r.tech.reversal?.type !== 'NONE' && (
                <div style={{ fontSize:10, color:'#7c3aed', fontWeight:600, marginTop:6 }}>
                  🔄 Reversal: {r.tech.reversal.type.replace('_', ' ')} ({r.tech.reversal.strength})
                </div>
              )}
              <div style={{ fontSize:11, color:'#475569', lineHeight:1.6, marginTop:8 }}>
                {[
                  r.tech.rsi < 35 ? `RSI oversold (${r.tech.rsi?.toFixed(0)})` : r.tech.rsi > 70 ? `RSI overbought (${r.tech.rsi?.toFixed(0)})` : `RSI ${r.tech.rsi?.toFixed(0)}`,
                  r.tech.macd?.bull === true ? 'MACD bullish' : r.tech.macd?.bull === false ? 'MACD bearish' : null,
                  r.tech.a50 === true ? 'Above MA50' : r.tech.a50 === false ? 'Below MA50' : null,
                  r.tech.a200 === true ? 'Above MA200' : r.tech.a200 === false ? 'Below MA200' : null,
                  r.tech.ema?.goldenCross ? '⭐ Golden Cross' : r.tech.ema?.deathCross ? '💀 Death Cross' : null,
                  r.tech.pats?.bullishEngulfing ? 'Bullish Engulfing' : r.tech.pats?.hammer ? 'Hammer' : r.tech.pats?.morningStar ? 'Morning Star' : null,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          )}

          {/* Key stats */}
          <div className="stats-g">
            <StatCard label="RSI (14)"  value={r.tech.rsi?.toFixed(1) || '—'} sub={r.tech.rsi < 35 ? 'Oversold' : r.tech.rsi > 70 ? 'Overbought' : 'Neutral'} valClass={r.tech.rsi < 35 ? 'up' : r.tech.rsi > 70 ? 'dn' : 'bl'} />
            <StatCard label="ATR"       value={`₹${fmt(r.tech.atr || 0)}`} sub="14-day volatility" valClass="am" />
            <StatCard label="MA50"      value={r.tech.ema?.e50 ? `₹${fmt(r.tech.ema.e50)}` : '—'} sub={r.tech.a50 ? 'Above ✅' : r.tech.a50 === false ? 'Below ❌' : 'N/A'} valClass={r.tech.a50 ? 'up' : 'dn'} />
            <StatCard label="MA200"     value={r.tech.ema?.e200 ? `₹${fmt(r.tech.ema.e200)}` : '—'} sub={r.tech.a200 ? 'Above ✅' : r.tech.a200 === false ? 'Below ❌' : 'Need 200d'} valClass={r.tech.a200 ? 'up' : 'dn'} />
            <StatCard label="SUPPORT"   value={r.tech.sr?.pivotS1 ? `₹${fmt(r.tech.sr.pivotS1)}` : '—'} sub="Pivot S1" valClass="up" />
            <StatCard label="RESISTANCE" value={r.tech.sr?.pivotR1 ? `₹${fmt(r.tech.sr.pivotR1)}` : '—'} sub="Pivot R1" valClass="dn" />
          </div>

          {/* Trade setup */}
          {r.tech.sl && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, marginBottom:10 }}>📐 Trade Setup</div>
              <div className="trade-setup">
                <div className="ts-box"><div className="ts-l">ENTRY</div><div className="ts-v" style={{ color:'#1d4ed8' }}>₹{fmt(r.tech.entry?.trigger || r.ltp)}</div><div className="ts-s" style={{ color:'#64748b', fontSize:8 }}>{r.tech.entry?.method}</div></div>
                <div className="ts-box"><div className="ts-l">STOP LOSS</div><div className="ts-v" style={{ color:'#dc2626' }}>₹{fmt(r.tech.sl)}</div><div className="ts-s" style={{ color:'#dc2626' }}>-{((r.ltp - r.tech.sl) / r.ltp * 100).toFixed(1)}%</div></div>
                <div className="ts-box"><div className="ts-l">TARGET (MOD)</div><div className="ts-v" style={{ color:'#16a34a' }}>₹{fmt(r.tech.target)}</div><div className="ts-s" style={{ color:'#16a34a' }}>R:R {r.tech.pot?.rr?.toFixed(1)}</div></div>
              </div>
              <div className="c-targets" style={{ marginTop:8 }}>
                <div className="tgt cons"><div className="tgt-l">CONSERVATIVE</div><div className="tgt-v">₹{fmt(r.tech.targets?.cons || 0)}</div></div>
                <div className="tgt mod"><div className="tgt-l">MODERATE</div><div className="tgt-v">₹{fmt(r.tech.targets?.mod  || 0)}</div></div>
                <div className="tgt agg"><div className="tgt-l">AGGRESSIVE</div><div className="tgt-v">₹{fmt(r.tech.targets?.agg  || 0)}</div></div>
              </div>
            </div>
          )}

          {/* Multi-timeframe */}
          {(r.tf30?.rsi || r.tf5?.rsi) && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, marginBottom:10 }}>📊 Multi-Timeframe</div>
              <div className="stats-g">
                {r.tech.rsi && <StatCard label="DAILY RSI"  value={r.tech.rsi?.toFixed(1)} sub="Daily"  valClass={r.tech.rsi < 40 ? 'up' : r.tech.rsi > 65 ? 'dn' : 'bl'} />}
                {r.tf30?.rsi && <StatCard label="30-MIN RSI" value={r.tf30.rsi.toFixed(1)} sub={`30-min · ${r.tf30.trend}`} valClass={r.tf30.trend === 'UP' ? 'up' : 'dn'} />}
                {r.tf5?.rsi  && <StatCard label="5-MIN RSI"  value={r.tf5.rsi.toFixed(1)}  sub={`5-min · ${r.tf5.trend}`}  valClass={r.tf5.trend  === 'UP' ? 'up' : 'dn'} />}
                {r.tf5?.vwap && <StatCard label="INTRA VWAP" value={`₹${fmt(r.tf5.vwap)}`} sub={r.ltp >= r.tf5.vwap ? 'Above VWAP ✅' : 'Below VWAP'} valClass={r.ltp >= r.tf5.vwap ? 'up' : 'dn'} />}
              </div>
              {r.marketCtx && (
                <div style={{ fontSize:10, fontWeight:700, color: r.marketCtx.neutral ? '#d97706' : r.marketCtx.bullish ? '#16a34a' : '#dc2626', marginTop:8, padding:'6px 10px', background: r.marketCtx.neutral ? '#fffbeb' : r.marketCtx.bullish ? '#f0fdf4' : '#fef2f2', borderRadius:6 }}>
                  Composite: {r.marketCtx.neutral ? '↔ NEUTRAL' : r.marketCtx.bullish ? '📈 BULLISH' : '📉 BEARISH'} ({r.marketCtx.compositeScore > 0 ? '+' : ''}{r.marketCtx.compositeScore})
                  {r.marketCtx.momentumFresh && ' · 🔥 Momentum Fresh'}
                  {r.marketCtx.emaCross !== 'no_cross' && ` · EMA: ${r.marketCtx.emaCross?.replace('_', ' ')}`}
                </div>
              )}
            </div>
          )}

          {/* FII/DII */}
          {fiiInterp && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:9, padding:'10px 14px', marginBottom:12 }}>
              <div style={{ fontSize:9, color:'#94a3b8', marginBottom:3 }}>FII/DII BIAS</div>
              <div style={{ fontSize:13, fontWeight:800, color:fiiInterp.color }}>{fiiInterp.label}</div>
              <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>{fiiInterp.detail}</div>
            </div>
          )}

          {/* F&O section */}
          {r.foData && !r.foData.error && (
            <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:14, marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, marginBottom:10 }}>
                ⚡ F&O Options — {r.foData.picks.filter(p => p.trendAligned).length} with-trend · {r.foData.picks.length} total · Exp {r.foData.expiry}
              </div>
              <div className="stats-g" style={{ marginBottom:10 }}>
                {r.foData.maxPain > 0 && <StatCard label="MAX PAIN" value={`₹${fmt(r.foData.maxPain)}`} valClass="pu" />}
                {r.foData.oiWalls?.callWall > 0 && <StatCard label="CALL WALL" value={`₹${fmt(r.foData.oiWalls.callWall)}`} valClass="dn" />}
                {r.foData.oiWalls?.putWall  > 0 && <StatCard label="PUT WALL"  value={`₹${fmt(r.foData.oiWalls.putWall)}`}  valClass="up" />}
                <StatCard label="PCR" value={(r.foData.pcr || 0).toFixed(2)} sub={r.foData.pcr > 1.2 ? 'Bearish hedging' : 'Put-Call ratio'} valClass={r.foData.pcr > 1.2 ? 'dn' : 'up'} />
              </div>
              {/* With-trend picks */}
              {r.foData.picks.filter(p => p.trendAligned).length > 0 && (
                <>
                  <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:6, padding:'6px 10px', marginBottom:8, fontSize:10, fontWeight:700, color:'#15803d' }}>
                    ✅ {r.foData.picks.filter(p => p.trendAligned).length} WITH-TREND signals
                  </div>
                  {r.foData.picks.filter(p => p.trendAligned).slice(0, 3).map((pick, i) => (
                    <div key={i} style={{ marginBottom:12 }}>
                      <div style={{ background: pick.type === 'CE' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${pick.type === 'CE' ? '#86efac' : '#fca5a5'}`, borderRadius:10, padding:12, marginBottom:6 }}>
                        <div style={{ fontWeight:800, fontSize:14, marginBottom:6 }}>{pick.und} {pick.strike} {pick.type} · ₹{fmt(pick.entry)} · {pick.confidence}% conf</div>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4, background:'#e2e8f0', borderRadius:7, padding:1, marginBottom:8 }}>
                          {[{l:'ENTRY',v:`₹${fmt(pick.entry)}`,c:'#1d4ed8'},{l:'SL',v:`₹${fmt(pick.sl)}`,c:'#dc2626'},{l:'TARGET',v:`₹${fmt(pick.tgt)}`,c:'#16a34a'}].map(b=>(
                            <div key={b.l} style={{ background:'#f8fafc', padding:'6px 8px', textAlign:'center' }}>
                              <div style={{ fontSize:7, color:'#64748b' }}>{b.l}</div>
                              <div style={{ fontSize:13, fontWeight:800, color:b.c }}>{b.v}</div>
                            </div>
                          ))}
                        </div>
                        <PositionSizing pick={pick} portSize={cfg.portSize} riskPct={cfg.riskPct} />
                        <PayoffCalc pick={pick} />
                      </div>
                    </div>
                  ))}
                </>
              )}
              {r.foData.picks.length === 0 && (
                <div style={{ fontSize:11, color:'#64748b', padding:8 }}>No signals meet confidence ≥{cfg.minOptConf}%. Lower Options Min Confidence in ⚙ Settings.</div>
              )}

              {/* Multi-expiry comparison */}
              {r.foData.multiExpiry && (
                <div style={{ marginTop:12, background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:12 }}>
                  <div style={{ fontSize:10, fontWeight:800, marginBottom:8 }}>📅 MULTI-EXPIRY COMPARISON · ATM {r.foData.multiExpiry.atm}</div>
                  {['CE', 'PE'].map(side => {
                    const me = r.foData.multiExpiry;
                    const cur = me[side.toLowerCase()].cur, nxt = me[side.toLowerCase()].nxt;
                    const costDiff = nxt.ltp > 0 && cur.ltp > 0 ? +((nxt.ltp - cur.ltp) / cur.ltp * 100).toFixed(0) : null;
                    return (
                      <div key={side} style={{ marginBottom:8 }}>
                        <div style={{ fontSize:9, fontWeight:700, color:'#374151', marginBottom:4 }}>{side === 'CE' ? '📈' : '📉'} ATM {side} {me.atm}</div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
                          <div style={{ background:'#f0f9ff', border:'1px solid #bae6fd', borderRadius:6, padding:'6px 8px' }}>
                            <div style={{ fontSize:7, color:'#0369a1', fontWeight:700 }}>CURRENT · {me.expiry} · {me.dteCur}d</div>
                            <div style={{ fontSize:14, fontWeight:800, color:'#1e40af' }}>₹{fmt(cur.ltp)}</div>
                            <div style={{ fontSize:8, color:'#64748b' }}>IV {cur.iv?.toFixed(1)}% · Δ{Math.abs(cur.delta).toFixed(2)} · Θ{cur.theta?.toFixed(1)}</div>
                          </div>
                          <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:6, padding:'6px 8px' }}>
                            <div style={{ fontSize:7, color:'#64748b', fontWeight:700 }}>NEXT · {me.nextExp} · {me.dteNxt}d</div>
                            <div style={{ fontSize:14, fontWeight:800, color:'#374151' }}>₹{fmt(nxt.ltp)}</div>
                            <div style={{ fontSize:8, color:'#64748b' }}>IV {nxt.iv?.toFixed(1)}% · Δ{Math.abs(nxt.delta).toFixed(2)} · Θ{nxt.theta?.toFixed(1)}</div>
                            {costDiff !== null && <div style={{ fontSize:7, color: costDiff > 0 ? '#dc2626' : '#16a34a', fontWeight:600 }}>{costDiff > 0 ? '+' : ''}{costDiff}% vs current</div>}
                          </div>
                        </div>
                        <div style={{ fontSize:8, color:'#64748b', marginTop:3, padding:'4px 6px', background:'#fffbeb', borderRadius:4 }}>
                          💡 {side === 'CE'
                            ? (cur.ltp > 0 && nxt.ltp > 0 ? `Current week cheaper by ₹${fmt(nxt.ltp - cur.ltp)} but ${me.dteCur}d less time. ${me.dteCur <= 3 ? 'High gamma risk — expires soon.' : 'Reasonable for intraday swing.'}` : 'Comparison unavailable')
                            : (cur.ltp > 0 && nxt.ltp > 0 ? `Next week gives ${me.dteNxt - me.dteCur} more days for ₹${fmt(nxt.ltp - cur.ltp)} extra premium.` : 'Comparison unavailable')}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {r.foData?.error && (
            <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8, padding:10, marginBottom:12, fontSize:11, color:'#dc2626' }}>
              Options error: {r.foData.error}
            </div>
          )}

          <div className="disc">⚠ Analysis for educational purposes only. Not SEBI-registered advice. Always DYODD.</div>
        </div>
      )}

      {!r && !loading && !error && (
        <EmptyState>🔍 Enter a stock symbol above to get full professional analysis including F&O options</EmptyState>
      )}
    </div>
  );
}

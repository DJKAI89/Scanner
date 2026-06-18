import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, EmptyState } from '../components/common.jsx';
import LiveChart from '../components/LiveChart';
import { fetchQ, fetchCandles, fetchIntraday, fetchOptions, fetchOptionContracts } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';
import {
  calcRSI, calcEMACrossover, calcATR, calcBBSqueeze, calcSR, calcVWAP,
  detectPatterns, calcRisk, calcPotential, calcConfidence, countIndicatorsEx,
  getRec, autoSLTarget, calcEntryTrigger, detectReversal, calcMACD,
  isNearSupport, calcRSIDivergence, getSignalStrength,
  calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain,
  applyFIIBias, calcVolumeSurge, calcEMA,
} from '../services/technical';
import { fmt, fmtVol } from '../utils/formatters';
import { getIST, getISTDate, sleep, localIsOpen } from '../utils/marketTime';
import { QUICK_STOCKS } from '../constants/config';
import {
  AccentCard, Tag, RecPill, LevelsStrip, Banner, FooterNote,
} from '../components/cardKit';

// ── SectionCard — accent-header card shell, consistent with Analysis/Stocks pages ──
function SectionCard({ title, accent = '#16a34a', right, children }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14,
      overflow: 'hidden', marginBottom: 12, boxShadow: '0 1px 4px rgba(0,0,0,.04)',
    }}>
      <div style={{
        padding: '10px 14px 9px', borderBottom: `1px solid ${accent}33`,
        background: `linear-gradient(90deg, ${accent}14, #ffffff)`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div style={{ width: 3, height: 14, borderRadius: 2, background: accent, flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 800, color: '#0f172a', letterSpacing: 0.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
        </div>
        {right}
      </div>
      <div style={{ padding: '13px 14px' }}>{children}</div>
    </div>
  );
}

// ── LookupChartPopup — full-screen bottom-sheet popup, matching Stocks/Picks chart popup ──
function LookupChartPopup({ r, onClose }) {
  if (!r) return null;
  const chgColor = (r.chgPct || 0) >= 0 ? '#16a34a' : '#dc2626';
  const recColors = { 'STRONG BUY':'#16a34a', BUY:'#22c55e', MODERATE:'#0ea5e9', WATCH:'#d97706', AVOID:'#dc2626' };
  const rec = r.tech?.rec;
  const recColor = recColors[rec] || '#64748b';

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', backdropFilter: 'blur(2px)' }}
    >
      <div style={{ background: '#fff', width: '100%', maxHeight: '92dvh', borderRadius: '18px 18px 0 0', overflowY: 'auto', padding: '0 0 24px', boxShadow: '0 -8px 32px rgba(0,0,0,0.2)', animation: 'slideUp .22s ease' }}>
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: '#e2e8f0' }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 16px 12px' }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: '#0f172a', lineHeight: 1.1 }}>{r.inst?.s}</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{r.inst?.n || r.inst?.s} · {r.inst?.sec || 'NSE'}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#0f172a' }}>₹{fmt(r.ltp)}</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: chgColor }}>{(r.chgPct||0)>=0?'+':''}{r.chgPct.toFixed(2)}%</div>
            {rec && <div style={{ fontSize: 10, fontWeight: 800, color: recColor }}>{rec} · {r.tech?.numInds || 0} ind</div>}
          </div>
        </div>

        {/* Live chart — auto-loads historicals + live ticks */}
        <div style={{ padding: '0 12px', marginBottom: 12 }}>
          <LiveChart
            instrKey={r.inst?.key || ''}
            candles={[]}
            entry={r.tech?.entry?.trigger || r.ltp}
            sl={r.tech?.sl}
            target={r.tech?.target}
            symbol={r.inst?.s || ''}
            livePrice={r.ltp}
            liveChgPct={r.chgPct}
          />
        </div>

        {/* Trade setup */}
        {r.tech?.sl > 0 && (
          <div style={{ padding: '0 12px', marginBottom: 12 }}>
            <LevelsStrip
              entry={fmt(r.tech?.entry?.trigger || r.ltp)}
              sl={fmt(r.tech?.sl)}
              target={fmt(r.tech?.target)}
              entrySub={r.tech?.entry?.method}
              tgtSub={r.tech?.pot?.rr ? `R:R ${Number(r.tech.pot.rr).toFixed(1)}:1` : null}
            />
          </div>
        )}

        {/* Close button */}
        <div style={{ padding: '0 12px' }}>
          <button onClick={onClose} style={{ width: '100%', padding: '13px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 800, cursor: 'pointer' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

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
    <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:9, padding:'9px 11px', marginBottom:8 }}>
      <div style={{ fontSize:8.5, color:'#64748b', fontWeight:800, letterSpacing:.3, marginBottom:6 }}>PAYOFF CALCULATOR</div>
      {scenarios.map((s) => (
        <div key={s.pct} style={{ display:'flex', justifyContent:'space-between', padding:'3px 6px' }}>
          <span style={{ fontSize:9.5, color:'#374151', fontWeight:600 }}>{s.pct > 0 ? '+' : ''}{s.pct}%</span>
          <span style={{ fontSize:9.5, fontWeight:700, color:s.pnlPct >= 0 ? '#16a34a' : '#dc2626' }}>
            ₹{fmt(s.newPrem)} {s.pnlPct !== 0 ? `(${s.pnlPct > 0 ? '+' : ''}${s.pnlPct}%)` : ''}
          </span>
        </div>
      ))}
      <div style={{ display:'flex', justifyContent:'space-between', marginTop:6, paddingTop:6, borderTop:'1px solid #e2e8f0', fontSize:8.5, color:'#64748b' }}>
        <span>Break-even ₹{fmt(beSpot, 0)}</span>
        <span>{bePct}% move needed</span>
        <span>Theta -₹{thetaAbs.toFixed(2)}/day</span>
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
    <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:9, padding:'9px 11px', marginBottom:8 }}>
      <div style={{ fontSize:8.5, color:'#64748b', fontWeight:800, letterSpacing:.3, marginBottom:4 }}>POSITION SIZING</div>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ fontSize:17, fontWeight:800, color:'#1d4ed8' }}>{recLots} lot{recLots > 1 ? 's' : ''}</div>
        <div style={{ textAlign:'right', fontSize:10.5, color:'#64748b', lineHeight:1.6 }}>
          <b style={{ color:'#0f172a' }}>Capital</b> ₹{fmt(recCapital, 0)}<br />
          <b style={{ color:'#0f172a' }}>Risk cap</b> ₹{fmt(maxRisk, 0)}
        </div>
      </div>
    </div>
  );
}

function OptionSuggestionCard({ pick, cfg, showTools = true }) {
  const isBuy  = pick.action === 'BUY';
  const isSell = pick.action === 'SELL';
  const dir    = isBuy ? 'bull' : isSell ? 'bear' : 'neutral';
  // For SELL: SL is above entry, target is below — swap colors/labels
  const slSub  = pick.entry > 0 ? `${isBuy ? '-' : '+'}${((Math.abs(pick.sl - pick.entry)/pick.entry)*100).toFixed(1)}%` : null;
  const tgtSub = pick.entry > 0 ? `${isBuy ? '+' : '-'}${((Math.abs(pick.tgt - pick.entry)/pick.entry)*100).toFixed(1)}%` : null;

  return (
    <AccentCard dir={dir} style={{ marginBottom: 10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8, marginBottom:8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight:800, fontSize:14.5, color:'#0f172a' }}>{pick.und} {pick.strike} {pick.type}</div>
          <div style={{ fontSize:10, color:'#64748b', marginTop:2 }}>
            ₹{fmt(pick.entry)} entry · Exp {pick.expiry || '—'} · Lot {pick.lot || 1}
          </div>
        </div>
        <RecPill label={`${pick.action || 'BUY'} ${pick.type}`} dir={dir} />
      </div>

      <div style={{ marginBottom: 8 }}>
        <Tag tone={pick.confidence >= 70 ? 'green' : pick.confidence >= 50 ? 'amber' : 'red'}>
          {pick.confidence}% confidence
        </Tag>
      </div>

      <LevelsStrip
        entry={fmt(pick.entry)}
        sl={fmt(pick.sl)}
        target={fmt(pick.tgt)}
        slSub={slSub}
        tgtSub={tgtSub}
      />

      {/* R:R and capital */}
      <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom: pick.trendAligned !== undefined || showTools ? 8 : 0 }}>
        {pick.rr > 0 && <Tag tone="purple">R:R {Number(pick.rr).toFixed(1)}:1</Tag>}
        {pick.amtRequired > 0 && <Tag tone="blue">Capital ₹{fmt(pick.amtRequired,0)}</Tag>}
        {pick.maxLoss > 0 && <Tag tone="red">Max Loss ₹{fmt(Math.abs(pick.maxLoss),0)}</Tag>}
        {pick.maxProfit > 0 && <Tag tone="green">Max Profit ₹{fmt(pick.maxProfit,0)}</Tag>}
      </div>

      {/* Trend alignment */}
      {pick.trendAligned !== undefined && (
        <Banner
          tone={pick.trendAligned ? 'green' : 'amber'}
          icon={pick.trendAligned ? '✅' : '⚠'}
          title={pick.trendAligned ? 'With Market Trend' : 'Against Market Trend — lower confidence'}
        />
      )}

      {showTools && <PositionSizing pick={pick} portSize={cfg.portSize} riskPct={cfg.riskPct} />}
      {showTools && <PayoffCalc pick={pick} />}
    </AccentCard>
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
  const [chartOpen, setChartOpen] = useState(false);

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
      const chgPts  = live.changeAmt;
      const chgPct  = prevClose > 0 ? (chgPts / prevClose) * 100 : 0;
      return {
        ...prev,
        q: { ...prev.q, last_price: live.ltp },
        ltp: live.ltp,
        chgPts,
        chgPct,
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
    setChartOpen(false);
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
      const chgPts = q.net_change != null ? +q.net_change : ltp - (q.ohlc?.close || ltp);
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
      let intraData = null;
      setProgress('Loading intraday candles...');
      try {
        // Always try intraday — if market closed, fetchIntraday returns [] safely
        const c5 = await fetchIntraday(inst.key, '5minute', token, onTokenExpired);
        if (c5.length >= 3) {
          const c5chron = [...c5].reverse();
          const cl5     = c5chron.map(c => +c[4]);

          // EMA momentum
          const ema5v   = calcEMA(cl5, 5);
          const ema13v  = calcEMA(cl5, 13);
          const emaBull = ema5v[ema5v.length-1] != null && ema13v[ema13v.length-1] != null
            ? ema5v[ema5v.length-1] > ema13v[ema13v.length-1] : null;
          const accel   = ema5v.length >= 2 && ema5v[ema5v.length-1] > ema5v[ema5v.length-2];

          // Volume
          const curVol  = +(c5chron[c5chron.length-1]?.[5] || 0);
          const avgVol  = c5chron.length > 5
            ? c5chron.slice(0,-1).reduce((s,c)=>s+(+c[5]||0),0) / (c5chron.length-1) : 0;
          const volRatio = avgVol > 0 ? +(curVol/avgVol).toFixed(2) : null;

          // VWAP
          const vwap5   = calcVWAP(c5);
          const aboveVWAP = vwap5 ? ltp >= vwap5 : null;

          // Intraday high/low vs PDH/PDL
          const intraHi  = Math.max(...c5chron.map(c => +c[2]));
          const intraLo  = Math.min(...c5chron.map(c => +c[3]));

          tf5 = { rsi:calcRSI(cl5), vwap:vwap5, trend:cl5[cl5.length-1]>cl5[0]?'UP':'DOWN',
            volRatio, emaBull, accelerating:accel };
          intraData = { volRatio, emaBull, accelerating:accel, aboveVWAP, vwap:vwap5,
            intraHi, intraLo, curVol, avgVol };
          marketCtx = computeCtxFromCandles(c5, ltp, chgPct, 0, null);
        }
      } catch (e) { lg('Intraday fetch: ' + e.message, 'w'); }

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

      setResult({ inst, q, ltp, chgPct, chgPts, tech, tf30, tf5, marketCtx, foData, intraData, time:getIST() });
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
      <div className="lookup-search-row">
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

      <div className="lookup-quick-stocks">
        {QUICK_STOCKS.map((s) => <button key={s} className="lkp-q" onClick={() => lookup(s)}>{s}</button>)}
      </div>

      {error && <ErrorBanner title="Lookup Error" message={error} onRetry={() => lookup()} />}
      {loading && <Spinner label={'Analysing ' + sym + '...'} progress={progress} sub="Quote · Candles · Intraday · Indicators · Options chain" />}

      {r && !loading && (
        <div>
          {/* Hero card */}
          <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:14, padding:16, marginBottom:12, boxShadow:'0 1px 4px rgba(0,0,0,.04)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                  <span style={{ fontSize:21, fontWeight:900, color:'#0f172a', letterSpacing:-0.3 }}>{r.inst?.s}</span>
                  <button
                    onClick={() => setChartOpen(true)}
                    style={{ fontSize:9.5, color:'#1d4ed8', fontWeight:700, background:'#eff6ff', border:'1px solid #bfdbfe', padding:'3px 9px', borderRadius:7, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:3 }}
                  >
                    📊 Chart
                  </button>
                </div>
                <div style={{ fontSize:11, color:'#64748b', marginTop:3 }}>{r.inst?.n} · {r.inst?.sec} {r.inst?.fo ? '· F&O' : ''}</div>
                <div style={{ fontSize:9, color:'#94a3b8', marginTop:5, display:'flex', alignItems:'center', gap:5 }}>
                  <span>Updated {r.time}</span>
                  {activeKey.length > 0 && (
                    <>
                      <span>·</span>
                      <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
                        <span style={{ width:5, height:5, borderRadius:'50%', background: liveConnected ? '#16a34a' : '#cbd5e1', flexShrink:0 }} />
                        {liveConnected ? (liveMode === 'ws' ? 'Live WS' : 'Live Poll') : 'Static'}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:25, fontWeight:900, color:r.chgPct >= 0 ? '#16a34a' : '#dc2626', letterSpacing:-0.5 }}>₹{fmt(r.ltp)}</div>
                <div style={{ fontSize:13, fontWeight:700, color:r.chgPct >= 0 ? '#16a34a' : '#dc2626' }}>
                  {r.chgPts != null ? (r.chgPts >= 0 ? '+' : '') + fmt(r.chgPts) : (r.chgPct >= 0 ? '+' : '') + r.chgPct.toFixed(2) + '%'}
                  {' '}
                  <span style={{ fontSize:10, fontWeight:600, opacity:.8 }}>({r.chgPct >= 0 ? '+' : ''}{r.chgPct.toFixed(2)}%)</span>
                </div>
              </div>
            </div>
            {r.q.volume > 0 && (
              <div style={{ fontSize:9.5, color:'#94a3b8', marginTop:9, paddingTop:9, borderTop:'1px solid #f1f5f9' }}>
                Vol {fmtVol(r.q.volume)} · Avg20 {fmtVol(r.tech?.avgVol || 0)} · {(r.tech?.volRatio || 1).toFixed(1)}× avg
              </div>
            )}
          </div>

          {/* Recommendation banner */}
          {r.tech?.rec && (
            <div style={{
              background: recBg[r.tech.rec] || '#fffbeb',
              border: `1px solid ${(recColors[r.tech.rec] || '#d97706')}55`,
              borderLeft: `4px solid ${recColors[r.tech.rec] || '#d97706'}`,
              borderRadius: 10, padding: '13px 15px', marginBottom: 12,
            }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:6 }}>
                <div style={{ fontWeight:900, fontSize:18, color:recColors[r.tech.rec] || '#d97706', letterSpacing:-0.3 }}>{r.tech.rec}</div>
                <div style={{ fontSize:10.5, fontWeight:700, color:r.tech.strength?.color }}>{r.tech.strength?.label} · {r.tech.numInds} indicators · {r.tech.conf?.toFixed(0)}% conf</div>
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

          {/* Trade setup */}
          {r.tech.sl > 0 && (
            <SectionCard title="Trade Setup" accent="#16a34a">
              <LevelsStrip
                entry={fmt(r.tech.entry?.trigger || r.ltp)}
                sl={fmt(r.tech.sl)}
                target={fmt(r.tech.target)}
                entrySub={r.tech.entry?.method}
                tgtSub={r.tech.pot?.rr ? `R:R ${r.tech.pot.rr.toFixed(1)}:1` : null}
              />
            </SectionCard>
          )}

          {/* Key technical levels */}
          <SectionCard title="Technical Levels" accent="#0ea5e9">
            <div className="stats-g" style={{ marginBottom: 0 }}>
              <StatCard label="RSI (14)" value={r.tech.rsi?.toFixed(1) || '—'} sub={r.tech.rsi < (cfg.rsiOS||35) ? 'Oversold' : r.tech.rsi > (cfg.rsiOB||65) ? 'Overbought' : 'Neutral'} valClass={r.tech.rsi < (cfg.rsiOS||35) ? 'up' : r.tech.rsi > (cfg.rsiOB||65) ? 'dn' : 'bl'} />
              <StatCard label="ATR" value={`₹${fmt(r.tech.atr || 0)}`} sub="14-day volatility" valClass="am" />
              <StatCard label="MA50" value={r.tech.ema?.e50 ? `₹${fmt(r.tech.ema.e50)}` : '—'} sub={r.tech.a50 ? 'Above' : r.tech.a50 === false ? 'Below' : 'N/A'} valClass={r.tech.a50 ? 'up' : 'dn'} />
              <StatCard label="MA200" value={r.tech.ema?.e200 ? `₹${fmt(r.tech.ema.e200)}` : '—'} sub={r.tech.a200 ? 'Above' : r.tech.a200 === false ? 'Below' : 'Need 200d'} valClass={r.tech.a200 ? 'up' : 'dn'} />
              <StatCard label="SUPPORT" value={r.tech.sr?.pivotS1 ? `₹${fmt(r.tech.sr.pivotS1)}` : '—'} sub="Pivot S1" valClass="up" />
              <StatCard label="RESISTANCE" value={r.tech.sr?.pivotR1 ? `₹${fmt(r.tech.sr.pivotR1)}` : '—'} sub="Pivot R1" valClass="dn" />
            </div>
          </SectionCard>

          {(r.tf30?.rsi || r.tf5?.rsi) && (
            <SectionCard title="Multi-Timeframe Analysis" accent="#7c3aed">
              <div className="stats-g" style={{ marginBottom: 0 }}>
                {r.tech.rsi && <StatCard label="DAILY RSI" value={r.tech.rsi?.toFixed(1)} sub="Daily" valClass={r.tech.rsi < (cfg.rsiOS||35) ? 'up' : r.tech.rsi > (cfg.rsiOB||65) ? 'dn' : 'bl'} />}
                {r.tf30?.rsi && <StatCard label="30-MIN RSI" value={r.tf30.rsi.toFixed(1)} sub={`30m · ${r.tf30.trend}`} valClass={r.tf30.trend === 'UP' ? 'up' : 'dn'} />}
                {r.tf5?.rsi && <StatCard label="5-MIN RSI" value={r.tf5.rsi.toFixed(1)} sub={`5m · ${r.tf5.trend}`} valClass={r.tf5.trend === 'UP' ? 'up' : 'dn'} />}
                {r.tf5?.vwap && <StatCard label="INTRA VWAP" value={`₹${fmt(r.tf5.vwap)}`} sub={r.ltp >= r.tf5.vwap ? '▲ Above VWAP' : '▼ Below VWAP'} valClass={r.ltp >= r.tf5.vwap ? 'up' : 'dn'} />}
                {r.tf5?.volRatio != null && <StatCard label="INTRA VOL" value={`${r.tf5.volRatio}×`} sub="vs avg 5m candle" valClass={r.tf5.volRatio >= 2 ? 'up' : r.tf5.volRatio >= 1.5 ? 'am' : 'dn'} />}
                {r.tf5?.emaBull != null && <StatCard label="5M EMA" value={r.tf5.emaBull ? '▲ Bull' : '▼ Bear'} sub="EMA 5 vs 13" valClass={r.tf5.emaBull ? 'up' : 'dn'} />}
              </div>

              {/* Intraday signal tags */}
              {r.intraData && (r.intraData.volRatio >= 1.5 || r.intraData.emaBull != null || r.intraData.accelerating) && (
                <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginTop:10 }}>
                  {r.intraData.volRatio >= 2 && <Tag tone="purple">🔥 Volume surge {r.intraData.volRatio}× intraday</Tag>}
                  {r.intraData.volRatio >= 1.5 && r.intraData.volRatio < 2 && <Tag tone="blue">📊 Elevated intraday volume {r.intraData.volRatio}×</Tag>}
                  {r.intraData.emaBull && <Tag tone="green">⚡ 5m EMA bullish trend</Tag>}
                  {r.intraData.accelerating && <Tag tone="amber">🚀 Intraday momentum accelerating</Tag>}
                  {r.intraData.aboveVWAP && <Tag tone="green">↑ Above VWAP ₹{r.intraData.vwap?.toFixed(1)}</Tag>}
                  {r.intraData.aboveVWAP === false && <Tag tone="red">↓ Below VWAP ₹{r.intraData.vwap?.toFixed(1)}</Tag>}
                </div>
              )}
            </SectionCard>
          )}

          {fiiInterp && (
            <SectionCard title="FII / DII Bias" accent="#0ea5e9">
              <div style={{ fontSize:14, fontWeight:800, color:fiiInterp.color }}>{fiiInterp.label}</div>
              <div style={{ fontSize:10.5, color:'#64748b', marginTop:3 }}>{fiiInterp.detail}</div>
            </SectionCard>
          )}

          {r.foData && !r.foData.error && (
            <SectionCard
              title={r.foData.unsupported
                ? 'Options Suggestions'
                : r.foData.empty
                  ? `Options Suggestions · Exp ${r.foData.expiry}`
                  : `Options Suggestions · Exp ${r.foData.expiry}`}
              accent="#d97706"
              right={!r.foData.unsupported && !r.foData.empty ? (
                <Tag tone="slate">{r.foData.picks.filter((p) => p.trendAligned).length} with-trend · {r.foData.picks.length} total</Tag>
              ) : null}
            >
              {r.foData.unsupported && (
                <div style={{ fontSize:11, color:'#64748b', padding:8 }}>No options contracts found for {r.inst?.s} on NSE.</div>
              )}

              {r.foData.empty && (
                <div style={{ fontSize:11, color:'#64748b', padding:8 }}>Options chain is empty for {r.inst?.s}. Market may be closed or chain data is not populated yet.</div>
              )}

              {!r.foData.unsupported && !r.foData.empty && (
                <>
                  <div className="stats-g" style={{ marginBottom:10 }}>
                    {r.foData.maxPain > 0 && <StatCard label="MAX PAIN" value={`₹${fmt(r.foData.maxPain)}`} valClass="pu" />}
                    {r.foData.oiWalls?.callWall > 0 && <StatCard label="CALL WALL" value={`₹${fmt(r.foData.oiWalls.callWall)}`} valClass="dn" />}
                    {r.foData.oiWalls?.putWall > 0 && <StatCard label="PUT WALL" value={`₹${fmt(r.foData.oiWalls.putWall)}`} valClass="up" />}
                    <StatCard label="PCR" value={(r.foData.pcr || 0).toFixed(2)} sub={r.foData.pcr > 1.2 ? 'Bearish hedging' : 'Put-Call ratio'} valClass={r.foData.pcr > 1.2 ? 'dn' : 'up'} />
                  </div>

                  {r.foData.picks.filter((p) => p.trendAligned).length > 0 && (
                    <>
                      <Banner tone="green" icon="✅" title={`${r.foData.picks.filter((p) => p.trendAligned).length} WITH-TREND signals`} />
                      {r.foData.picks.filter((p) => p.trendAligned).slice(0, 3).map((pick, i) => <OptionSuggestionCard key={`wt-${i}`} pick={pick} cfg={cfg} />)}
                    </>
                  )}

                  {r.foData.picks.filter((p) => !p.trendAligned).length > 0 && (
                    <>
                      <Banner tone="amber" icon="⚠" title={`${r.foData.picks.filter((p) => !p.trendAligned).length} COUNTER-TREND signals`} />
                      {r.foData.picks.filter((p) => !p.trendAligned).slice(0, 3).map((pick, i) => <OptionSuggestionCard key={`ct-${i}`} pick={pick} cfg={cfg} />)}
                    </>
                  )}

                  {r.foData.picks.length === 0 && (
                    <div style={{ fontSize:11, color:'#64748b', padding:8 }}>No signals meet confidence ≥ {cfg.minOptConf}%. Lower Options Min Confidence in settings.</div>
                  )}

                  {r.foData.multiExpiry && (
                    <div style={{ marginTop:4, background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:11, padding:12 }}>
                      <div style={{ fontSize:9.5, fontWeight:800, color:'#374151', letterSpacing:.3, marginBottom:9 }}>MULTI-EXPIRY COMPARISON · ATM {r.foData.multiExpiry.atm}</div>
                      {['CE', 'PE'].map((side) => {
                        const me = r.foData.multiExpiry;
                        const cur = me[side.toLowerCase()].cur;
                        const nxt = me[side.toLowerCase()].nxt;
                        const costDiff = nxt.ltp > 0 && cur.ltp > 0 ? +((nxt.ltp - cur.ltp) / cur.ltp * 100).toFixed(0) : null;
                        return (
                          <div key={side} style={{ marginBottom:8 }}>
                            <div style={{ fontSize:9.5, fontWeight:700, color:'#374151', marginBottom:4 }}>{side} ATM {me.atm}</div>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
                              <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:'7px 9px' }}>
                                <div style={{ fontSize:7.5, color:'#1d4ed8', fontWeight:800, letterSpacing:.2 }}>CURRENT · {me.expiry} · {me.dteCur}d</div>
                                <div style={{ fontSize:14.5, fontWeight:800, color:'#1e40af', marginTop:1 }}>₹{fmt(cur.ltp)}</div>
                              </div>
                              <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:8, padding:'7px 9px' }}>
                                <div style={{ fontSize:7.5, color:'#64748b', fontWeight:800, letterSpacing:.2 }}>NEXT · {me.nextExp} · {me.dteNxt}d</div>
                                <div style={{ fontSize:14.5, fontWeight:800, color:'#0f172a', marginTop:1 }}>₹{fmt(nxt.ltp)}</div>
                                {costDiff !== null && <div style={{ fontSize:7.5, color:costDiff > 0 ? '#dc2626' : '#16a34a', fontWeight:700, marginTop:1 }}>{costDiff > 0 ? '+' : ''}{costDiff}% vs current</div>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </SectionCard>
          )}

          {r.foData?.error && (
            <Banner tone="red" icon="⛔" title="Options error" detail={r.foData.error} />
          )}

          <FooterNote>Analysis for educational purposes only. Not SEBI-registered advice. Always DYODD.</FooterNote>
        </div>
      )}

      {!r && !loading && !error && (
        <EmptyState>Enter a stock symbol above to get full analysis including option suggestions where available.</EmptyState>
      )}

      {chartOpen && <LookupChartPopup r={r} onClose={() => setChartOpen(false)} />}
    </div>
  );
}

import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, MarketClosedBanner, LastUpdated, StatCard, EmptyState } from '../components/common.jsx';
import { fetchQ, fetchOptions, fetchIntraday } from '../services/api';
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST, sleep } from '../utils/marketTime';
import { INDEX_OPTS } from '../constants/config';
import { calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain, applyFIIBias } from '../services/technical';
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
  { id:'sensex',label:'Sensex' },{ id:'finnifty',label:'FinNifty' },
  { id:'buy',label:'📈 BUY' },{ id:'sell',label:'📉 SELL' },
  { id:'aligned',label:'✅ With-Trend' },
];

function OptionCard({ pick }) {
  const isBuy = pick.action === 'BUY';
  const bg = isBuy ? '#f0fdf4' : '#fef2f2', bdr = isBuy ? '#16a34a' : '#dc2626';
  const slPct  = pick.entry > 0 ? ((pick.entry - pick.sl)  / pick.entry * 100).toFixed(1) : 0;
  const tgtPct = pick.entry > 0 ? ((pick.tgt  - pick.entry) / pick.entry * 100).toFixed(1) : 0;
  return (
    <div style={{ background:bg, border:`1.5px solid ${bdr}55`, borderRadius:11, padding:14, position:'relative', marginBottom:8 }}>
      <div style={{ position:'absolute', top:11, right:11, background:bdr, color:'#fff', fontSize:8, fontWeight:800, padding:'3px 8px', borderRadius:20 }}>
        {pick.action} {pick.type}
      </div>
      <div style={{ marginBottom:9, paddingRight:80 }}>
        <div style={{ fontSize:15, fontWeight:800 }}>{pick.und} {pick.strike} {pick.type}</div>
        <div style={{ fontSize:10, color:'#64748b' }}>Exp: {pick.expiry} · Lot: {pick.lot} · DTE {pick._dte ?? ''}</div>
        {pick.trendDir && <div style={{ fontSize:9, color:'#7c3aed', fontWeight:600 }}>{pick.trendDir} · Zone: {pick.priceZone}</div>}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4, marginBottom:8 }}>
        {[{l:'LTP',v:`₹${fmt(pick.entry||0)}`},{l:'DELTA',v:(pick.delta||0).toFixed(2)},{l:'IV %',v:`${(pick.iv||0).toFixed(1)}%`},{l:'CONF',v:`${pick.confidence||0}%`}]
          .map(m=>(
          <div key={m.l} style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:6, padding:'5px 7px' }}>
            <div style={{ fontSize:8, color:'#94a3b8', marginBottom:2 }}>{m.l}</div>
            <div style={{ fontSize:13, fontWeight:700 }}>{m.v}</div>
          </div>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4, background:'#e2e8f0', borderRadius:8, padding:1, marginBottom:8 }}>
        {[
          {l:'ENTRY', v:`₹${fmt(pick.entry||0)}`, c:'#1d4ed8', s:''},
          {l:pick.action==='SELL'?'SL (ABOVE)':'SL', v:`₹${fmt(pick.sl||0)}`, c:'#dc2626', s:pick.action==='BUY'?`-${slPct}%`:`+${slPct}%`},
          {l:'TARGET', v:`₹${fmt(pick.tgt||0)}`, c:'#16a34a', s:pick.action==='BUY'?`+${tgtPct}%`:`-${tgtPct}%`},
        ].map(b=>(
          <div key={b.l} style={{ background:'#f8fafc', padding:'7px 8px', textAlign:'center' }}>
            <div style={{ fontSize:7, color:'#64748b' }}>{b.l}</div>
            <div style={{ fontSize:13, fontWeight:800, color:b.c }}>{b.v}</div>
            {b.s && <div style={{ fontSize:8, color:b.c }}>{b.s}</div>}
          </div>
        ))}
      </div>

      {/* Signals */}
      {pick.signals?.length > 0 && (
        <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:6 }}>
          {pick.signals.map((s,i) => (
            <span key={i} style={{ fontSize:8, fontWeight:700, background:'#f0f9ff', color:'#0369a1', border:'1px solid #bae6fd', borderRadius:10, padding:'2px 6px' }}>{s.l}</span>
          ))}
        </div>
      )}

      {/* OI Build + IV Env */}
      {pick.oiBuildType && pick.oiBuildType !== 'NEUTRAL' && (
        <div style={{ fontSize:9, fontWeight:700, color: pick.oiBuildBonus > 0 ? '#16a34a' : '#dc2626', marginBottom:4 }}>
          OI: {pick.oiBuildType.replace('_', ' ')} {pick.oiBuildBonus > 0 ? `(+${pick.oiBuildBonus}pts)` : `(${pick.oiBuildBonus}pts)`}
          {pick.ivEnv && pick.ivEnv !== 'STABLE' && ` · IV: ${pick.ivEnv}`}
        </div>
      )}

      <div style={{ display:'flex', gap:8, fontSize:9, color:'#64748b', flexWrap:'wrap' }}>
        {pick.amtRequired > 0 && <span>💰 ₹{fmt(pick.amtRequired,0)}</span>}
        {pick.rr          > 0 && <span>⚖ R:R {pick.rr.toFixed(1)}</span>}
        {pick.maxLoss      != null && <span>Max Loss ₹{fmt(Math.abs(pick.maxLoss),0)}</span>}
        {pick.trendAligned && <span style={{ color:'#16a34a', fontWeight:700 }}>✅ With-Trend</span>}
        {!pick.trendAligned && <span style={{ color:'#d97706', fontWeight:700 }}>⚠ Counter-Trend</span>}
        {pick.nearMaxPain  && <span style={{ color:'#7c3aed', fontWeight:700 }}>🎯 MaxPain</span>}
      </div>
    </div>
  );
}

export default function OptionsPane() {
  const { token, cfg, marketStatus, lg, onTokenExpired, updateBadge, fiiInterp, fiiData, gh } = useApp();
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [groups, setGroups]     = useState([]);
  const [vix, setVix]           = useState(0);
  const [filter, setFilter]     = useState('all');
  const [progress, setProgress] = useState('');
  const [updTime, setUpdTime]   = useState('');
  const [marketCtxMap, setMarketCtxMap] = useState({});
  const prevAvgIVCache = useRef({}), prevPCRCache = useRef({});

  useEffect(() => { if (token && marketStatus.open) loadOptions(); }, [token]); // eslint-disable-line

  async function loadOptions(force = false) {
    if (loading && !force) return;
    setLoading(true); setError(''); setProgress('Step 1: Fetching Nifty direction + VIX...');
    try {
      // Step 1: index quotes + VIX
      const mktD = await fetchQ('NSE_INDEX|Nifty 50,NSE_INDEX|India VIX', token, onTokenExpired);
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
        try { idxCandles[key] = await fetchIntraday(key, '5minute', token, onTokenExpired); }
        catch (e) { idxCandles[key] = []; }
        await sleep(400);
      }

      // Compute per-index marketCtx
      const ctxMap = {};
      for (const idx of INDEX_OPTS) {
        const candles = idxCandles[idx.key] || [];
        const q2      = await fetchQ(idx.key, token, onTokenExpired).then(d => d[idx.key]).catch(() => null);
        if (!q2?.last_price) continue;
        const spotChg = getChgPct(q2);
        ctxMap[idx.name] = computeCtxFromCandles(candles, q2.last_price, spotChg, vixVal, null);
      }
      setMarketCtxMap(ctxMap);

      // Step 2: Scan each index
      const built = [];
      for (const [ui, idx] of INDEX_OPTS.entries()) {
        const q = await fetchQ(idx.key, token, onTokenExpired).then(d => d[idx.key]).catch(() => null);
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
            { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }
          ).then(r => r.json());
          expiry = (cd?.data?.map(e => e.expiry).sort() || [])[0] || '';
        } catch (e) { lg('Contract ' + idx.name + ': ' + e.message, 'w'); }
        if (!expiry) continue;

        // Full chain
        const chain = await fetchOptions(idx.key, expiry, token, onTokenExpired);
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
        })).filter(p => p.confidence >= cfg.minOptConf);

        lg(`${idx.name}: ${chain.length} strikes → ${picks.length} raw → ${picksWithFII.length} ≥${cfg.minOptConf}% | composite=${richCtx.compositeScore} pcr=${pcr}`, 'o');
        built.push({ name: idx.name, spot, spotChg, picks: picksWithFII, expiry, maxPain, oiWalls, pcr, pcrTrend, ivTrend });
      }

      setGroups(built);
      const withTrend = built.reduce((s, g) => s + g.picks.filter(p => p.trendAligned).length, 0);
      const total     = built.reduce((s, g) => s + g.picks.length, 0);
      updateBadge('options', withTrend > 0 ? withTrend + ' signals' : '—');
      setUpdTime('Updated: ' + getIST());
      const allPicks = built.flatMap(g => g.picks);
      if (allPicks.length) logSignals(gh, allPicks.map(p => buildOptionSignal(p, vixVal)), vixVal, lg);
      lg(`✅ Options: ${total} signals (${withTrend} with-trend)`, 'o');
    } catch (e) {
      setError(e.message); lg('Options error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }

  const { txt: vixTxt } = interpVIX(vix);
  const filtered = groups.map(g => ({
    ...g,
    picks: g.picks.filter(p => {
      if (filter === 'all')       return true;
      if (filter === 'nifty')     return g.name === 'NIFTY';
      if (filter === 'banknifty') return g.name === 'BANKNIFTY';
      if (filter === 'sensex')    return g.name === 'SENSEX';
      if (filter === 'finnifty')  return g.name === 'FINNIFTY';
      if (filter === 'buy')       return p.action === 'BUY';
      if (filter === 'sell')      return p.action === 'SELL';
      if (filter === 'aligned')   return p.trendAligned;
      return true;
    }),
  })).filter(g => g.picks.length > 0);

  return (
    <div>
      {!marketStatus.open && <MarketClosedBanner msg={marketStatus.msg || '🔔 NSE Market Closed'} />}
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
          <div className="stats-g">
            {groups.map(g => (
              <StatCard key={g.name} label={g.name} value={`₹${fmt(g.spot)}`} sub={fmtC(g.spotChg)} valClass={g.spotChg >= 0 ? 'up' : 'dn'} />
            ))}
            {vix > 0 && <StatCard label="INDIA VIX" value={vix.toFixed(2)} sub={vixTxt} valClass={vix < 16 ? 'up' : vix > 22 ? 'dn' : 'am'} />}
          </div>

          {/* Max Pain + OI Walls */}
          {groups.filter(g => g.maxPain > 0).map(g => (
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
                <div className="opt-group-hdr">{g.name} — ₹{fmt(g.spot)} ({fmtC(g.spotChg)}) · Exp: {g.expiry} · {g.picks.filter(p=>p.trendAligned).length} with-trend · {g.picks.length} total</div>
                {/* With-trend first */}
                {g.picks.filter(p=>p.trendAligned).length > 0 && (
                  <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:6, padding:'6px 10px', marginBottom:8, fontSize:10, fontWeight:700, color:'#15803d' }}>
                    ✅ {g.picks.filter(p=>p.trendAligned).length} WITH-TREND signals
                  </div>
                )}
                <div className="cards-g" style={{ marginBottom:8 }}>
                  {g.picks.filter(p=>p.trendAligned).map((p,i) => <OptionCard key={i} pick={p} />)}
                </div>
                {/* Counter-trend */}
                {g.picks.filter(p=>!p.trendAligned).length > 0 && (
                  <>
                    <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:6, padding:'6px 10px', marginBottom:8, fontSize:10, fontWeight:700, color:'#92400e' }}>
                      ⚠ {g.picks.filter(p=>!p.trendAligned).length} COUNTER-TREND — against market direction
                    </div>
                    <div className="cards-g" style={{ marginBottom:16 }}>
                      {g.picks.filter(p=>!p.trendAligned).map((p,i) => <OptionCard key={i} pick={p} />)}
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

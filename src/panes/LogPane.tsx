import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, EmptyState, StatCard } from '../components/common.jsx';
import { isBullSignal } from '../services/github';
import {
  getSignalFeedKey, loadSignalLog,
  resolveSignalsAgainstLivePrices, persistResolvedSignals, checkAllOutcomes as checkAllOutcomesService,
} from '../services/logService';
import { fmt, fmtWhen, fmtRs0 } from '../utils/formatters';
import { groupCorrelated } from '../utils/signalGroups';
import { getIST, getISTDate } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed.js';
import Icon from '../components/Icon.jsx';

const STATUS_COLORS = {
  OPEN:       { bg:'#eff6ff', color:'#1d4ed8', border:'#bfdbfe' },
  TARGET_HIT: { bg:'#f0fdf4', color:'#16a34a', border:'#86efac' },
  SL_HIT:     { bg:'#fef2f2', color:'#dc2626', border:'#fca5a5' },
  EXPIRED:    { bg:'#f8fafc', color:'#64748b', border:'#e2e8f0' },
};
const EXIT_REASON_LABELS = {
  TARGET:     { icon:'target',    text:'Target' },
  SL:         { icon:'cross',     text:'Stop loss' },
  TRAIL_STOP: { icon:'trendUp',   text:'Trail stop' },
  TIME_STOP:  { icon:'clock',     text:'Time stop' },
  EXPIRY:     { icon:null,        text:'⌛ Expired' },
};

function SignalRow({ sig, livePrice, marketOpen = true }) {
  const sc = STATUS_COLORS[sig.status] || STATUS_COLORS.OPEN;
  const isBuy  = isBullSignal(sig); // uses shared isBullSignal (handles BUY/SELL/CALL/PUT)
  const isOpt  = sig.type === 'OPTION';
  const ltp    = livePrice ?? null;
  const entry  = sig.entry  || 0;
  const partials = sig.partials || [];
  const hasHit = (level) => partials.some(p => p.level === level);
  // Effective SL — trailing stop once break-even/partial-exit has activated
  const effSL  = sig.trailSL ?? sig.sl ?? 0;
  // Next unhit target — T1 → T2 → T3, falling back to legacy single target
  const nextTarget = !hasHit('T1') ? { v: sig.targetT1 || sig.target, l: 'T1' }
                    : !hasHit('T2') ? { v: sig.targetT2 || sig.target, l: 'T2' }
                    : { v: sig.targetT3 || sig.target, l: 'T3' };
  const tgtVal = nextTarget.v || sig.target || 0;

  // Live P&L
  const pnlPct = ltp && entry
    ? +((ltp - entry) / entry * 100).toFixed(2)
    : (sig.pnlPct ?? null);

  // Target progress % (how far from entry to next target)
  const totalMove  = Math.abs(tgtVal - entry);
  const actualMove = ltp ? (isBuy ? ltp - entry : entry - ltp) : 0;
  const toPct = ltp && totalMove > 0
    ? Math.round(Math.max(-50, Math.min(120, actualMove / totalMove * 100)))
    : null;

  // SL distance % (vs effective/trailing SL)
  const slDist = ltp && entry && effSL
    ? +((isBuy ? ltp - effSL : effSL - ltp) / entry * 100).toFixed(1)
    : null;

  // Flash on price change
  const prevLtp = useRef(ltp);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (!ltp || ltp === prevLtp.current) return;
    setFlash(ltp > prevLtp.current ? 'flash-up' : 'flash-dn');
    prevLtp.current = ltp;
    const t = setTimeout(() => setFlash(''), 700);
    return () => clearTimeout(t);
  }, [ltp]);

  // What the position bets on, independent of BUY/SELL: a bought PUT (or sold CALL) is a bearish view.
  const isLong   = !/sell/i.test(String(sig.signal || sig.action || 'BUY'));
  const bullView = (sig.optType === 'CE') === isLong;
  const live     = !!marketOpen;
  const typeIcon = isOpt
    ? (sig.optType === 'CE' ? 'trendUp' : 'trendDown')
    : 'target';

  return (
    <div className={flash} style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:'12px 14px', marginBottom:8, transition:'background .3s', boxShadow:'var(--shadow-raised, 0 2px 8px rgba(15,23,42,.08))' }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:6, marginBottom:8 }}>
        <div>
          <span style={{ fontWeight:800, fontSize:14 }}><Icon name={typeIcon} size={13} style={{ marginRight:4 }}/>{sig.stock || sig.name}</span>
          {isOpt && (
            <span style={{ fontSize:9, background:'#e0e7ff', color:'#3730a3', borderRadius:4, padding:'1px 5px', marginLeft:6, fontWeight:700 }}>
              {sig.strike} {sig.optType} {sig.expiry}
            </span>
          )}
          {isOpt && (
            <span style={{ fontSize:9, fontWeight:800, marginLeft:6, padding:'1px 6px', borderRadius:4,
              background: bullView ? '#dcfce7' : '#fee2e2', color: bullView ? '#15803d' : '#b91c1c' }}>
              {bullView ? '▲' : '▼'} {sig.optType === 'CE' ? 'CALL' : 'PUT'} · {bullView ? 'bullish' : 'bearish'} view
            </span>
          )}
          {ltp && sig.status==='OPEN' && (
            live
              ? <span className="badge-live" style={{ marginLeft:6 }}>₹{fmt(ltp)}</span>
              : <span style={{ marginLeft:6, fontSize:10, fontWeight:700, color:'#64748b' }}>₹{fmt(ltp)} <span style={{ fontSize:8, fontWeight:600, color:'#94a3b8' }}>last</span></span>
          )}
        </div>
        <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
          <span style={{ fontSize:8, fontWeight:800, padding:'2px 8px', borderRadius:20, background:isBuy?'#dcfce7':'#fee2e2', color:isBuy?'#16a34a':'#dc2626' }}>
            {sig.signal}
          </span>
          <span style={{ fontSize:8, fontWeight:800, padding:'2px 8px', borderRadius:20, background:sc.bg, color:sc.color, border:`1px solid ${sc.border}` }}>
            {sig.status?.replace('_',' ')}
          </span>
        </div>
      </div>

      {/* Metrics */}
      <div style={{ display:'grid', gridTemplateColumns: isOpt && sig.capitalReq ? 'repeat(4,1fr)' : 'repeat(3,1fr)', gap:4, marginBottom:8 }}>
        {[
          { l:'ENTRY',  v: entry ? `₹${fmt(entry)}` : '—' },
          { l: sig.trailSL != null ? '🔒 TRAIL SL' : 'SL', v: effSL ? `₹${fmt(effSL)}` : '—' },
          { l:'CONF',   v: `${sig.confidence||0}%`          },
          // Estimated amount, based on entry price — BUY shows actual premium
          // paid (ltp x lot); SELL shows an approximate margin estimate, NOT
          // the premium received, since writing an option needs margin
          // collateral, not a premium outlay. Labeled distinctly so the two
          // aren't read as the same kind of number.
          ...(isOpt && sig.capitalReq ? [{ l: sig.capitalIsMargin ? 'EST. MARGIN' : 'EST. AMOUNT', v: fmtRs0(sig.capitalReq) }] : []),
        ].map(m => (
          <div key={m.l} style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:6, padding:'5px 7px' }}>
            <div style={{ fontSize:8, color:'#94a3b8', marginBottom:2, letterSpacing:.3 }}>{m.l}</div>
            <div style={{ fontSize:13, fontWeight:800 }}>{m.v}</div>
          </div>
        ))}
      </div>

      {/* T1/T2/T3 strip — always visible, hit levels checked off */}
      {(sig.targetT1 || sig.targetT2 || sig.targetT3 || sig.target) && (
        <div style={{ display:'flex', gap:4, marginBottom:8 }}>
          {[
            { l:'T1', v: sig.targetT1 || sig.target },
            { l:'T2', v: sig.targetT2 || sig.target },
            { l:'T3', v: sig.targetT3 || sig.target },
          ].map(t => {
            const hit = hasHit(t.l);
            const isNext = sig.status === 'OPEN' && t.l === nextTarget.l;
            return (
              <div key={t.l} style={{
                flex:1, textAlign:'center', borderRadius:6, padding:'4px 3px',
                background: hit ? '#f0fdf4' : isNext ? '#eff6ff' : '#f8fafc',
                border: isNext ? '2px solid #3b82f6' : `1px solid ${hit ? '#86efac' : '#e2e8f0'}`,
              }}>
                <div style={{ fontSize:7.5, fontWeight:800, color: hit ? '#16a34a' : isNext ? '#1d4ed8' : '#94a3b8' }}>{hit && <Icon name="check" size={8} style={{ marginRight:2 }}/>}{t.l}{isNext ? ' · NEXT' : ''}</div>
                <div style={{ fontSize:10.5, fontWeight:700, color: hit ? '#16a34a' : '#334155' }}>{t.v ? `₹${fmt(t.v)}` : '—'}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Partial exits + break-even badges */}
      {(partials.length > 0 || sig.beActive) && (
        <div style={{ display:'flex', gap:5, flexWrap:'wrap', marginBottom:8 }}>
          {sig.beActive && (
            <span style={{ fontSize:8, fontWeight:800, background:'#eff6ff', color:'#1d4ed8', border:'1px solid #bfdbfe', borderRadius:6, padding:'2px 7px' }}><Icon name="lock" size={9} style={{ marginRight:3 }}/><span>BE</span></span>
          )}
          {partials.map((p, i) => (
            <span key={i} style={{ fontSize:8, fontWeight:800, background:'#f0fdf4', color:'#16a34a', border:'1px solid #bbf7d0', borderRadius:6, padding:'2px 7px' }}>
              <Icon name="check" size={9} style={{ marginRight:3 }}/>{p.level} @ ₹{fmt(p.price)} ({p.pctClosed}%)
            </span>
          ))}
          {sig.remainingPct != null && sig.remainingPct < 100 && sig.status === 'OPEN' && (
            <span style={{ fontSize:8, fontWeight:800, background:'#fffbeb', color:'#92400e', border:'1px solid #fde68a', borderRadius:6, padding:'2px 7px' }}>
              {sig.remainingPct}% remaining
            </span>
          )}
        </div>
      )}

      {/* Live P&L + progress bar (OPEN signals with live price) */}
      {sig.status==='OPEN' && ltp != null && (
        <div style={{ background:(!live&&(pnlPct==null||pnlPct===0))?'#f8fafc':pnlPct!=null&&pnlPct>=0?'#f0fdf4':'#fef2f2', border:`1px solid ${(!live&&(pnlPct==null||pnlPct===0))?'#e2e8f0':pnlPct!=null&&pnlPct>=0?'#bbf7d0':'#fecaca'}`, borderRadius:8, padding:'9px 11px', marginBottom:8 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
            <div>
              <div style={{ fontSize:9, fontWeight:700, letterSpacing:.4, color:'#94a3b8' }}>{live ? 'LIVE P&L' : 'P&L AT LAST PRICE'}</div>
              <div style={{ fontSize:16, fontWeight:800, letterSpacing:-.3, color:(!live&&(pnlPct==null||pnlPct===0))?'#64748b':pnlPct!=null&&pnlPct>=0?'#16a34a':'#dc2626' }}>
                {pnlPct!=null ? (pnlPct>=0?'+':'')+pnlPct.toFixed(2)+'%' : '—'}
              </div>
            </div>
            {slDist!=null && (
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:9, fontWeight:700, letterSpacing:.4, color:'#94a3b8' }}>SL DIST</div>
                <div style={{ fontSize:12, fontWeight:700, color:pnlPct<0?'#dc2626':'#64748b' }}>
                  {pnlPct>=0?'+':'-'}{slDist}%
                </div>
              </div>
            )}
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:9, fontWeight:700, letterSpacing:.4, color:'#94a3b8' }}>{live ? 'LIVE PRICE' : 'LAST PRICE'}</div>
              <div style={{ fontSize:13, fontWeight:700 }}>₹{fmt(ltp)}</div>
            </div>
          </div>

          {/* Progress bar: entry → target */}
          {toPct!=null && (live || toPct!==0) && (
            <div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'#94a3b8', marginBottom:4, fontWeight:700}}>
                <span>Entry ₹{fmt(entry)}</span>
                <span>To Target {toPct}%</span>
                <span>₹{fmt(tgtVal)}</span>
              </div>
              <div style={{ height:7, background:'#eef2f6', borderRadius:4, overflow:'hidden', boxShadow:'inset 0 1px 2px rgba(15,23,42,.07)' }}>
                <div style={{
                  height:'100%', borderRadius:4, transition:'width .4s ease',
                  background: toPct>=100?'linear-gradient(90deg,#16a34a,#22c55e)':toPct>=50?'linear-gradient(90deg,#22c55e,#4ade80)':toPct>=0?'linear-gradient(90deg,#3b82f6,#60a5fa)':'linear-gradient(90deg,#f59e0b,#fbbf24)',
                  width: Math.min(100, Math.max(0, toPct))+'%',
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ fontSize:9, color:'#94a3b8', display:'flex', gap:10, flexWrap:'wrap' }}>
        <span>📅 {fmtWhen(sig.date, sig.time)}</span>
        {sig.rr     && <span><Icon name="scale" size={10} style={{ marginRight:2 }}/>R:R {sig.rr}</span>}
        {isOpt && sig.lot && <span><Icon name="box" size={10} style={{ marginRight:2 }}/>{sig.lot} qty</span>}
        {sig.strength && <span>💪 {sig.strength}</span>}
        {sig.exitPrice && <span><Icon name="flag" size={10} style={{ marginRight:2 }}/>Exit ₹{fmt(sig.exitPrice)}</span>}
        {sig.exitReason && (
          <span>
            {EXIT_REASON_LABELS[sig.exitReason]
              ? <>{EXIT_REASON_LABELS[sig.exitReason].icon && <Icon name={EXIT_REASON_LABELS[sig.exitReason].icon} size={11} style={{ marginRight:3 }}/>} {EXIT_REASON_LABELS[sig.exitReason].text}</>
              : sig.exitReason}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Compute day stats for index update ────────────────────────
// Several option signals on the same underlying, side, expiry and day are really ONE market view
// taken several times (e.g. two UNIONBANK puts logged in the same scan). Grouping shows the combined
// exposure at a glance — the thing that actually matters for risk — and keeps a long list scannable.
function SignalGroup({ members, lastPrices, marketOpen }) {
  const [open, setOpen] = useState(false);
  const first = members[0];
  const name = first.stock || first.name || first.und || first.symbol || '';
  const isLong = !/sell/i.test(String(first.signal || first.action || 'BUY'));
  const bullView = (first.optType === 'CE') === isLong;
  const color = bullView ? '#16a34a' : '#dc2626';
  const total = members.reduce((a, m) => a + (m.capitalReq || 0), 0);
  const avgConf = Math.round(members.reduce((a, m) => a + (m.confidence || 0), 0) / members.length);
  const cnt = (st) => members.filter((m) => m.status === st).length;
  const pnls = members.map((m) => {
    if (m.status === 'OPEN') { const lp = lastPrices[getSignalFeedKey(m)]?.ltp; return lp && m.entry ? ((lp - m.entry) / m.entry) * 100 : null; }
    return m.pnlPct ?? null;
  }).filter((v) => v != null);
  const avgPnl = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : null;
  const strikes = members.map((m) => m.strike).filter(Boolean).join(' · ');
  const chip = (txt, bg, fg) => <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 6, background: bg, color: fg }}>{txt}</span>;
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderLeft: `4px solid ${color}`, borderRadius: 12, marginBottom: 10, boxShadow: 'var(--shadow-raised)' }}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '11px 12px 6px', fontFamily: 'inherit' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 900, color: '#0f172a' }}>{name}</span>
            <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4, background: bullView ? '#dcfce7' : '#fee2e2', color: bullView ? '#15803d' : '#b91c1c' }}>
              {bullView ? '▲' : '▼'} {first.optType === 'CE' ? 'CALL' : 'PUT'} · {bullView ? 'bullish' : 'bearish'} view
            </span>
          </div>
          <span style={{ fontSize: 10, fontWeight: 800, color: '#1d4ed8', whiteSpace: 'nowrap' }}>{members.length} signals {open ? '▾' : '▸'}</span>
        </div>
        <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, marginTop: 3 }}>Strikes {strikes} · Exp {first.expiry}</div>
      </button>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '2px 12px 8px' }}>
        {chip(`Exposure ${fmtRs0(total)}`, '#f1f5f9', '#0f172a')}
        {chip(`Avg conf ${avgConf}%`, '#f5f3ff', '#6d28d9')}
        {cnt('OPEN') > 0 && chip(`${cnt('OPEN')} open`, '#fffbeb', '#b45309')}
        {cnt('TARGET_HIT') > 0 && chip(`${cnt('TARGET_HIT')} target hit`, '#f0fdf4', '#15803d')}
        {cnt('SL_HIT') > 0 && chip(`${cnt('SL_HIT')} SL hit`, '#fef2f2', '#b91c1c')}
        {avgPnl != null && !(avgPnl === 0 && !marketOpen) && chip(`Avg P&L ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`, avgPnl >= 0 ? '#f0fdf4' : '#fef2f2', avgPnl >= 0 ? '#15803d' : '#b91c1c')}
      </div>
      <div style={{ margin: '0 12px 10px', fontSize: 9.5, fontWeight: 700, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '4px 8px' }}>
        ⚠ {members.length} correlated signals — effectively one market view with {members.length}× the exposure
      </div>
      {open && (
        <div style={{ padding: '0 8px 4px' }}>
          {members.map((m, i) => (
            <SignalRow key={m.id || i} sig={m} marketOpen={marketOpen}
              livePrice={m.status === 'OPEN' ? (lastPrices[getSignalFeedKey(m)]?.ltp ?? null) : null} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function LogPane() {
  const { gh, token, cfg, onTokenExpired, updateBadge, lg, marketStatus, openSignalCount, runSignalMonitor } = useApp();

  const [loading, setLoading]         = useState(false);
  const [checking, setChecking]       = useState(false);
  const [error, setError]             = useState('');
  const [signals, setSignals]         = useState([]);
  const [sigShaMap, setSigShaMap]     = useState({});
  // stats derived live from filtered signals — see useMemo below
  const [filter, setFilter]           = useState('all');
  const [typeFilter, setTypeFilter]   = useState('all');
  const [days, setDays]               = useState(1);
  const [wsResolved, setWsResolved]   = useState(0);
  const resolvedRef = useRef(new Set());

  // Collect ALL open signal instrument keys (stocks + options)
  const openSignals = useMemo(() => signals.filter(s => s.status==='OPEN'), [signals]);
  const openKeys    = useMemo(() => {
    const keys = openSignals.map(getSignalFeedKey).filter(Boolean);
    return [...new Set(keys)];
  }, [openSignals]);

  // WebSocket feed for ALL open signals (stocks + options)
  const { connected: wsConnected, lastPrices } = useMarketFeed(
    token, openKeys, marketStatus.open && openKeys.length > 0
  );

  // Real-time SL/Target resolution — works for BOTH stocks and options
  useEffect(() => {
    if (!wsConnected || !openSignals.length) return;
    const istDate = getISTDate();
    const istTime = new Date().toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata', hour12:false });

    const { updated, changed, newlyResolved, touchedIds } = resolveSignalsAgainstLivePrices(
      signals, lastPrices, resolvedRef.current, istDate, istTime, cfg
    );
    if (newlyResolved.length) {
      newlyResolved.forEach(id => resolvedRef.current.add(id));
      setWsResolved(n => n + newlyResolved.length);
    }
    setSignals(updated);

    if (changed) {
      persistResolvedSignals(gh, updated, new Set(touchedIds), lg, (date, newSha) => {
        setSigShaMap(m => ({ ...m, [date]: newSha }));
      });
    }
  }, [lastPrices, wsConnected, cfg]); // eslint-disable-line

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { signals: all, shaMap } = await loadSignalLog({ gh, days, lg, updateBadge });
      setSignals(all);
      setSigShaMap(prev => ({ ...prev, ...shaMap })); // preserve existing SHAs + add new ones
      resolvedRef.current.clear();
    } catch(e) { setError(e.message); lg('Log error: '+e.message,'e'); }
    finally { setLoading(false); }
  }, [gh, days, updateBadge, lg]);

  // ── checkAllOutcomes — top-level useCallback (NOT inside load) ──
  const checkAllOutcomes = useCallback(async () => {
    setChecking(true); setError('');
    try {
      await checkAllOutcomesService({ gh, token, cfg, onTokenExpired, lg });
      await load();
    } catch(e) { setError('Outcome check failed: ' + e.message); lg('checkAllOutcomes: '+e.message,'e'); }
    finally { setChecking(false); }
  }, [gh, token, cfg, onTokenExpired, load, lg]); // eslint-disable-line

  useEffect(() => { if (gh.token) load(); }, [gh.token, days]); // eslint-disable-line

  const filtered = signals.filter(s => {
    if (filter!=='all'&&s.status!==filter) return false;
    if (typeFilter!=='all'&&s.type!==typeFilter) return false;
    return true;
  });

  // Derive stats from filtered signals — auto-updates when WS resolves or dropdown changes
  const stats = useMemo(() => {
    if (!filtered.length) return null;
    const closed  = filtered.filter(s => s.status==='TARGET_HIT' || s.status==='SL_HIT');
    const hits    = filtered.filter(s => s.status==='TARGET_HIT').length;
    const winRate = closed.length ? Math.round(hits / closed.length * 100) : null;
    return {
      total:   filtered.length,
      open:    filtered.filter(s => s.status==='OPEN').length,
      hits,
      sls:     closed.length - hits,
      winRate,
      avgConf: Math.round(filtered.reduce((s, x) => s + (x.confidence || 0), 0) / filtered.length),
    };
  }, [filtered]);

  const stocksOpen  = openSignals.filter(s=>s.type==='STOCK').length;
  const optionsOpen = openSignals.filter(s=>s.type==='OPTION').length;

  // ── one honest monitoring banner (replaces two near-identical "live" banners that kept saying
  //    "live" after the close and disagreed on the count: one counted this view, the other all open) ──
  const marketOpen = !!marketStatus.open;
  const totalOpen = Math.max(openSignalCount || 0, openSignals.length);
  const plural = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;
  const scopeNote = totalOpen > openSignals.length ? ` ${openSignals.length} in this view · ${totalOpen} open in total.` : '';
  let bannerTone, bannerText;
  if (!openSignals.length) { bannerTone = 'info'; bannerText = `${plural(totalOpen, 'open signal')} outside this date range ${marketOpen ? 'are being tracked' : 'will be tracked once the market opens'} — widen the date filter to see them.`; }
  else if (!marketOpen)    { bannerTone = 'closed'; bannerText = `🌙 Market closed — ${plural(openSignals.length, 'open signal')} paused; tracking resumes at 9:15 AM IST.${scopeNote}`; }
  else if (wsConnected)    { bannerTone = 'live'; bannerText = `⚡ Live — tracking ${plural(stocksOpen, 'stock')} + ${plural(optionsOpen, 'option')}; SL & Target resolve instantly (also re-checked every 60s).${scopeNote}`; }
  else                     { bannerTone = 'wait'; bannerText = `Connecting live feed for ${plural(openKeys.length, 'open signal')}…${scopeNote}`; }
  const BANNER = {
    live:   { bg: '#f0fdf4', bd: '#86efac', fg: '#15803d', dot: '#16a34a' },
    closed: { bg: '#f8fafc', bd: '#e2e8f0', fg: '#475569', dot: '#94a3b8' },
    wait:   { bg: '#f8fafc', bd: '#e2e8f0', fg: '#64748b', dot: '#94a3b8' },
    info:   { bg: '#eff6ff', bd: '#bfdbfe', fg: '#1d4ed8', dot: '#3b82f6' },
  }[bannerTone];
  const nStock = filtered.filter((x) => x.type === 'STOCK').length;
  const nOpt = filtered.length - nStock;

  // Group correlated option signals; stocks and lone option signals stay single (utils/signalGroups.js)
  const rows = groupCorrelated(filtered);

  return (
    <div>
      {!gh.token && (
        <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:8, padding:'12px 14px', marginBottom:12, fontSize:11, color:'#b45309', fontWeight:600 }}>
          ⚠ GitHub not configured — go to ⚙ Settings to enable signal logging.
        </div>
      )}
      {error && <ErrorBanner title="⚠ Log Error" message={error} onRetry={load} />}

      {/* Monitoring status — one banner, honest about market state and scope */}
      {(openKeys.length > 0 || totalOpen > 0) && (
        <div style={{ background: BANNER.bg, border: `1px solid ${BANNER.bd}`, borderRadius: 8, padding: '8px 12px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: BANNER.dot, flexShrink: 0 }} />
          <span style={{ fontWeight: 600, color: BANNER.fg, lineHeight: 1.45 }}>{bannerText}</span>
          {wsResolved > 0 && (
            <span style={{ marginLeft: 'auto', background: '#dcfce7', color: '#15803d', fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap' }}>
              ⚡ {wsResolved} resolved this session
            </span>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="log-controls">
        <select value={days} onChange={e=>setDays(+e.target.value)} className="log-filter-select">
          <option value={1}>Today</option>
          {[7,14,30,60].map(d=><option key={d} value={d}>Last {d} days</option>)}
        </select>
        <select value={filter} onChange={e=>setFilter(e.target.value)} className="log-filter-select">
          <option value="all">All Status</option>
          <option value="OPEN">Open ⚡</option>
          <option value="TARGET_HIT">Target Hit ✅</option>
          <option value="SL_HIT">SL Hit ❌</option>
          <option value="EXPIRED">Expired</option>
        </select>
        <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} className="log-filter-select">
          <option value="all">All Types</option>
          <option value="STOCK">Stocks 📊</option>
          <option value="OPTION">Options ⚡</option>
        </select>
        <button className="btn btn-g" onClick={load} disabled={loading} style={{ padding:'7px 14px', fontSize:11 }}>
          {loading?'⏳':'🔄 Refresh'}
        </button>
        <button className="btn btn-g" onClick={() => runSignalMonitor()} disabled={checking} title="Check every open signal (all dates, not just this view) against current prices now" style={{ padding:'7px 14px', fontSize:11, background:'#f0fdf4', border:'1px solid #86efac', color:'#166534' }}>
          {checking ? '⏳ Checking…' : `✅ Check Now${openSignalCount > 0 ? ' (' + openSignalCount + ')' : ''}`}
        </button>
      </div>

      {loading ? <Spinner label="Loading signal log..." sub="Reading from GitHub..." /> : (
        <div>
          {stats && (
            <div className="stats-g" style={{ marginBottom:12 }}>
              <StatCard label="TOTAL"    value={stats.total}   sub={`${nStock} stock${nStock!==1?'s':''} · ${nOpt} option${nOpt!==1?'s':''}`} valClass="bl" />
              <StatCard label="OPEN ⚡"  value={stats.open}    sub={marketOpen ? 'tracking live' : 'paused · market closed'} valClass="am" />
              <StatCard label="WIN RATE" value={stats.winRate!=null?stats.winRate+'%':'—'} sub={`${stats.hits}W · ${stats.sls}L`} valClass={(stats.winRate||0)>=50?'up':'dn'} />
              <StatCard label="AVG CONF" value={stats.avgConf+'%'} sub={`across ${stats.total} signals`} valClass="pu" />
            </div>
          )}

          {filtered.length===0
            ?<EmptyState>{gh.token?`No signals for selected filters (${days}d)`:'Configure GitHub in ⚙ Settings to start logging'}</EmptyState>
            :rows.map((r, i) => r.kind === 'group'
              ? <SignalGroup key={r.key} members={r.members} lastPrices={lastPrices} marketOpen={marketOpen} />
              : <SignalRow
                  key={r.key ?? i}
                  sig={r.sig}
                  marketOpen={marketOpen}
                  livePrice={r.sig.status === 'OPEN' ? (lastPrices[getSignalFeedKey(r.sig)]?.ltp ?? null) : null}
                />
            )
          }
        </div>
      )}
    </div>
  );
}
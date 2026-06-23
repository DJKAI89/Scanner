import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, EmptyState, StatCard } from '../components/common.jsx';
import { isBullSignal } from '../services/github';
import {
  getSignalFeedKey, loadSignalLog,
  resolveSignalsAgainstLivePrices, persistResolvedSignals, checkAllOutcomes as checkAllOutcomesService,
} from '../services/logService';
import { fmt } from '../utils/formatters';
import { getIST, getISTDate } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed.js';

const STATUS_COLORS = {
  OPEN:       { bg:'#eff6ff', color:'#1d4ed8', border:'#bfdbfe' },
  TARGET_HIT: { bg:'#f0fdf4', color:'#16a34a', border:'#86efac' },
  SL_HIT:     { bg:'#fef2f2', color:'#dc2626', border:'#fca5a5' },
  EXPIRED:    { bg:'#f8fafc', color:'#64748b', border:'#e2e8f0' },
};

function SignalRow({ sig, livePrice }) {
  const sc = STATUS_COLORS[sig.status] || STATUS_COLORS.OPEN;
  const isBuy  = isBullSignal(sig); // uses shared isBullSignal (handles BUY/SELL/CALL/PUT)
  const isOpt  = sig.type === 'OPTION';
  const ltp    = livePrice ?? null;
  const entry  = sig.entry  || 0;
  const slVal  = sig.sl     || 0;
  const tgtVal = sig.target || 0;

  // Live P&L
  const pnlPct = ltp && entry
    ? +((ltp - entry) / entry * 100).toFixed(2)
    : (sig.pnlPct ?? null);

  // Target progress % (how far from entry to target)
  const totalMove  = Math.abs(tgtVal - entry);
  const actualMove = ltp ? (isBuy ? ltp - entry : entry - ltp) : 0;
  const toPct = ltp && totalMove > 0
    ? Math.round(Math.max(-50, Math.min(120, actualMove / totalMove * 100)))
    : null;

  // SL distance %
  const slDist = ltp && entry && slVal
    ? +((isBuy ? ltp - slVal : slVal - ltp) / entry * 100).toFixed(1)
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

  const typeIcon = isOpt
    ? (sig.optType === 'CE' ? '📈' : '📉')
    : '📊';

  return (
    <div className={flash} style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:'12px 14px', marginBottom:8, transition:'background .3s' }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:6, marginBottom:8 }}>
        <div>
          <span style={{ fontWeight:800, fontSize:14 }}>{typeIcon} {sig.stock || sig.name}</span>
          {isOpt && (
            <span style={{ fontSize:9, background:'#e0e7ff', color:'#3730a3', borderRadius:4, padding:'1px 5px', marginLeft:6, fontWeight:700 }}>
              {sig.strike} {sig.optType} {sig.expiry}
            </span>
          )}
          {ltp && sig.status==='OPEN' && (
            <span style={{ fontSize:9, background:'#dcfce7', color:'#16a34a', borderRadius:4, padding:'1px 5px', marginLeft:6, fontWeight:800 }}>
              ⚡ ₹{fmt(ltp)}
            </span>
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
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4, marginBottom:8 }}>
        {[
          { l:'ENTRY',  v: entry  ? `₹${fmt(entry)}`  : '—' },
          { l:'SL',     v: slVal  ? `₹${fmt(slVal)}`  : '—' },
          { l:'TARGET', v: tgtVal ? `₹${fmt(tgtVal)}` : '—' },
          { l:'CONF',   v: `${sig.confidence||0}%`          },
        ].map(m => (
          <div key={m.l} style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:6, padding:'5px 7px' }}>
            <div style={{ fontSize:7, color:'#94a3b8', marginBottom:2 }}>{m.l}</div>
            <div style={{ fontSize:12, fontWeight:700 }}>{m.v}</div>
          </div>
        ))}
      </div>

      {/* Live P&L + progress bar (OPEN signals with live price) */}
      {sig.status==='OPEN' && ltp != null && (
        <div style={{ background:pnlPct!=null&&pnlPct>=0?'#f0fdf4':'#fef2f2', borderRadius:8, padding:'8px 10px', marginBottom:8 }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:5 }}>
            <div>
              <div style={{ fontSize:7, color:'#94a3b8' }}>LIVE P&L</div>
              <div style={{ fontSize:15, fontWeight:800, color:pnlPct!=null&&pnlPct>=0?'#16a34a':'#dc2626' }}>
                {pnlPct!=null ? (pnlPct>=0?'+':'')+pnlPct.toFixed(2)+'%' : '—'}
              </div>
            </div>
            {slDist!=null && (
              <div style={{ textAlign:'center' }}>
                <div style={{ fontSize:11, color:'#94a3b8' }}>SL DIST</div>
                <div style={{ fontSize:11, fontWeight:700, color:pnlPct<0?'#dc2626':'#64748b' }}>
                  {pnlPct>=0?'+':'-'}{slDist}%
                </div>
              </div>
            )}
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:7, color:'#94a3b8' }}>LIVE PRICE</div>
              <div style={{ fontSize:13, fontWeight:700 }}>₹{fmt(ltp)}</div>
            </div>
          </div>

          {/* Progress bar: entry → target */}
          {toPct!=null && (
            <div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'#94a3b8', marginBottom:3, fontWeight:700}}>
                <span>Entry ₹{fmt(entry)}</span>
                <span>To Target {toPct}%</span>
                <span>₹{fmt(tgtVal)}</span>
              </div>
              <div style={{ height:6, background:'#e2e8f0', borderRadius:3, overflow:'hidden' }}>
                <div style={{
                  height:'100%', borderRadius:3, transition:'width .4s ease',
                  background: toPct>=100?'#16a34a':toPct>=50?'#22c55e':toPct>=0?'#3b82f6':'#dc2626',
                  width: Math.min(100, Math.max(0, toPct))+'%',
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <div style={{ fontSize:9, color:'#94a3b8', display:'flex', gap:10, flexWrap:'wrap' }}>
        <span>📅 {sig.date} {(sig.time||'').slice(0,5)}</span>
        {sig.rr     && <span>⚖ R:R {sig.rr}</span>}
        {isOpt && sig.lot && <span>📦 {sig.lot} qty</span>}
        {sig.strength && <span>💪 {sig.strength}</span>}
        {sig.exitPrice && <span>🏁 Exit ₹{fmt(sig.exitPrice)}</span>}
      </div>
    </div>
  );
}

// ── Compute day stats for index update ────────────────────────
export default function LogPane() {
  const { gh, token, onTokenExpired, updateBadge, lg, marketStatus, openSignalCount, runSignalMonitor } = useApp();

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

    const { updated, changed, newlyResolved } = resolveSignalsAgainstLivePrices(
      signals, lastPrices, resolvedRef.current, istDate, istTime
    );
    if (newlyResolved.length) {
      newlyResolved.forEach(id => resolvedRef.current.add(id));
      setWsResolved(n => n + newlyResolved.length);
    }
    setSignals(updated);

    if (changed) {
      persistResolvedSignals(gh, updated, resolvedRef.current, lg, (date, newSha) => {
        setSigShaMap(m => ({ ...m, [date]: newSha }));
      });
    }
  }, [lastPrices, wsConnected]); // eslint-disable-line

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
      await checkAllOutcomesService({ gh, token, onTokenExpired, lg });
      await load();
    } catch(e) { setError('Outcome check failed: ' + e.message); lg('checkAllOutcomes: '+e.message,'e'); }
    finally { setChecking(false); }
  }, [gh, token, onTokenExpired, load, lg]); // eslint-disable-line

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

  return (
    <div>
      {!gh.token && (
        <div style={{ background:'#fffbeb', border:'1px solid #fde68a', borderRadius:8, padding:'12px 14px', marginBottom:12, fontSize:11, color:'#b45309', fontWeight:600 }}>
          ⚠ GitHub not configured — go to ⚙ Settings to enable signal logging.
        </div>
      )}
      {error && <ErrorBanner title="⚠ Log Error" message={error} onRetry={load} />}

      {/* WebSocket status — shows stocks AND options monitoring */}
      {openKeys.length > 0 && (
        <div style={{ background:wsConnected?'#f0fdf4':'#f8fafc', border:`1px solid ${wsConnected?'#86efac':'#e2e8f0'}`, borderRadius:8, padding:'7px 12px', marginBottom:10, display:'flex', alignItems:'center', gap:8, fontSize:10, flexWrap:'wrap' }}>
          <div style={{ width:7, height:7, borderRadius:'50%', background:wsConnected?'#16a34a':'#94a3b8', flexShrink:0 }} />
          <span style={{ fontWeight:600, color:wsConnected?'#15803d':'#64748b' }}>
            {wsConnected
              ? `⚡ Live monitoring ${stocksOpen} stock${stocksOpen!==1?'s':''} + ${optionsOpen} option${optionsOpen!==1?'s':''} — SL & Target resolve instantly`
              : `WebSocket connecting for ${openKeys.length} open signal${openKeys.length!==1?'s':''}...`}
          </span>
          {wsResolved > 0 && (
            <span style={{ marginLeft:'auto', background:'#dcfce7', color:'#15803d', fontSize:9, fontWeight:800, padding:'2px 7px', borderRadius:10 }}>
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
        <button className="btn btn-g" onClick={() => runSignalMonitor()} disabled={checking} title="Check all OPEN signals against live prices now" style={{ padding:'7px 14px', fontSize:11, background:'#eff6ff', color:'#1d4ed8' }}>
          {checking ? '⏳ Checking…' : `✅ Check Now${openSignalCount > 0 ? ' (' + openSignalCount + ')' : ''}`}
        </button>
      </div>

      {loading ? <Spinner label="Loading signal log..." sub="Reading from GitHub..." /> : (
        <div>
          {openSignalCount > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 11px', background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:8, marginBottom:10, fontSize:10 }}>
              <div style={{ width:7, height:7, borderRadius:'50%', background:'#16a34a', flexShrink:0 }} />
              <span style={{ color:'#15803d', fontWeight:700 }}>
                🔍 Monitoring {openSignalCount} open signal{openSignalCount !== 1 ? 's' : ''} live — auto-checking every 60s
              </span>
            </div>
          )}
          {stats && (
            <div className="stats-g" style={{ marginBottom:12 }}>
              <StatCard label="TOTAL"    value={stats.total}   valClass="bl" />
              <StatCard label="OPEN ⚡"  value={stats.open}    valClass="am" />
              <StatCard label="WIN RATE" value={stats.winRate!=null?stats.winRate+'%':'—'} sub={`${stats.hits}W · ${stats.sls}L`} valClass={(stats.winRate||0)>=50?'up':'dn'} />
              <StatCard label="AVG CONF" value={stats.avgConf+'%'} valClass="pu" />
            </div>
          )}

          {filtered.length===0
            ?<EmptyState>{gh.token?`No signals for selected filters (${days}d)`:'Configure GitHub in ⚙ Settings to start logging'}</EmptyState>
            :filtered.map((sig,i) => (
              <SignalRow
                key={sig.id||i}
                sig={sig}
                livePrice={sig.status === 'OPEN' ? (lastPrices[getSignalFeedKey(sig)]?.ltp ?? null) : null}
              />
            ))
          }
        </div>
      )}
    </div>
  );
}

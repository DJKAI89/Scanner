import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, EmptyState } from '../components/common.jsx';
import { ghReadMultipleDays } from '../services/github';
import { fmt } from '../utils/formatters';

// ── Exact port of HTML wr() helper ───────────────────────────
function wr(arr) {
  if (!arr || !arr.length) return null;
  const h = arr.filter(s => s.status === 'TARGET_HIT').length;
  return { h, t: arr.length, r: Math.round(h / arr.length * 100) };
}

const sc  = v => v === null ? '#94a3b8' : v >= 65 ? '#16a34a' : v >= 50 ? '#d97706' : '#dc2626';
const pct = v => v === null ? '—' : v + '%';
const avgPnlOf = arr => {
  const v = arr.filter(s => s.pnlPct != null);
  return v.length ? (v.reduce((a, s) => a + s.pnlPct, 0) / v.length).toFixed(1) : '—';
};

function Bar({ label, r, t, extra = '' }) {
  if (!t) return (
    <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#94a3b8', padding:'3px 0' }}>
      <span>{label}</span><span>No data</span>
    </div>
  );
  const color = sc(r), w = r || 0;
  return (
    <div style={{ marginBottom:8 }}>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, marginBottom:2 }}>
        <span style={{ color:'#374151', fontWeight:600 }}>{label}{extra}</span>
        <span style={{ color, fontWeight:700 }}>{pct(r)} · {t} signals</span>
      </div>
      <div style={{ background:'#f1f5f9', borderRadius:4, height:5 }}>
        <div style={{ background:color, width:Math.min(100,w)+'%', height:5, borderRadius:4 }} />
      </div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, padding:'12px 14px', marginBottom:10 }}>
      <div style={{ fontSize:11, fontWeight:800, color:'#0f172a', marginBottom:10 }}>{title}</div>
      {children}
    </div>
  );
}

export default function AnalysisPane() {
  const { gh, updateBadge, lg } = useApp();
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [data, setData]       = useState(null);
  const [days, setDays]       = useState(30);

  const load = useCallback(async () => {
    if (!gh.token || !gh.user || !gh.repo) {
      setError('GitHub not configured — go to ⚙ Settings to set it up.');
      return;
    }
    setLoading(true); setError('');
    try {
      const signals = await ghReadMultipleDays(gh, days);
      if (!signals.length) { setData({ empty: true }); return; }

      const closed  = signals.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
      const expired = signals.filter(s => s.status === 'EXPIRED');
      const open    = signals.filter(s => s.status === 'OPEN');
      const total   = closed.length;

      if (total < 5) {
        setData({ insufficient: true, total, open: open.length, expired: expired.length });
        return;
      }

      const overall   = wr(closed);
      const avgConf   = Math.round(closed.reduce((a, s) => a + (s.confidence || 50), 0) / total);
      const avgPnlAll = avgPnlOf(closed);
      const avgPnlTgt = avgPnlOf(closed.filter(s => s.status === 'TARGET_HIT'));
      const avgPnlSL  = avgPnlOf(closed.filter(s => s.status === 'SL_HIT'));

      // Streak
      const recent = closed.slice(-20).reverse();
      let streak = 0, streakType = '';
      for (const s of recent) {
        const isHit = s.status === 'TARGET_HIT';
        if (!streakType) streakType = isHit ? 'W' : 'L';
        if ((streakType === 'W') === isHit) streak++; else break;
      }

      // By underlying
      const underlyings = [...new Set(closed.map(s => s.stock || s.name?.split(' ')[0]))].slice(0, 8);
      const byUnderlying = underlyings.map(u => {
        const g = closed.filter(s => (s.stock || s.name?.split(' ')[0]) === u);
        return { u, ...(wr(g) || { h:0, t:0, r:null }) };
      }).filter(x => x.t >= 3).sort((a, b) => (b.r || 0) - (a.r || 0));

      // CE vs PE
      const ceSignals = closed.filter(s => s.optType === 'CE' || s.signal === 'CALL');
      const peSignals = closed.filter(s => s.optType === 'PE' || s.signal === 'PUT');
      const ceWR = wr(ceSignals), peWR = wr(peSignals);

      // Signal types
      const sigTypes = ['BUY', 'SELL', 'WATCH', 'MODERATE'].map(type => {
        const g     = closed.filter(s => s.signal === type);
        const stats = wr(g) || { h:0, t:0, r:null };
        return { type, ...stats };
      }).filter(x => x.t >= 3);

      // Confidence bands
      const confBands = [50, 60, 70, 75, 80, 85, 90, 95].map(b => {
        const g = closed.filter(s => (s.confidence || 50) >= b && (s.confidence || 50) < b + 5);
        return { band: `${b}–${b+4}%`, ...(wr(g) || { h:0, t:0, r:null }) };
      }).filter(x => x.t >= 2);

      // Time sessions
      const getH = s => parseInt((s.time || '').split(':')[0]) || 0;
      const getM = s => parseInt((s.time || '').split(':')[1]) || 0;
      const sessions = [
        { label:'Opening 9:15–9:45',  fn:s => { const h=getH(s),m=getM(s); return h===9&&m>=15&&m<=45; } },
        { label:'Early 9:45–10:30',   fn:s => { const h=getH(s),m=getM(s); return (h===9&&m>45)||(h===10&&m<=30); } },
        { label:'Mid 10:30–12:30',    fn:s => { const h=getH(s); return h>=11&&h<=12; } },
        { label:'Afternoon 12:30–2',  fn:s => { const h=getH(s); return h>=12&&h<14; } },
        { label:'Pre-close 2–3:30',   fn:s => { const h=getH(s); return h>=14; } },
      ];
      const timeBreak = sessions.map(({ label, fn }) => {
        const g = closed.filter(fn);
        return { label, ...(wr(g) || { h:0, t:0, r:null }) };
      }).filter(x => x.t >= 2);
      const bestTime = timeBreak.filter(x => x.r !== null).sort((a, b) => b.r - a.r)[0];

      // Daily performance
      const byDate = {};
      closed.forEach(s => {
        const cd = s.exitDate || s.date;
        if (!byDate[cd]) byDate[cd] = { hits:0, sls:0, pnl:0 };
        byDate[cd][s.status === 'TARGET_HIT' ? 'hits' : 'sls']++;
        byDate[cd].pnl += (s.pnlPct || 0);
      });
      const dailyRows = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);

      // CompositeScore calibration
      const scoredSignals = closed.filter(s => s.compositeScore != null);
      const csBuckets = [
        { label:'Strong Bear ≤-2',   min:-99, max:-2   },
        { label:'Weak Bear -2..-0.5', min:-2,  max:-0.5 },
        { label:'Neutral ±0.5',       min:-0.5, max:0.5 },
        { label:'Weak Bull 0.5..2',   min:0.5,  max:2   },
        { label:'Strong Bull ≥2',     min:2,    max:99  },
      ];
      const csRows = scoredSignals.length >= 5
        ? csBuckets.map(b => {
          const g = scoredSignals.filter(s => s.compositeScore >= b.min && s.compositeScore < b.max);
          const r2 = wr(g);
          return r2 && r2.t >= 2 ? { label: b.label, r: r2.r, t: r2.t } : null;
        }).filter(Boolean)
        : [];

      // Actionable summary
      const bestConf = confBands.filter(b => b.r !== null).sort((a, b) => b.r - a.r)[0];
      const bestUnd  = byUnderlying[0];
      const summaryPoints = [];
      if (bestTime)   summaryPoints.push(`Best time: <b>${bestTime.label}</b> (${bestTime.r}% win rate)`);
      if (bestConf)   summaryPoints.push(`Sweet spot confidence: <b>${bestConf.band}</b> (${bestConf.r}% win rate)`);
      if (bestUnd)    summaryPoints.push(`Best performing: <b>${bestUnd.u}</b> (${bestUnd.r}% from ${bestUnd.t} signals)`);
      if (ceWR && peWR && ceWR.t >= 3 && peWR.t >= 3)
        summaryPoints.push(`${ceWR.r > peWR.r ? 'CE' : 'PE'} outperforming: <b>${Math.max(ceWR.r, peWR.r)}%</b>`);
      if (streak >= 3) summaryPoints.push(`Current streak: <b>${streak} ${streakType === 'W' ? 'wins 🔥' : 'losses ⚠'}</b>`);

      // Quality alerts
      const qualityAlerts = [];
      if (overall.r !== null && overall.r < 30)
        qualityAlerts.push(`⚠ Win rate is <b>${overall.r}%</b> — below viable threshold. Signals losing money systematically.`);
      if (streak >= 5 && streakType === 'L')
        qualityAlerts.push(`🔴 <b>${streak} consecutive losses</b> — consider pausing until root cause identified.`);
      const worstSession = timeBreak.filter(x => x.r !== null && x.t >= 5).sort((a, b) => (a.r||0) - (b.r||0))[0];
      if (worstSession && worstSession.r < 10)
        qualityAlerts.push(`🕐 <b>${worstSession.label}</b> only ${worstSession.r}% win rate — avoid trading in this window.`);
      if (avgConf > 70 && overall.r !== null && overall.r < 20)
        qualityAlerts.push(`📉 Confidence has <b>no predictive value</b> — ${avgConf}% avg conf yet only ${overall.r}% win rate.`);

      updateBadge('analysis', String(signals.length));
      lg(`Analysis: ${total} closed, ${open.length} open`, 'o');

      setData({
        signals, closed, open, expired, total, overall, avgConf, avgPnlAll, avgPnlTgt, avgPnlSL,
        streak, streakType, byUnderlying, ceSignals, peSignals, ceWR, peWR, sigTypes, confBands,
        timeBreak, bestTime, dailyRows, csRows, scoredSignals, summaryPoints, qualityAlerts,
      });
    } catch (e) {
      setError(e.message); lg('Analysis error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }, [gh, days, updateBadge, lg]);

  useEffect(() => { if (gh.token) load(); }, [gh.token, days]); // eslint-disable-line

  return (
    <div>
      <div style={{ display:'flex', gap:8, marginBottom:14, alignItems:'center', flexWrap:'wrap' }}>
        <select value={days} onChange={e => setDays(+e.target.value)} className="log-filter-select" style={{ maxWidth:160 }}>
          {[7,14,30,60,90].map(d => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <button className="btn btn-g" onClick={load} disabled={loading} style={{ padding:'7px 14px', fontSize:11 }}>
          {loading ? '⏳' : '🔄 Refresh'}
        </button>
      </div>

      {error   && <ErrorBanner title="⚠ Error" message={error} onRetry={load} />}
      {loading && <Spinner label="Analysing signal log..." sub="Win rate · Confidence bands · Time sessions · CompositeScore calibration" />}

      {!loading && data?.empty && <EmptyState>📊 No signals found in last {days} days · Run scans to populate signal log</EmptyState>}
      {!loading && !data && !error && <EmptyState>{gh.token ? '🔄 Click Refresh to load' : '⚙ Configure GitHub in Settings to enable analysis'}</EmptyState>}
      {!loading && data?.insufficient && (
        <EmptyState>Need at least 5 closed signals for analysis.<br />{data.total} closed · {data.open} open · {data.expired} expired</EmptyState>
      )}

      {!loading && data && !data.empty && !data.insufficient && (() => {
        const d = data;
        return (
          <div>
            {/* Quality alerts */}
            {d.qualityAlerts.length > 0 && (
              <div style={{ background:'#fef2f2', border:'2px solid #fca5a5', borderRadius:10, padding:'12px 14px', marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:800, color:'#991b1b', marginBottom:8 }}>🚨 Signal Quality Issues</div>
                {d.qualityAlerts.map((a, i) => (
                  <div key={i} style={{ fontSize:10, color:'#7f1d1d', marginBottom:6, paddingLeft:8, borderLeft:'3px solid #ef4444', lineHeight:1.4 }} dangerouslySetInnerHTML={{ __html: a }} />
                ))}
                <div style={{ marginTop:10, paddingTop:8, borderTop:'1px solid #fca5a5', fontSize:9, color:'#991b1b', fontWeight:600 }}>
                  💡 Raise min confidence ≥80% · Trade Opening/Early only · Use ATM strikes · Check trend alignment
                </div>
              </div>
            )}

            {/* Key insights */}
            {d.summaryPoints.length > 0 && (
              <div style={{ background:'linear-gradient(135deg,#f0fdf4,#ecfdf5)', border:'1px solid #bbf7d0', borderRadius:10, padding:'12px 14px', marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:800, color:'#15803d', marginBottom:8 }}>💡 Key Insights</div>
                {d.summaryPoints.map((p, i) => (
                  <div key={i} style={{ fontSize:10, color:'#374151', marginBottom:4, paddingLeft:8, borderLeft:'3px solid #22c55e' }} dangerouslySetInnerHTML={{ __html: '→ ' + p }} />
                ))}
              </div>
            )}

            {/* Overall stats */}
            <div className="stats-g" style={{ marginBottom:10 }}>
              <div className="sc"><div className="sc-lbl">CLOSED</div><div className="sc-val bl">{d.total}</div><div className="sc-sub">{d.expired.length} expired</div></div>
              <div className="sc"><div className="sc-lbl">WIN RATE</div><div className="sc-val" style={{ color:sc(d.overall.r) }}>{pct(d.overall.r)}</div><div className="sc-sub">{d.overall.h} targets</div></div>
              <div className="sc"><div className="sc-lbl">AVG P&L</div><div className="sc-val" style={{ color:parseFloat(d.avgPnlAll)>=0?'#16a34a':'#dc2626' }}>{d.avgPnlAll==='—'?'—':(parseFloat(d.avgPnlAll)>=0?'+':'')+d.avgPnlAll+'%'}</div><div className="sc-sub">on close</div></div>
              <div className="sc"><div className="sc-lbl">STREAK</div><div className="sc-val" style={{ color:d.streakType==='W'?'#16a34a':'#dc2626' }}>{d.streak}{d.streakType==='W'?'W':'L'}</div><div className="sc-sub">recent</div></div>
            </div>

            <div className="stats-g" style={{ marginBottom:10 }}>
              <div className="sc"><div className="sc-lbl">AVG WIN</div><div className="sc-val up">{d.avgPnlTgt==='—'?'—':'+'+d.avgPnlTgt+'%'}</div><div className="sc-sub">target hits</div></div>
              <div className="sc"><div className="sc-lbl">AVG LOSS</div><div className="sc-val dn">{d.avgPnlSL==='—'?'—':d.avgPnlSL+'%'}</div><div className="sc-sub">SL hits</div></div>
              <div className="sc"><div className="sc-lbl">AVG CONF</div><div className="sc-val">{d.avgConf}%</div><div className="sc-sub">at entry</div></div>
              <div className="sc"><div className="sc-lbl">OPEN</div><div className="sc-val am">{d.open.length}</div><div className="sc-sub">watching</div></div>
            </div>

            {/* By underlying */}
            {d.byUnderlying.length >= 2 && (
              <Card title="📊 Win Rate by Underlying">
                {d.byUnderlying.map(x => <Bar key={x.u} label={x.u} r={x.r} t={x.t} />)}
              </Card>
            )}

            {/* Signal type breakdown */}
            <Card title="📈 Signal Type Breakdown">
              {d.ceWR && d.ceWR.t >= 2 && <Bar label="CE Options 📈" r={d.ceWR.r} t={d.ceWR.t} extra={` avg ${avgPnlOf(d.ceSignals)}%`} />}
              {d.peWR && d.peWR.t >= 2 && <Bar label="PE Options 📉" r={d.peWR.r} t={d.peWR.t} extra={` avg ${avgPnlOf(d.peSignals)}%`} />}
              {d.sigTypes.map(x => <Bar key={x.type} label={`${x.type === 'BUY' ? 'BUY 📈' : x.type === 'SELL' ? 'SELL 📉' : x.type} Signals`} r={x.r} t={x.t} />)}
            </Card>

            {/* Confidence bands */}
            <Card title="🎯 Win Rate by Confidence">
              {d.confBands.map(b => <Bar key={b.band} label={b.band} r={b.r} t={b.t} />)}
              <div style={{ fontSize:8, color:'#94a3b8', marginTop:2 }}>Higher confidence should = higher win rate</div>
            </Card>

            {/* Time sessions */}
            <Card title="🕐 Best Time to Trade">
              {d.timeBreak.map(t => <Bar key={t.label} label={t.label} r={t.r} t={t.t} />)}
            </Card>

            {/* CompositeScore calibration */}
            {d.csRows.length > 0 ? (
              <Card title="📐 CompositeScore Calibration">
                {d.csRows.map(r => (
                  <div key={r.label} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom:'1px solid #f1f5f9', fontSize:9 }}>
                    <span style={{ color:'#374151', fontWeight:600 }}>{r.label}</span>
                    <span style={{ color:sc(r.r), fontWeight:700 }}>{pct(r.r)} · {r.t} signals</span>
                  </div>
                ))}
                <div style={{ fontSize:8, color:'#94a3b8', marginTop:6 }}>
                  Score ranges with highest win rate should get higher weight in computeCtxFromCandles().
                </div>
              </Card>
            ) : d.scoredSignals.length < 5 ? (
              <div style={{ background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:10, padding:'10px 14px', marginBottom:10, fontSize:9, color:'#64748b' }}>
                📐 <b>CompositeScore calibration</b> — will appear after {5-d.scoredSignals.length} more scored signals.
              </div>
            ) : null}

            {/* Daily performance */}
            {d.dailyRows.length >= 3 && (
              <Card title="📅 Recent Daily Performance">
                {d.dailyRows.map(([date, dd]) => {
                  const dayWR  = dd.hits + dd.sls > 0 ? Math.round(dd.hits / (dd.hits + dd.sls) * 100) : null;
                  const pnlStr = dd.pnl >= 0 ? '+' + dd.pnl.toFixed(1) : dd.pnl.toFixed(1);
                  return (
                    <div key={date} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:'1px solid #f1f5f9', fontSize:9 }}>
                      <span style={{ fontWeight:600, color:'#374151' }}>{date}</span>
                      <span style={{ color:sc(dayWR), fontWeight:700 }}>{pct(dayWR)}</span>
                      <span style={{ color:'#64748b' }}>{dd.hits}W {dd.sls}L</span>
                      <span style={{ color:dd.pnl>=0?'#16a34a':'#dc2626', fontWeight:700 }}>{pnlStr}%</span>
                    </div>
                  );
                })}
              </Card>
            )}

            {/* Last 10 closed signals */}
            <Card title="🕒 Recent Closed Signals">
              {d.closed.slice(-10).reverse().map((s, i) => {
                const col  = s.status === 'TARGET_HIT' ? '#16a34a' : '#dc2626';
                const icon = s.status === 'TARGET_HIT' ? '✅' : '❌';
                const pnl  = s.pnlPct != null ? (s.pnlPct >= 0 ? '+' : '') + s.pnlPct.toFixed(1) + '%' : '—';
                return (
                  <div key={i} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'5px 0', borderBottom:'1px solid #f1f5f9', fontSize:9 }}>
                    <div>
                      <span style={{ fontWeight:700, color:'#0f172a' }}>{s.name || s.stock}</span>
                      <span style={{ color:'#94a3b8', marginLeft:4 }}>{s.date} {(s.time || '').slice(0,5)}</span>
                    </div>
                    <span style={{ color:col, fontWeight:700 }}>{icon} {pnl}</span>
                  </div>
                );
              })}
            </Card>
          </div>
        );
      })()}
    </div>
  );
}

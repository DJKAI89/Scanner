import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, EmptyState } from '../components/common.jsx';
import { ghReadMultipleDays } from '../services/github';

// ── helpers ───────────────────────────────────────────────────
function wr(arr) {
  if (!arr?.length) return null;
  const h = arr.filter(s => s.status === 'TARGET_HIT').length;
  return { h, t: arr.length, r: Math.round(h / arr.length * 100) };
}
const pct   = v => v === null ? '—' : v + '%';
const avgOf = arr => {
  const v = arr.filter(s => s.pnlPct != null);
  return v.length ? +(v.reduce((a, s) => a + s.pnlPct, 0) / v.length).toFixed(1) : null;
};
const clr   = r => r >= 55 ? '#10b981' : r >= 40 ? '#f59e0b' : '#ef4444';
const glow  = r => r >= 55 ? '0 0 12px #10b98133' : r >= 40 ? '0 0 12px #f59e0b33' : '0 0 12px #ef444433';

// ── Animated ring (win rate donut) ────────────────────────────
function RingGauge({ value, size = 88, stroke = 9, label, sub, color }) {
  const r     = (size - stroke) / 2;
  const circ  = 2 * Math.PI * r;
  const dash  = (value / 100) * circ;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1e293b" strokeWidth={stroke} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 1s cubic-bezier(.4,0,.2,1)', filter: `drop-shadow(${glow(value)})` }} />
      </svg>
      <div style={{ marginTop: -size * 0.6, height: size * 0.5, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 0 }}>
        <div style={{ fontSize: size * 0.22, fontWeight: 900, color, letterSpacing: -1, lineHeight: 1 }}>{value}%</div>
        {label && <div style={{ fontSize: size * 0.11, color: '#94a3b8', fontWeight: 600, marginTop: 2 }}>{label}</div>}
      </div>
      {sub && <div style={{ fontSize: 9, color: '#64748b', fontWeight: 600, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Spark bar (horizontal gradient bar) ──────────────────────
function SparkBar({ value, max = 100, color, height = 6 }) {
  const w = Math.min(100, max > 0 ? (value / max) * 100 : 0);
  return (
    <div style={{ background: '#1e293b', borderRadius: 99, height, overflow: 'hidden', flex: 1 }}>
      <div style={{
        height: '100%', width: w + '%', borderRadius: 99,
        background: `linear-gradient(90deg, ${color}88, ${color})`,
        transition: 'width .8s cubic-bezier(.4,0,.2,1)',
        boxShadow: `0 0 6px ${color}66`,
      }} />
    </div>
  );
}

// ── Timeline sparkline ────────────────────────────────────────
function MiniSparkline({ points, width = 100, height = 32 }) {
  if (!points?.length) return null;
  const min  = Math.min(...points);
  const max  = Math.max(...points);
  const range = max - min || 1;
  const xs   = points.map((_, i) => (i / (points.length - 1)) * width);
  const ys   = points.map(p => height - ((p - min) / range) * (height - 4) - 2);
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x},${ys[i]}`).join(' ');
  const last = points[points.length - 1];
  const color = last >= 50 ? '#10b981' : last >= 35 ? '#f59e0b' : '#ef4444';
  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L${xs[xs.length-1]},${height} L${xs[0]},${height} Z`} fill="url(#sg)" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r={3} fill={color} />
    </svg>
  );
}

// ── Hexagon stat tile ─────────────────────────────────────────
function StatTile({ label, value, sub, color = '#10b981', size = 'md' }) {
  const isLg = size === 'lg';
  return (
    <div style={{
      background: 'linear-gradient(135deg, #0f172a, #1e293b)',
      border: `1px solid ${color}33`,
      borderRadius: 14, padding: isLg ? '16px 18px' : '11px 14px',
      display: 'flex', flexDirection: 'column', gap: 3,
      boxShadow: `inset 0 1px 0 ${color}22`,
    }}>
      <div style={{ fontSize: 8, fontWeight: 800, color: '#475569', letterSpacing: 1.5, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: isLg ? 28 : 22, fontWeight: 900, color, lineHeight: 1, letterSpacing: -1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: '#64748b', fontWeight: 600 }}>{sub}</div>}
    </div>
  );
}

// ── Radial time clock ─────────────────────────────────────────
function TimeClock({ sessions }) {
  const size = 180, cx = size / 2, cy = size / 2, rOuter = 78, rInner = 44;
  const slots = [
    { start: 0,   end: 0.08, label: '9:15', key: 'Opening 9:15–9:45' },
    { start: 0.08, end: 0.22, label: '9:45', key: 'Early 9:45–10:30' },
    { start: 0.22, end: 0.50, label: '10:30', key: 'Mid 10:30–12:30' },
    { start: 0.50, end: 0.73, label: '12:30', key: 'Afternoon 12:30–2' },
    { start: 0.73, end: 1.0,  label: '2:00', key: 'Pre-close 2–3:30' },
  ];
  function arc(pStart, pEnd, rO, rI) {
    const a1 = (pStart * 2 * Math.PI) - Math.PI / 2;
    const a2 = (pEnd   * 2 * Math.PI) - Math.PI / 2;
    const x1 = cx + rO * Math.cos(a1), y1 = cy + rO * Math.sin(a1);
    const x2 = cx + rO * Math.cos(a2), y2 = cy + rO * Math.sin(a2);
    const x3 = cx + rI * Math.cos(a2), y3 = cy + rI * Math.sin(a2);
    const x4 = cx + rI * Math.cos(a1), y4 = cy + rI * Math.sin(a1);
    const lg = pEnd - pStart > 0.5 ? 1 : 0;
    return `M${x1},${y1} A${rO},${rO},0,${lg},1,${x2},${y2} L${x3},${y3} A${rI},${rI},0,${lg},0,${x4},${y4} Z`;
  }
  return (
    <svg width={size} height={size}>
      <circle cx={cx} cy={cy} r={rOuter + 4} fill="none" stroke="#1e293b" strokeWidth={1} />
      {slots.map((sl, i) => {
        const sess = sessions.find(s => s.label === sl.key);
        const r2   = sess?.r ?? 0;
        const color = r2 >= 55 ? '#10b981' : r2 >= 40 ? '#f59e0b' : r2 > 0 ? '#ef4444' : '#334155';
        const gap   = 0.01;
        return (
          <g key={i}>
            <path d={arc(sl.start + gap, sl.end - gap, rOuter, rInner)} fill={color} opacity={r2 > 0 ? 0.85 : 0.25}
              style={{ filter: r2 >= 55 ? `drop-shadow(0 0 6px ${color}88)` : 'none' }} />
            {r2 > 0 && (() => {
              const mid = (sl.start + sl.end) / 2;
              const a   = mid * 2 * Math.PI - Math.PI / 2;
              const rM  = (rOuter + rInner) / 2;
              return (
                <text x={cx + rM * Math.cos(a)} y={cy + rM * Math.sin(a)}
                  textAnchor="middle" dominantBaseline="middle"
                  style={{ fontSize: 9, fontWeight: 800, fill: '#fff' }}>{r2}%</text>
              );
            })()}
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={rInner - 2} fill="#0f172a" />
      <text x={cx} y={cy - 6} textAnchor="middle" style={{ fontSize: 11, fill: '#94a3b8', fontWeight: 700 }}>BEST</text>
      <text x={cx} y={cy + 8} textAnchor="middle" style={{ fontSize: 11, fill: '#94a3b8', fontWeight: 700 }}>TIME</text>
    </svg>
  );
}

// ── Confidence heatmap ────────────────────────────────────────
function ConfHeatmap({ bands }) {
  const max = Math.max(...bands.map(b => b.t), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {bands.map(b => {
        const c = clr(b.r);
        return (
          <div key={b.band} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', minWidth: 52, textAlign: 'right' }}>{b.band}</div>
            <SparkBar value={b.t} max={max} color={c} height={20} />
            <div style={{ minWidth: 48, textAlign: 'right' }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: c }}>{pct(b.r)}</span>
              <span style={{ fontSize: 8, color: '#475569', marginLeft: 4 }}>·{b.t}</span>
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 8, color: '#334155', marginTop: 2, textAlign: 'center' }}>
        bar width = signal volume · color = win rate
      </div>
    </div>
  );
}

// ── Underlying leaderboard ────────────────────────────────────
function Leaderboard({ items }) {
  const best = items[0]?.r || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      {items.map((x, i) => {
        const c = clr(x.r);
        return (
          <div key={x.u} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 20, height: 20, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: i === 0 ? '#fbbf24' : i === 1 ? '#94a3b8' : i === 2 ? '#cd7c3e' : '#1e293b',
              fontSize: 9, fontWeight: 900, color: i < 3 ? '#0f172a' : '#64748b',
            }}>{i + 1}</div>
            <div style={{ flex: 1, fontSize: 10, fontWeight: 700, color: '#e2e8f0' }}>{x.u}</div>
            <SparkBar value={x.r} max={best} color={c} height={14} />
            <div style={{ minWidth: 60, textAlign: 'right' }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: c }}>{pct(x.r)}</span>
              <span style={{ fontSize: 8, color: '#475569', marginLeft: 4 }}>n={x.t}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Daily P&L timeline ────────────────────────────────────────
function DailyTimeline({ rows }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {rows.map(([date, dd], i) => {
        const total = dd.hits + dd.sls;
        const wr2   = total ? Math.round(dd.hits / total * 100) : null;
        const c     = wr2 >= 55 ? '#10b981' : wr2 >= 35 ? '#f59e0b' : '#ef4444';
        const isPos = dd.pnl >= 0;
        return (
          <div key={date} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
            background: i % 2 === 0 ? '#0f172a' : '#111827',
            borderBottom: '1px solid #1e293b',
          }}>
            <div style={{ fontSize: 9, color: '#64748b', fontWeight: 700, minWidth: 68 }}>{date}</div>
            <div style={{
              width: 6, height: 6, borderRadius: '50%', background: c,
              boxShadow: `0 0 5px ${c}`,
              flexShrink: 0,
            }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <SparkBar value={dd.hits} max={total || 1} color="#10b981" height={5} />
                <SparkBar value={dd.sls}  max={total || 1} color="#ef4444" height={5} />
              </div>
              <div style={{ fontSize: 8, color: '#475569' }}>{dd.hits}W · {dd.sls}L</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: c }}>{pct(wr2)}</div>
              <div style={{ fontSize: 9, fontWeight: 700, color: isPos ? '#10b981' : '#ef4444' }}>
                {isPos ? '+' : ''}{dd.pnl.toFixed(1)}%
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Signal flow (CE vs PE battle) ────────────────────────────
function CEPEFlow({ ceWR, peWR, ceSignals, peSignals }) {
  const ceR = ceWR?.r ?? 0, peR = peWR?.r ?? 0;
  const ceAvg = avgOf(ceSignals), peAvg = avgOf(peSignals);
  return (
    <div style={{ display: 'flex', gap: 0, borderRadius: 12, overflow: 'hidden', border: '1px solid #1e293b' }}>
      {[
        { label: 'CE 📈', r: ceR, t: ceWR?.t || 0, avg: ceAvg, color: '#3b82f6', side: 'left' },
        { label: 'PE 📉', r: peR, t: peWR?.t || 0, avg: peAvg, color: '#a855f7', side: 'right' },
      ].map((side, i) => (
        <div key={i} style={{
          flex: 1, padding: '14px 12px', textAlign: side.side === 'right' ? 'right' : 'left',
          background: `linear-gradient(135deg, ${side.color}11, ${side.color}06)`,
          borderRight: i === 0 ? '1px solid #1e293b' : 'none',
        }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: side.color, letterSpacing: 1, marginBottom: 6 }}>{side.label}</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: clr(side.r), letterSpacing: -1 }}>{pct(side.r)}</div>
          <div style={{ fontSize: 9, color: '#64748b', marginTop: 3 }}>n={side.t}</div>
          {side.avg !== null && (
            <div style={{ fontSize: 10, fontWeight: 700, color: side.avg >= 0 ? '#10b981' : '#ef4444', marginTop: 4 }}>
              avg {side.avg >= 0 ? '+' : ''}{side.avg}%
            </div>
          )}
        </div>
      ))}
      <div style={{
        position: 'absolute', left: '50%', transform: 'translateX(-50%)',
        fontSize: 8, color: '#334155', fontWeight: 800, padding: '2px 6px',
        background: '#0f172a', borderRadius: 4, marginTop: 4,
      }}>VS</div>
    </div>
  );
}

// ── Composite score arc ───────────────────────────────────────
function CSArc({ rows }) {
  const order = ['Strong Bear ≤-2', 'Weak Bear -2..-0.5', 'Neutral ±0.5', 'Weak Bull 0.5..2', 'Strong Bull ≥2'];
  const colors = ['#ef4444', '#f97316', '#94a3b8', '#22d3ee', '#10b981'];
  const sorted = order.map((label, i) => {
    const found = rows.find(r => r.label === label);
    return { label, r: found?.r ?? null, t: found?.t ?? 0, color: colors[i] };
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {sorted.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: 2, background: item.color, flexShrink: 0 }} />
          <div style={{ fontSize: 9, fontWeight: 600, color: '#94a3b8', minWidth: 120 }}>{item.label}</div>
          {item.r !== null ? (
            <>
              <SparkBar value={item.r} max={100} color={item.color} height={16} />
              <div style={{ minWidth: 52, textAlign: 'right' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: clr(item.r) }}>{pct(item.r)}</span>
                <span style={{ fontSize: 8, color: '#334155', marginLeft: 4 }}>·{item.t}</span>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 9, color: '#334155' }}>no data</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────
function Section({ title, children, accent = '#10b981' }) {
  return (
    <div style={{
      background: 'linear-gradient(135deg, #0f172a, #111827)',
      border: `1px solid ${accent}22`,
      borderRadius: 16, overflow: 'hidden', marginBottom: 12,
    }}>
      <div style={{
        padding: '10px 14px 8px',
        borderBottom: `1px solid ${accent}22`,
        background: `linear-gradient(90deg, ${accent}11, transparent)`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: accent }} />
        <span style={{ fontSize: 11, fontWeight: 800, color: '#e2e8f0', letterSpacing: 0.3 }}>{title}</span>
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  );
}

// ── Recent signals feed ───────────────────────────────────────
function SignalFeed({ signals }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {signals.map((s, i) => {
        const hit  = s.status === 'TARGET_HIT';
        const pnl  = s.pnlPct != null ? (s.pnlPct >= 0 ? '+' : '') + s.pnlPct.toFixed(1) + '%' : '—';
        const c    = hit ? '#10b981' : '#ef4444';
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 0', borderBottom: '1px solid #1e293b',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: hit ? '#10b98120' : '#ef444420', fontSize: 11,
            }}>{hit ? '✓' : '✕'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#e2e8f0' }}>{s.name || s.stock}</div>
              <div style={{ fontSize: 8, color: '#475569' }}>{s.date} · {(s.time || '').slice(0, 5)}</div>
            </div>
            <div style={{
              fontSize: 12, fontWeight: 900, color: c,
              textShadow: `0 0 8px ${c}88`,
            }}>{pnl}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────
export default function AnalysisPane() {
  const { gh, cfg, updateBadge, lg } = useApp();
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [data,    setData]    = useState(null);
  const [days,    setDays]    = useState(30);

  const load = useCallback(async () => {
    if (!gh.token || !gh.user || !gh.repo) { setError('GitHub not configured — go to ⚙ Settings.'); return; }
    setLoading(true); setError('');
    try {
      const signals = await ghReadMultipleDays(gh, days);
      if (!signals.length) { setData({ empty: true }); return; }

      const closed  = signals.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
      const expired = signals.filter(s => s.status === 'EXPIRED');
      const open    = signals.filter(s => s.status === 'OPEN');
      const total   = closed.length;

      if (total < 5) { setData({ insufficient: true, total, open: open.length }); return; }

      const overall   = wr(closed);
      const avgConf   = Math.round(closed.reduce((a, s) => a + (s.confidence || 50), 0) / total);
      const avgPnlAll = avgOf(closed);
      const avgPnlTgt = avgOf(closed.filter(s => s.status === 'TARGET_HIT'));
      const avgPnlSL  = avgOf(closed.filter(s => s.status === 'SL_HIT'));

      // Streak
      const recent = [...closed].reverse();
      let streak = 0, streakType = '';
      for (const s of recent) {
        const hit = s.status === 'TARGET_HIT';
        if (!streakType) streakType = hit ? 'W' : 'L';
        if ((streakType === 'W') === hit) streak++; else break;
      }

      // Win rate over time (rolling 7-day for sparkline)
      const byDate2 = {};
      closed.forEach(s => {
        const d = s.exitDate || s.date;
        if (!byDate2[d]) byDate2[d] = { hits: 0, t: 0 };
        byDate2[d].t++;
        if (s.status === 'TARGET_HIT') byDate2[d].hits++;
      });
      const sparkPoints = Object.entries(byDate2).sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, d]) => d.t >= 2 ? Math.round(d.hits / d.t * 100) : null).filter(v => v !== null);

      // By underlying
      const underlyings = [...new Set(closed.map(s => s.stock || s.name?.split(' ')[0]))];
      const byUnderlying = underlyings.map(u => {
        const g = closed.filter(s => (s.stock || s.name?.split(' ')[0]) === u);
        return { u, ...(wr(g) || { h: 0, t: 0, r: null }) };
      }).filter(x => x.t >= 3).sort((a, b) => (b.r || 0) - (a.r || 0)).slice(0, 8);

      // CE vs PE
      const ceSignals = closed.filter(s => s.optType === 'CE' || s.signal === 'CALL');
      const peSignals = closed.filter(s => s.optType === 'PE' || s.signal === 'PUT');

      // Signal types
      const sigTypes = ['BUY', 'SELL', 'MODERATE'].map(type => ({
        type,
        ...(wr(closed.filter(s => s.signal === type)) || { h: 0, t: 0, r: null }),
        avg: avgOf(closed.filter(s => s.signal === type)),
      })).filter(x => x.t >= 3);

      // Confidence bands
      const confBands = [60, 65, 70, 75, 80, 85, 90, 95].map(b => {
        const g = closed.filter(s => (s.confidence || 50) >= b && (s.confidence || 50) < b + 5);
        return { band: `${b}–${b + 4}%`, ...(wr(g) || { h: 0, t: 0, r: null }) };
      }).filter(x => x.t >= 2);

      // Sessions
      const getH = s => parseInt((s.time || '').split(':')[0]) || 0;
      const getM = s => parseInt((s.time || '').split(':')[1]) || 0;
      const sessions = [
        { label: 'Opening 9:15–9:45',  fn: s => { const h = getH(s), m = getM(s); return h === 9 && m >= 15 && m <= 45; } },
        { label: 'Early 9:45–10:30',   fn: s => { const h = getH(s), m = getM(s); return (h === 9 && m > 45) || (h === 10 && m <= 30); } },
        { label: 'Mid 10:30–12:30',    fn: s => { const h = getH(s); return h >= 11 && h <= 12; } },
        { label: 'Afternoon 12:30–2',  fn: s => { const h = getH(s); return h >= 12 && h < 14; } },
        { label: 'Pre-close 2–3:30',   fn: s => { const h = getH(s); return h >= 14; } },
      ];
      const timeBreak = sessions.map(({ label, fn }) => ({
        label, ...(wr(closed.filter(fn)) || { h: 0, t: 0, r: null }),
      })).filter(x => x.t >= 2);

      // Daily rows
      const byDate = {};
      closed.forEach(s => {
        const cd = s.exitDate || s.date;
        if (!byDate[cd]) byDate[cd] = { hits: 0, sls: 0, pnl: 0 };
        byDate[cd][s.status === 'TARGET_HIT' ? 'hits' : 'sls']++;
        byDate[cd].pnl += (s.pnlPct || 0);
      });
      const dailyRows = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 8);

      // CS buckets
      const scoredSignals = closed.filter(s => s.compositeScore != null);
      const csBuckets = [
        { label: 'Strong Bear ≤-2',    min: -99,  max: -2   },
        { label: 'Weak Bear -2..-0.5', min: -2,   max: -0.5 },
        { label: 'Neutral ±0.5',       min: -0.5, max: 0.5  },
        { label: 'Weak Bull 0.5..2',   min: 0.5,  max: 2    },
        { label: 'Strong Bull ≥2',     min: 2,    max: 99   },
      ];
      const csRows = scoredSignals.length >= 5
        ? csBuckets.map(b => {
          const g = scoredSignals.filter(s => s.compositeScore >= b.min && s.compositeScore < b.max);
          const r2 = wr(g);
          return r2 && r2.t >= 2 ? { label: b.label, r: r2.r, t: r2.t } : null;
        }).filter(Boolean) : [];

      // Alerts
      const alerts = [];
      if (overall.r < 35)      alerts.push({ level: 'danger', msg: `Win rate ${overall.r}% — signals losing systematically. Raise min confidence to 75%+.` });
      if (streak >= 4 && streakType === 'L') alerts.push({ level: 'danger', msg: `${streak} consecutive losses — pause and review signal quality.` });
      const badSess = timeBreak.filter(x => x.r !== null && x.t >= 5).sort((a, b) => (a.r || 0) - (b.r || 0))[0];
      if (badSess?.r < 15)     alerts.push({ level: 'warn', msg: `${badSess.label}: only ${badSess.r}% win rate — skip this window.` });
      if (avgConf > 72 && overall.r < 25) alerts.push({ level: 'warn', msg: `${avgConf}% avg confidence but only ${overall.r}% win rate — calibration needed.` });

      updateBadge('analysis', String(signals.length));
      lg(`Analysis: ${total} closed, ${open.length} open`, 'o');

      setData({
        signals, closed, open, expired, total, overall, avgConf, avgPnlAll, avgPnlTgt, avgPnlSL,
        streak, streakType, sparkPoints, byUnderlying, ceSignals, peSignals, ceWR: wr(ceSignals), peWR: wr(peSignals),
        sigTypes, confBands, timeBreak, dailyRows, csRows, scoredSignals, alerts,
      });
    } catch (e) {
      setError(e.message); lg('Analysis error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }, [gh, days, updateBadge, lg]);

  useEffect(() => { if (gh.token) load(); }, [gh.token, days]); // eslint-disable-line

  const darkBg = { background: '#0a0f1a', minHeight: '100vh' };

  return (
    <div style={darkBg}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <select value={days} onChange={e => setDays(+e.target.value)}
          style={{ flex: 1, background: '#1e293b', border: '1px solid #334155', borderRadius: 9, padding: '8px 12px', fontSize: 11, fontWeight: 700, color: '#e2e8f0', cursor: 'pointer' }}>
          {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <button onClick={load} disabled={loading}
          style={{ padding: '8px 18px', fontSize: 11, fontWeight: 800, borderRadius: 9, border: 'none', background: loading ? '#1e293b' : 'linear-gradient(135deg,#10b981,#0d9488)', color: '#fff', cursor: loading ? 'default' : 'pointer' }}>
          {loading ? '⏳' : '↻ Refresh'}
        </button>
      </div>

      {error   && <ErrorBanner title="⚠ Error" message={error} onRetry={load} />}
      {loading && <Spinner label="Reading signal history..." sub="Win rate · Time analysis · CompositeScore calibration" />}
      {!loading && data?.empty       && <EmptyState>📊 No signals in last {days} days — run scans to start logging</EmptyState>}
      {!loading && !data && !error   && <EmptyState>{gh.token ? '↻ Click Refresh to load' : '⚙ Configure GitHub in Settings first'}</EmptyState>}
      {!loading && data?.insufficient && <EmptyState>Need 5+ closed signals · {data.total} closed · {data.open} open so far</EmptyState>}

      {!loading && data && !data.empty && !data.insufficient && (() => {
        const d = data;
        const pnlColor = v => v === null ? '#94a3b8' : v >= 0 ? '#10b981' : '#ef4444';
        const fmt = v => v === null ? '—' : (v >= 0 ? '+' : '') + v + '%';

        return (
          <div>
            {/* Alerts */}
            {d.alerts.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                {d.alerts.map((a, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 10, padding: '10px 12px', marginBottom: 6,
                    borderRadius: 10, alignItems: 'flex-start',
                    background: a.level === 'danger' ? '#450a0a' : '#431407',
                    border: `1px solid ${a.level === 'danger' ? '#ef4444' : '#f97316'}44`,
                  }}>
                    <span style={{ fontSize: 14, flexShrink: 0 }}>{a.level === 'danger' ? '🚨' : '⚠️'}</span>
                    <span style={{ fontSize: 10, color: a.level === 'danger' ? '#fca5a5' : '#fdba74', lineHeight: 1.5 }}>{a.msg}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Hero stats row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, marginBottom: 12 }}>
              <div style={{
                gridColumn: '1 / -1', background: 'linear-gradient(135deg,#0f172a,#1a1f35)',
                border: '1px solid #10b98133', borderRadius: 16, padding: '16px 14px',
                display: 'flex', alignItems: 'center', gap: 16,
              }}>
                <RingGauge value={d.overall.r} color={clr(d.overall.r)} label="WIN RATE" sub={`${d.overall.h}W · ${d.total - d.overall.h}L`} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: 8, color: '#475569', fontWeight: 700, letterSpacing: 1 }}>AVG WIN</div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: '#10b981' }}>{fmt(d.avgPnlTgt)}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 8, color: '#475569', fontWeight: 700, letterSpacing: 1 }}>AVG LOSS</div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: '#ef4444' }}>{fmt(d.avgPnlSL)}</div>
                    </div>
                  </div>
                  <MiniSparkline points={d.sparkPoints} width={180} height={36} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#475569' }}>
                    <span>Daily win rate trend ({d.sparkPoints.length} days)</span>
                    <span>{d.streakType === 'W' ? '🔥' : '⚠'} {d.streak}{d.streakType} streak</span>
                  </div>
                </div>
              </div>
              <StatTile label="Avg Confidence" value={d.avgConf + '%'} sub="at signal entry" color="#6366f1" />
              <StatTile label="Open Watching" value={d.open.length} sub={`${d.expired.length} expired`} color="#f59e0b" />
            </div>

            {/* CE vs PE */}
            {d.ceWR?.t >= 3 && d.peWR?.t >= 3 && (
              <Section title="CE vs PE Battle" accent="#6366f1">
                <CEPEFlow ceWR={d.ceWR} peWR={d.peWR} ceSignals={d.ceSignals} peSignals={d.peSignals} />
                {d.sigTypes.length > 0 && (
                  <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {d.sigTypes.map(st => (
                      <div key={st.type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', minWidth: 60 }}>{st.type}</div>
                        <SparkBar value={st.r || 0} max={100} color={clr(st.r || 0)} height={16} />
                        <span style={{ fontSize: 10, fontWeight: 800, color: clr(st.r || 0), minWidth: 36 }}>{pct(st.r)}</span>
                        <span style={{ fontSize: 8, color: '#334155', minWidth: 30 }}>n={st.t}</span>
                        {st.avg !== null && <span style={{ fontSize: 9, fontWeight: 700, color: pnlColor(st.avg) }}>{fmt(st.avg)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {/* Time clock */}
            {d.timeBreak.length >= 3 && (
              <Section title="Best Time to Trade" accent="#f59e0b">
                <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <TimeClock sessions={d.timeBreak} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {d.timeBreak.map(t => (
                      <div key={t.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 6, height: 6, borderRadius: 2, background: clr(t.r || 0), flexShrink: 0 }} />
                        <div style={{ fontSize: 9, color: '#94a3b8', flex: 1 }}>{t.label.replace('Opening ', '').replace('Early ', '').replace('Mid ', '').replace('Afternoon ', '').replace('Pre-close ', '')}</div>
                        <span style={{ fontSize: 10, fontWeight: 800, color: clr(t.r || 0) }}>{pct(t.r)}</span>
                        <span style={{ fontSize: 8, color: '#334155' }}>·{t.t}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>
            )}

            {/* Confidence heatmap */}
            {d.confBands.length >= 3 && (
              <Section title="Confidence → Win Rate" accent="#22d3ee">
                <ConfHeatmap bands={d.confBands} />
              </Section>
            )}

            {/* Underlying leaderboard */}
            {d.byUnderlying.length >= 2 && (
              <Section title="Win Rate by Underlying" accent="#a855f7">
                <Leaderboard items={d.byUnderlying} />
              </Section>
            )}

            {/* CompositeScore */}
            {d.csRows.length >= 3 && (
              <Section title="CompositeScore Calibration" accent="#fb923c">
                <CSArc rows={d.csRows} />
                <div style={{ fontSize: 8, color: '#334155', marginTop: 8 }}>
                  Highest win rate bucket → raise that range weight in computeCtxFromCandles()
                </div>
              </Section>
            )}

            {/* Daily timeline */}
            {d.dailyRows.length >= 3 && (
              <Section title="Daily Performance" accent="#10b981">
                <DailyTimeline rows={d.dailyRows} />
              </Section>
            )}

            {/* Recent signals */}
            <Section title="Recent Closed Signals" accent="#6366f1">
              <SignalFeed signals={d.closed.slice(-12).reverse()} />
            </Section>
          </div>
        );
      })()}
    </div>
  );
}

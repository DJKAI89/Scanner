import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken } from '../services/api';
import { getMtf, describeMtf } from '../services/mtf';

const GRADE = {
  A: { bg: '#dcfce7', c: '#15803d' }, B: { bg: '#dbeafe', c: '#1d4ed8' },
  C: { bg: '#fef3c7', c: '#b45309' }, AVOID: { bg: '#fee2e2', c: '#b91c1c' },
};
const TREND_C = (d) => (d > 0 ? '#15803d' : d < 0 ? '#b91c1c' : '#64748b');
const lvl = (n) => Math.round(n).toLocaleString('en-IN');

export function GradePill({ label, g }) {
  if (!g) return null;
  const s = GRADE[g.grade] || GRADE.C;
  return (
    <span title={g.why || (g.reasons || []).join(' · ')} style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 20, background: s.bg, color: s.c, whiteSpace: 'nowrap' }}>
      {label} {g.grade}{g.veto ? ' (blocked)' : ''}
    </span>
  );
}

// Full top-down view of one instrument: trend per timeframe, nearest levels, grade for a long and a short.
// Loads through the same cache the scanners use, so opening it costs no extra calls after a scan.
export default function MtfPanel({ instrumentKey, price, title = 'Multi-Timeframe Analysis', defaultOpen = true, m5 = null }) {
  const { token, onTokenExpired, lg } = useApp();
  const accessToken = resolveAccessToken(token);
  const priceRef = useRef(price);
  priceRef.current = price;
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [open, setOpen] = useState(defaultOpen);

  const load = useCallback(async () => {
    if (!instrumentKey || !accessToken) { setState({ loading: false, data: null, error: !accessToken ? 'Not connected' : '' }); return; }
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      const ctx = await getMtf({ key: instrumentKey, price: priceRef.current, token: accessToken, onTokenExpired, m5, lg });
      setState({ loading: false, data: describeMtf(ctx), error: ctx ? '' : 'No weekly/daily history could be loaded for this instrument.' });
    } catch (e) { setState({ loading: false, data: null, error: e.message }); }
  }, [instrumentKey, accessToken]); // eslint-disable-line

  useEffect(() => { if (price > 0) load(); }, [instrumentKey, accessToken, price > 0]); // eslint-disable-line

  const d = state.data;
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, marginBottom: 12, boxShadow: '0 1px 4px #0000000a', overflow: 'hidden' }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: '#7c3aed' }} />
        <span style={{ fontSize: 12, fontWeight: 800, color: '#0f172a', flex: 1 }}>{title}</span>
        {d && <><GradePill label="Long" g={d.long} /><GradePill label="Short" g={d.short} /></>}
        <span style={{ fontSize: 10, color: '#94a3b8' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px' }}>
          {state.loading && <div style={{ fontSize: 11, color: '#94a3b8', padding: '6px 0' }}>Loading weekly, daily, 60-min and 15-min history...</div>}
          {!state.loading && state.error && (
            <div style={{ fontSize: 11, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px' }}>
              {state.error}{' '}
              <button onClick={load} style={{ border: 'none', background: 'none', color: '#1d4ed8', fontWeight: 700, cursor: 'pointer', fontSize: 11 }}>Retry</button>
            </div>
          )}
          {d && (
            <>
              {d.rows.map((r) => (
                <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, padding: '7px 0', borderTop: '1px solid #f1f5f9', fontSize: 11 }}>
                  <span style={{ fontWeight: 800, color: '#0f172a', minWidth: 62 }}>{r.label}</span>
                  <span style={{ fontWeight: 800, color: r.ok ? TREND_C(r.dir) : '#94a3b8' }}>{r.state}</span>
                  <span style={{ color: '#94a3b8', fontSize: 10, textAlign: 'right', flex: 1 }}>{r.ok ? `${r.structure} · ${r.rule}` : 'not available'}</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 8, marginTop: 2, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.6, marginBottom: 4 }}>RESISTANCE ABOVE</div>
                  {d.above.length ? d.above.map((l, i) => <div key={i} style={{ fontSize: 10, color: '#b91c1c', padding: '1px 0' }}>{lvl(l.price)} <span style={{ color: '#94a3b8' }}>({l.src}{l.atr != null ? `, ${l.atr} ATR` : ''})</span></div>) : <div style={{ fontSize: 10, color: '#94a3b8' }}>none nearby</div>}
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.6, marginBottom: 4 }}>SUPPORT BELOW</div>
                  {d.below.length ? d.below.map((l, i) => <div key={i} style={{ fontSize: 10, color: '#15803d', padding: '1px 0' }}>{lvl(l.price)} <span style={{ color: '#94a3b8' }}>({l.src}{l.atr != null ? `, ${l.atr} ATR` : ''})</span></div>) : <div style={{ fontSize: 10, color: '#94a3b8' }}>none nearby</div>}
                </div>
              </div>
              {(d.long?.why || d.short?.why) && (
                <div style={{ fontSize: 10, color: '#b45309', marginTop: 8, lineHeight: 1.5 }}>
                  {d.long?.why && <div>Long: {d.long.why}</div>}{d.short?.why && <div>Short: {d.short.why}</div>}
                </div>
              )}
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8, lineHeight: 1.5 }}>
                Higher timeframes (weekly, daily, 60-min) outrank the entry timeframe: a trade against the daily trend plus another higher timeframe is blocked, not just penalised.
                {d.atrD ? ` Daily ATR ₹${d.atrD}.` : ''}{d.partial ? ' Some timeframes had no data, so the grade uses the rest.' : ''}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

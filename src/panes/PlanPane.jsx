import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner } from '../components/common.jsx';
import { resolveAccessToken } from '../services/api';
import { effectiveOptionCfg } from '../services/optionScan';
import { loadPlanInputs, assemblePlan, logTriggered, loadPlanHistory } from '../services/planService';
import { fmtMin } from '../services/planEngine';

const REFRESH_MS = 60000;
const inr = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const lvl = (n) => Math.round(n).toLocaleString('en-IN');

const BIAS = {
  BULLISH:  { label: 'Bullish bias',  bg: '#dcfce7', c: '#15803d' },
  BEARISH:  { label: 'Bearish bias',  bg: '#fee2e2', c: '#b91c1c' },
  NO_TRADE: { label: 'No-trade',      bg: '#fef3c7', c: '#b45309' },
};
const STATE = {
  WAITING:   { label: 'Waiting for trigger', bg: '#e0e7ff', c: '#4338ca' },
  TRIGGERED: { label: 'Triggered',           bg: '#dcfce7', c: '#15803d' },
};
const STATUS_CHIP = {
  OPEN:       { label: 'Open',   bg: '#e0e7ff', c: '#4338ca' },
  TARGET_HIT: { label: 'Target', bg: '#dcfce7', c: '#15803d' },
  SL_HIT:     { label: 'SL hit', bg: '#fee2e2', c: '#b91c1c' },
  EXPIRED:    { label: 'Expired', bg: '#f1f5f9', c: '#64748b' },
};

const Pill = ({ s }) => (
  <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 20, background: s.bg, color: s.c, whiteSpace: 'nowrap' }}>{s.label}</span>
);
const Card = ({ children, style }) => (
  <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 14, marginBottom: 12, boxShadow: '0 1px 4px #0000000a', ...style }}>{children}</div>
);
const Cap = ({ children }) => (
  <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.8, margin: '4px 2px 8px' }}>{children}</div>
);
const KV = ({ items }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
    {items.map(([k, v]) => (
      <div key={k} style={{ background: '#f8fafc', borderRadius: 8, padding: '7px 9px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.4 }}>{k}</div>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#0f172a' }}>{v}</div>
      </div>
    ))}
  </div>
);

function TradeCard({ p }) {
  const c = p.contract;
  const st = STATE[p.state] || STATE.WAITING;
  return (
    <Card style={{ border: `1px solid ${p.state === 'TRIGGERED' ? '#86efac' : '#c7d2fe'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 900, color: '#0f172a' }}>{p.und} {c.strike} {p.side}</div>
        <Pill s={st} />
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Setup: {p.setupLabel}</div>
      <div style={{ fontSize: 11, color: '#0f172a', marginTop: 8, lineHeight: 1.5 }}>{p.triggerText}</div>
      <KV items={[
        [p.state === 'TRIGGERED' ? 'ENTRY NOW' : 'ENTRY LEVEL', `${p.und} ${lvl(p.entryLevel)}`],
        ['PREMIUM NOW', `₹${c.ltp}`],
        ['WRONG IF', `${p.dir === 1 ? 'closes below' : 'closes above'} ${lvl(p.invalidation)}`],
        ['PREMIUM STOP', `₹${c.stop}`],
        ['TARGETS', `T1 ₹${c.t1} · T2 ₹${c.t2}`],
        ['SIZE', `${c.sizing.lots} lot${c.sizing.lots > 1 ? 's' : ''} · risk ${inr(c.sizing.maxLossRupees)}`],
      ]} />
      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8, lineHeight: 1.5 }}>
        Index targets {lvl(p.t1Level)} / {lvl(p.t2Level)} · expiry {c.expiry} ({c.dte}d) · delta {c.delta} · book half at T1, trail the rest · aim to be out by 14:30
      </div>
    </Card>
  );
}

export default function PlanPane() {
  const { token, cfg: cfgBase, mlModels, gh, lg, onTokenExpired, marketStatus } = useApp();
  const accessToken = resolveAccessToken(token);
  const cfg = effectiveOptionCfg(cfgBase, mlModels);
  const [data, setData] = useState(null);
  const [hist, setHist] = useState({ planToday: [], scorecard: [] });
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [lastAt, setLastAt] = useState(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (!accessToken) throw new Error('Not connected: add your Upstox token first.');
      setError('');
      const inputs = await loadPlanInputs({ token: accessToken, cfg, onTokenExpired, lg, setProgress });
      let h = hist;
      if (gh?.token && gh?.user && gh?.repo) { h = await loadPlanHistory(gh); setHist(h); }
      let assembled = assemblePlan(inputs, cfg, h.planToday);
      // Triggered plans are logged (paper) so the monitor + scorecard can track them.
      if (marketStatus.open && gh?.token && assembled.plan.trades.some((t) => t.state === 'TRIGGERED')) {
        const n = await logTriggered(gh, assembled.plan, inputs.vix, lg);
        if (n > 0) { h = await loadPlanHistory(gh); setHist(h); assembled = assemblePlan(inputs, cfg, h.planToday); }
      }
      setData(assembled);
      setLastAt(new Date());
    } catch (e) { setError(e.message); lg('Plan: ' + e.message, 'w'); }
    finally { setLoading(false); setProgress(''); busy.current = false; }
  }, [accessToken, cfg, gh, marketStatus.open]); // eslint-disable-line

  useEffect(() => { load(); }, [accessToken]); // eslint-disable-line
  useEffect(() => {
    if (!marketStatus.open) return undefined;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [marketStatus.open, load]);

  if (loading && !data) return <Spinner label="Building today's plan..." sub={progress} />;

  const head = data?.headline;
  const bias = BIAS[head?.bias] || BIAS.NO_TRADE;
  const meter = data?.plan.meter;
  const lossPct = meter && meter.limitRupees > 0 ? Math.min(100, meter.lossRupees / meter.limitRupees * 100) : 0;

  return (
    <div style={{ padding: '0 0 24px' }}>
      {error && <ErrorBanner message={error} />}

      <div style={{ fontSize: 10, color: '#64748b', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 10px', marginBottom: 10, lineHeight: 1.5 }}>
        Paper mode: triggered plans are logged to your Signal Log, not sent as orders. Plans refresh every minute while this page is open{marketStatus.open ? '' : ' (market closed: showing the last state)'}; logging only happens while it is open.
        {lastAt && <span> · Updated {lastAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>}
      </div>

      {head && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.8 }}>MARKET VIEW · {fmtMin(data.min)} IST</div>
            <Pill s={bias} />
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 12, color: '#475569', lineHeight: 1.7 }}>
            {head.reasons.map((r, i) => <li key={i}>{r}</li>)}
            {head.blockers.map((r, i) => <li key={'b' + i} style={{ color: '#b45309', fontWeight: 700 }}>{r}</li>)}
          </ul>
          <KV items={[
            ['SUPPORT (PUT WALL)', head.levels.support ? lvl(head.levels.support) : '—'],
            ['RESISTANCE (CALL WALL)', head.levels.resistance ? lvl(head.levels.resistance) : '—'],
            ['MAX PAIN', head.levels.maxPain ? lvl(head.levels.maxPain) : '—'],
            ['INDIA VIX', data.vix.toFixed(1)],
          ]} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {data.perIndex.map((ix) => {
              const b = BIAS[ix.view.bias] || BIAS.NO_TRADE;
              return <span key={ix.name} style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 20, background: b.bg, color: b.c }}>{ix.name}: {b.label.replace(' bias', '')}</span>;
            })}
          </div>
        </Card>
      )}

      {meter && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.8 }}>RISK TODAY</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>trades {meter.trades} of {meter.maxTrades}</div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12 }}>
            <span>Loss used</span>
            <b>{inr(meter.lossRupees)} of {inr(meter.limitRupees)} limit ({meter.dailyLossR}R)</b>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: '#f1f5f9', overflow: 'hidden', marginTop: 6 }}>
            <div style={{ width: `${lossPct}%`, height: 6, background: lossPct >= 100 ? '#dc2626' : '#16a34a' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12 }}>
            <span>Open risk</span><b>{inr(meter.openRisk)}</b>
          </div>
          {meter.halted && <div style={{ marginTop: 8, fontSize: 11, fontWeight: 700, color: '#b91c1c' }}>{meter.haltReason}</div>}
        </Card>
      )}

      {hist.planToday.length > 0 && (
        <>
          <Cap>ENTERED TODAY</Cap>
          {hist.planToday.map((s) => {
            const chip = STATUS_CHIP[s.status] || STATUS_CHIP.OPEN;
            return (
              <Card key={s.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 14, fontWeight: 900 }}>{s.name}</div><Pill s={chip} />
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{s.note}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 8 }}>
                  <span>Entry ₹{s.entry} · stop ₹{s.sl} · {s.planLots || '?'} lot</span>
                  <b style={{ color: (s.pnlPct ?? s.livePnlPct ?? 0) >= 0 ? '#16a34a' : '#dc2626' }}>
                    {s.pnlPct != null ? `${s.pnlPct > 0 ? '+' : ''}${s.pnlPct}%` : s.livePnlPct != null ? `${s.livePnlPct > 0 ? '+' : ''}${s.livePnlPct}%` : '—'}
                  </b>
                </div>
              </Card>
            );
          })}
        </>
      )}

      <Cap>TODAY'S TRADES (MAX {meter?.maxTrades ?? 3})</Cap>
      {data?.plan.trades.length ? data.plan.trades.map((p) => <TradeCard key={p.id} p={p} />) : (
        <Card>
          <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.6 }}>
            {head?.bias === 'NO_TRADE'
              ? 'No trade plans right now. Standing aside is a valid position: see the reasons in the market view above.'
              : 'The market has a bias, but no setup is ready or fits your risk yet. Plans appear here when one does.'}
          </div>
        </Card>
      )}

      {data?.plan.skipped.length > 0 && (
        <>
          <Cap>SKIPPED / DROPPED</Cap>
          <Card style={{ padding: '4px 14px' }}>
            {data.plan.skipped.map((p, i) => (
              <div key={p.id + i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderTop: i ? '1px solid #f1f5f9' : 'none', fontSize: 11 }}>
                <span style={{ fontWeight: 800 }}>{p.und} · {p.setupLabel}</span>
                <span style={{ color: '#b45309', textAlign: 'right' }}>{p.skipReason || 'not tradeable'}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      <Cap>SETUP SCORECARD · 30 DAYS</Cap>
      <Card style={{ padding: '4px 14px' }}>
        {hist.scorecard.length === 0 ? (
          <div style={{ fontSize: 11, color: '#94a3b8', padding: '10px 0' }}>No closed plan trades yet. Results appear after plans trigger and resolve.</div>
        ) : hist.scorecard.map((s, i) => (
          <div key={s.setup} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderTop: i ? '1px solid #f1f5f9' : 'none', fontSize: 11 }}>
            <span style={{ fontWeight: 800 }}>{s.label}</span>
            <span style={{ color: s.tooFew ? '#94a3b8' : s.avgR >= 0 ? '#16a34a' : '#dc2626' }}>
              n={s.n} · {s.avgR > 0 ? '+' : ''}{s.avgR}R avg · {s.winRate}% win{s.tooFew ? ' · too few to judge' : ''}
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

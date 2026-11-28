import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { fetchFundamental, resolveAccessToken } from '../services/api';
import { Spinner } from './common.jsx';

const LOWER_BETTER = new Set(['P/E', 'P/B', 'EV/EBITDA']);
const SH_LABEL = { promoters: 'Promoters', fii: 'FII', other_dii: 'Other DII', mutual_funds: 'Mutual funds', retail_and_other: 'Retail and others' };
const SH_COLOR = { promoters: '#2563eb', fii: '#d97706', other_dii: '#b45309', mutual_funds: '#7c3aed', retail_and_other: '#64748b' };
const FIN_LABEL = { revenue: 'Revenue', operating_profit: 'Operating profit', net_profit: 'Net profit' };

const toNum = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const inr = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

function Card({ title, accent = '#2563eb', right, children }) {
  return (
    <div className="fd-card">
      <div className="fd-hd" style={{ borderLeftColor: accent }}>
        <span>{title}</span>{right}
      </div>
      <div className="fd-bd">{children}</div>
    </div>
  );
}
const Unavailable = ({ what }) => <div className="fd-na">{what} is not available for this instrument.</div>;

function RatiosCard({ rows, symbol }) {
  if (!rows?.length) return <Card title="Key ratios" accent="#2563eb"><Unavailable what="Key ratios data" /></Card>;
  return (
    <Card title="Key ratios" accent="#2563eb">
      <div className="dt-wrap" style={{ margin: 0 }}>
        <table className="dt">
          <thead><tr><th>Ratio</th><th /><th className="r">{symbol}</th><th className="r">Sector</th></tr></thead>
          <tbody>
            {rows.map((x) => {
              const c = toNum(x.company_value), s = toNum(x.sector_value);
              const better = c == null || s == null ? null : (LOWER_BETTER.has(x.name) ? c < s : c > s);
              return (
                <tr key={x.name}>
                  <td><b>{x.name}</b></td>
                  <td>{better == null ? '' : better ? '👍' : '👎'}</td>
                  <td className={'r b ' + (better == null ? '' : better ? 'up' : 'dn')}>{x.company_value ?? '—'}</td>
                  <td className="r">{x.sector_value ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="fd-legend"><span><i style={{ background: '#b91c1c' }} />Worse than sector</span><span><i style={{ background: '#15803d' }} />Better than sector</span></div>
    </Card>
  );
}

function HoldingsCard({ rows }) {
  if (!rows?.length) return <Card title="Shareholding" accent="#7c3aed"><Unavailable what="Shareholding data" /></Card>;
  const periods = (rows[0]?.history || []).map((h) => h.period);
  const latest = rows.map((r) => ({ cat: r.category, v: r.history?.[0]?.value ?? 0, prev: r.history?.[1]?.value }));
  return (
    <Card title="Shareholding" accent="#7c3aed" right={<span className="m">{periods[0] || ''}</span>}>
      <div className="pf-allocbar" role="img" aria-label="Shareholding pattern">
        {latest.map((x) => <span key={x.cat} style={{ width: Math.max(0, x.v) + '%', background: SH_COLOR[x.cat] || '#94a3b8' }} title={`${SH_LABEL[x.cat] || x.cat} ${x.v}%`} />)}
      </div>
      <div className="dt-wrap" style={{ margin: '10px 0 0' }}>
        <table className="dt">
          <thead><tr><th>Holder</th>{periods.map((p) => <th key={p} className="r">{p}</th>)}<th className="r">QoQ</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const d = r.history?.length > 1 ? +(r.history[0].value - r.history[1].value).toFixed(2) : null;
              return (
                <tr key={r.category}>
                  <td><i className="fd-dot" style={{ background: SH_COLOR[r.category] || '#94a3b8' }} /><b>{SH_LABEL[r.category] || r.category}</b></td>
                  {periods.map((p) => { const h = (r.history || []).find((x) => x.period === p); return <td key={p} className="r">{h ? h.value.toFixed(2) + '%' : '—'}</td>; })}
                  <td className={'r b ' + (d == null || d === 0 ? '' : d > 0 ? 'up' : 'dn')}>{d == null ? '—' : (d > 0 ? '+' : '') + d.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function FinancialsCard({ data, period, setPeriod, loading }) {
  const cats = data?.income_statement || [];
  const periods = (cats[0]?.history || []).map((h) => h.period);
  const toggle = (
    <span className="chip-row" style={{ margin: 0 }}>
      {[['yearly', 'Yearly'], ['quarterly', 'Quarterly']].map(([id, l]) => (
        <button key={id} className={'chip' + (period === id ? ' on' : '')} onClick={() => setPeriod(id)}>{l}</button>
      ))}
    </span>
  );
  return (
    <Card title="Financials (₹ Cr)" accent="#0d9488" right={toggle}>
      {loading ? <Spinner label="Loading..." /> : !cats.length ? <Unavailable what="Income statement data" /> : (
        <div className="dt-wrap" style={{ margin: 0 }}>
          <table className="dt">
            <thead><tr><th>{data?.type || 'consolidated'}</th>{periods.map((p) => <th key={p} className="r">{p}</th>)}</tr></thead>
            <tbody>
              {cats.map((c) => (
                <tr key={c.category}>
                  <td><b>{FIN_LABEL[c.category] || c.category}</b></td>
                  {periods.map((p) => {
                    const h = (c.history || []).find((x) => x.period === p);
                    const up = String(h?.change || '').startsWith('+');
                    return (
                      <td key={p} className="r">
                        <div className={'b ' + (h && h.value < 0 ? 'dn' : '')}>{h ? inr(h.value) : '—'}</div>
                        {h?.change && <div className={'dt-sub ' + (up ? 'up' : 'dn')}>{h.change}</div>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Balance sheet ──────────────────────────────────────────────
function BalanceCard({ data }) {
  const hist = data?.history || [];
  if (!hist.length) return <Card title="Balance sheet (₹ Cr)" accent="#2563eb"><Unavailable what="Balance sheet data" /></Card>;
  const cols = hist.slice(0, 5);
  const row = (label, fn, cls = '') => (
    <tr><td><b>{label}</b></td>{cols.map((h) => <td key={h.period} className={'r ' + cls}>{inr(fn(h))}</td>)}</tr>
  );
  return (
    <Card title="Balance sheet (₹ Cr)" accent="#2563eb" right={<span className="m">{data.type} · {data.time_period}</span>}>
      <div className="dt-wrap" style={{ margin: 0 }}>
        <table className="dt">
          <thead><tr><th />{cols.map((h) => <th key={h.period} className="r">{h.period}</th>)}</tr></thead>
          <tbody>
            {row('Total assets', (h) => h.total_asset)}
            {row('Total liabilities', (h) => h.total_liability)}
            {row('Assets minus liabilities', (h) => h.total_asset - h.total_liability, 'b')}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Cash flow ─────────────────────────────────────────────────
const CF_LABEL = { operating: 'Operating', investing: 'Investing', financing: 'Financing' };
function CashFlowCard({ data }) {
  const cats = data?.cash_flow || [];
  if (!cats.length) return <Card title="Cash flow (₹ Cr)" accent="#0d9488"><Unavailable what="Cash flow data" /></Card>;
  const periods = (cats[0]?.history || []).slice(0, 5).map((h) => h.period);
  return (
    <Card title="Cash flow (₹ Cr)" accent="#0d9488" right={<span className="m">{data.type} · {data.time_period}</span>}>
      <div className="dt-wrap" style={{ margin: 0 }}>
        <table className="dt">
          <thead><tr><th />{periods.map((p) => <th key={p} className="r">{p}</th>)}</tr></thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.category}>
                <td><b>{CF_LABEL[c.category] || c.category}</b></td>
                {periods.map((p) => {
                  const h = (c.history || []).find((x) => x.period === p);
                  const up = String(h?.change || '').startsWith('+');
                  return (
                    <td key={p} className="r">
                      <div className={'b ' + (h && h.value < 0 ? 'dn' : '')}>{h ? inr(h.value) : '—'}</div>
                      {h?.change && <div className={'dt-sub ' + (up ? 'up' : 'dn')}>{h.change}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="m" style={{ marginTop: 8 }}>Negative investing and financing flows are normal (money spent on growth, debt and dividends).</div>
    </Card>
  );
}

// ── Corporate actions ─────────────────────────────────────────
function ActionsCard({ rows }) {
  if (!rows?.length) return <Card title="Corporate actions" accent="#b45309"><div className="fd-na" style={{ margin: 0 }}>No dividends, bonus, split or rights issues on record.</div></Card>;
  return (
    <Card title="Corporate actions" accent="#b45309">
      {rows.map((a, i) => {
        const detail = (a.event_details || []).find((d) => d.name === 'Details')?.value;
        const rec = (a.event_details || []).find((d) => /record date/i.test(d.name))?.value;
        const ann = (a.event_details || []).find((d) => /announcement/i.test(d.name))?.value;
        return (
          <div key={i} style={{ padding: '10px 0', borderBottom: i < rows.length - 1 ? '1px solid #f1f5f9' : 'none' }}>
            <div className="r" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="dt-pill up">{a.name}</span>
              <b style={{ fontSize: 13 }}>{a.expiry_date || '—'}</b>
              {a.amount ? <span className="b">₹{a.amount}</span> : null}
              {a.ratio ? <span className="b">{a.ratio}</span> : null}
            </div>
            <div className="m" style={{ marginTop: 4 }}>{[ann && `Announced ${ann}`, rec && `Record ${rec}`].filter(Boolean).join(' · ')}</div>
            {detail && <div style={{ fontSize: 12, color: '#334155', marginTop: 2 }}>{detail}</div>}
          </div>
        );
      })}
    </Card>
  );
}

// ── Competitors ───────────────────────────────────────────────
function PeersCard({ rows, stocks }) {
  if (!rows?.length) return <Card title="Competitors" accent="#7c3aed"><Unavailable what="Competitor data" /></Card>;
  return (
    <Card title="Competitors" accent="#7c3aed">
      {rows.map((c) => {
        const sym = (stocks || []).find((x) => x.key === c.instrument_key)?.s;
        return (
          <div key={c.instrument_key} style={{ padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
            <div className="r" style={{ gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 14 }}>{sym || c.instrument_key.split('|')[1]}</b>
              {c.sector && <span className="dt-pill nt">{c.sector}</span>}
              {c.sector_market_cap_inr?.formatted && <span className="m">Sector cap {c.sector_market_cap_inr.formatted}</span>}
              {sym && (
                <button className="chip" style={{ marginLeft: 'auto' }}
                  onClick={() => window.dispatchEvent(new CustomEvent('scanner:lookup', { detail: sym }))}>Analyse</button>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#475569', marginTop: 4, lineHeight: 1.5 }}>
              {String(c.company_profile || '').slice(0, 220)}{String(c.company_profile || '').length > 220 ? '…' : ''}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

export default function FundamentalsTab({ inst }) {
  const { token, onTokenExpired, stocks } = useApp();
  const accessToken = resolveAccessToken(token);
  const isin = String(inst?.key || '').split('|')[1] || '';
  const listed = /^(NSE|BSE)_EQ\|/.test(inst?.key || '');
  const [state, setState] = useState({ loading: true });
  const [period, setPeriod] = useState('yearly');
  const [finLoading, setFinLoading] = useState(false);
  const [sub, setSub] = useState('overview');
  const [extra, setExtra] = useState({});          // balance, cashflow, actions, peers (undefined = not asked yet)
  const [extraBusy, setExtraBusy] = useState({});

  useEffect(() => {
    if (!listed || !accessToken) return;
    let off = false;
    setState({ loading: true });
    setExtra({}); setExtraBusy({}); setSub('overview');
    const f = (ep, q = '') => fetchFundamental(isin, ep, accessToken, onTokenExpired, q);
    Promise.allSettled([f('profile'), f('key-ratios'), f('share-holdings'), f('income-statement', '?type=consolidated&time_period=yearly')])
      .then(([p, r, h, i]) => {
        if (off) return;
        setPeriod('yearly');
        setState({
          loading: false,
          profile: p.status === 'fulfilled' ? p.value : null,
          ratios: r.status === 'fulfilled' ? r.value : null,
          holdings: h.status === 'fulfilled' ? h.value : null,
          income: i.status === 'fulfilled' ? i.value : null,
          allFailed: [p, r, h, i].every((x) => x.status === 'rejected'),
          err: [p, r, h, i].find((x) => x.status === 'rejected')?.reason?.message,
        });
      });
    return () => { off = true; };
  }, [isin, accessToken]); // eslint-disable-line

  // The extra statements are only fetched when their sub-tab is opened (saves API calls).
  const loadExtra = (key, endpoint, query = '') => {
    if (extra[key] !== undefined || extraBusy[key]) return;
    setExtraBusy((b) => ({ ...b, [key]: true }));
    fetchFundamental(isin, endpoint, accessToken, onTokenExpired, query)
      .then((d) => setExtra((e) => ({ ...e, [key]: d ?? null })))
      .catch(() => setExtra((e) => ({ ...e, [key]: null })))
      .finally(() => setExtraBusy((b) => ({ ...b, [key]: false })));
  };
  useEffect(() => {
    if (state.loading || !listed) return;
    if (sub === 'financials') { loadExtra('balance', 'balance-sheet', '?type=consolidated'); loadExtra('cashflow', 'cash-flow', '?type=consolidated'); }
    if (sub === 'events') { loadExtra('actions', 'corporate-actions'); loadExtra('peers', 'competitors'); }
  }, [sub, state.loading]); // eslint-disable-line

  const changePeriod = (next) => {
    if (next === period) return;
    setPeriod(next); setFinLoading(true);
    fetchFundamental(isin, 'income-statement', accessToken, onTokenExpired, `?type=consolidated&time_period=${next}`)
      .then((d) => setState((s) => ({ ...s, income: d })))
      .catch(() => setState((s) => ({ ...s, income: null })))
      .finally(() => setFinLoading(false));
  };

  if (!listed) return <div className="fd-na">Fundamentals are available for listed equities only.</div>;
  if (state.loading) return <Spinner label="Loading fundamentals..." />;
  if (state.allFailed) return <div className="fd-na">Could not load fundamentals{state.err ? ': ' + state.err : ''}.</div>;
  const { profile } = state;
  const busy = (k) => extra[k] === undefined && extraBusy[k];
  return (
    <div>
      <div className="chip-row">
        {[['overview', 'Overview'], ['financials', 'Financials'], ['events', 'Events and peers']].map(([id, l]) => (
          <button key={id} className={'chip' + (sub === id ? ' on' : '')} onClick={() => setSub(id)}>{l}</button>
        ))}
      </div>

      {sub === 'overview' && (
        <>
          <RatiosCard rows={state.ratios} symbol={inst?.s} />
          <HoldingsCard rows={state.holdings} />
          {profile && (
            <Card title="About the company" accent="#64748b" right={profile.sector ? <span className="dt-pill nt">{profile.sector}</span> : null}>
              <div style={{ fontSize: 13, lineHeight: 1.6, color: '#334155' }}>{profile.company_profile}</div>
              {profile.sector_market_cap_inr?.formatted && (
                <div className="m" style={{ marginTop: 8 }}>Sector market cap: {profile.sector_market_cap_inr.formatted}{profile.sector_market_cap_usd?.formatted ? ' (' + profile.sector_market_cap_usd.formatted + ')' : ''}</div>
              )}
            </Card>
          )}
        </>
      )}

      {sub === 'financials' && (
        <>
          <FinancialsCard data={state.income} period={period} setPeriod={changePeriod} loading={finLoading} />
          {busy('balance') ? <Spinner label="Loading balance sheet..." /> : <BalanceCard data={extra.balance} />}
          {busy('cashflow') ? <Spinner label="Loading cash flow..." /> : <CashFlowCard data={extra.cashflow} />}
        </>
      )}

      {sub === 'events' && (
        <>
          {busy('actions') ? <Spinner label="Loading corporate actions..." /> : <ActionsCard rows={extra.actions} />}
          {busy('peers') ? <Spinner label="Loading competitors..." /> : <PeersCard rows={extra.peers} stocks={stocks} />}
        </>
      )}
    </div>
  );
}

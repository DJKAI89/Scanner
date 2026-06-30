import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, LastUpdated, EmptyState } from '../components/common.jsx';
import { resolveAccessToken } from '../services/api';
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { loadOptionChainAnalysis, mergeLiveIntoRows } from '../services/optionAnalysisService';

const INDEX_FILTERS = [
  { id: 'NIFTY',     key: 'NSE_INDEX|Nifty 50',  step: 50,  lot: 75 },
  { id: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank', step: 100, lot: 30 },
  { id: 'SENSEX',    key: 'BSE_INDEX|SENSEX',     step: 100, lot: 20 },
];

const VIX_KEY = 'NSE_INDEX|India VIX';

const BUILD_ICON = {
  LONG_BUILD:  { icon: '📈', tone: '#16a34a', label: 'Long Build' },
  SHORT_COVER: { icon: '↩',  tone: '#16a34a', label: 'Short Cover' },
  SHORT_BUILD: { icon: '📉', tone: '#dc2626', label: 'Short Build' },
  LONG_UNWIND: { icon: '↪',  tone: '#dc2626', label: 'Long Unwind' },
  NEUTRAL:     null,
};

function fmtMargin(v) {
  if (!v) return '—';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(1) + 'L';
  return '₹' + (v / 1e3).toFixed(0) + 'K';
}

function confColor(c) {
  if (c == null) return '#94a3b8';
  return c >= 70 ? '#16a34a' : c >= 50 ? '#d97706' : '#dc2626';
}

// ── One side (CE or PE) of a strike row ──
function SideCell({ cell, align }) {
  if (!cell) return <div style={{ flex: 1, textAlign: align, color: '#cbd5e1', fontSize: 11 }}>—</div>;
  const build = BUILD_ICON[cell.oiBuildType];
  return (
    <div style={{ flex: 1, textAlign: align, padding: '2px 4px' }}>
      <div style={{ display: 'flex', justifyContent: align === 'left' ? 'flex-start' : 'flex-end', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>{fmt(cell.ltp)}</span>
        {cell.isLive && <span style={{ fontSize: 7, color: '#16a34a' }}>⚡</span>}
      </div>
      <div style={{ fontSize: 9, color: '#64748b' }}>{fmt(cell.oi, 0)} OI</div>
      <div style={{ display: 'flex', justifyContent: align === 'left' ? 'flex-start' : 'flex-end', alignItems: 'center', gap: 4, marginTop: 2 }}>
        <span style={{ fontSize: 9, fontWeight: 800, color: confColor(cell.confidence) }}>{cell.confidence}%</span>
        {build && <span title={build.label} style={{ fontSize: 9 }}>{build.icon}</span>}
      </div>
      <div style={{ fontSize: 8, color: '#94a3b8', marginTop: 1 }}>M: {fmtMargin(cell.marginEst)}</div>
    </div>
  );
}

function StrikeRow({ row, atmStrike }) {
  const isAtm = row.strike === atmStrike;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', padding: '8px 6px',
      borderBottom: '1px solid #f1f5f9',
      background: isAtm ? '#faf5ff' : '#fff',
    }}>
      <SideCell cell={row.CE} align="left" />
      <div style={{
        width: 64, textAlign: 'center', fontSize: 12, fontWeight: 800,
        color: isAtm ? '#7c3aed' : '#0f172a',
      }}>
        {fmt(row.strike, 0)}
        {isAtm && <div style={{ fontSize: 7, color: '#7c3aed', fontWeight: 700 }}>ATM</div>}
      </div>
      <SideCell cell={row.PE} align="right" />
    </div>
  );
}

export default function OptionAnalysisPane() {
  const { token, cfg, marketStatus, lg, onTokenExpired, updateBadge } = useApp();
  const accessToken = resolveAccessToken(token);

  const [filter, setFilter] = useState('NIFTY');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [data, setData] = useState(null);
  const [updTime, setUpdTime] = useState('');
  const [expiry, setExpiry] = useState(null);

  const idx = INDEX_FILTERS.find((i) => i.id === filter) || INDEX_FILTERS[0];

  const load = useCallback(async (expiryOverride) => {
    setLoading(true); setError('');
    try {
      const ctx = { token: accessToken, indexKey: idx.key, step: idx.step, lot: idx.lot, expiry: expiryOverride || expiry, cfg, onTokenExpired, lg };
      const result = await loadOptionChainAnalysis(ctx, { setProgress });
      setData(result);
      setExpiry(result.expiry);
      setUpdTime('Updated: ' + getIST());
      updateBadge('optAnalysis', String(result.rows.length));
    } catch (e) {
      setError(e.message); lg('Option analysis error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }, [accessToken, idx.key, idx.step, idx.lot, cfg, onTokenExpired, lg, updateBadge]); // eslint-disable-line

  // Reload on filter change (fresh expiry each time — new index, new expiry list)
  useEffect(() => { if (accessToken) { setExpiry(null); load(null); } }, [filter, accessToken]); // eslint-disable-line

  useEffect(() => {
    const onScan = () => load();
    document.addEventListener('friday:scan', onScan);
    return () => document.removeEventListener('friday:scan', onScan);
  }, [load]);

  // ── Live WS feed: spot + VIX + every visible option instrument ──
  const optionKeys = useMemo(() => {
    if (!data?.rows) return [];
    const keys = [];
    data.rows.forEach((r) => { if (r.CE?.instrKey) keys.push(r.CE.instrKey); if (r.PE?.instrKey) keys.push(r.PE.instrKey); });
    return keys;
  }, [data]);

  const { lastPrices: idxPrices } = useMarketFeed(accessToken, [idx.key, VIX_KEY], !!accessToken, { pollFallback: true });
  const { lastPrices: optPrices } = useMarketFeed(accessToken, optionKeys, optionKeys.length > 0, { pollFallback: false, mode: 'full' });

  const liveRows = useMemo(() => mergeLiveIntoRows(data?.rows, optPrices), [data, optPrices]);
  const liveSpot = idxPrices[idx.key]?.ltp || data?.spot || 0;
  const liveVix  = idxPrices[VIX_KEY]?.ltp || data?.vixVal || 0;
  const { txt: vixTxt } = interpVIX(liveVix);

  return (
    <div>
      {/* Index filter tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: '#f1f5f9', borderRadius: 10, padding: 3 }}>
        {INDEX_FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            background: filter === f.id ? '#fff' : 'transparent',
            color: filter === f.id ? '#7c3aed' : '#64748b',
            boxShadow: filter === f.id ? '0 1px 4px rgba(0,0,0,.1)' : 'none',
          }}>{f.id}</button>
        ))}
      </div>

      {error && <ErrorBanner title="⚠ Option Analysis Error" message={error} onRetry={() => load()} />}

      {loading ? (
        <Spinner label={`Loading ${filter} option chain...`} progress={progress} sub="Confidence · OI Buildup · Margin estimate" />
      ) : !data ? (
        <EmptyState>Pull to scan or tap ▶ to load the {filter} chain</EmptyState>
      ) : (
        <div>
          {!marketStatus.open && (
            <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 10, color: '#92400e', fontWeight: 700 }}>
              📅 Market Closed — showing last available data
            </div>
          )}

          {/* Spot + VIX */}
          <div className="stats-g" style={{ marginBottom: 10 }}>
            <StatCard label={filter} value={`₹${fmt(liveSpot, 0)}`} sub={fmtC(data.spotChg)} valClass={data.spotChg >= 0 ? 'up' : 'dn'} />
            <StatCard label="INDIA VIX" value={liveVix.toFixed(2)} sub={vixTxt} valClass={liveVix < 16 ? 'up' : liveVix > 22 ? 'dn' : 'am'} />
            <StatCard label="PCR" value={data.pcr?.toFixed(2) ?? '—'} sub={data.pcr > 1 ? 'Bullish bias' : data.pcr < 0.7 ? 'Bearish bias' : 'Neutral'} valClass={data.pcr > 1 ? 'up' : data.pcr < 0.7 ? 'dn' : 'am'} />
          </div>

          {/* Expiry selector */}
          {data.expiries?.length > 1 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, overflowX: 'auto', paddingBottom: 2 }}>
              {data.expiries.slice(0, 6).map((exp) => (
                <button key={exp} onClick={() => { setExpiry(exp); load(exp); }} style={{
                  padding: '5px 10px', fontSize: 10, fontWeight: 700, borderRadius: 16, whiteSpace: 'nowrap',
                  border: exp === data.expiry ? 'none' : '1px solid #e2e8f0', cursor: 'pointer',
                  background: exp === data.expiry ? '#7c3aed' : '#fff',
                  color: exp === data.expiry ? '#fff' : '#374151',
                }}>{exp}</button>
              ))}
            </div>
          )}

          {/* Max pain + OI walls */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', marginBottom: 10, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 10 }}>
            <span>🎯 Max Pain: <b style={{ color: '#7c3aed' }}>₹{fmt(data.maxPain, 0)}</b></span>
            {data.oiWalls?.callWall > 0 && <span>📉 Call Wall: <b style={{ color: '#dc2626' }}>₹{fmt(data.oiWalls.callWall, 0)}</b></span>}
            {data.oiWalls?.putWall > 0 && <span>📈 Put Wall: <b style={{ color: '#16a34a' }}>₹{fmt(data.oiWalls.putWall, 0)}</b></span>}
          </div>

          {updTime && <LastUpdated time={updTime} />}

          {/* Chain table */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ display: 'flex', padding: '8px 6px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: 9, fontWeight: 700, color: '#64748b' }}>
              <div style={{ flex: 1, textAlign: 'left' }}>CALLS (LTP · OI · Conf · Margin)</div>
              <div style={{ width: 64, textAlign: 'center' }}>STRIKE</div>
              <div style={{ flex: 1, textAlign: 'right' }}>PUTS (LTP · OI · Conf · Margin)</div>
            </div>
            {liveRows.map((row) => <StrikeRow key={row.strike} row={row} atmStrike={data.atm} />)}
          </div>

          <div className="disc">⚠ Margin is an estimate (SPAN+exposure varies by broker/time). Confidence uses the same model as F&O Options. Not SEBI advice · DYODD.</div>
        </div>
      )}
    </div>
  );
}

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, LastUpdated, EmptyState } from '../components/common.jsx';
import { resolveAccessToken } from '../services/api';
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { loadOptionChainAnalysis, mergeLiveIntoRows, selectStrikesAroundATM } from '../services/optionAnalysisService';

const INDEX_FILTERS = [
  { id: 'NIFTY',     key: 'NSE_INDEX|Nifty 50',  step: 50,  lot: 75, color: '#7c3aed' },
  { id: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank', step: 100, lot: 30, color: '#0ea5e9' },
  { id: 'SENSEX',    key: 'BSE_INDEX|SENSEX',     step: 100, lot: 20, color: '#16a34a' },
];

const VIX_KEY = 'NSE_INDEX|India VIX';
const PAGE_SIZE = 20;

const BUILD_ICON = {
  LONG_BUILD:  { icon: '📈', tone: '#16a34a', label: 'Long Build' },
  SHORT_COVER: { icon: '↩',  tone: '#16a34a', label: 'Short Cover' },
  SHORT_BUILD: { icon: '📉', tone: '#dc2626', label: 'Short Build' },
  LONG_UNWIND: { icon: '↪',  tone: '#dc2626', label: 'Long Unwind' },
  NEUTRAL:     null,
};

function fmtMargin(v) {
  if (!v) return '—';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + 'L';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + fmt(v, 0);
}

function confColor(c) {
  if (c == null) return '#94a3b8';
  return c >= 70 ? '#16a34a' : c >= 50 ? '#d97706' : '#dc2626';
}
function confBg(c) {
  if (c == null) return 'transparent';
  return c >= 70 ? '#f0fdf4' : c >= 50 ? '#fffbeb' : '#fef2f2';
}

// ── One side (CE or PE) of a strike row ──
function SideCell({ cell, align, itm }) {
  if (!cell) return <div style={{ flex: 1, textAlign: align, color: '#e2e8f0', fontSize: 11, padding: '6px 8px' }}>—</div>;
  const build = BUILD_ICON[cell.oiBuildType];
  return (
    <div style={{
      flex: 1, textAlign: align, padding: '7px 9px',
      background: itm ? (align === 'left' ? 'linear-gradient(90deg,#f5f3ff,transparent)' : 'linear-gradient(270deg,#f5f3ff,transparent)') : 'transparent',
    }}>
      <div style={{ display: 'flex', justifyContent: align === 'left' ? 'flex-start' : 'flex-end', alignItems: 'baseline', gap: 5 }}>
        <span style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', letterSpacing: -0.2 }}>{fmt(cell.ltp)}</span>
        {cell.isLive && <span style={{ fontSize: 7, color: '#16a34a', animation: 'pulse 1.5s ease-in-out infinite' }}>⚡</span>}
      </div>
      <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 1 }}>{fmt(cell.oi, 0)} OI</div>
      <div style={{
        display: 'inline-flex', justifyContent: align === 'left' ? 'flex-start' : 'flex-end', alignItems: 'center', gap: 4,
        marginTop: 4, background: confBg(cell.confidence), borderRadius: 5, padding: '1.5px 5px',
      }}>
        <span style={{ fontSize: 9.5, fontWeight: 800, color: confColor(cell.confidence) }}>{cell.confidence}%</span>
        {build && <span title={build.label} style={{ fontSize: 9.5 }}>{build.icon}</span>}
      </div>
      <div style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 2 }}>{fmtMargin(cell.marginEst)} margin</div>
    </div>
  );
}

function StrikeRow({ row, atmStrike, accentColor }) {
  const isAtm = row.strike === atmStrike;
  const ceITM = row.strike < atmStrike;
  const peITM = row.strike > atmStrike;
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      borderBottom: '1px solid #f1f5f9',
      background: isAtm ? '#faf5ff' : '#fff',
      transition: 'background .15s',
    }}>
      <SideCell cell={row.CE} align="left" itm={ceITM} />
      <div style={{
        width: 62, flexShrink: 0, textAlign: 'center', fontSize: 12.5, fontWeight: 800,
        color: isAtm ? accentColor : '#334155',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        borderLeft: '1px solid #f1f5f9', borderRight: '1px solid #f1f5f9',
        background: isAtm ? '#fff' : '#fafbfc',
      }}>
        <div>{fmt(row.strike, 0)}</div>
        {isAtm && <div style={{ fontSize: 7, color: accentColor, fontWeight: 800, marginTop: 1 }}>● ATM</div>}
      </div>
      <SideCell cell={row.PE} align="right" itm={peITM} />
    </div>
  );
}

function ChainSection({ title, chain, atm, accentColor, visibleCount, onLoadMore }) {
  const allRows = chain?.rows || [];
  const shown = useMemo(() => selectStrikesAroundATM(allRows, atm, visibleCount), [allRows, atm, visibleCount]);
  const hasMore = allRows.length > shown.length;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '9px 12px', borderRadius: '10px 10px 0 0',
        background: `linear-gradient(90deg, ${accentColor}15, ${accentColor}05)`,
        border: `1px solid ${accentColor}30`, borderBottom: 'none',
      }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: accentColor }}>{title}</span>
        <span style={{ fontSize: 9.5, color: '#64748b', fontWeight: 600 }}>Exp {chain?.expiry} · {shown.length}/{allRows.length} strikes</span>
      </div>

      {/* Max pain + walls strip */}
      {chain && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 9.5, padding: '7px 12px', background: '#fff', border: `1px solid ${accentColor}30`, borderTop: 'none', borderBottom: 'none' }}>
          <span>🎯 Max Pain <b style={{ color: '#7c3aed' }}>{fmt(chain.maxPain, 0)}</b></span>
          {chain.oiWalls?.callWall > 0 && <span>📉 Call Wall <b style={{ color: '#dc2626' }}>{fmt(chain.oiWalls.callWall, 0)}</b></span>}
          {chain.oiWalls?.putWall > 0 && <span>📈 Put Wall <b style={{ color: '#16a34a' }}>{fmt(chain.oiWalls.putWall, 0)}</b></span>}
          <span>PCR <b>{chain.pcr?.toFixed(2)}</b></span>
        </div>
      )}

      <div style={{
        display: 'flex', padding: '7px 9px', background: '#f8fafc',
        border: `1px solid ${accentColor}30`, borderTop: 'none',
        fontSize: 8.5, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.3,
      }}>
        <div style={{ flex: 1, textAlign: 'left' }}>CALLS</div>
        <div style={{ width: 62, textAlign: 'center' }}>STRIKE</div>
        <div style={{ flex: 1, textAlign: 'right' }}>PUTS</div>
      </div>

      <div style={{ border: `1px solid ${accentColor}30`, borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden', boxShadow: '0 2px 8px rgba(15,23,42,.04)' }}>
        {shown.length === 0
          ? <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: '#94a3b8' }}>No strikes in range</div>
          : shown.map((row) => <StrikeRow key={row.strike} row={row} atmStrike={atm} accentColor={accentColor} />)}
        {hasMore && (
          <button onClick={onLoadMore} style={{
            width: '100%', padding: '10px 0', border: 'none', borderTop: '1px solid #f1f5f9',
            background: '#fafbfc', color: accentColor, fontSize: 11, fontWeight: 800, cursor: 'pointer',
          }}>
            ↓ Load 20 More Strikes
          </button>
        )}
      </div>
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
  const [visibleInMonth, setVisibleInMonth] = useState(PAGE_SIZE);
  const [visibleOutMonth, setVisibleOutMonth] = useState(PAGE_SIZE);

  const idx = INDEX_FILTERS.find((i) => i.id === filter) || INDEX_FILTERS[0];

  const load = useCallback(async () => {
    setLoading(true); setError('');
    setVisibleInMonth(PAGE_SIZE); setVisibleOutMonth(PAGE_SIZE);
    try {
      const ctx = { token: accessToken, indexKey: idx.key, step: idx.step, lot: idx.lot, cfg, onTokenExpired, lg };
      const result = await loadOptionChainAnalysis(ctx, { setProgress });
      setData(result);
      setUpdTime('Updated: ' + getIST());
      const total = (result.inMonth?.rows.length || 0) + (result.outOfMonth?.rows.length || 0);
      updateBadge('optAnalysis', String(total));
    } catch (e) {
      setError(e.message); lg('Option analysis error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }, [accessToken, idx.key, idx.step, idx.lot, cfg, onTokenExpired, lg, updateBadge]); // eslint-disable-line

  useEffect(() => { if (accessToken) load(); }, [filter, accessToken]); // eslint-disable-line

  useEffect(() => {
    const onScan = () => load();
    document.addEventListener('friday:scan', onScan);
    return () => document.removeEventListener('friday:scan', onScan);
  }, [load]);

  // ── Live WS feed: spot + VIX + every loaded option instrument (both chains) ──
  const optionKeys = useMemo(() => {
    const keys = [];
    [data?.inMonth, data?.outOfMonth].forEach((chain) => {
      chain?.rows.forEach((r) => { if (r.CE?.instrKey) keys.push(r.CE.instrKey); if (r.PE?.instrKey) keys.push(r.PE.instrKey); });
    });
    return keys;
  }, [data]);

  const { lastPrices: idxPrices } = useMarketFeed(accessToken, [idx.key, VIX_KEY], !!accessToken, { pollFallback: true });
  const { lastPrices: optPrices } = useMarketFeed(accessToken, optionKeys, optionKeys.length > 0, { pollFallback: false, mode: 'full' });

  const liveInMonth = useMemo(() => data?.inMonth ? { ...data.inMonth, rows: mergeLiveIntoRows(data.inMonth.rows, optPrices, idx.lot) } : null, [data, optPrices, idx.lot]);
  const liveOutOfMonth = useMemo(() => data?.outOfMonth ? { ...data.outOfMonth, rows: mergeLiveIntoRows(data.outOfMonth.rows, optPrices, idx.lot) } : null, [data, optPrices, idx.lot]);

  const liveSpot = idxPrices[idx.key]?.ltp || data?.spot || 0;
  const liveVix  = idxPrices[VIX_KEY]?.ltp || data?.vixVal || 0;
  const { txt: vixTxt } = interpVIX(liveVix);
  const wsLive = Object.keys(optPrices).length > 0;

  return (
    <div>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }`}</style>

      {/* Index filter tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: '#f1f5f9', borderRadius: 10, padding: 3 }}>
        {INDEX_FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 800, cursor: 'pointer',
            background: filter === f.id ? '#fff' : 'transparent',
            color: filter === f.id ? f.color : '#64748b',
            boxShadow: filter === f.id ? '0 1px 6px rgba(0,0,0,.1)' : 'none',
            transition: 'all .15s',
          }}>{f.id}</button>
        ))}
      </div>

      {error && <ErrorBanner title="⚠ Option Analysis Error" message={error} onRetry={load} />}

      {loading ? (
        <Spinner label={`Loading ${filter} option chain...`} progress={progress} sub="In-month + out-of-month · Confidence · OI Buildup · Live Margin" />
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
            <StatCard label="WS FEED" value={wsLive ? 'LIVE' : 'Connecting'} sub={`${optionKeys.length} instruments`} valClass={wsLive ? 'up' : 'am'} />
          </div>

          {updTime && <LastUpdated time={updTime} />}

          <ChainSection
            title="📅 THIS MONTH (In-Month)"
            chain={liveInMonth}
            atm={data.inMonth?.atm}
            accentColor={idx.color}
            visibleCount={visibleInMonth}
            onLoadMore={() => setVisibleInMonth((v) => v + PAGE_SIZE)}
          />

          {liveOutOfMonth ? (
            <ChainSection
              title="🗓 NEXT MONTH (Out-of-Month)"
              chain={liveOutOfMonth}
              atm={data.outOfMonth?.atm}
              accentColor="#d97706"
              visibleCount={visibleOutMonth}
              onLoadMore={() => setVisibleOutMonth((v) => v + PAGE_SIZE)}
            />
          ) : (
            <div style={{ fontSize: 10, color: '#94a3b8', textAlign: 'center', padding: '8px 0' }}>No out-of-month expiry available</div>
          )}

          <div className="disc">⚠ Margin = lot size × LTP (live, tracks premium) — not a SPAN+exposure margin from your broker. Confidence uses the same model as F&O Options. Not SEBI advice · DYODD.</div>
        </div>
      )}
    </div>
  );
}

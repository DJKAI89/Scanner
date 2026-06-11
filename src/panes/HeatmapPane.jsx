import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken, fetchQ } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { getIST } from '../utils/marketTime';

const fmt  = v => v >= 1000 ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : v.toFixed(2);
const fmtP = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const fmtC = v => (v >= 0 ? '+' : '') + v.toFixed(2);

// ── Color scale ───────────────────────────────────────────────
function heatColor(chg) {
  if (chg >=  3)   return { bg: '#0d5c2f', text: '#ffffff', sub: '#a7f3d0' };
  if (chg >=  2)   return { bg: '#166534', text: '#ffffff', sub: '#bbf7d0' };
  if (chg >=  1)   return { bg: '#15803d', text: '#ffffff', sub: '#dcfce7' };
  if (chg >=  0.5) return { bg: '#16a34a', text: '#ffffff', sub: '#dcfce7' };
  if (chg >=  0.1) return { bg: '#22c55e', text: '#ffffff', sub: '#f0fdf4' };
  if (chg >=  0)   return { bg: '#4ade80', text: '#14532d', sub: '#14532d' };
  if (chg >= -0.1) return { bg: '#f87171', text: '#ffffff', sub: '#fee2e2' };
  if (chg >= -0.5) return { bg: '#ef4444', text: '#ffffff', sub: '#fee2e2' };
  if (chg >= -1)   return { bg: '#dc2626', text: '#ffffff', sub: '#fecaca' };
  if (chg >= -2)   return { bg: '#b91c1c', text: '#ffffff', sub: '#fca5a5' };
  if (chg >= -3)   return { bg: '#991b1b', text: '#ffffff', sub: '#fca5a5' };
  return             { bg: '#7f1d1d',       text: '#ffffff', sub: '#f87171' };
}

// ── Tile ──────────────────────────────────────────────────────
function HeatTile({ stock, ltp, chgPct, chgPt, isLive }) {
  const colors  = heatColor(chgPct);
  const hasData = ltp > 0;
  return (
    <div style={{
      background: hasData ? colors.bg : '#e2e8f0',
      borderRadius: 6, padding: '6px 7px 5px',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      height: 72, boxSizing: 'border-box', overflow: 'hidden',
      border: '1px solid rgba(0,0,0,0.06)', transition: 'background .4s',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 800,
        color: hasData ? colors.text : '#94a3b8',
        lineHeight: 1.1, letterSpacing: -0.2,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{stock.s}</div>

      <div style={{ fontSize: 10, fontWeight: 700, color: hasData ? colors.sub : '#cbd5e1', lineHeight: 1.2 }}>
        {hasData ? `₹${fmt(ltp)}` : '—'}
      </div>

      <div>
        {hasData && chgPt !== 0 && (
          <div style={{ fontSize: 8, fontWeight: 600, color: colors.sub, lineHeight: 1.2 }}>
            {fmtC(chgPt)}
          </div>
        )}
        <div style={{ fontSize: 12, fontWeight: 900, color: hasData ? colors.text : '#94a3b8', lineHeight: 1 }}>
          {hasData ? fmtP(chgPct) : '—'}
        </div>
      </div>
    </div>
  );
}

// ── Breadth bar ───────────────────────────────────────────────
function BreadthBar({ enriched }) {
  let adv = 0, dec = 0, flat = 0;
  for (const s of enriched) {
    if (!s.ltp) continue;
    if (s.chgPct >  0.1) adv++;
    else if (s.chgPct < -0.1) dec++;
    else flat++;
  }
  const total = adv + dec + flat || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', height: 10 }}>
        <div style={{ width: `${adv/total*100}%`,  background: '#16a34a', transition: 'width .6s' }} />
        <div style={{ width: `${flat/total*100}%`, background: '#94a3b8', transition: 'width .6s' }} />
        <div style={{ width: `${dec/total*100}%`,  background: '#dc2626', transition: 'width .6s' }} />
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 9, fontWeight: 700 }}>
        <span style={{ color: '#16a34a' }}>▲ {adv}</span>
        <span style={{ color: '#94a3b8' }}>— {flat}</span>
        <span style={{ color: '#dc2626' }}>▼ {dec}</span>
        <span style={{ color: '#64748b', marginLeft: 'auto' }}>{adv+dec+flat} loaded</span>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────
export default function HeatmapPane() {
  const { token, stocks, marketStatus, lg, updateBadge } = useApp();

  const [sector,   setSector]   = useState('ALL');
  const [sortBy,   setSortBy]   = useState('chg');
  // REST base prices — loaded on mount, same as Portfolio's load()
  const [basePrices, setBasePrices] = useState({}); // { instrKey: { ltp, cp } }
  const [loading,    setLoading]    = useState(false);
  const [updTime,    setUpdTime]    = useState('');
  const [error,      setError]      = useState('');

  const accessToken = resolveAccessToken(token);

  // All keys — always pass to useMarketFeed regardless of market status
  // Same as Portfolio: no marketStatus.open gate on useMarketFeed
  const allKeys = useMemo(() => stocks.map(s => s.key).filter(Boolean), [stocks]);

  // ── Persistent WebSocket — always on, pollFallback handles closed market ──
  // Exact same call signature as PortfolioPane
  const { connected: wsConnected, lastPrices } = useMarketFeed(
    accessToken, allKeys, allKeys.length > 0, { pollFallback: true, mode: 'ltpc' }
  );

  // ── REST base load — runs on mount like Portfolio's load() ──
  const loadBase = useCallback(async () => {
    if (!accessToken || !allKeys.length) 
    { 
      return;
    }
    setLoading(true); setError('');
    lg(`Heatmap: loading ${allKeys.length} quotes…`, 'o');
    try {
      const BATCH = 50;
      const results = {};
      const batches = [];
      for (let i = 0; i < allKeys.length; i += BATCH)
        batches.push(allKeys.slice(i, i + BATCH));

      await Promise.allSettled(
        batches.map(batch =>
          fetchQ(batch.join(','), accessToken).then(raw => {
            for (const [k, q] of Object.entries(raw)) {
              const ltp = q.last_price || 0;
              const cp  = q.ohlc?.close || 0;
              if (ltp > 0) results[k] = { ltp, cp };
            }
          })
        )
      );

      const count = Object.keys(results).length;
      setBasePrices(results);
      setUpdTime('Updated: ' + getIST());
      updateBadge('heatmap', String(count));
      lg(`Heatmap: ${count} base quotes loaded`, 'o');
    } catch (e) {
      setError(e.message);
      lg('Heatmap error: ' + e.message, 'e');
    } finally {
      setLoading(false);
    }
  }, [accessToken, allKeys, lg, updateBadge]); // eslint-disable-line

  // Mount — same as Portfolio's useEffect
  useEffect(() => { 
    if (accessToken)
    loadBase(); 
  }, [accessToken]); // eslint-disable-line

  // Update timestamp when WS ticks arrive — same as Portfolio
  useEffect(() => {
    if (Object.keys(lastPrices).length > 0) {
      setUpdTime('Live: ' + getIST());
    }
  }, [lastPrices]);

  // ── Enrich — same pattern as Portfolio's enrich() ──
  // REST base gives ltp+cp, WS lastPrices overrides ltp when live
  const enriched = useMemo(() => {
    return stocks.map(stock => {
      const key    = stock.key;
      const base   = basePrices[key];
      const live   = lastPrices[key];
      const ltp    = live?.ltp || base?.ltp || 0;
      const cp     = live?.cp  || base?.cp  || 0;
      const chgPct = (ltp > 0 && cp > 0) ? +((ltp - cp) / cp * 100).toFixed(2) : 0;
      const chgPt  = (ltp > 0 && cp > 0) ? +(ltp - cp).toFixed(2) : 0;
      return { ...stock, ltp, cp, chgPct, chgPt, isLive: !!live?.ltp };
    });
  }, [stocks, basePrices, lastPrices]);

  // Sectors
  const sectors = useMemo(() =>
    ['ALL', ...Array.from(new Set(stocks.map(s => s.sec).filter(Boolean))).sort()],
    [stocks]
  );

  // Filtered + sorted
  const filtered = useMemo(() =>
    sector === 'ALL' ? enriched : enriched.filter(s => s.sec === sector),
    [enriched, sector]
  );

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === 'chg')     return b.chgPct - a.chgPct;
      if (sortBy === 'chg_asc') return a.chgPct - b.chgPct;
      if (sortBy === 'price')   return b.ltp    - a.ltp;
      return a.s.localeCompare(b.s);
    });
  }, [filtered, sortBy]);

  const loadedCount = enriched.filter(s => s.ltp > 0).length;

  if (!stocks.length) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>No stocks loaded</div>
        <div style={{ fontSize: 11 }}>Go to ⚙ Settings → Reload stocks.json</div>
      </div>
    );
  }

  return (
    <div>
      {/* WS status — same as Portfolio */}
      {allKeys.length > 0 && (
        <div style={{ fontSize: 9, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: wsConnected ? '#16a34a' : '#94a3b8', flexShrink: 0 }} />
          <span style={{ color: '#94a3b8' }}>
            {wsConnected
              ? `⚡ Live — ${loadedCount}/${allKeys.length} streaming`
              : loading ? 'Loading base prices…' : 'WebSocket connecting…'}
          </span>
          {updTime && <span style={{ marginLeft: 'auto', color: '#94a3b8' }}>{updTime}</span>}
        </div>
      )}

      {error && (
        <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 10, color: '#991b1b', marginBottom: 8 }}>
          ⚠ {error}
        </div>
      )}

      {/* Breadth bar */}
      {loadedCount > 0 && (
        <div style={{ marginBottom: 10 }}>
          <BreadthBar enriched={filtered} />
        </div>
      )}

      {/* Sector pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, overflowX: 'auto', paddingBottom: 2 }}>
        {sectors.map(sec => (
          <button key={sec} onClick={() => setSector(sec)} style={{
            padding: '5px 11px', fontSize: 10, fontWeight: 700, borderRadius: 20,
            border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            background: sector === sec ? '#0f172a' : '#f1f5f9',
            color:      sector === sec ? '#ffffff' : '#64748b',
            transition: 'all .15s',
          }}>{sec === 'ALL' ? '🌐 All' : sec}</button>
        ))}
      </div>

      {/* Sort + refresh */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
          flex: 1, background: '#fff', border: '1px solid #e2e8f0',
          borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 700,
          color: '#0f172a', cursor: 'pointer',
        }}>
          <option value="chg">↓ Gainers first</option>
          <option value="chg_asc">↑ Losers first</option>
          <option value="price">↓ Price high→low</option>
          <option value="name">A–Z Name</option>
        </select>
        <button onClick={loadBase} disabled={loading} style={{
          padding: '6px 16px', fontSize: 11, fontWeight: 800, borderRadius: 8,
          border: 'none', cursor: loading ? 'default' : 'pointer',
          background: loading ? '#e2e8f0' : 'linear-gradient(135deg,#0f172a,#1e293b)',
          color: loading ? '#94a3b8' : '#fff',
        }}>{loading ? '⏳' : '↻'}</button>
      </div>

      {/* Info */}
      <div style={{ fontSize: 9, color: '#94a3b8', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>{filtered.length} stocks{sector !== 'ALL' ? ` · ${sector}` : ''}</span>
        <span>{loadedCount}/{allKeys.length} prices loaded</span>
      </div>

      {loading && loadedCount === 0 && (
        <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
          ⏳ Loading prices…
        </div>
      )}

      {/* Heatmap grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3 }}>
        {sorted.map(stock => (
          <HeatTile
            key={stock.instrKey || stock.s}
            stock={stock}
            ltp={stock.ltp}
            chgPct={stock.chgPct}
            chgPt={stock.chgPt}
            isLive={stock.isLive}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={{ marginTop: 14, padding: '10px 12px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', marginBottom: 6, letterSpacing: 1 }}>COLOR SCALE</div>
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', height: 12 }}>
          {['#0d5c2f','#166534','#15803d','#22c55e','#4ade80','#94a3b8','#f87171','#ef4444','#dc2626','#991b1b','#7f1d1d'].map((c, i) => (
            <div key={i} style={{ flex: 1, background: c }} />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 9, color: '#94a3b8' }}>
          <span>≥+3%</span><span>0%</span><span>≤-3%</span>
        </div>
      </div>
    </div>
  );
}

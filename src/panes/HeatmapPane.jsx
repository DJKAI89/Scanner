import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken, fetchIntraday } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { loadBasePrices, enrichHeatmapRows } from '../services/heatmapService';
import { calcBBSqueeze } from '../services/technical';
import { getIST } from '../utils/marketTime';

const fmt  = v => v >= 1000 ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : v.toFixed(2);
const fmtP = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const fmtC = v => (v >= 0 ? '+' : '') + v.toFixed(2);

// How many of the biggest movers (by |chgPct|) get a live BB Squeeze check —
// computing this for all 500 stocks would mean 500 extra candle fetches every
// refresh, so it's scoped to the tiles most likely to matter.
const SQUEEZE_CHECK_COUNT = 24;

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
// volRank: 0-1, this tile's volume rank among currently visible tiles (1 = highest volume shown)
// hasSignal: true if an OPEN signal currently exists for this symbol
// squeeze: 'extreme' | 'squeeze' | null
function HeatTile({ stock, ltp, chgPct, chgPt, volRank, hasSignal, squeeze, onTap }) {
  const colors  = heatColor(chgPct);
  const hasData = ltp > 0;
  // Border thickness scales with relative volume — a quiet mover and a
  // heavily-traded mover at the same % change now look visibly different.
  const borderW = hasData ? 1 + Math.round((volRank || 0) * 3) : 1;
  return (
    <div onClick={onTap} style={{
      background: hasData ? colors.bg : '#e2e8f0',
      borderRadius: 4, padding: '4px 5px 3px',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      height: 52, boxSizing: 'border-box', overflow: 'hidden', position: 'relative',
      border: `${borderW}px solid ${hasData && volRank > 0.6 ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.06)'}`,
      transition: 'background .3s', cursor: 'pointer',
    }}>
      {(hasSignal || squeeze) && (
        <div style={{ position: 'absolute', top: 2, right: 3, display: 'flex', gap: 2 }}>
          {hasSignal && <span title="Open signal" style={{ fontSize: 8 }}>🎯</span>}
          {squeeze === 'extreme' && <span title="Extreme BB squeeze — breakout imminent" style={{ fontSize: 8 }}>⚡</span>}
          {squeeze === 'squeeze' && <span title="BB squeeze — consolidating" style={{ fontSize: 8 }}>🔸</span>}
        </div>
      )}

      <div style={{
        fontSize: 10, fontWeight: 800,
        color: hasData ? colors.text : '#94a3b8',
        lineHeight: 1.1, letterSpacing: -0.3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{stock.s}</div>

      <div style={{ fontSize: 9, fontWeight: 600, color: hasData ? colors.sub : '#cbd5e1', lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {hasData ? `₹${fmt(ltp)}` : '—'}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
       {hasData && chgPt !== 0 && (
          <div style={{ fontSize: 10, fontWeight: 900, color: colors.sub, lineHeight: 1 }}>
            {fmtC(chgPt)}
          </div>
        )}
        <div style={{ fontSize: 10, fontWeight: 600, color: hasData ? colors.text : '#94a3b8', lineHeight: 1 }}>
          ({hasData ? fmtP(chgPct) : ''})
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

// ── Sector aggregate row — avg change per sector, tap to filter ──
function SectorAggregateRow({ enriched, sector, setSector }) {
  const bySector = useMemo(() => {
    const map = {};
    for (const s of enriched) {
      if (!s.sec || !s.ltp) continue;
      if (!map[s.sec]) map[s.sec] = { sum: 0, count: 0 };
      map[s.sec].sum += s.chgPct;
      map[s.sec].count++;
    }
    return Object.entries(map)
      .map(([sec, { sum, count }]) => ({ sec, avg: +(sum / count).toFixed(2), count }))
      .sort((a, b) => b.avg - a.avg);
  }, [enriched]);

  if (!bySector.length) return null;

  return (
    <div style={{ marginBottom: 10, overflowX: 'auto', display: 'flex', gap: 6, paddingBottom: 2 }}>
      {bySector.map(({ sec, avg, count }) => {
        const c = heatColor(avg);
        return (
          <button key={sec} onClick={() => setSector(sector === sec ? 'ALL' : sec)} style={{
            flexShrink: 0, padding: '5px 9px', borderRadius: 7, border: sector === sec ? '2px solid #0f172a' : '1px solid rgba(0,0,0,0.08)',
            background: c.bg, color: c.text, fontSize: 9.5, fontWeight: 800, cursor: 'pointer', textAlign: 'left',
          }}>
            <div style={{ whiteSpace: 'nowrap' }}>{sec}</div>
            <div style={{ fontSize: 9, opacity: 0.85 }}>{fmtP(avg)} · {count}</div>
          </button>
        );
      })}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────
export default function HeatmapPane() {
  const { token, stocks, marketStatus, lg, updateBadge, onTokenExpired, setActiveTab, setPendingLookupSymbol, openSignalSymbols, onTokenExpired: onTokExp } = useApp();

  const [sector,   setSector]   = useState('ALL');
  const [sortBy,   setSortBy]   = useState('chg');
  const [basePrices, setBasePrices] = useState({});
  const [loading,    setLoading]    = useState(false);
  const [updTime,    setUpdTime]    = useState('');
  const [error,      setError]      = useState('');
  const [squeezeMap, setSqueezeMap] = useState({}); // instrKey → 'extreme' | 'squeeze'

  const accessToken = resolveAccessToken(token);
  const allKeys = useMemo(() => stocks.map(s => s.key).filter(Boolean), [stocks]);

  const { connected: wsConnected, lastPrices } = useMarketFeed(
    accessToken, allKeys, allKeys.length > 0, { pollFallback: true, mode: 'ltpc' }
  );

  const loadBase = useCallback(async () => {
    if (!accessToken || !allKeys.length) return;
    setLoading(true); setError('');
    try {
      const { results, updTime: nextUpdTime } = await loadBasePrices({ accessToken, allKeys, onTokenExpired, lg, updateBadge });
      setBasePrices(results);
      setUpdTime(nextUpdTime);
    } catch (e) {
      setError(e.message);
      lg('Heatmap error: ' + e.message, 'e');
    } finally {
      setLoading(false);
    }
  }, [accessToken, allKeys, onTokenExpired, lg, updateBadge]); // eslint-disable-line

  useEffect(() => { if (accessToken) loadBase(); }, [accessToken]); // eslint-disable-line

  useEffect(() => {
    if (Object.keys(lastPrices).length > 0) {
      setUpdTime('Live: ' + getIST());
    }
  }, [lastPrices]);

  const enriched = useMemo(() => enrichHeatmapRows(stocks, basePrices, lastPrices), [stocks, basePrices, lastPrices]);

  const sectors = useMemo(() =>
    ['ALL', ...Array.from(new Set(stocks.map(s => s.sec).filter(Boolean))).sort()],
    [stocks]
  );

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

  // Relative volume rank (0-1) among currently visible/loaded tiles — cheap,
  // reuses volume already present in the quote data (no extra API calls).
  const volRankMap = useMemo(() => {
    const vols = sorted.filter(s => s.ltp > 0 && s.volume > 0).map(s => s.volume).sort((a, b) => a - b);
    if (!vols.length) return {};
    const map = {};
    for (const s of sorted) {
      if (!s.volume) { map[s.key] = 0; continue; }
      const idx = vols.findIndex(v => v >= s.volume);
      map[s.key] = idx / vols.length;
    }
    return map;
  }, [sorted]);

  // BB Squeeze check — only for the top N biggest movers currently visible,
  // to avoid firing hundreds of candle fetches on every refresh.
  useEffect(() => {
    if (!accessToken || !marketStatus.open) return;
    const candidates = [...sorted].filter(s => s.ltp > 0).sort((a, b) => Math.abs(b.chgPct) - Math.abs(a.chgPct)).slice(0, SQUEEZE_CHECK_COUNT);
    if (!candidates.length) return;
    let cancelled = false;
    (async () => {
      const results = {};
      for (const s of candidates) {
        if (cancelled) return;
        try {
          const candles = await fetchIntraday(s.key, '30minute', accessToken, onTokExp);
          const closes = (candles || []).map(c => c[4]).reverse(); // oldest-first
          const sq = calcBBSqueeze(closes);
          if (sq?.extremeSqueeze) results[s.key] = 'extreme';
          else if (sq?.squeeze) results[s.key] = 'squeeze';
        } catch (_) { /* skip on error, non-critical */ }
      }
      if (!cancelled) setSqueezeMap(results);
    })();
    return () => { cancelled = true; };
  }, [accessToken, marketStatus.open, sector]); // eslint-disable-line

  const loadedCount = enriched.filter(s => s.ltp > 0).length;

  const openTile = useCallback((stock) => {
    setPendingLookupSymbol(stock.s);
    setActiveTab('lookup');
  }, [setPendingLookupSymbol, setActiveTab]);

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

      {loadedCount > 0 && (
        <div style={{ marginBottom: 10 }}>
          <BreadthBar enriched={filtered} />
        </div>
      )}

      {loadedCount > 0 && <SectorAggregateRow enriched={enriched} sector={sector} setSector={setSector} />}

      {/* Sector pills */}
      <div className="sector-pills">
        {sectors.map(sec => (
          <button key={sec} onClick={() => setSector(sec)} className="sector-pill" style={{
            background: sector === sec ? '#0f172a' : '#f1f5f9',
            color:      sector === sec ? '#ffffff' : '#64748b',
          }}>{sec === 'ALL' ? '🌐 All' : sec}</button>
        ))}
      </div>

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

      <div style={{ fontSize: 9, color: '#94a3b8', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>{filtered.length} stocks{sector !== 'ALL' ? ` · ${sector}` : ''}</span>
        <span>{loadedCount}/{allKeys.length} prices loaded</span>
      </div>

      {loading && loadedCount === 0 && (
        <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
          ⏳ Loading prices…
        </div>
      )}

      <div className="heatmap-grid">
        {sorted.map(stock => (
          <HeatTile
            key={stock.instrKey || stock.s}
            stock={stock}
            ltp={stock.ltp}
            chgPct={stock.chgPct}
            chgPt={stock.chgPt}
            volRank={volRankMap[stock.key] || 0}
            hasSignal={openSignalSymbols?.has(stock.s)}
            squeeze={squeezeMap[stock.key] || null}
            onTap={() => openTile(stock)}
          />
        ))}
      </div>

      {/* Legend */}
      <div style={{ marginTop: 14, padding: '10px 12px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0', boxShadow: 'var(--shadow-flat)' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', marginBottom: 6, letterSpacing: 1 }}>COLOR SCALE</div>
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', height: 12 }}>
          {['#0d5c2f','#166534','#15803d','#22c55e','#4ade80','#94a3b8','#f87171','#ef4444','#dc2626','#991b1b','#7f1d1d'].map((c, i) => (
            <div key={i} style={{ flex: 1, background: c }} />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 9, color: '#94a3b8' }}>
          <span>≥+3%</span><span>0%</span><span>≤-3%</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 9, color: '#94a3b8', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>🎯 Open signal</span>
          <span>⚡ Extreme squeeze</span>
          <span>🔸 BB squeeze</span>
          <span>Thicker border = higher relative volume</span>
        </div>
      </div>
    </div>
  );
}

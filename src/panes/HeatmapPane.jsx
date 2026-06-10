import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken, fetchQ } from '../services/api';
import { fetchScanQuotesViaWS } from '../hooks/useMarketFeed';

const fmt  = v => v >= 1000 ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : v.toFixed(2);
const fmtP = (v, decimals = 2) => (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
const fmtC = v => (v >= 0 ? '+' : '') + v.toFixed(2);

// ── Color scale based on % change ────────────────────────────
// Deep green → light green → white → light red → deep red
function heatColor(chg) {
  if (chg >= 3)    return { bg: '#0d5c2f', text: '#ffffff', sub: '#a7f3d0' };
  if (chg >= 2)    return { bg: '#166534', text: '#ffffff', sub: '#bbf7d0' };
  if (chg >= 1)    return { bg: '#15803d', text: '#ffffff', sub: '#d1fae5' };
  if (chg >= 0.5)  return { bg: '#16a34a', text: '#ffffff', sub: '#dcfce7' };
  if (chg >= 0.1)  return { bg: '#22c55e', text: '#ffffff', sub: '#f0fdf4' };
  if (chg >= 0)    return { bg: '#4ade80', text: '#14532d', sub: '#166534' };
  if (chg >= -0.1) return { bg: '#f87171', text: '#fff',    sub: '#fee2e2' };
  if (chg >= -0.5) return { bg: '#ef4444', text: '#ffffff', sub: '#fee2e2' };
  if (chg >= -1)   return { bg: '#dc2626', text: '#ffffff', sub: '#fecaca' };
  if (chg >= -2)   return { bg: '#b91c1c', text: '#ffffff', sub: '#fca5a5' };
  if (chg >= -3)   return { bg: '#991b1b', text: '#ffffff', sub: '#fca5a5' };
  return           { bg: '#7f1d1d',         text: '#ffffff', sub: '#f87171' };
}

// ── Box size based on price magnitude ────────────────────────
function boxSize(price) {
  if (price >= 5000) return 'xl';
  if (price >= 2000) return 'lg';
  if (price >= 1000) return 'md';
  if (price >= 500)  return 'sm';
  return 'xs';
}

const SIZE_H = { xl: 80, lg: 76, md: 72, sm: 68, xs: 64 };

// ── Individual heatmap tile ───────────────────────────────────
function HeatTile({ stock, quote, size }) {
  const chg    = quote?.chgPct ?? 0;
  const ltp    = quote?.ltp    ?? 0;
  const chgPt  = quote?.chgPt  ?? 0;
  const colors = heatColor(chg);
  const h      = SIZE_H[size] || 80;

  return (
    <div style={{
      background: colors.bg,
      borderRadius: 6,
      padding: '6px 7px 5px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      height: h,
      cursor: 'pointer',
      transition: 'transform .15s, box-shadow .15s',
      boxSizing: 'border-box',
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.08)',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.02)'; e.currentTarget.style.zIndex = 10; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.3)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)';    e.currentTarget.style.zIndex = 1;  e.currentTarget.style.boxShadow = 'none'; }}
    >
      {/* Stock name */}
      <div style={{
        fontSize: 11, fontWeight: 800, color: colors.text,
        lineHeight: 1.1, letterSpacing: -0.2,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{stock.s}</div>

      {/* Price */}
      <div style={{
        fontSize: 10, fontWeight: 700, color: colors.sub, lineHeight: 1.2,
      }}>{ltp > 0 ? `₹${fmt(ltp)}` : '—'}</div>

      {/* Change pt + pct */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {ltp > 0 && (
          <div style={{ fontSize: 8, color: colors.sub, fontWeight: 600, lineHeight: 1.2 }}>
            {fmtC(chgPt)}
          </div>
        )}
        <div style={{ fontSize: 12, fontWeight: 900, color: colors.text, lineHeight: 1 }}>
          {ltp > 0 ? fmtP(chg) : ''}
        </div>
      </div>
    </div>
  );
}

// ── Market breadth bar ────────────────────────────────────────
function BreadthBar({ quotes }) {
  const vals   = Object.values(quotes);
  const adv    = vals.filter(q => q.chgPct >  0.1).length;
  const dec    = vals.filter(q => q.chgPct < -0.1).length;
  const flat   = vals.length - adv - dec;
  const total  = vals.length || 1;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', height: 10 }}>
        <div style={{ width: `${adv / total * 100}%`,  background: '#16a34a', transition: 'width .6s' }} />
        <div style={{ width: `${flat / total * 100}%`, background: '#94a3b8', transition: 'width .6s' }} />
        <div style={{ width: `${dec / total * 100}%`,  background: '#dc2626', transition: 'width .6s' }} />
      </div>
      <div style={{ display: 'flex', gap: 12, fontSize: 9, fontWeight: 700 }}>
        <span style={{ color: '#16a34a' }}>▲ {adv} up</span>
        <span style={{ color: '#94a3b8' }}>— {flat} flat</span>
        <span style={{ color: '#dc2626' }}>▼ {dec} down</span>
        <span style={{ color: '#64748b', marginLeft: 'auto' }}>{vals.length} stocks</span>
      </div>
    </div>
  );
}

// ── Main pane ─────────────────────────────────────────────────
export default function HeatmapPane() {
  const { token, stocks, updateBadge, lg } = useApp();

  const [quotes,     setQuotes]     = useState({});   // { instrKey: { ltp, chgPct, chgPt } }
  const [loading,    setLoading]    = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [sector,     setSector]     = useState('ALL');
  const [sortBy,     setSortBy]     = useState('chg'); // 'chg' | 'chg_asc' | 'name' | 'price'
  const [error,      setError]      = useState('');
  const timerRef = useRef(null);

  // Derive sectors
  const sectors = ['ALL', ...Array.from(new Set(stocks.map(s => s.sec).filter(Boolean))).sort()];

  // Filtered + sorted stocks
  const filtered = stocks.filter(s => sector === 'ALL' || s.sec === sector);
  const withQuote = filtered.map(s => {
    const q = quotes[s.instrKey] || {};
    return { ...s, ltp: q.ltp || 0, chgPct: q.chgPct || 0, chgPt: q.chgPt || 0 };
  });

  const sorted = [...withQuote].sort((a, b) => {
    if (sortBy === 'chg')     return b.chgPct - a.chgPct;
    if (sortBy === 'chg_asc') return a.chgPct - b.chgPct;
    if (sortBy === 'price')   return b.ltp - a.ltp;
    return a.s.localeCompare(b.s);
  });

  // Parse raw quote (works for both WS and REST response shapes)
  function parseQuote(q) {
    const ltp  = q.last_price || 0;
    const prev = q.ohlc?.close || 0;
    const chgPct = (ltp > 0 && prev > 0) ? ((ltp - prev) / prev) * 100 : 0;
    const chgPt  = (ltp > 0 && prev > 0) ? ltp - prev : 0;
    return { ltp, chgPct, chgPt };
  }

  // Fetch via REST in batches of 50 (Upstox limit per call)
  async function fetchViaREST(accessToken, keys) {
    const BATCH = 50;
    const map = {};
    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);
      try {
        const raw = await fetchQ(batch.join(','), accessToken);
        for (const [k, v] of Object.entries(raw)) {
          map[k] = parseQuote(v);
        }
      } catch (_) {}
    }
    return map;
  }

  // Fetch quotes — WS first, REST fallback if WS returns <50% coverage
  const fetchAll = useCallback(async () => {
    if (!stocks.length) return;
    const accessToken = resolveAccessToken(token);
    if (!accessToken) { setError('Token not set — paste token in ⚙ Settings'); return; }
    setLoading(true); setError('');
    try {
      const keys = stocks.map(s => s.instrKey).filter(Boolean);
      let map = {};
      let source = 'WS';

      // Try WebSocket first
      try {
        const raw = await fetchScanQuotesViaWS(accessToken, keys, 10000);
        for (const [key, q] of Object.entries(raw)) {
          const p = parseQuote(q);
          if (p.ltp > 0) map[key] = p;
        }
      } catch (_) {}

      // Fall back to REST if WS got < 50% coverage (market closed / WS auth failed)
      if (Object.keys(map).length < keys.length * 0.5) {
        lg('Heatmap: WS got partial data, falling back to REST', 'w');
        source = 'REST';
        map = await fetchViaREST(accessToken, keys);
      }

      if (Object.keys(map).length === 0) {
        setError('No quote data returned — market may be closed or token expired');
        return;
      }

      setQuotes(map);
      setLastUpdate(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ` (${source})`);
      updateBadge('heatmap', String(Object.keys(map).length));
      lg(`Heatmap: ${Object.keys(map).length} quotes via ${source}`, 'o');
    } catch (e) {
      setError('Quote fetch failed: ' + e.message);
      lg('Heatmap error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }, [stocks, token, updateBadge, lg]); // eslint-disable-line

  // Auto-refresh every 30s
  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, 30000);
    return () => clearInterval(timerRef.current);
  }, [fetchAll]);

  // Market summary stats
  const loadedQuotes = Object.values(quotes).filter(q => q.ltp > 0);
  const advDecMap = sector === 'ALL' ? quotes : Object.fromEntries(
    filtered.map(s => [s.instrKey, quotes[s.instrKey]]).filter(([, q]) => q)
  );
  const advDec = Object.values(advDecMap).filter(q => q?.ltp > 0);

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
      {/* Header bar */}
      <div style={{ marginBottom: 10 }}>
        {/* Breadth bar — only when we have data */}
        {advDec.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <BreadthBar quotes={advDecMap} />
          </div>
        )}

        {/* Controls row 1: sector filter */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, overflowX: 'auto', paddingBottom: 2 }}>
          {sectors.map(sec => (
            <button key={sec} onClick={() => setSector(sec)} style={{
              padding: '5px 11px', fontSize: 10, fontWeight: 700, borderRadius: 20,
              border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
              background: sector === sec ? '#0f172a' : '#f1f5f9',
              color:      sector === sec ? '#ffffff' : '#64748b',
              boxShadow:  sector === sec ? '0 1px 4px rgba(0,0,0,.2)' : 'none',
              transition: 'all .15s',
            }}>{sec === 'ALL' ? '🌐 All' : sec}</button>
          ))}
        </div>

        {/* Controls row 2: sort + refresh */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
            flex: 1, background: '#fff', border: '1px solid #e2e8f0',
            borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 700,
            color: '#0f172a', cursor: 'pointer',
          }}>
            <option value="chg">↓ Gainers first</option>
            <option value="chg_asc">↑ Losers first</option>
            <option value="price">↓ Price: high→low</option>
            <option value="name">A–Z Name</option>
          </select>
          <button onClick={fetchAll} disabled={loading} style={{
            padding: '6px 14px', fontSize: 11, fontWeight: 800, borderRadius: 8,
            border: 'none', cursor: loading ? 'default' : 'pointer',
            background: loading ? '#e2e8f0' : 'linear-gradient(135deg,#0f172a,#1e293b)',
            color: loading ? '#94a3b8' : '#fff',
            minWidth: 70,
          }}>{loading ? '⏳' : '↻ Live'}</button>
        </div>

        {/* Status line */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 9, color: '#94a3b8' }}>
          <span>{filtered.length} stocks · {sector !== 'ALL' ? sector : 'all sectors'}</span>
          {lastUpdate && <span>Updated {lastUpdate} · auto↻ 30s</span>}
        </div>

        {error && (
          <div style={{ marginTop: 6, padding: '7px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, fontSize: 10, color: '#991b1b', fontWeight: 600 }}>
            ⚠ {error}
          </div>
        )}
      </div>

      {/* Heatmap grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 3,
      }}>
        {sorted.map(stock => {
          const q = quotes[stock.instrKey];
          const sz = q?.ltp ? boxSize(q.ltp) : 'sm';
          return (
            <HeatTile
              key={stock.instrKey || stock.s}
              stock={stock}
              quote={q ? { ...q } : null}
              size={sz}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ marginTop: 14, padding: '10px 12px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', marginBottom: 6, letterSpacing: 1 }}>COLOR SCALE</div>
        <div style={{ display: 'flex', gap: 3, borderRadius: 6, overflow: 'hidden', height: 14 }}>
          {[
            '#0d5c2f','#15803d','#22c55e','#4ade80',
            '#94a3b8',
            '#f87171','#ef4444','#dc2626','#991b1b',
          ].map((c, i) => (
            <div key={i} style={{ flex: 1, background: c }} />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 9, color: '#94a3b8' }}>
          <span>≥+3%</span>
          <span>0%</span>
          <span>≤-3%</span>
        </div>
      </div>
    </div>
  );
}

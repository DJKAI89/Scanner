import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken } from '../services/api';
import { useMarketFeed } from '../hooks/useMarketFeed';

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
function HeatTile({ stock, price }) {
  const ltp    = price?.ltp    ?? 0;
  const chgPct = price?.chgPct ?? 0;
  const chgPt  = ltp > 0 ? (ltp - (price?.cp || ltp)) : 0;
  const colors = heatColor(chgPct);
  const hasData = ltp > 0;

  return (
    <div style={{
      background: hasData ? colors.bg : '#e2e8f0',
      borderRadius: 6,
      padding: '6px 7px 5px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      height: 72,
      boxSizing: 'border-box',
      overflow: 'hidden',
      border: '1px solid rgba(0,0,0,0.06)',
      transition: 'background .4s',
    }}>
      {/* Name */}
      <div style={{
        fontSize: 11, fontWeight: 800,
        color: hasData ? colors.text : '#94a3b8',
        lineHeight: 1.1, letterSpacing: -0.2,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{stock.s}</div>

      {/* LTP */}
      <div style={{
        fontSize: 10, fontWeight: 700,
        color: hasData ? colors.sub : '#cbd5e1',
        lineHeight: 1.2,
      }}>
        {hasData ? `₹${fmt(ltp)}` : '—'}
      </div>

      {/* Change pt + pct */}
      <div>
        {hasData && (
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
function BreadthBar({ items, lastPrices }) {
  let adv = 0, dec = 0, flat = 0;
  for (const s of items) {
    const p = lastPrices[s.instrKey];
    if (!p?.ltp) continue;
    const c = p.chgPct || 0;
    if (c >  0.1) adv++;
    else if (c < -0.1) dec++;
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
        <span style={{ color: '#64748b', marginLeft: 'auto' }}>{adv+dec+flat} live</span>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────
export default function HeatmapPane() {
  const { token, stocks } = useApp();

  const [sector, setSector] = useState('ALL');
  const [sortBy, setSortBy] = useState('chg');

  const accessToken = resolveAccessToken(token);

  // All instrument keys from stocks list
  const allKeys = useMemo(() => stocks.map(s => s.instrKey).filter(Boolean), [stocks]);

  // ── Single persistent WS — same as Portfolio/Stocks pages ──
  // 'ltpc' mode: gets ltp + cp (prev close) for every key, continuous ticks
  const { connected, lastPrices, wsMode } = useMarketFeed(
    accessToken,
    allKeys,
    allKeys.length > 0,
    { mode: 'ltpc', pollFallback: true }
  );

  // Sectors
  const sectors = useMemo(() =>
    ['ALL', ...Array.from(new Set(stocks.map(s => s.sec).filter(Boolean))).sort()],
    [stocks]
  );

  // Filter by sector
  const filtered = useMemo(() =>
    sector === 'ALL' ? stocks : stocks.filter(s => s.sec === sector),
    [stocks, sector]
  );

  // Sort
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const pa = lastPrices[a.instrKey];
      const pb = lastPrices[b.instrKey];
      if (sortBy === 'chg')     return (pb?.chgPct ?? -99) - (pa?.chgPct ?? -99);
      if (sortBy === 'chg_asc') return (pa?.chgPct ?? 99)  - (pb?.chgPct ?? 99);
      if (sortBy === 'price')   return (pb?.ltp    ?? 0)   - (pa?.ltp    ?? 0);
      return a.s.localeCompare(b.s);
    });
  }, [filtered, lastPrices, sortBy]);

  // WS status indicator
  const wsLabel = wsMode === 'ws' ? '🟢 Live WS'
    : wsMode === 'poll' ? '🟡 Polling'
    : connected ? '🟢 Live'
    : '🔴 Connecting…';

  if (!stocks.length) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#94a3b8' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>No stocks loaded</div>
        <div style={{ fontSize: 11 }}>Go to ⚙ Settings → Reload stocks.json</div>
      </div>
    );
  }

  const loadedCount = allKeys.filter(k => lastPrices[k]?.ltp > 0).length;

  return (
    <div>
      {/* Breadth bar */}
      {loadedCount > 0 && (
        <div style={{ marginBottom: 10 }}>
          <BreadthBar items={filtered} lastPrices={lastPrices} />
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

      {/* Sort + status */}
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
        <div style={{
          padding: '6px 12px', fontSize: 10, fontWeight: 700, borderRadius: 8,
          background: '#f8fafc', border: '1px solid #e2e8f0', whiteSpace: 'nowrap',
          color: wsMode === 'ws' ? '#16a34a' : wsMode === 'poll' ? '#d97706' : '#94a3b8',
        }}>{wsLabel}</div>
      </div>

      {/* Info line */}
      <div style={{ fontSize: 9, color: '#94a3b8', marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>{filtered.length} stocks · {sector !== 'ALL' ? sector : 'all sectors'}</span>
        <span>{loadedCount}/{allKeys.length} prices loaded</span>
      </div>

      {/* Loading state */}
      {loadedCount === 0 && (
        <div style={{ padding: '20px 0', textAlign: 'center', color: '#94a3b8', fontSize: 11 }}>
          ⏳ Connecting to market feed…
        </div>
      )}

      {/* Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 3 }}>
        {sorted.map(stock => (
          <HeatTile
            key={stock.instrKey || stock.s}
            stock={stock}
            price={lastPrices[stock.instrKey] ?? null}
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

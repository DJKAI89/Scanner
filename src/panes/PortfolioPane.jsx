import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, EmptyState, LastUpdated } from '../components/common.jsx';
import { resolveAccessToken } from '../services/api';
import { fmt, fmtC } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed';
import {
  getInstrumentKey, loadPortfolio, enrichPortfolioRows,
  computeSectorMap, computeConcentrationWarnings, sortRows, loadPortfolioAiGuidance,
} from '../services/portfolioService';

export default function PortfolioPane() {
  const { token, onTokenExpired, lg, updateBadge, marketStatus, gh, mlModels } = useApp();
  const accessToken = resolveAccessToken(token);

  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [positions, setPositions] = useState([]);
  const [holdings, setHoldings]   = useState([]);
  const [updTime, setUpdTime]     = useState('');
  const [tab, setTab]             = useState('holdings');
  const [sortCol, setSortCol]     = useState('sym');
  const [sortDir, setSortDir]     = useState('asc');
  const [aiGuidance, setAiGuidance] = useState(null);

  function toggleSort(col) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir(col === 'sym' ? 'asc' : 'desc'); }
  }

  const allKeys = useMemo(() => {
    const keys = [...positions.map(getInstrumentKey), ...holdings.map(getInstrumentKey)].filter(Boolean);
    return [...new Set(keys)];
  }, [positions, holdings]);

  const { connected: wsConnected, lastPrices } = useMarketFeed(
    accessToken, allKeys, allKeys.length > 0, { pollFallback: true, mode: 'ltpc' }
  );

  useEffect(() => { if (accessToken) load(); }, [accessToken]); // eslint-disable-line
  useEffect(() => {
    if (Object.keys(lastPrices).length > 0) setUpdTime('Live: ' + getIST());
  }, [lastPrices]);

  // ── PORTFOLIO LOAD — thin wrapper around services/portfolioService.loadPortfolio ──
  async function load() {
    setLoading(true); setError('');
    try {
      const { positions: pos, holdings: hld } = await loadPortfolio(accessToken, onTokenExpired);
      setPositions(pos); setHoldings(hld);
      updateBadge('portfolio', String(pos.length + hld.length));
      setUpdTime('Updated: ' + getIST());
      lg(`Portfolio: ${pos.length} positions, ${hld.length} holdings`, 'o');
    } catch (e) {
      setError(e.message);
      lg('Portfolio error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }

  const enrichedPos = useMemo(() => enrichPortfolioRows(positions, lastPrices), [positions, lastPrices]);
  const enrichedHld = useMemo(() =>
    enrichPortfolioRows(holdings, lastPrices).sort((a, b) => (a.tradingsymbol||a.symbol||'').localeCompare(b.tradingsymbol||b.symbol||'')),
    [holdings, lastPrices]);

  const portfolioRows = [...enrichedPos, ...enrichedHld];
  const totalPnl   = portfolioRows.reduce((s, i) => s + (i.pnl     || 0), 0);
  const invested   = portfolioRows.reduce((s, i) => s + (i.avg * i.qty), 0);
  const todayPnl   = portfolioRows.reduce((s, i) => s + (i.todayPnl|| 0), 0);
  const totalValue = portfolioRows.reduce((s, i) => s + (i.value   || 0), 0);

  // AI guidance — only refires on raw data reload, not on every WS price tick
  useEffect(() => {
    if (!gh?.token || !mlModels || (!positions.length && !holdings.length)) { setAiGuidance(null); return; }
    loadPortfolioAiGuidance({ gh, mlModels, portfolioRows: [...positions, ...holdings] }).then(setAiGuidance);
  }, [positions, holdings, gh?.token, gh?.user, gh?.repo, mlModels?.computedAt]); // eslint-disable-line

  const sectorMap = useMemo(() => computeSectorMap(enrichedHld.concat(enrichedPos)), [enrichedHld, enrichedPos]);

  const correlationWarnings = useMemo(() => computeConcentrationWarnings(sectorMap, totalValue), [sectorMap, totalValue]);

  const current = tab === 'positions' ? enrichedPos : enrichedHld;

  const sortedCurrent = useMemo(() => sortRows(current, sortCol, sortDir), [current, sortCol, sortDir]);

  // ── Shared color helpers ──
  const gc = v => v >= 0 ? '#16a34a' : '#dc2626';
  const fmtPnl = (v, abs = false) => {
    const n = abs ? Math.abs(v) : v;
    return (v >= 0 ? '+' : '') + '₹' + fmt(Math.abs(n));
  };
  const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

  // ── Sort header helper ──
  function SortHdr({ col, label, align = 'right' }) {
    const active = sortCol === col;
    return (
      <div onClick={() => toggleSort(col)} style={{
        fontSize: 9, fontWeight: 700, color: active ? '#1d4ed8' : '#94a3b8',
        letterSpacing: 0.5, cursor: 'pointer', textAlign: align,
        display: 'flex', alignItems: 'center', justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        gap: 2, userSelect: 'none', whiteSpace: 'nowrap',
      }}>
        {label}
        <span style={{ fontSize: 8, opacity: active ? 1 : 0.4 }}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </div>
    );
  }

  // ── Mobile card (all 9 fields, stacked) ──
  function MobileCard({ item }) {
    const sym = item.tradingsymbol || item.symbol || '';
    return (
      <div style={{
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
        padding: '11px 13px', marginBottom: 8,
        boxShadow: '0 1px 3px rgba(0,0,0,.04)',
      }}>
        {/* Top row: Symbol + LTP */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 5 }}>
              {sym}
              {item.isLive && marketStatus.open && (
                <span style={{ fontSize: 7, background: '#dcfce7', color: '#16a34a', borderRadius: 3, padding: '1px 4px', fontWeight: 800 }}>⚡</span>
              )}
            </div>
            <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 1 }}>{item.exchange || 'NSE'} EQ · Qty: {item.qty?.toLocaleString('en-IN')}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: item.ltp >= item.avg ? '#16a34a' : '#dc2626' }}>₹{fmt(item.ltp)}</div>
            <div style={{ fontSize: 9, color: '#94a3b8' }}>Avg ₹{fmt(item.avg)}</div>
          </div>
        </div>

        {/* Grid: 4 metrics */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6 }}>
          {[
            { label: 'VALUE',      value: '₹' + fmt(item.value),         color: '#0f172a' },
            { label: 'DAY P&L',    value: fmtPnl(item.todayPnl),         color: gc(item.todayPnl) },
            { label: 'DAY %',      value: fmtPct(item.todayPct),          color: gc(item.todayPct) },
            { label: 'OVERALL P&L', value: fmtPnl(item.pnl),             color: gc(item.pnl) },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: '#f8fafc', borderRadius: 6, padding: '5px 7px' }}>
              <div style={{ fontSize: 7, color: '#94a3b8', fontWeight: 700, letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 11, fontWeight: 800, color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Overall % bar */}
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 4, background: '#f1f5f9', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%', borderRadius: 2,
              width: Math.min(100, Math.abs(item.pnlPct)) + '%',
              background: item.pnlPct >= 0 ? '#16a34a' : '#dc2626',
              transition: 'width .4s',
            }} />
          </div>
          <div style={{ fontSize: 11, fontWeight: 900, color: gc(item.pnlPct), minWidth: 52, textAlign: 'right' }}>
            {fmtPct(item.pnlPct)}
          </div>
        </div>
      </div>
    );
  }

  // ── Tablet row (horizontal table, all 9 cols) ──
  const COLS = [
    { col: 'sym',    label: 'SYMBOL',      align: 'left'  },
    { col: 'qty',    label: 'NET QTY',     align: 'right' },
    { col: 'avg',    label: 'AVG PRICE',   align: 'right' },
    { col: 'ltp',    label: 'LTP ⚡',      align: 'right' },
    { col: 'value',  label: 'CURR VALUE',  align: 'right' },
    { col: 'dayPnl', label: 'DAY P&L',     align: 'right' },
    { col: 'dayPct', label: 'DAY %',       align: 'right' },
    { col: 'pnl',    label: 'OVERALL P&L', align: 'right' },
    { col: 'pnlPct', label: 'OVERALL %',   align: 'right' },
  ];

  // CSS grid: symbol wider, rest equal
  const gridCols = '1.8fr 0.7fr 0.9fr 0.9fr 1fr 1fr 0.7fr 1fr 0.8fr';

  function TableRow({ item }) {
    const sym = item.tradingsymbol || item.symbol || '';
    return (
      <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 4, padding: '9px 12px', borderBottom: '1px solid #f1f5f9', alignItems: 'center', fontSize: 11 }}>
        <div>
          <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
            {sym}
            {item.isLive && marketStatus.open && (
              <span style={{ fontSize: 7, background: '#dcfce7', color: '#16a34a', borderRadius: 3, padding: '1px 3px', fontWeight: 800 }}>⚡</span>
            )}
          </div>
          <div style={{ fontSize: 9, color: '#94a3b8' }}>{item.exchange || 'NSE'} EQ</div>
        </div>
        <div style={{ textAlign: 'right', fontWeight: 600 }}>{item.qty?.toLocaleString('en-IN')}</div>
        <div style={{ textAlign: 'right' }}>₹{fmt(item.avg)}</div>
        <div style={{ textAlign: 'right', fontWeight: 700, color: item.ltp >= item.avg ? '#16a34a' : '#dc2626' }}>₹{fmt(item.ltp)}</div>
        <div style={{ textAlign: 'right' }}>₹{fmt(item.value)}</div>
        <div style={{ textAlign: 'right', fontWeight: 600, color: gc(item.todayPnl) }}>{fmtPnl(item.todayPnl)}</div>
        <div style={{ textAlign: 'right', fontWeight: 700, color: gc(item.todayPct) }}>{fmtPct(item.todayPct)}</div>
        <div style={{ textAlign: 'right', fontWeight: 700, color: gc(item.pnl) }}>{fmtPnl(item.pnl)}</div>
        <div style={{ textAlign: 'right', fontWeight: 800, color: gc(item.pnlPct) }}>{fmtPct(item.pnlPct)}</div>
      </div>
    );
  }

  return (
    <div>
      {error && <ErrorBanner title="⚠ Portfolio Error" message={error} onRetry={load} />}
      {loading ? (
        <Spinner label="Loading portfolio..." sub="Positions · Holdings" />
      ) : (
        <div>
          {/* WS status */}
          {allKeys.length > 0 && (
            <div style={{ fontSize: 9, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: wsConnected ? '#16a34a' : '#94a3b8', flexShrink: 0 }} />
              <span style={{ color: '#94a3b8' }}>
                {wsConnected ? `⚡ Live P&L — ${allKeys.length} instruments streaming` : 'WebSocket connecting...'}
              </span>
              {updTime && <span style={{ marginLeft: 'auto', color: '#94a3b8' }}>{updTime}</span>}
            </div>
          )}

          {/* Summary stats */}
          <div className="stats-g" style={{ marginBottom: 12 }}>
            <StatCard label="INVESTED"  value={`₹${fmt(invested)}`}   valClass="bl" />
            <StatCard label="VALUE"     value={`₹${fmt(totalValue)}`} valClass="pu" />
            <StatCard label="TODAY P&L" value={(todayPnl  >= 0 ? '+₹' : '-₹') + fmt(Math.abs(todayPnl))}  valClass={todayPnl  >= 0 ? 'up' : 'dn'} />
            <StatCard label="TOTAL P&L" value={(totalPnl  >= 0 ? '+₹' : '-₹') + fmt(Math.abs(totalPnl))}  valClass={totalPnl  >= 0 ? 'up' : 'dn'} />
            <StatCard label="POSITIONS" value={positions.length} valClass="am" />
            <StatCard label="HOLDINGS"  value={holdings.length}  valClass="pu" />
          </div>

          {/* Concentration warnings */}
          {correlationWarnings.length > 0 && (
            <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 13px', marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#92400e', marginBottom: 4 }}>⚠ Concentration Risk</div>
              {correlationWarnings.map((w, i) => <div key={i} style={{ fontSize: 10, color: '#78350f' }}>{w}</div>)}
            </div>
          )}

          {/* AI portfolio guidance */}
          {aiGuidance?.suggestions?.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>🤖 AI Guidance — today's candidates vs your exposure (max {aiGuidance.maxConcurrent} concurrent)</div>
              {aiGuidance.suggestions.map(s => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f1f5f9', fontSize: 10 }}>
                  <div>
                    <span style={{ fontWeight: 700 }}>{s.symbol}</span>
                    {s.clusterPenalty > 0 && <span style={{ color: '#d97706', marginLeft: 6 }}>⚠ cluster penalty {s.clusterPenalty}</span>}
                  </div>
                  <div style={{ textAlign: 'right', color: '#374151' }}>
                    risk {s.suggestedRiskPct}% · stop {s.dailyStopPct}%
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Sector exposure */}
          {sectorMap.length > 1 && totalValue > 0 && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#0f172a', marginBottom: 10 }}>🏭 Sector Exposure</div>
              {sectorMap.map(([sec, v]) => {
                const pct = totalValue > 0 ? (v.value / totalValue * 100) : 0;
                const col = pct > 40 ? '#dc2626' : pct > 25 ? '#d97706' : '#16a34a';
                return (
                  <div key={sec} style={{ marginBottom: 7 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 2 }}>
                      <span style={{ color: '#374151', fontWeight: 600 }}>{sec} ({v.count})</span>
                      <span style={{ fontWeight: 700, color: col }}>{pct.toFixed(0)}% · ₹{fmt(v.value)}</span>
                    </div>
                    <div style={{ background: '#f1f5f9', borderRadius: 4, height: 5 }}>
                      <div style={{ background: col, width: Math.min(100, pct) + '%', height: 5, borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Tab toggle */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 12, background: '#f1f5f9', borderRadius: 10, padding: 3 }}>
            {[
              { id: 'holdings',  label: `💼 Holdings (${holdings.length})`   },
              { id: 'positions', label: `📊 Positions (${positions.length})` },
            ].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
                fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: tab === t.id ? '#fff' : 'transparent',
                color:      tab === t.id ? '#1d4ed8' : '#64748b',
                boxShadow:  tab === t.id ? '0 1px 4px rgba(0,0,0,.1)' : 'none',
              }}>{t.label}</button>
            ))}
          </div>

          {current.length === 0 ? (
            <EmptyState>No {tab} found in your Upstox account</EmptyState>
          ) : (
            <>
              {/* ── MOBILE: cards layout (<600px) ── */}
              <div className="ptbl-cards">
                {/* Sort bar for mobile */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 10, overflowX: 'auto', paddingBottom: 2 }}>
                  {COLS.map(({ col, label }) => (
                    <button key={col} onClick={() => toggleSort(col)} style={{
                      padding: '4px 10px', fontSize: 9, fontWeight: 700, borderRadius: 16,
                      border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                      background: sortCol === col ? '#0f172a' : '#f1f5f9',
                      color:      sortCol === col ? '#fff'    : '#64748b',
                    }}>
                      {label} {sortCol === col ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                    </button>
                  ))}
                </div>
                {sortedCurrent.map((item, i) => <MobileCard key={i} item={item} />)}
              </div>

              {/* ── TABLET/DESKTOP: table layout (≥600px) ── */}
              <div className="ptbl-table">
                <div style={{
                  background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10,
                  overflow: 'hidden', overflowX: 'auto', WebkitOverflowScrolling: 'touch',
                }}>
                  {/* Header */}
                  <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 4, padding: '8px 12px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', minWidth: 680 }}>
                    {COLS.map(({ col, label, align }) => (
                      <SortHdr key={col} col={col} label={label} align={align} />
                    ))}
                  </div>
                  {/* Rows */}
                  <div style={{ minWidth: 680 }}>
                    {sortedCurrent.map((item, i) => <TableRow key={i} item={item} />)}
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="disc">
            ⚡ P&L updates in real-time via Upstox WebSocket during market hours. Actual P&L may differ due to charges and settlement.
          </div>
        </div>
      )}
    </div>
  );
}

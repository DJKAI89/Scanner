import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, LastUpdated, EmptyState } from '../components/common.jsx';
import { resolveAccessToken, fetchOptionGreeks } from '../services/api';
import { fmt, fmtC, interpVIX } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { loadOptionMeta, loadChainForExpiry, mergeLiveIntoRows, selectStrikesAroundATM } from '../services/optionAnalysisService';
import { buildConfidenceRows } from '../components/ConfidenceBreakdown';

const INDEX_FILTERS = [
  { id: 'NIFTY',     key: 'NSE_INDEX|Nifty 50',  step: 50,  lot: 75, color: '#7c3aed' },
  { id: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank', step: 100, lot: 30, color: '#0ea5e9' },
  { id: 'SENSEX',    key: 'BSE_INDEX|SENSEX',     step: 100, lot: 20, color: '#16a34a' },
];

const VIX_KEY = 'NSE_INDEX|India VIX';
const PAGE_SIZE = 20;

function chgColor(pct) {
  if (pct == null || pct === 0) return '#64748b';
  return pct > 0 ? '#16a34a' : '#dc2626';
}
// Bar strength under each %-change figure — width scaled to magnitude, capped.
function ChgBar({ pct, align }) {
  const w = Math.min(100, Math.abs(pct || 0) * 2);
  return (
    <div style={{ height: 2, width: '100%', background: '#f1f5f9', marginTop: 3 }}>
      <div style={{
        height: 2, width: w + '%', background: chgColor(pct),
        marginLeft: align === 'right' ? 'auto' : 0,
      }} />
    </div>
  );
}

function confColor(c) {
  if (c == null) return '#94a3b8';
  return c >= 70 ? '#16a34a' : c >= 50 ? '#d97706' : '#dc2626';
}
function confBg(c) {
  if (c == null) return 'transparent';
  return c >= 70 ? '#f0fdf4' : c >= 50 ? '#fffbeb' : '#fef2f2';
}
function fmtMargin(v) {
  if (!v) return '—';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + 'L';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + fmt(v, 0);
}

// ── One side (CE or PE) of a strike row — LTP, confidence, margin ──
function SideCell({ cell, align }) {
  const [open, setOpen] = useState(false);
  if (!cell) return <div style={{ flex: 1, padding: '8px 6px' }} />;
  const ltpColor = chgColor(cell.ltpChgPct);
  const rows = open ? buildConfidenceRows(cell, 'option') : [];
  return (
    <div style={{ flex: 1, padding: '8px 9px', textAlign: align }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, color: ltpColor, display: 'flex', alignItems: 'baseline', gap: 4, justifyContent: align === 'left' ? 'flex-start' : 'flex-end' }}>
        {fmt(cell.ltp)}{cell.isLive && <span style={{ fontSize: 6, color: '#16a34a' }}>⚡</span>}
      </div>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: ltpColor }}>{cell.ltpChgPct >= 0 ? '+' : ''}{cell.ltpChgPct}%</div>
      <ChgBar pct={cell.ltpChgPct} align={align} />
      <button onClick={() => setOpen(v => !v)} style={{
        border: 'none', cursor: 'pointer', display: 'inline-flex', justifyContent: align === 'left' ? 'flex-start' : 'flex-end', alignItems: 'center', gap: 4,
        marginTop: 4, background: confBg(cell.confidence), borderRadius: 5, padding: '1.5px 5px',
      }}>
        <span style={{ fontSize: 9.5, fontWeight: 800, color: confColor(cell.confidence) }}>{cell.confidence}% {open ? '▾' : '▸'}</span>
      </button>
      <div style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 2 }}>{fmtMargin(cell.marginEst)} margin</div>
      {open && rows.length > 0 && (
        <div style={{ marginTop: 5, background: '#fafbfc', border: '1px solid #f1f5f9', borderRadius: 6, padding: '5px 7px', textAlign: 'left' }}>
          <div style={{ fontSize: 7.5, fontWeight: 800, color: '#94a3b8', marginBottom: 2 }}>RAW SIGNAL — grid shows base score only, not the full ranked pipeline</div>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9 }}>
              <span style={{ color: '#64748b' }}>{r.label}</span>
              <span style={{ fontWeight: 700, color: r.dir > 0 ? '#16a34a' : r.dir < 0 ? '#dc2626' : '#64748b' }}>{r.val}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StrikeRow({ row, accentColor }) {
  const pcr = row.CE?.oi > 0 ? +(row.PE?.oi / row.CE.oi).toFixed(2) : (row.PE?.oi > 0 ? 99.99 : 0);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid #f1f5f9', background: row.atm ? '#faf5ff' : '#fff' }}>
      <SideCell cell={row.CE} align="left" />
      <div style={{
        width: 78, flexShrink: 0, textAlign: 'center', fontSize: 13, fontWeight: 800,
        color: row.atm ? accentColor : '#334155',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        borderLeft: '1px solid #f1f5f9', borderRight: '1px solid #f1f5f9', background: '#fafbfc',
      }}>
        <div>{fmt(row.strike, 0)}</div>
        <div style={{ fontSize: 8.5, color: '#94a3b8', fontWeight: 700, marginTop: 1 }}>PCR: {pcr}</div>
      </div>
      <SideCell cell={row.PE} align="right" />
    </div>
  );
}

// Spot-price pill inserted inline between the strike rows just below spot,
// exactly like a broker chain's "current price" divider.
function SpotDivider({ spot, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '6px 0' }}>
      <div style={{ flex: 1, height: 1, background: color }} />
      <div style={{ background: color, color: '#fff', fontSize: 12, fontWeight: 800, padding: '5px 16px', borderRadius: 20, margin: '0 8px' }}>
        {fmt(spot, 2)}
      </div>
      <div style={{ flex: 1, height: 1, background: color }} />
    </div>
  );
}

function ChainSection({ chain, shownRows, totalStrikes, spot, accentColor, onLoadMore }) {
  const hasMore = totalStrikes > shownRows.length;
  let spotInserted = false;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '9px 12px', borderRadius: '10px 10px 0 0',
        background: `linear-gradient(90deg, ${accentColor}15, ${accentColor}05)`,
        border: `1px solid ${accentColor}30`, borderBottom: 'none',
      }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: accentColor }}>📅 {chain?.expiry}</span>
        <span style={{ fontSize: 9.5, color: '#64748b', fontWeight: 600 }}>{shownRows.length}/{totalStrikes} · Max Pain {fmt(chain?.maxPain, 0)} · PCR {chain?.pcr?.toFixed(2)}</span>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', padding: '7px 9px', background: '#f1f5f9',
        border: `1px solid ${accentColor}30`, borderTop: 'none',
        fontSize: 9, fontWeight: 800, color: '#64748b', letterSpacing: 0.3,
      }}>
        <div style={{ flex: 1, textAlign: 'left' }}>← CALLS</div>
        <div style={{ width: 78, textAlign: 'center' }}>STRIKE 🔍</div>
        <div style={{ flex: 1, textAlign: 'right' }}>PUTS →</div>
      </div>

      <div style={{ border: `1px solid ${accentColor}30`, borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden', boxShadow: 'var(--shadow-raised)' }}>
        {shownRows.length === 0
          ? <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: '#94a3b8' }}>No strikes in range</div>
          : shownRows.map((row, i) => {
              // Insert the spot-price divider right where price crosses between strikes.
              const showDivider = !spotInserted && spot && row.strike >= spot && (i === 0 || shownRows[i - 1].strike < spot);
              if (showDivider) spotInserted = true;
              return (
                <React.Fragment key={row.strike}>
                  {showDivider && <SpotDivider spot={spot} color={accentColor} />}
                  <StrikeRow row={row} accentColor={accentColor} />
                </React.Fragment>
              );
            })}
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
  const { token, cfg: cfgBase, mlModels, marketStatus, lg, onTokenExpired, updateBadge } = useApp();
  const accessToken = resolveAccessToken(token);
  const optGates = mlModels?.thresholds?.option;
  const cfg = optGates?.deltaGate != null ? { ...cfgBase, delta: optGates.deltaGate, iv: optGates.ivGate } : cfgBase;

  const [filter, setFilter] = useState('NIFTY');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [meta, setMeta] = useState(null);       // spot/vix/marketCtx/expiryList — fetched once per index
  const [chain, setChain] = useState(null);      // the single loaded chain for the selected expiry
  const [expiry, setExpiry] = useState('');
  const [chainLoading, setChainLoading] = useState(false);
  const [updTime, setUpdTime] = useState('');
  const [visibleStrikes, setVisibleStrikes] = useState(PAGE_SIZE);

  const idx = INDEX_FILTERS.find((i) => i.id === filter) || INDEX_FILTERS[0];

  const load = useCallback(async () => {
    setLoading(true); setError(''); setChain(null); setMeta(null);
    setVisibleStrikes(PAGE_SIZE);
    try {
      const ctx = { token: accessToken, indexKey: idx.key, step: idx.step, lot: idx.lot, cfg, onTokenExpired, lg };
      const m = await loadOptionMeta(ctx, { setProgress });
      setMeta(m);
      const defaultExpiry = m.expiryList[0];
      setExpiry(defaultExpiry);
      setProgress(`Fetching chain (${defaultExpiry})...`);
      const c = await loadChainForExpiry(ctx, defaultExpiry, m);
      setChain(c);
      setUpdTime('Updated: ' + getIST());
      updateBadge('optAnalysis', String(c.rows.length));
    } catch (e) {
      setError(e.message); lg('Option analysis error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }, [accessToken, idx.key, idx.step, idx.lot, cfg, onTokenExpired, lg, updateBadge]); // eslint-disable-line

  useEffect(() => { if (accessToken) load(); }, [filter, accessToken]); // eslint-disable-line

  useEffect(() => {
    const onScan = () => load();
    document.addEventListener('scanner:scan', onScan);
    return () => document.removeEventListener('scanner:scan', onScan);
  }, [load]);

  const switchExpiry = useCallback(async (nextExpiry) => {
    if (!meta || nextExpiry === expiry) return;
    setExpiry(nextExpiry);
    setChainLoading(true); setError('');
    setVisibleStrikes(PAGE_SIZE);
    try {
      const ctx = { token: accessToken, indexKey: idx.key, step: idx.step, lot: idx.lot, cfg, onTokenExpired };
      const c = await loadChainForExpiry(ctx, nextExpiry, meta);
      setChain(c);
      setUpdTime('Updated: ' + getIST());
    } catch (e) {
      setError(e.message); lg('Option analysis error: ' + e.message, 'e');
    } finally { setChainLoading(false); }
  }, [meta, expiry, accessToken, idx.key, idx.step, idx.lot, cfg, onTokenExpired, lg]);

  // ── Only the strikes currently shown on screen ──
  const shownRows = useMemo(
    () => selectStrikesAroundATM(chain?.rows || [], chain?.atm, visibleStrikes),
    [chain, visibleStrikes]
  );

  // ── SINGLE WS connection for the whole page: index + VIX + only the ──
  // ── visible strikes' option instrument keys. Upstox allows one active ──
  // ── feed connection per token — two hooks here would race/starve each ──
  // ── other, which is why the grid previously looked "dead". pollFallback ──
  // ── is on, so even if WS itself is rejected, REST polling every 15s ──
  // ── still keeps the grid (and spot/VIX) updating.──
  const [liveGreeks, setLiveGreeks] = useState({});

  const feedKeys = useMemo(() => {
    const keys = [idx.key, VIX_KEY];
    shownRows.forEach((r) => { if (r.CE?.instrKey) keys.push(r.CE.instrKey); if (r.PE?.instrKey) keys.push(r.PE.instrKey); });
    return keys;
  }, [idx.key, shownRows]);

  // Real delta/theta/iv for visible strikes — WS doesn't carry these (see
  // fetchOptionGreeks comment), so poll the REST endpoint every 20s instead.
  useEffect(() => {
    const optKeys = feedKeys.slice(2);
    if (!accessToken || !optKeys.length) return;
    let cancelled = false;
    const poll = () => fetchOptionGreeks(optKeys, accessToken, onTokenExpired).then((g) => { if (!cancelled) setLiveGreeks(g); }).catch(() => {});
    poll();
    const t = setInterval(poll, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, [feedKeys, accessToken, onTokenExpired]);

  const { lastPrices: live, wsMode } = useMarketFeed(accessToken, feedKeys, feedKeys.length > 2, { pollFallback: true, mode: 'full' });

  const liveShownRows = useMemo(() => {
    const cs = meta?.marketCtx?.compositeScore ?? (meta?.niftyBullish ? 1 : -1);
    return mergeLiveIntoRows(shownRows, live, idx.lot, cs > 0.5, cs < -0.5, cfg?.oi ?? 15, liveGreeks);
  }, [shownRows, live, idx.lot, meta, cfg, liveGreeks]);

  const liveSpot = live[idx.key]?.ltp || meta?.spot || 0;
  const liveVix  = live[VIX_KEY]?.ltp || meta?.vixVal || 0;
  const { txt: vixTxt } = interpVIX(liveVix);
  const spotChgLive = live[idx.key]?.chgPct ?? meta?.spotChg ?? 0;
  const spotCp = liveSpot > 0 && spotChgLive != null ? liveSpot / (1 + spotChgLive / 100) : liveSpot;
  const spotPts = liveSpot - spotCp;

  return (
    <div>
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: '#f1f5f9', borderRadius: 10, padding: 3 }}>
        {INDEX_FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            flex: 1, padding: '9px 0', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 800, cursor: 'pointer',
            background: filter === f.id ? '#fff' : 'transparent',
            color: filter === f.id ? f.color : '#64748b',
            boxShadow: filter === f.id ? '0 1px 6px rgba(0,0,0,.1)' : 'none',
          }}>{f.id}</button>
        ))}
      </div>

      {error && <ErrorBanner title="⚠ Option Analysis Error" message={error} onRetry={load} />}

      {loading ? (
        <Spinner label={`Loading ${filter} option chain...`} progress={progress} sub="Confidence · OI Buildup · Live Margin" />
      ) : !meta ? (
        <EmptyState>Pull to scan or tap ▶ to load the {filter} chain</EmptyState>
      ) : (
        <div>
          {!marketStatus.open && (
            <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 10, color: '#92400e', fontWeight: 700 }}>
              📅 Market Closed — showing last available data
            </div>
          )}

          <div className="stats-g" style={{ marginBottom: 10 }}>
            <StatCard label={filter} value={`₹${fmt(liveSpot, 0)}`} sub={`${spotPts >= 0 ? '+' : ''}${spotPts.toFixed(2)} pts`} valClass={spotChgLive >= 0 ? 'up' : 'dn'} />
            <StatCard label="INDIA VIX" value={liveVix.toFixed(2)} sub={vixTxt} valClass={liveVix < 16 ? 'up' : liveVix > 22 ? 'dn' : 'am'} />
            <StatCard label="FEED" value={wsMode === 'ws' ? 'LIVE' : wsMode === 'poll' ? 'POLLING' : '...'} sub={`${feedKeys.length - 2} strikes`} valClass={wsMode === 'ws' ? 'up' : 'am'} />
          </div>

          {updTime && <LastUpdated time={updTime} />}

          <div style={{ display: 'flex', gap: 6, marginBottom: 10, overflowX: 'auto', paddingBottom: 2 }}>
            {meta.expiryList.map((e) => (
              <button key={e} onClick={() => switchExpiry(e)} disabled={chainLoading} style={{
                whiteSpace: 'nowrap', padding: '7px 12px', borderRadius: 20,
                border: expiry === e ? 'none' : '1px solid #e2e8f0',
                fontSize: 11, fontWeight: 700, cursor: chainLoading ? 'default' : 'pointer',
                background: expiry === e ? idx.color : '#fff',
                color: expiry === e ? '#fff' : '#374151',
                opacity: chainLoading && expiry !== e ? 0.5 : 1,
              }}>{e}</button>
            ))}
          </div>

          {chainLoading ? (
            <Spinner label={`Loading ${expiry}...`} />
          ) : (
            <ChainSection
              chain={chain}
              shownRows={liveShownRows}
              totalStrikes={chain?.rows.length || 0}
              spot={liveSpot}
              accentColor={idx.color}
              onLoadMore={() => setVisibleStrikes((v) => v + PAGE_SIZE)}
            />
          )}

          <div className="disc">⚠ Margin = lot size × LTP (live) — not SPAN+exposure. PCR per strike = strike's PE OI ÷ CE OI. Not SEBI advice · DYODD.</div>
        </div>
      )}
    </div>
  );
}

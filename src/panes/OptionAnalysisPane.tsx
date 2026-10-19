import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, LastUpdated, EmptyState } from '../components/common.jsx';
import { resolveAccessToken, fetchOptionGreeks } from '../services/api';
import { interpVIX } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { loadOptionMeta, loadChainForExpiry, mergeLiveIntoRows, selectStrikesAroundATM, summarizeChain } from '../services/optionAnalysisService';
import { effectiveOptionCfg } from '../services/optionScan';
import { SnapshotCard, ChainSection, expiryLabel } from '../components/OptionChainParts';
import ScanProgress from '../components/ScanProgress';

const INDEX_FILTERS = [
  { id: 'NIFTY',     key: 'NSE_INDEX|Nifty 50',  step: 50,  lot: 75, color: '#7c3aed' },
  { id: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank', step: 100, lot: 30, color: '#0ea5e9' },
  { id: 'SENSEX',    key: 'BSE_INDEX|SENSEX',     step: 100, lot: 20, color: '#16a34a' },
];

const VIX_KEY = 'NSE_INDEX|India VIX';
const PAGE_SIZE = 20;

export default function OptionAnalysisPane() {
  const { token, cfg: cfgBase, mlModels, marketStatus, lg, onTokenExpired, updateBadge } = useApp();
  const accessToken = resolveAccessToken(token);
  // Same learned delta/IV gates every other option page applies (optionScan.effectiveOptionCfg)
  const cfg = effectiveOptionCfg(cfgBase, mlModels);

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

  // ── Chain-level read (walls, max pain, PCR, straddle, IV skew, OI flow) ──
  // Built from the full strike list — not just the visible strikes — with live
  // rows swapped in where the WebSocket has them, so totals aren't window-limited.
  const rowsForSummary = useMemo(() => {
    if (!chain?.rows) return [];
    const live = new Map(liveShownRows.map((r) => [r.strike, r]));
    return chain.rows.map((r) => live.get(r.strike) || r);
  }, [chain, liveShownRows]);
  const summary = useMemo(() => summarizeChain(chain, liveSpot, rowsForSummary), [chain, liveSpot, rowsForSummary]);
  const walls = summary ? { callWall: summary.callWall, putWall: summary.putWall, maxPain: summary.maxPain } : null;
  const maxOi = summary ? Math.max(summary.callWallOI || 0, summary.putWallOI || 0) : 0;

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
        <ScanProgress title={`Loading ${filter} option chain`} message={progress} accent={idx.color}
          phases={[{ label: 'Spot & VIX', re: /spot|vix/i }, { label: 'Expiries', re: /expiries/i }, { label: 'Context', re: /intraday/i }, { label: 'Chain', re: /chain/i }]}
          weights={[0.15, 0.15, 0.30, 0.40]} hint="OI walls · Max Pain · PCR · Straddle · IV skew" />
      ) : !meta ? (
        <EmptyState>Pull to scan or tap ▶ to load the {filter} chain</EmptyState>
      ) : (
        <div>
          {!marketStatus.open && (
            <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginBottom: 10, fontSize: 10, color: '#92400e', fontWeight: 700 }}>
              📅 Market Closed — showing last available data
            </div>
          )}

          <SnapshotCard
            s={summary} filter={filter} accent={idx.color}
            spot={liveSpot} spotPts={spotPts} spotChg={spotChgLive}
            vix={liveVix} vixTxt={vixTxt} wsMode={wsMode} feedCount={feedKeys.length - 2}
          />

          {updTime && <LastUpdated time={updTime} />}

          <div style={{ display: 'flex', gap: 6, marginBottom: 10, overflowX: 'auto', paddingBottom: 2 }}>
            {meta.expiryList.map((e) => {
              const { date, dte } = expiryLabel(e);
              const on = expiry === e;
              return (
                <button key={e} onClick={() => switchExpiry(e)} disabled={chainLoading} style={{
                  whiteSpace: 'nowrap', padding: '6px 12px', borderRadius: 20, lineHeight: 1.25,
                  border: on ? 'none' : '1px solid #e2e8f0', cursor: chainLoading ? 'default' : 'pointer',
                  background: on ? idx.color : '#fff', color: on ? '#fff' : '#374151',
                  opacity: chainLoading && !on ? 0.5 : 1,
                }}>
                  <span style={{ fontSize: 11, fontWeight: 800 }}>{date}</span>
                  <span style={{ fontSize: 9, fontWeight: 700, opacity: 0.8, marginLeft: 5 }}>{dte === 0 ? 'today' : dte + 'd'}</span>
                </button>
              );
            })}
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
              walls={walls}
              maxOi={maxOi}
              onLoadMore={() => setVisibleStrikes((v) => v + PAGE_SIZE)}
            />
          )}

          <div className="disc">⚠ Margin = lot size × LTP (live) — not SPAN+exposure. PCR per strike = strike's PE OI ÷ CE OI. Walls, max pain and the straddle range describe where open interest and option prices sit — they are not trade signals. Not SEBI advice · DYODD.</div>
        </div>
      )}
    </div>
  );
}

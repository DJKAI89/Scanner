import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner } from './common.jsx';
import { resolveAccessToken } from '../services/api';
import { interpVIX } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { loadOptionMeta, loadChainForExpiry, selectStrikesAroundATM, summarizeChain } from '../services/optionAnalysisService';
import { effectiveOptionCfg, scoreChainForGrid } from '../services/optionScan';
import { SnapshotCard, ChainSection, expiryLabel } from './OptionChainParts';

const PAGE_SIZE = 20;
const ACCENT = '#d97706';

// Smallest gap between listed strikes — used to find the ATM row for this stock.
function strikeStep(chainRaw, spot) {
  const s = [...new Set((chainRaw || []).map((x) => x.strike_price).filter((n) => n > 0))].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < s.length; i++) step = Math.min(step, s[i] - s[i - 1]);
  return Number.isFinite(step) && step > 0 ? step : Math.max(0.05, Math.round(spot * 0.01));
}
const nearestStrike = (rows, spot) => rows.reduce((a, r) => (Math.abs(r.strike - spot) < Math.abs(a - spot) ? r.strike : a), rows[0]?.strike || 0);

/** Full option chain with per-strike confidence for the analysed stock (same engine as the Option Analysis page). */
const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export default function StockOptionsTab({ inst, ltp: ltpIn, chgPct: chgPctIn, chgPts: chgPtsIn, foChain, foCtx = null }) {
  const ltp = n0(ltpIn), chgPct = n0(chgPctIn), chgPts = n0(chgPtsIn);
  const { token, cfg: cfgBase, mlModels, lg, onTokenExpired, fiiData, fiiInterp, adaptWeights, confCalibration, vixHistorySeries } = useApp();
  const accessToken = resolveAccessToken(token);
  const cfg = effectiveOptionCfg(cfgBase, mlModels);

  const [loading, setLoading] = useState(true);
  const [chainLoading, setChainLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [meta, setMeta] = useState(null);
  const [chain, setChain] = useState(null);
  const [expiry, setExpiry] = useState('');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [upd, setUpd] = useState('');

  const spot0 = ltp || 0;
  const step = useMemo(() => strikeStep(foChain, spot0), [foChain, spot0]);
  const ctx = useMemo(
    () => ({ token: accessToken, indexKey: inst.key, step, lot: inst.lot || 1, cfg, onTokenExpired, lg }),
    [accessToken, inst.key, inst.lot, step, cfg, onTokenExpired, lg]
  );
  // Every strike gets the SAME final confidence the Options page / Options Suggestions use
  // (scanChain -> calibration -> regime -> learned weights -> ML ranking), computed with the same
  // market context (NIFTY bias, real VIX, the stock's daily/MTF context).
  const withAtm = (c, spot, m) => {
    const nearest = nearestStrike(c.rows, spot);
    let scored = new Map();
    try {
      scored = scoreChainForGrid({
        chain: c.chain, atm: nearest, spot, name: inst.s, expiry: c.expiry, lot: inst.lot || 1,
        maxPain: c.maxPain, pcr: c.pcr, stkCtx: foCtx?.stkCtx || m.marketCtx,
        env: { niftyBull: foCtx?.niftyBull ?? m.niftyBullish, vixVal: foCtx?.vixVal || m.vixVal },
        deps: { fiiData, fiiInterp, adaptWeights, mlModels, confCalibration, cfg: cfgBase, vixHistorySeries },
      });
    } catch (e) { lg('Option grid scoring failed: ' + e.message, 'w'); }
    const rows = c.rows.map((row) => {
      let next = row;
      for (const side of ['CE', 'PE']) {
        const p = scored.get(`${row.strike}|${side}`);
        if (p && row[side] && typeof p.confidence === 'number') {
          if (next === row) next = { ...row };
          next[side] = { ...row[side], confidence: p.confidence, baseConfidence: p.confBreakdown?.base ?? p.confidence,
            ...(p.oiBuildType ? { oiBuildType: p.oiBuildType, oiBuildBonus: p.oiBuildBonus ?? 0 } : {}) };
        }
      }
      return next;
    });
    return { ...c, rows, atm: nearest };
  };

  const load = useCallback(async () => {
    setLoading(true); setError(''); setChain(null); setMeta(null); setVisible(PAGE_SIZE);
    try {
      const m0 = await loadOptionMeta(ctx, { setProgress });
      // Score the grid with the same market context the Options Suggestions use
      // (NIFTY bias, real VIX, the stock's daily/MTF context) instead of the stock's own day-change.
      const m = foCtx ? {
        ...m0,
        marketCtx: foCtx.stkCtx || m0.marketCtx,
        niftyBullish: foCtx.niftyBull ?? m0.niftyBullish,
        vixVal: foCtx.vixVal || m0.vixVal,
      } : m0;
      setMeta(m);
      const e0 = m.expiryList[0];
      setExpiry(e0);
      setProgress(`Fetching chain (${e0})...`);
      setChain(withAtm(await loadChainForExpiry(ctx, e0, m), m.spot, m));
      setUpd('Updated: ' + getIST());
    } catch (e) {
      setError(e.message); lg('Stock options tab: ' + e.message, 'e');
    } finally { setLoading(false); }
  }, [ctx, lg]); // eslint-disable-line

  useEffect(() => { if (accessToken && inst?.key) load(); }, [inst?.key, accessToken]); // eslint-disable-line

  const switchExpiry = async (next) => {
    if (!meta || next === expiry) return;
    setExpiry(next); setChainLoading(true); setError(''); setVisible(PAGE_SIZE);
    try {
      setChain(withAtm(await loadChainForExpiry(ctx, next, meta), meta.spot, meta));
      setUpd('Updated: ' + getIST());
    } catch (e) { setError(e.message); } finally { setChainLoading(false); }
  };

  const spot = ltp || meta?.spot || 0;
  const shownRows = useMemo(() => selectStrikesAroundATM(chain?.rows || [], chain?.atm, visible), [chain, visible]);
  const summary = useMemo(() => summarizeChain(chain, spot, chain?.rows || []), [chain, spot]);
  const walls = summary ? { callWall: summary.callWall, putWall: summary.putWall, maxPain: summary.maxPain } : null;
  const maxOi = summary ? Math.max(summary.callWallOI || 0, summary.putWallOI || 0) : 0;
  const vix = meta?.vixVal || 0;

  if (loading) return <Spinner label={progress || 'Loading option chain...'} />;
  if (error && !chain) return <ErrorBanner title="Option chain error" message={error} onRetry={load} />;
  if (!meta || !chain) return null;

  return (
    <div>
      {error && <ErrorBanner title="Option chain error" message={error} onRetry={() => switchExpiry(expiry)} />}
      <SnapshotCard s={summary} filter={inst.s} accent={ACCENT} spot={spot} spotPts={chgPts} spotChg={chgPct}
        vix={vix} vixTxt={interpVIX(vix).txt} wsMode="static" feedCount={shownRows.length} />
      {upd && <div className="m" style={{ margin: '0 0 8px' }}>{upd}</div>}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, overflowX: 'auto', paddingBottom: 2 }}>
        {meta.expiryList.map((e) => {
          const { date, dte } = expiryLabel(e);
          const on = expiry === e;
          return (
            <button key={e} onClick={() => switchExpiry(e)} disabled={chainLoading} style={{
              whiteSpace: 'nowrap', padding: '6px 12px', borderRadius: 20, lineHeight: 1.25, cursor: chainLoading ? 'default' : 'pointer',
              border: on ? 'none' : '1px solid #e2e8f0', background: on ? ACCENT : '#fff', color: on ? '#fff' : '#374151',
              opacity: chainLoading && !on ? 0.5 : 1,
            }}>
              <span style={{ fontSize: 12, fontWeight: 800 }}>{date}</span>
              <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, marginLeft: 5 }}>{dte === 0 ? 'today' : dte + 'd'}</span>
            </button>
          );
        })}
      </div>
      {chainLoading ? <Spinner label={`Loading ${expiry}...`} /> : (
        <ChainSection chain={chain} shownRows={shownRows} totalStrikes={chain.rows.length} spot={spot}
          accentColor={ACCENT} walls={walls} maxOi={maxOi} onLoadMore={() => setVisible((v) => v + PAGE_SIZE)} />
      )}
      <div className="disc">⚠ Strike confidence uses the same model as the Option Analysis page. Prices and OI are a snapshot from the last load, not live. Margin = lot size × LTP.</div>
    </div>
  );
}

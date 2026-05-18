import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, MarketClosedBanner, LastUpdated, StatCard, EmptyState } from '../components/common.jsx';
import { fetchQ, fetchOptions, withRetry } from '../services/api';
import { fmt, fmtC, interpVIX, getChgPct } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { INDEX_OPTS } from '../constants/config';
import { calcMaxPain, calcOIWalls, calcSmartOptionSLTarget } from '../services/technical';

const OPT_FILTERS = [
  { id: 'all', label: 'All' }, { id: 'nifty', label: 'Nifty' },
  { id: 'banknifty', label: 'BankNifty' }, { id: 'sensex', label: 'Sensex' },
  { id: 'finnifty', label: 'FinNifty' }, { id: 'buy', label: '📈 BUY' }, { id: 'sell', label: '📉 SELL' },
];

function OptionCard({ pick }) {
  const isBuy = pick.type === 'CE';
  const bg    = isBuy ? '#f0fdf4' : '#fef2f2';
  const bdr   = isBuy ? '#16a34a' : '#dc2626';
  const recBg = isBuy ? '#16a34a' : '#dc2626';
  return (
    <div style={{ background: bg, border: `1.5px solid ${bdr}55`, borderRadius: 11, padding: 14, position: 'relative' }}>
      <div style={{ position: 'absolute', top: 11, right: 11, background: recBg, color: '#fff', fontSize: 8, fontWeight: 800, padding: '3px 8px', borderRadius: 20 }}>
        BUY {pick.type}
      </div>
      <div style={{ marginBottom: 9, paddingRight: 80 }}>
        <div style={{ fontSize: 15, fontWeight: 800 }}>{pick.und} {pick.strike} {pick.type}</div>
        <div style={{ fontSize: 10, color: '#64748b' }}>Exp: {pick.expiry} · Lot: {pick.lot} · {pick.slTgtMethod}</div>
      </div>
      {/* Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, marginBottom: 8 }}>
        {[
          { l: 'LTP',   v: `₹${fmt(pick.entry || 0)}` },
          { l: 'DELTA', v: (pick.delta || 0).toFixed(2) },
          { l: 'IV %',  v: `${(pick.iv || 0).toFixed(1)}%` },
          { l: 'CONF',  v: `${(pick.confidence || 0).toFixed(0)}%` },
        ].map((m) => (
          <div key={m.l} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6, padding: '5px 7px' }}>
            <div style={{ fontSize: 8, color: '#94a3b8', marginBottom: 2 }}>{m.l}</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{m.v}</div>
          </div>
        ))}
      </div>
      {/* Trade setup */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 4, background: '#e2e8f0', borderRadius: 8, padding: 1, marginBottom: 8 }}>
        {[
          { l: 'ENTRY',  v: `₹${fmt(pick.entry || 0)}`,  c: '#1d4ed8' },
          { l: 'SL',     v: `₹${fmt(pick.sl    || 0)}`,  c: '#dc2626', s: `-${(((pick.entry - pick.sl) / pick.entry) * 100).toFixed(1)}%` },
          { l: 'TARGET', v: `₹${fmt(pick.tgt   || 0)}`,  c: '#16a34a', s: `+${(((pick.tgt - pick.entry) / pick.entry) * 100).toFixed(1)}%` },
        ].map((b) => (
          <div key={b.l} style={{ background: '#f8fafc', padding: '7px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 7, color: '#64748b' }}>{b.l}</div>
            <div style={{ fontSize: 13, fontWeight: 800, color: b.c }}>{b.v}</div>
            {b.s && <div style={{ fontSize: 8, color: b.c }}>{b.s}</div>}
          </div>
        ))}
      </div>
      {/* Greeks + Capital */}
      <div style={{ display: 'flex', gap: 8, fontSize: 9, color: '#64748b', flexWrap: 'wrap' }}>
        {pick.amtRequired > 0   && <span>💰 ₹{fmt(pick.amtRequired, 0)}</span>}
        {pick.rr          > 0   && <span>⚖ R:R {pick.rr.toFixed(1)}</span>}
        {pick.dte         >= 0  && <span>📅 DTE {pick.dte}</span>}
        {pick.trendAligned      && <span style={{ color: '#16a34a', fontWeight: 700 }}>✅ Trend</span>}
        {pick.nearMaxPain       && <span style={{ color: '#7c3aed', fontWeight: 700 }}>🎯 Near Max Pain</span>}
      </div>
    </div>
  );
}

export default function OptionsPane() {
  const { token, cfg, marketStatus, lg, onTokenExpired, updateBadge, fiiInterp } = useApp();
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [groups, setGroups]     = useState([]);
  const [vix, setVix]           = useState(0);
  const [filter, setFilter]     = useState('all');
  const [progress, setProgress] = useState('');
  const [updTime, setUpdTime]   = useState('');

  useEffect(() => { if (token && marketStatus.open) loadOptions(); }, [token]); // eslint-disable-line

  async function loadOptions(force = false) {
    if (loading && !force) return;
    setLoading(true); setError(''); setProgress('Fetching index prices...');
    try {
      const idxKeys = INDEX_OPTS.map((i) => i.key).join(',') + ',NSE_INDEX|India VIX';
      const quotes  = await fetchQ(idxKeys, token, onTokenExpired);
      const vixVal  = quotes['NSE_INDEX|India VIX']?.last_price || 0;
      setVix(vixVal);

      const built = [];
      for (const idx of INDEX_OPTS) {
        const q = quotes[idx.key];
        if (!q?.last_price) continue;
        setProgress(`Scanning ${idx.name} options chain...`);
        const spot = q.last_price;

        // Fetch expiry
        let expiry = '';
        try {
          const cd = await fetch(
            `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent(idx.key)}`,
            { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }
          ).then((r) => r.json());
          expiry = (cd?.data?.map((e) => e.expiry).sort() || [])[0] || '';
        } catch (e) { lg('Contract: ' + e.message, 'w'); }
        if (!expiry) continue;

        // Fetch full chain
        const chain = await fetchOptions(idx.key, expiry, token, onTokenExpired);
        const maxPain = calcMaxPain(chain);
        const oiWalls = calcOIWalls(chain);

        const picks = [];
        for (const row of chain.slice(0, 40)) {
          const strike = row.strike_price;
          if (Math.abs(strike - spot) / spot > 0.035) continue; // near ATM only

          for (const [type, optData] of [['CE', row.call_options], ['PE', row.put_options]]) {
            const ltp    = optData?.market_data?.ltp;
            if (!ltp || ltp < 1) continue;
            const delta  = optData?.option_greeks?.delta  || 0;
            const iv     = optData?.option_greeks?.iv     || 0;
            const theta  = optData?.option_greeks?.theta  || 0;
            const absDelta = Math.abs(delta);
            if (absDelta < cfg.delta || iv < cfg.iv) continue;

            // Smart SL/Target using IV + DTE + Delta
            const { sl, tgt, rr, dte, method } = calcSmartOptionSLTarget(
              ltp, spot, strike, iv, delta, theta, expiry, vixVal
            );

            const isBull = type === 'CE';
            const confidence = Math.min(95,
              50 + (absDelta - 0.4) * 50 +
              (iv > cfg.iv * 1.5 ? 10 : 0) +
              (vixVal < 16 && isBull ? 5 : vixVal > 20 && !isBull ? 5 : 0)
            );
            if (confidence < cfg.minOptConf) continue;
            if (cfg.maxOptCapital > 0 && ltp * idx.lot > cfg.maxOptCapital) continue;

            picks.push({
              und: idx.name, strike, type, expiry, lot: idx.lot,
              entry: ltp, sl, tgt, rr, dte,
              delta: absDelta, iv, confidence,
              slTgtMethod: method,
              action: 'BUY',
              trendAligned: (isBull && getChgPct(q) > 0) || (!isBull && getChgPct(q) < 0),
              amtRequired: ltp * idx.lot,
              nearMaxPain: maxPain > 0 && Math.abs(strike - maxPain) / spot < 0.01,
            });
          }
        }

        built.push({
          name: idx.name, spot, spotChg: getChgPct(q), picks, expiry,
          maxPain, oiWalls,
        });
      }

      setGroups(built);
      updateBadge('options', String(built.reduce((s, g) => s + g.picks.length, 0)));
      setUpdTime('Updated: ' + getIST());
      lg(`Options: ${built.reduce((s, g) => s + g.picks.length, 0)} signals`, 'o');
    } catch (e) {
      setError(e.message); lg('Options error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }

  const { txt: vixTxt } = interpVIX(vix);
  const filtered = groups.map((g) => ({
    ...g,
    picks: g.picks.filter((p) => {
      if (filter === 'all')       return true;
      if (filter === 'nifty')     return g.name === 'NIFTY';
      if (filter === 'banknifty') return g.name === 'BANKNIFTY';
      if (filter === 'sensex')    return g.name === 'SENSEX';
      if (filter === 'finnifty')  return g.name === 'FINNIFTY';
      if (filter === 'buy')       return p.type === 'CE';
      if (filter === 'sell')      return p.type === 'PE';
      return true;
    }),
  })).filter((g) => g.picks.length > 0);

  return (
    <div>
      {!marketStatus.open && <MarketClosedBanner msg={marketStatus.msg || '🔔 NSE Market Closed'} />}
      {error && <ErrorBanner title="⚠ Options Error" message={error} onRetry={() => loadOptions(true)} />}

      {loading ? (
        <Spinner label="Scanning F&O options..." progress={progress}
          sub="Nifty · BankNifty · Sensex · FinNifty · Smart SL/Target · Max Pain · OI Walls" />
      ) : (
        <div>
          {updTime && <LastUpdated time={updTime} />}

          {/* FII/DII bias */}
          {fiiInterp && (
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 9, padding: '10px 14px', marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: '#94a3b8', marginBottom: 3 }}>FII/DII BIAS</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: fiiInterp.color }}>{fiiInterp.label}</div>
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{fiiInterp.detail}</div>
            </div>
          )}

          {/* Stats */}
          <div className="stats-g">
            {groups.map((g) => (
              <StatCard key={g.name} label={g.name} value={`₹${fmt(g.spot)}`} sub={fmtC(g.spotChg)} valClass={g.spotChg >= 0 ? 'up' : 'dn'} />
            ))}
            {vix > 0 && <StatCard label="INDIA VIX" value={vix.toFixed(2)} sub={vixTxt} valClass={vix < 16 ? 'up' : vix > 22 ? 'dn' : 'am'} />}
          </div>

          {/* Max Pain + OI Walls per group */}
          {groups.map((g) => g.maxPain > 0 && (
            <div key={g.name + '-meta'} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 12px', marginBottom: 8, display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 10 }}>
              <span style={{ fontWeight: 700 }}>{g.name}</span>
              <span>🎯 Max Pain: <b style={{ color: '#7c3aed' }}>₹{fmt(g.maxPain)}</b></span>
              {g.oiWalls?.callWall > 0 && <span>📉 Call Wall: <b style={{ color: '#dc2626' }}>₹{fmt(g.oiWalls.callWall)}</b></span>}
              {g.oiWalls?.putWall  > 0 && <span>📈 Put Wall:  <b style={{ color: '#16a34a' }}>₹{fmt(g.oiWalls.putWall)}</b></span>}
            </div>
          ))}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto', paddingBottom: 4 }}>
            {OPT_FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{
                whiteSpace: 'nowrap', padding: '6px 12px', borderRadius: 20,
                border: filter === f.id ? 'none' : '1px solid #e2e8f0',
                fontSize: 11, fontWeight: 700, cursor: 'pointer',
                background: filter === f.id ? '#16a34a' : '#fff',
                color:      filter === f.id ? '#fff' : '#374151',
              }}>{f.label}</button>
            ))}
          </div>

          {filtered.length === 0
            ? <EmptyState>{marketStatus.open ? '🔄 No signals · Click ▶ Scan' : '📅 NSE Market Closed · Options available Mon–Fri 9:15–15:30 IST'}</EmptyState>
            : filtered.map((g) => (
              <div key={g.name}>
                <div className="opt-group-hdr">{g.name} — ₹{fmt(g.spot)} ({fmtC(g.spotChg)}) · Exp: {g.expiry} · {g.picks.length} signals</div>
                <div className="cards-g" style={{ marginBottom: 16 }}>
                  {g.picks.map((p, i) => <OptionCard key={i} pick={p} />)}
                </div>
              </div>
            ))
          }
          <div className="disc">⚠ SL/Target calculated via IV + DTE + Delta model. Options carry significant risk. Always DYODD.</div>
        </div>
      )}
    </div>
  );
}

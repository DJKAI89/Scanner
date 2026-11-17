import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { resolveAccessToken, fetchQ } from '../services/api';
import { mtfDiagnostics, clearMtfCache } from '../services/mtf';
import { INDEX_OPTS } from '../constants/config';
import { GradePill } from './MtfPanel';

// Settings > "Multi-timeframe data check". Fetches each timeframe live for one instrument (bypassing the
// cache) and shows exactly what came back, so you can confirm multi-timeframe is working with YOUR token
// without waiting for a scan.
export default function MtfDiagnostics() {
  const { token, onTokenExpired, stocks } = useApp();
  const accessToken = resolveAccessToken(token);
  const [target, setTarget] = useState('NIFTY');
  const [symbol, setSymbol] = useState('RELIANCE');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');

  const run = async () => {
    setBusy(true); setErr(''); setRes(null);
    try {
      if (!accessToken) throw new Error('Not connected: add your Upstox token first.');
      let key, name;
      if (target === 'STOCK') {
        const s = (stocks || []).find((x) => x.s === symbol.trim().toUpperCase());
        if (!s?.key) throw new Error(`"${symbol}" is not in your stock list.`);
        key = s.key; name = s.s;
      } else {
        const ix = INDEX_OPTS.find((i) => i.name === target);
        key = ix.key; name = ix.name;
      }
      const q = await fetchQ(key, accessToken, onTokenExpired);
      const price = q[key]?.last_price || q[key]?.ohlc?.close;
      if (!price) throw new Error('Could not read a price for ' + name);
      clearMtfCache();
      const out = await mtfDiagnostics({ key, price, token: accessToken, onTokenExpired });
      setRes({ name, price, ...out });
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="setting-card">
      <h4>🧭 Multi-Timeframe Data Check</h4>
      <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5, margin: '4px 0 10px' }}>
        Fetches weekly, daily, 60-minute and 15-minute history live and shows what came back. Run it once after deploying, and again if the scan log shows "MTF ... no usable history".
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}>
          {INDEX_OPTS.map((i) => <option key={i.name} value={i.name}>{i.name}</option>)}
          <option value="STOCK">A stock...</option>
        </select>
        {target === 'STOCK' && (
          <input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="RELIANCE" style={{ padding: '7px 9px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, width: 110 }} />
        )}
        <button onClick={run} disabled={busy} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#0f172a', color: '#fff', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
          {busy ? 'Checking...' : 'Run check'}
        </button>
      </div>
      {err && <div style={{ marginTop: 10, fontSize: 11, color: '#b91c1c' }}>{err}</div>}
      {res && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: res.ok ? '#15803d' : '#b45309', marginBottom: 6 }}>
            {res.name} ₹{Math.round(res.price).toLocaleString('en-IN')}: {res.ok ? 'all timeframes loaded' : 'some timeframes failed'}
          </div>
          {res.steps.map((s) => (
            <div key={s.tf} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, padding: '6px 0', borderTop: '1px solid #f1f5f9' }}>
              <span style={{ fontWeight: 800 }}>{s.ok ? '✅' : '❌'} {s.label}</span>
              <span style={{ color: '#64748b', textAlign: 'right' }}>
                {s.ok ? `${s.bars} bars · ${s.from} → ${s.to} · ${s.source} · ${s.ms} ms` : `${s.error || 'failed'}${s.source && s.source !== '-' ? ' · ' + s.source : ''}`}
              </span>
            </div>
          ))}
          {res.summary && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <GradePill label="Long" g={res.summary.long} /><GradePill label="Short" g={res.summary.short} />
              <span style={{ fontSize: 10, color: '#64748b' }}>{res.summary.rows.filter((r) => r.ok).map((r) => `${r.label}: ${r.state}`).join(' · ')}</span>
            </div>
          )}
          {!res.ok && (
            <div style={{ marginTop: 10, fontSize: 10, color: '#b45309', lineHeight: 1.5 }}>
              Weekly and daily fall back to the older Upstox endpoint if the new one fails. 60-minute and 15-minute have no fallback: if they fail, grades use weekly and daily only and cards show the grade as partial. A "401" means the token expired.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

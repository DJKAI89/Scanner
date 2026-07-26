import React, { useState } from 'react';

// ── Confidence breakdown — shows the REAL components that fed the final
// score, not fabricated numbers. Works for both stock and option picks by
// reading whichever fields exist on the pick object.
export function buildConfidenceRows(p, kind) {
  const rows = [];

  if (kind === 'option') {
    // signals[] IS the base-score breakdown (Delta/IV/OI+/OI-/Theta/ATM)
    (p.signals || []).forEach((s) => rows.push({ label: s.l, val: `+${s.s}`, dir: 1 }));
    if (p.oiBuildBonus)
      rows.push({
        label: `OI Buildup (${p.oiBuildType})`,
        val: (p.oiBuildBonus >= 0 ? '+' : '') + p.oiBuildBonus,
        dir: Math.sign(p.oiBuildBonus),
      });
    if (p.zoneAdj)
      rows.push({ label: 'PDH/PDL Zone', val: (p.zoneAdj >= 0 ? '+' : '') + p.zoneAdj, dir: Math.sign(p.zoneAdj) });
    if (p.dirFlipPenalty) rows.push({ label: 'Direction Flip', val: p.dirFlipPenalty, dir: -1 });
    if (p.stockPCR != null)
      rows.push({ label: 'PCR', val: p.stockPCR.toFixed(2), dir: p.stockPCR > 1.2 ? 1 : p.stockPCR < 0.8 ? -1 : 0 });
    if (p.confluence != null)
      rows.push({
        label: 'Confluence',
        val: (p.confluence >= 0 ? '+' : '') + p.confluence,
        dir: Math.sign(p.confluence),
      });
    if (p.regime) rows.push({ label: 'Regime', val: p.regime.replace(/_/g, ' '), dir: 0 });
  } else {
    // stock
    if (p.rsi != null) rows.push({ label: 'RSI', val: Math.round(p.rsi), dir: p.rsi >= 40 && p.rsi <= 70 ? 1 : 0 });
    if (p.macdBull != null)
      rows.push({ label: 'MACD', val: p.macdBull ? 'Bull Cross' : 'No Cross', dir: p.macdBull ? 1 : 0 });
    if (p.a50 != null || p.a200 != null)
      rows.push({
        label: 'Trend (EMA)',
        val: [p.a50 && '>50', p.a200 && '>200'].filter(Boolean).join(' ') || 'Below EMAs',
        dir: p.a50 || p.a200 ? 1 : -1,
      });
    if (p.vol != null && p.avgVol20 != null)
      rows.push({
        label: 'Volume',
        val: p.avgVol20 > 0 ? (p.vol / p.avgVol20).toFixed(1) + 'x avg' : '—',
        dir: p.vol > p.avgVol20 ? 1 : 0,
      });
    if (p.aboveVWAP != null)
      rows.push({ label: 'VWAP', val: p.aboveVWAP ? 'Above' : 'Below', dir: p.aboveVWAP ? 1 : -1 });
    if (p.nearSupp != null) rows.push({ label: 'Support', val: p.nearSupp ? 'Near' : 'Far', dir: p.nearSupp ? 1 : 0 });
    if (p.numInds != null)
      rows.push({ label: 'Indicators Aligned', val: p.numInds + '/10', dir: p.numInds >= 4 ? 1 : 0 });
    if (p.confluence != null)
      rows.push({
        label: 'Confluence',
        val: (p.confluence >= 0 ? '+' : '') + p.confluence,
        dir: Math.sign(p.confluence),
      });
    if (p.regime) rows.push({ label: 'Regime', val: p.regime.replace(/_/g, ' '), dir: 0 });
    if (p.risk != null)
      rows.push({ label: 'Risk Score', val: Math.round(p.risk), dir: p.risk < 40 ? 1 : p.risk > 60 ? -1 : 0 });
  }

  if (p.mlProbability != null) {
    rows.push({
      label: 'AI Model',
      val: Math.round(p.mlProbability * 100) + '%' + (p.aiModel ? ` (${p.aiModel})` : ''),
      dir: p.mlAdj > 0 ? 1 : p.mlAdj < 0 ? -1 : 0,
    });
  }

  return rows;
}

function dirColor(dir) {
  if (dir > 0) return '#16a34a';
  if (dir < 0) return '#dc2626';
  return '#64748b';
}

export function ConfidenceBreakdown({ pick, kind = 'stock' }) {
  const [open, setOpen] = useState(false);
  const rows = buildConfidenceRows(pick, kind);
  const confVal = pick.conf ?? pick.confidence ?? 0;
  if (!rows.length) return null;

  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          fontSize: 9.5,
          fontWeight: 800,
          color: '#7c3aed',
          display: 'flex',
          alignItems: 'center',
          gap: 3,
        }}
      >
        {open ? '▾' : '▸'} Why {confVal}%?
      </button>
      {open && (
        <div
          style={{
            marginTop: 5,
            background: '#fafbfc',
            border: '1px solid #f1f5f9',
            borderRadius: 7,
            padding: '7px 9px',
          }}
        >
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2.5px 0', fontSize: 10 }}>
              <span style={{ color: '#64748b' }}>{r.label}</span>
              <span style={{ fontWeight: 700, color: dirColor(r.dir) }}>{r.val}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

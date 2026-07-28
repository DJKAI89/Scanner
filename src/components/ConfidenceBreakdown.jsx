import React, { useState } from 'react';

// ── Confidence breakdown — shows the REAL components that fed the final
// score, not fabricated numbers. Works for both stock and option picks by
// reading whichever fields exist on the pick object.
export function buildConfidenceRows(p, kind) {
  const rows = [];

  if (kind === 'option') {
    // signals[] IS the base-score breakdown (Delta/IV/OI+/OI-/Theta/ATM)
    (p.signals || []).forEach((s) => rows.push({ label: s.l, val: `+${s.s}`, dir: 1 }));
    if (p.oiBuildBonus) rows.push({ label: `OI Buildup (${p.oiBuildType})`, val: (p.oiBuildBonus >= 0 ? '+' : '') + p.oiBuildBonus, dir: Math.sign(p.oiBuildBonus) });
    if (p.zoneAdj) rows.push({ label: 'PDH/PDL Zone', val: (p.zoneAdj >= 0 ? '+' : '') + p.zoneAdj, dir: Math.sign(p.zoneAdj) });
    if (p.dirFlipPenalty) rows.push({ label: 'Direction Flip', val: p.dirFlipPenalty, dir: -1 });
    if (p.stockPCR != null) rows.push({ label: 'PCR', val: p.stockPCR.toFixed(2), dir: p.stockPCR > 1.2 ? 1 : p.stockPCR < 0.8 ? -1 : 0 });
    if (p.confluence?.total) rows.push({ label: 'Confluence', val: `${p.confluence.agree}/${p.confluence.total} agree`, dir: p.confluence.conflicting >= 2 ? -1 : p.confluence.agree >= 4 ? 1 : 0 });
    if (p.regime) rows.push({ label: 'Regime', val: p.regime.replace(/_/g, ' '), dir: 0 });
  } else {
    if (p.rsi != null) rows.push({ label: 'RSI', val: Math.round(p.rsi), dir: p.rsi >= 40 && p.rsi <= 70 ? 1 : 0 });
    if (p.macdBull != null) rows.push({ label: 'MACD', val: p.macdBull ? 'Bull Cross' : 'No Cross', dir: p.macdBull ? 1 : 0 });
    if (p.a50 != null || p.a200 != null) rows.push({ label: 'Trend (EMA)', val: [p.a50 && '>50', p.a200 && '>200'].filter(Boolean).join(' ') || 'Below EMAs', dir: (p.a50 || p.a200) ? 1 : -1 });
    if (p.vol != null && p.avgVol20 != null) rows.push({ label: 'Volume', val: p.avgVol20 > 0 ? (p.vol / p.avgVol20).toFixed(1) + 'x avg' : '—', dir: p.vol > p.avgVol20 ? 1 : 0 });
    if (p.aboveVWAP != null) rows.push({ label: 'VWAP', val: p.aboveVWAP ? 'Above' : 'Below', dir: p.aboveVWAP ? 1 : -1 });
    if (p.nearSupp != null) rows.push({ label: 'Support', val: p.nearSupp ? 'Near' : 'Far', dir: p.nearSupp ? 1 : 0 });
    if (p.numInds != null) rows.push({ label: 'Indicators Aligned', val: p.numInds + '/10', dir: p.numInds >= 4 ? 1 : 0 });
    if (p.risk != null) rows.push({ label: 'Risk Score', val: Math.round(p.risk), dir: p.risk < 40 ? 1 : p.risk > 60 ? -1 : 0 });
    if (p.confluence?.total) rows.push({ label: 'Confluence', val: `${p.confluence.agree}/${p.confluence.total} agree`, dir: p.confluence.conflicting >= 2 ? -1 : p.confluence.agree >= 4 ? 1 : 0 });
    if (p.regime) rows.push({ label: 'Regime', val: p.regime.replace(/_/g, ' '), dir: 0 });
  }

  if (p.mlProbability != null) {
    rows.push({ label: 'AI Model Probability', val: Math.round(p.mlProbability) + '%' + (p.aiModel ? ` (${p.aiModel})` : ''), dir: p.mlAdj > 0 ? 1 : p.mlAdj < 0 ? -1 : 0 });
  }

  return rows;
}

function dirColor(dir) {
  if (dir > 0) return '#16a34a';
  if (dir < 0) return '#dc2626';
  return '#64748b';
}

function WaterfallRow({ label, val, isBase, isFinal }) {
  const numVal = typeof val === 'number' ? val : null;
  const color = isBase || isFinal ? '#0f172a' : numVal > 0 ? '#16a34a' : numVal < 0 ? '#dc2626' : '#94a3b8';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 10 }}>
      <span style={{ color: '#64748b', fontWeight: (isBase || isFinal) ? 800 : 400 }}>{label}</span>
      <span style={{ fontWeight: 800, color }}>
        {(isBase || isFinal) ? `${val}%` : (numVal > 0 ? `+${numVal}` : numVal)}
      </span>
    </div>
  );
}

// Real layer-by-layer waterfall: Base → FII → Calibration → Regime →
// Confluence → Adaptive Weights → AI Model → Final. Each layer clamps
// independently to 1-99%, so a layer showing e.g. +5 may have contributed
// less than that if the score was already near a bound — noted below.
function ConfidenceWaterfall({ b }) {
  const layers = [
    { label: 'FII Bias', val: b.fiiAdj },
    { label: 'Calibration', val: b.calAdj },
    { label: 'Regime', val: b.regimeAdj },
    { label: 'Confluence', val: b.confluenceAdj },
    { label: 'Adaptive Weights', val: b.adaptAdj },
    { label: 'AI Model', val: b.mlAdj },
  ].filter((l) => l.val !== 0);

  return (
    <div style={{ marginTop: 5, background: '#fafbfc', border: '1px solid #f1f5f9', borderRadius: 7, padding: '7px 9px' }}>
      <WaterfallRow label="Base Score" val={b.base} isBase />
      {layers.map((l, i) => <WaterfallRow key={i} label={l.label} val={l.val} />)}
      <div style={{ borderTop: '1px solid #e2e8f0', marginTop: 3, paddingTop: 3 }}>
        <WaterfallRow label="Final" val={b.final} isFinal />
      </div>
      <div style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 4 }}>
        Each layer clamps independently to 1–99%, so a layer's true effect can be partly absorbed if the score is already near either bound.
      </div>
    </div>
  );
}

export function ConfidenceBreakdown({ pick, kind = 'stock' }) {
  const [open, setOpen] = useState(false);
  const rows = buildConfidenceRows(pick, kind);
  const confVal = pick.conf ?? pick.confidence ?? 0;
  const breakdown = pick.confBreakdown;
  if (!rows.length && !breakdown) return null;

  return (
    <div style={{ marginTop: 6 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 9.5, fontWeight: 800, color: '#7c3aed', display: 'flex', alignItems: 'center', gap: 3,
        }}
      >
        {open ? '▾' : '▸'} Why {confVal}%?
      </button>
      {open && (
        <>
          {breakdown && <ConfidenceWaterfall b={breakdown} />}
          {rows.length > 0 && (
            <div style={{ marginTop: 5, background: '#fafbfc', border: '1px solid #f1f5f9', borderRadius: 7, padding: '7px 9px' }}>
              {breakdown && <div style={{ fontSize: 8.5, fontWeight: 800, color: '#94a3b8', marginBottom: 3 }}>SIGNALS THAT FED THE BASE SCORE</div>}
              {rows.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2.5px 0', fontSize: 10 }}>
                  <span style={{ color: '#64748b' }}>{r.label}</span>
                  <span style={{ fontWeight: 700, color: dirColor(r.dir) }}>{r.val}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
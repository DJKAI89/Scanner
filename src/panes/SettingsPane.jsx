import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { DEF } from '../constants/config';
import { pushSettingsToGH, pullSettingsFromGH } from '../services/github';
import { getIST } from '../utils/marketTime';

function SetRow({ label, sub, children }) {
  return (
    <div className="set-row">
      <div>
        <div className="set-lbl">{label}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Inp({ value, onChange, min, max, step = 1, width = 80 }) {
  return (
    <input className="set-inp" type="number" value={value} min={min} max={max} step={step}
      style={{ width }} onChange={(e) => onChange(+e.target.value)} />
  );
}

function ConfBar({ value, color }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div style={{ flex: 1, height: 6, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ height: '100%', background: color, borderRadius: 3, width: pct + '%', transition: 'width .3s' }} />
    </div>
  );
}

// ── Adaptive Weights Section ──────────────────────────────────────────────────
const STOCK_IND_LABELS = {
  macdBull:       { label: 'MACD Above Signal',     icon: '📈' },
  macdBullCross:  { label: 'MACD Bull Cross',        icon: '⚡' },
  macdBearCross:  { label: 'MACD Bear Cross',        icon: '⚠' },
  bbSqueeze:      { label: 'BB Squeeze',             icon: '🗜' },
  bbNearLower:    { label: 'Near Lower BB',          icon: '⬇' },
  adxBull:        { label: 'ADX Bull Trend',         icon: '💪' },
  adxBear:        { label: 'ADX Bear Trend',         icon: '🐻' },
  rsiDiv:         { label: 'RSI Bull Divergence',    icon: '🔄' },
  rsiDivHidden:   { label: 'RSI Hidden Divergence',  icon: '👁' },
  rsiBearDiv:     { label: 'RSI Bear Divergence',    icon: '🔻' },
  a50:            { label: 'Above 50 MA',            icon: '📊' },
  a200:           { label: 'Above 200 MA',           icon: '📊' },
  nearSupp:       { label: 'Near Support',           icon: '🛡' },
  aboveVWAP:      { label: 'Above VWAP',             icon: '🔵' },
  vwapNearLower:  { label: 'Near Lower VWAP',        icon: '⬇' },
  engulfing:      { label: 'Bullish Engulfing',      icon: '🕯' },
  hammer:         { label: 'Hammer Candle',          icon: '🔨' },
  morningStar:    { label: 'Morning Star',           icon: '⭐' },
  reversalFired:  { label: 'Reversal Signal',        icon: '🔄' },
  delivHigh:      { label: 'High Delivery (≥60%)',   icon: '📦' },
  delivLow:       { label: 'Low Delivery (≤25%)',    icon: '📭' },
};

const OPT_IND_LABELS = {
  trendAligned:   { label: 'Trend Aligned',          icon: '🎯' },
  emaBull:        { label: 'EMA 9 > 21 (Bull)',       icon: '📈' },
  emaBearish:     { label: 'EMA 9 < 21 (Bear)',       icon: '📉' },
  freshCross:     { label: 'Fresh EMA Cross',         icon: '⚡' },
  momentumFresh:  { label: 'Fresh Momentum',          icon: '🔄' },
  volSpike:       { label: 'Volume Spike (≥1.5×)',    icon: '🔥' },
  lowVol:         { label: 'Low Volume (<0.7×)',       icon: '😴' },
  nearPDH:        { label: 'Near PDH Zone',           icon: '🚀' },
  nearPDL:        { label: 'Near PDL Zone',           icon: '⬇' },
  oiBuildUp:      { label: 'OI Build Up',             icon: '📊' },
  compositeHigh:  { label: 'Strong Composite (≥2)',   icon: '💥' },
  compositeMed:   { label: 'Moderate Composite (≥1)', icon: '📐' },
  atm:            { label: 'At The Money',            icon: '🎯' },
};

function WeightRow({ indKey, data, labelMap }) {
  const meta = labelMap[indKey];
  if (!meta) return null;
  const adj = data.adj ?? 0;
  const isPos = adj > 0, isNeg = adj < 0;
  const adjColor = isPos ? '#16a34a' : isNeg ? '#dc2626' : '#94a3b8';
  const wrColor = data.wrWith >= 55 ? '#16a34a' : data.wrWith >= 45 ? '#d97706' : '#dc2626';
  const barW = Math.min(100, data.wrWith);

  return (
    <div style={{ padding: '9px 12px', borderBottom: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13 }}>{meta.icon}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#1e293b' }}>{meta.label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 600 }}>n={data.n}</span>
          <span style={{
            fontSize: 11, fontWeight: 800, color: adjColor,
            background: isPos ? '#f0fdf4' : isNeg ? '#fef2f2' : '#f8fafc',
            border: `1px solid ${isPos ? '#bbf7d0' : isNeg ? '#fecaca' : '#e2e8f0'}`,
            borderRadius: 6, padding: '1px 7px', minWidth: 52, textAlign: 'center',
          }}>
            {adj > 0 ? '+' : ''}{adj.toFixed(1)} pts
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 5, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: barW + '%', background: wrColor, borderRadius: 3, transition: 'width .4s' }} />
        </div>
        <span style={{ fontSize: 9, fontWeight: 700, color: wrColor, minWidth: 36, textAlign: 'right' }}>
          {data.wrWith}% WR
        </span>
        <span style={{ fontSize: 9, color: '#94a3b8', minWidth: 38, textAlign: 'right' }}>
          base {data.wrBase}%
        </span>
        <span style={{
          fontSize: 9, fontWeight: 700, minWidth: 40, textAlign: 'right',
          color: data.lift > 0 ? '#16a34a' : data.lift < 0 ? '#dc2626' : '#94a3b8'
        }}>
          {data.lift > 0 ? '+' : ''}{data.lift}% lift
        </span>
      </div>
    </div>
  );
}

function AdaptWeightsSection({ adaptWeights }) {
  const [tab, setTab] = useState('stock');

  if (!adaptWeights) {
    return (
      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>⏳ Accumulating Signal Data</div>
        <div style={{ fontSize: 10, color: '#b45309', lineHeight: 1.7 }}>
          Adaptive weights need <strong>15+ closed signals</strong> with indicator snapshots before they can be computed.
          Once enough signals close (TARGET_HIT or SL_HIT), this section will automatically populate with learned adjustments.
        </div>
        <div style={{ marginTop: 10, fontSize: 10, color: '#92400e', fontWeight: 600 }}>
          GitHub must be configured and signals must be logged first.
        </div>
      </div>
    );
  }

  const { stock, option, baselineWR, stockBaseWR, optBaseWR, totalSignals, withIndData, computedAt } = adaptWeights;
  const stockEntries = Object.entries(stock || {}).sort((a, b) => Math.abs(b[1].adj) - Math.abs(a[1].adj));
  const optEntries   = Object.entries(option || {}).sort((a, b) => Math.abs(b[1].adj) - Math.abs(a[1].adj));
  const computedDate = computedAt ? new Date(computedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const pendingStockInds = Object.keys(STOCK_IND_LABELS).filter(k => !stock?.[k]);
  const pendingOptInds   = Object.keys(OPT_IND_LABELS).filter(k => !option?.[k]);

  return (
    <div>
      {/* Summary stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 14 }}>
        {[
          { label: 'Total Closed', value: totalSignals, color: '#1d4ed8' },
          { label: 'With Ind. Data', value: withIndData, color: '#7c3aed' },
          { label: 'Baseline WR', value: Math.round(baselineWR * 100) + '%', color: baselineWR >= 0.5 ? '#16a34a' : '#dc2626' },
        ].map(s => (
          <div key={s.label} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 8, color: '#94a3b8', fontWeight: 600, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 9, color: '#94a3b8', marginBottom: 12 }}>Last computed: {computedDate}</div>

      {/* Tab selector */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {[
          { key: 'stock', label: `📊 Stocks (${stockEntries.length})` },
          { key: 'option', label: `⚡ Options (${optEntries.length})` },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            flex: 1, padding: '7px 10px', fontSize: 11, fontWeight: 700, borderRadius: 8, cursor: 'pointer', border: 'none',
            background: tab === t.key ? '#1d4ed8' : '#f1f5f9',
            color: tab === t.key ? '#fff' : '#64748b',
          }}>{t.label}</button>
        ))}
      </div>

      {/* Stock weights */}
      {tab === 'stock' && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#374151' }}>Indicator</span>
            <span style={{ fontSize: 9, color: '#94a3b8' }}>Base WR: {Math.round(stockBaseWR * 100)}%</span>
          </div>
          {stockEntries.length === 0
            ? <div style={{ padding: 16, fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>No stock indicator data yet</div>
            : stockEntries.map(([k, d]) => <WeightRow key={k} indKey={k} data={d} labelMap={STOCK_IND_LABELS} />)
          }
          {pendingStockInds.length > 0 && (
            <div style={{ padding: '10px 12px', background: '#fffbeb', borderTop: '1px solid #fde68a' }}>
              <div style={{ fontSize: 9, color: '#b45309', fontWeight: 600, marginBottom: 5 }}>
                ⏳ Accumulating ({pendingStockInds.length} indicators need 8+ samples):
              </div>
              <div style={{ fontSize: 9, color: '#d97706', lineHeight: 1.8 }}>
                {pendingStockInds.map(k => STOCK_IND_LABELS[k]?.label).filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Option weights */}
      {tab === 'option' && (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#374151' }}>Indicator</span>
            <span style={{ fontSize: 9, color: '#94a3b8' }}>Base WR: {Math.round(optBaseWR * 100)}%</span>
          </div>
          {optEntries.length === 0
            ? <div style={{ padding: 16, fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>No option indicator data yet</div>
            : optEntries.map(([k, d]) => <WeightRow key={k} indKey={k} data={d} labelMap={OPT_IND_LABELS} />)
          }
          {pendingOptInds.length > 0 && (
            <div style={{ padding: '10px 12px', background: '#fffbeb', borderTop: '1px solid #fde68a' }}>
              <div style={{ fontSize: 9, color: '#b45309', fontWeight: 600, marginBottom: 5 }}>
                ⏳ Accumulating ({pendingOptInds.length} indicators need 8+ samples):
              </div>
              <div style={{ fontSize: 9, color: '#d97706', lineHeight: 1.8 }}>
                {pendingOptInds.map(k => OPT_IND_LABELS[k]?.label).filter(Boolean).join(' · ')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div style={{ marginTop: 12, padding: '10px 12px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 6 }}>HOW TO READ</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {[
            { color: '#16a34a', text: '+pts = indicator predicts wins → confidence boosted when it fires' },
            { color: '#dc2626', text: '−pts = indicator predicts losses → confidence reduced when it fires' },
            { color: '#94a3b8', text: 'WR = win rate when this indicator was present in a signal' },
            { color: '#64748b', text: 'Lift = WR improvement vs overall baseline' },
          ].map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: l.color, flexShrink: 0, marginTop: 2 }} />
              <span style={{ fontSize: 9, color: '#64748b', lineHeight: 1.5 }}>{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MlRankerSection({ mlModels, mlSnapshots }) {
  if (!mlModels) {
    return (
      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px 16px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>Loading ML Ranker</div>
        <div style={{ fontSize: 10, color: '#b45309', lineHeight: 1.7 }}>
          The AI ranking layer turns on automatically after enough closed signals are available in GitHub history.
        </div>
      </div>
    );
  }

  const cards = [
    { key: 'stock', label: 'Stocks', data: mlModels.stock },
    { key: 'option', label: 'Options', data: mlModels.option },
  ];

  return (
    <div>
      <div style={{ fontSize: 10, color: '#64748b', marginBottom: 12, lineHeight: 1.7 }}>
        Model: <strong>{mlModels.modelName}</strong>. It learns win probability from your own logged signals and nudges confidence up or down before ranking.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
        {cards.map(({ key, label, data }) => (
          <div key={key} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>{label}</div>
            {!data ? (
              <div style={{ fontSize: 10, color: '#94a3b8' }}>Need more closed signals</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8 }}>
                  <div><div style={{ fontSize: 8, color: '#94a3b8' }}>Samples</div><div style={{ fontSize: 14, fontWeight: 800, color: '#1d4ed8' }}>{data.trainedOn}</div></div>
                  <div><div style={{ fontSize: 8, color: '#94a3b8' }}>Win Rate</div><div style={{ fontSize: 14, fontWeight: 800, color: '#16a34a' }}>{Math.round(data.baseRate * 100)}%</div></div>
                  <div><div style={{ fontSize: 8, color: '#94a3b8' }}>Accuracy</div><div style={{ fontSize: 14, fontWeight: 800, color: '#7c3aed' }}>{Math.round(data.accuracy * 100)}%</div></div>
                  <div><div style={{ fontSize: 8, color: '#94a3b8' }}>Edge</div><div style={{ fontSize: 14, fontWeight: 800, color: data.edge > 0 ? '#16a34a' : '#64748b' }}>{data.edge > 0 ? '+' : ''}{(data.edge * 100).toFixed(1)}</div></div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, marginTop: 8 }}>
                  <div><div style={{ fontSize: 8, color: '#94a3b8' }}>Walk-Forward</div><div style={{ fontSize: 12, fontWeight: 800, color: '#0f766e' }}>{Math.round(((data.walkForward?.accuracy || 0) || 0) * 100)}%</div></div>
                  <div><div style={{ fontSize: 8, color: '#94a3b8' }}>Serving Model</div><div style={{ fontSize: 12, fontWeight: 800, color: '#334155' }}>{mlSnapshots?.[0]?.[key]?.servingLabel || 'global'}</div></div>
                </div>
                {data.topFeatures?.length > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 8, color: '#94a3b8', marginBottom: 6 }}>TOP DRIVERS</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {data.topFeatures.slice(0, 4).map((f) => (
                        <span key={f.feature} style={{ fontSize: 8, fontWeight: 700, color: '#334155', background: '#e2e8f0', borderRadius: 999, padding: '3px 7px' }}>
                          {f.feature} {f.importance}%
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      {!!mlSnapshots?.length && (
        <div style={{ marginTop: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 8 }}>MODEL HISTORY</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {mlSnapshots.slice(0, 5).map((snap) => (
              <div key={snap.computedAt} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 9, color: '#475569' }}>
                <span style={{ color: '#64748b', fontSize:12, fontWeight: 700 }}>{new Date(snap.computedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span style={{ color: '#64748b', fontSize:12, fontWeight: 700 }}>Stock: {snap.stock?.trainedOn || 0}/{snap.stock ? Math.round((snap.stock.accuracy || 0) * 100) : 0}%</span>
                <span style={{ color: '#64748b', fontSize:12, fontWeight: 700 }}>Option: {snap.option?.trainedOn || 0}/{snap.option ? Math.round((snap.option.accuracy || 0) * 100) : 0}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {(mlModels?.thresholds?.stock || mlModels?.thresholds?.option) && (
        <div style={{ marginTop: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 8 }}>AI THRESHOLDS</div>
          {['stock', 'option'].map((k) => mlModels?.thresholds?.[k] ? (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 9, color: '#475569', marginBottom: 5 }}>
              <span style={{ fontWeight: 700 }}>{k.toUpperCase()}</span>
              <span>Prob {Math.round((mlModels.thresholds[k].probability || 0) * 100)}%</span>
              <span>RR {mlModels.thresholds[k].minRR}</span>
              <span>Risk {mlModels.thresholds[k].maxRisk}</span>
            </div>
          ) : null)}
        </div>
      )}
      {(mlModels?.drift?.stock || mlModels?.drift?.option) && (
        <div style={{ marginTop: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', marginBottom: 8 }}>DRIFT / ROLLBACK</div>
          {['stock', 'option'].map((k) => mlModels?.drift?.[k] ? (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 9, color: '#475569', marginBottom: 5 }}>
              <span style={{ fontWeight: 700 }}>{k.toUpperCase()}</span>
              <span>WF {Math.round((mlModels.drift[k].walkForwardAccuracy || 0) * 100)}%</span>
              <span style={{ color: mlModels.drift[k].stable ? '#16a34a' : '#dc2626', fontWeight: 700 }}>{mlModels.drift[k].stable ? 'Stable' : 'Drift'}</span>
              <span>{mlModels.drift[k].rollbackTo || 'No rollback'}</span>
            </div>
          ) : null)}
        </div>
      )}
    </div>
  );
}

export default function SettingsPane() {
  const {
    cfg, saveCfg, resetCfg,
    gh, saveGh,
    clearToken, showToast,
    stocksStatus, loadStocks,
    fiiInterp, loadFIIDII,
    ghSettingsPulled,
    adaptWeights, mlModels, mlSnapshots,
  } = useApp();

  const [local, setLocal]           = useState({ ...cfg });
  const [ghLocal, setGhLocal]       = useState({ ...gh });
  const [saveStatus, setSaveStatus] = useState('');
  const [ghStatus, setGhStatus]     = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [tokenSavedDate]            = useState(() => localStorage.getItem('friday_token_date') || '');
  const [notifPerm, setNotifPerm]   = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [ghTesting, setGhTesting]   = useState(false);

  useEffect(() => {
    setLocal({ ...cfg });
    setGhLocal({ ...gh });
  }, [cfg, gh, ghSettingsPulled]);

  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));

  function sanitiseGH(raw) {
    let { token: tok, user, repo } = raw;
    repo = (repo || '').trim(); user = (user || '').trim().toLowerCase();
    const ghMatch = repo.match(/https?:\/\/github\.com\/([^/]+)\/([^/\s#?]+)/);
    if (ghMatch) { if (!user) user = ghMatch[1].toLowerCase(); repo = ghMatch[2].replace(/\.git$/, ''); }
    const pagesMatch = repo.match(/https?:\/\/([^.]+)\.github\.io(?:\/([^/\s#?]+))?/);
    if (pagesMatch) { if (!user) user = pagesMatch[1]; repo = pagesMatch[2] || pagesMatch[1] + '.github.io'; }
    repo = repo.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+|\/+$/g, '');
    return { token: tok, user, repo };
  }

  function handleSave() {
    const cleaned = sanitiseGH(ghLocal);
    saveCfg(local); saveGh(cleaned);
    setSaveStatus('✅ Saved · ' + getIST());
    showToast('✅ Settings saved!');
    setTimeout(() => setSaveStatus(''), 4000);
    if (cleaned.token && cleaned.user && cleaned.repo) {
      pushSettingsToGH(cleaned, local)
        .then(ok => ok && setSaveStatus(s => s + ' · ☁ GitHub synced'))
        .catch(() => {});
    }
  }

  function handleReset() {
    if (!window.confirm('Reset all settings to defaults?')) return;
    resetCfg(); setLocal({ ...DEF });
    setSaveStatus('↺ Reset to defaults'); setTimeout(() => setSaveStatus(''), 3000);
  }

  async function handleTestGH() {
    const cleaned = sanitiseGH(ghLocal);
    setGhLocal(cleaned); setGhTesting(true); setGhStatus('🔄 Testing ' + cleaned.user + '/' + cleaned.repo + '...');
    if (!cleaned.token) { setGhStatus('❌ GitHub token required'); setGhTesting(false); return; }
    if (!cleaned.user)  { setGhStatus('❌ GitHub username required'); setGhTesting(false); return; }
    if (!cleaned.repo)  { setGhStatus('❌ Repository name required'); setGhTesting(false); return; }
    try {
      const r = await fetch(`https://api.github.com/repos/${cleaned.user}/${cleaned.repo}`, {
        headers: { Authorization: 'Bearer ' + cleaned.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (r.ok) {
        saveGh(cleaned);
        setGhStatus(`✅ Connected! ${cleaned.user}/${cleaned.repo} — Pulling settings...`);
        const pulled = await pullSettingsFromGH(cleaned);
        if (pulled) { saveCfg({ ...cfg, ...pulled }); setLocal({ ...cfg, ...pulled }); setGhStatus(s => s + ' ✅ Settings loaded!'); }
        else setGhStatus(s => s + ' · No remote settings yet');
        loadStocks(cleaned, true);
        loadFIIDII(cleaned, true);
      } else if (r.status === 401) setGhStatus('❌ Token invalid — regenerate with repo scope (or Contents permission for fine-grained tokens)');
      else if (r.status === 403) setGhStatus('❌ Forbidden — fine-grained token missing repo access/Contents permission, or rate-limited');
      else if (r.status === 404)   setGhStatus(`❌ Repo '${cleaned.user}/${cleaned.repo}' not found (check spelling/case, or token can't see it)`);
      else setGhStatus('❌ GitHub error: HTTP ' + r.status);
    } catch (e) { setGhStatus('❌ Network error: ' + e.message); }
    setGhTesting(false);
  }

  const confLabel = v =>
    v >= 85 ? '🟣 Very high — very few signals' : v >= 70 ? '🟢 High quality picks' :
    v >= 55 ? '🔵 Balanced results' : v >= 40 ? '🟡 More signals' : '🔴 Many signals (noisy)';

  return (
    <div>
      <div className="settings-g">

        {/* ── Confidence ── */}
        <div className="setting-card" style={{ gridColumn: '1 / -1' }}>
          <h4>🎯 Confidence Filters</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[
              { label: '📈 Stocks Min Confidence', key: 'minStockConf', color: '#16a34a' },
              { label: '⚡ Options Min Confidence', key: 'minOptConf',  color: '#0ea5e9' },
            ].map(({ label, key, color }) => (
              <div key={key}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 8 }}>{label}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                  <Inp value={local[key]} onChange={v => set(key, v)} min={0} max={100} width={70} />
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>%</span>
                  <ConfBar value={local[key]} color={color} />
                </div>
                <div style={{ fontSize: 10, color, fontWeight: 600 }}>{confLabel(local[key])}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Position Sizing ── */}
        <div className="setting-card">
          <h4>💰 Position Sizing</h4>
          <SetRow label="Portfolio Size (₹)" sub="Total trading capital">
            <Inp value={local.portSize} onChange={v => set('portSize', v)} min={10000} step={10000} width={90} />
          </SetRow>
          <SetRow label="Max Risk per Trade (%)" sub="% of capital at risk per trade">
            <Inp value={local.riskPct} onChange={v => set('riskPct', v)} min={0.5} max={10} step={0.5} width={70} />
          </SetRow>
          <div style={{ fontSize: 9, color: '#64748b', padding: '6px 8px', background: '#f8fafc', borderRadius: 6, marginTop: 6 }}>
            📐 Max loss = ₹{((local.portSize || 500000) * (local.riskPct || 2) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })} per trade
          </div>
        </div>

        {/* ── Options Stock Universe ── */}
        <div className="setting-card">
          <h4>⚡ Options Stock Scan</h4>
          <SetRow label="Stocks to Scan for Options" sub="Top F&O stocks by volume, from your full stock list">
            <Inp value={local.optStockScanCount} onChange={v => set('optStockScanCount', v)} min={5} max={100} step={5} width={70} />
          </SetRow>
          <div style={{ fontSize: 9, color: '#64748b', padding: '6px 8px', background: '#f8fafc', borderRadius: 6, marginTop: 6 }}>
            📐 Picks the top {local.optStockScanCount || 20} F&O-eligible stocks by volume each scan. Higher = more coverage but slower scans (API rate limits).
          </div>
        </div>

        {/* ── Technical Thresholds ── */}
        <div className="setting-card">
          <h4>📈 Technical Thresholds</h4>
          <SetRow label="RSI Oversold"     sub="Below = BUY signal"><Inp value={local.rsiOS} onChange={v => set('rsiOS', v)} min={10} max={45} /></SetRow>
          <SetRow label="RSI Overbought"   sub="Above = SELL signal"><Inp value={local.rsiOB} onChange={v => set('rsiOB', v)} min={55} max={90} /></SetRow>
          <SetRow label="Volume Spike (×)" sub="Min multiplier for signal"><Inp value={local.vol} onChange={v => set('vol', v)} min={1} step={0.1} /></SetRow>
          <SetRow label="Min Potential %"  sub="Min expected gain %"><Inp value={local.pot} onChange={v => set('pot', v)} min={1} max={20} /></SetRow>
          <SetRow label="Max Risk Score %" sub="Reject signals above this risk"><Inp value={local.risk} onChange={v => set('risk', v)} min={20} max={100} /></SetRow>
          <SetRow label="Min R:R Ratio"    sub="Risk:Reward filter"><Inp value={local.rr} onChange={v => set('rr', v)} min={0.5} max={5} step={0.1} /></SetRow>
        </div>

        {/* ── Options Thresholds ── */}
        <div className="setting-card">
          <h4>⚡ Options Thresholds</h4>
          <SetRow label="Min Delta (abs)"   sub="Directional strength filter"><Inp value={local.delta} onChange={v => set('delta', v)} min={0.1} step={0.05} /></SetRow>
          <SetRow label="IV Alert %"        sub="High vol threshold"><Inp value={local.iv} onChange={v => set('iv', v)} min={5} /></SetRow>
          <SetRow label="OI Change % Alert" sub="Buildup threshold"><Inp value={local.oi} onChange={v => set('oi', v)} min={5} /></SetRow>
          <SetRow label="Options SL %"      sub="% below entry = stop loss"><Inp value={local.optSL} onChange={v => set('optSL', v)} min={5} max={60} /></SetRow>
          <SetRow label="Options Target %"  sub="% above entry = target"><Inp value={local.optTgt} onChange={v => set('optTgt', v)} min={10} max={200} /></SetRow>
          <SetRow label="Max Capital ₹"     sub="Hide options above this · 0 = no limit"><Inp value={local.maxOptCapital} onChange={v => set('maxOptCapital', v)} min={0} step={1000} width={90} /></SetRow>
        </div>

        {/* ── Adaptive Weights ── */}
        <div className="setting-card" style={{ gridColumn: '1 / -1' }}>
          <h4>🧠 Adaptive Indicator Weights</h4>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 14, lineHeight: 1.7 }}>
            Automatically learned from your past signal outcomes. Each indicator's confidence adjustment
            is calibrated to your actual win/loss history — no manual tuning needed.
            Updates every time the app boots (reads last 60 days of closed signals).
          </div>
          <AdaptWeightsSection adaptWeights={adaptWeights} />
        </div>

        <div className="setting-card" style={{ gridColumn: '1 / -1' }}>
          <h4>🤖 ML Ranker</h4>
          <MlRankerSection mlModels={mlModels} mlSnapshots={mlSnapshots} />
        </div>

        {/* ── Stock Universe ── */}
        <div className="setting-card">
          <h4>📋 Stock Universe</h4>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, lineHeight: 1.7 }}>
            Loaded from <code style={{ background: '#f1f5f9', padding: '1px 4px', borderRadius: 3 }}>stocks/stocks.json</code> in your GitHub repo.
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 10, minHeight: 20,
            color: (stocksStatus||'').startsWith('✅') ? '#16a34a' : (stocksStatus||'').startsWith('⚠') ? '#dc2626' : '#d97706' }}>
            {stocksStatus || '— Not loaded yet'}
          </div>
          <button className="btn" onClick={() => loadStocks(gh, true)}
            style={{ width: '100%', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #93c5fd', borderRadius: 7, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
            🔄 Reload stocks.json
          </button>
        </div>

        {/* ── FII/DII ── */}
        <div className="setting-card">
          <h4>🏦 FII / DII Data</h4>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, lineHeight: 1.7 }}>
            From <code style={{ background: '#f1f5f9', padding: '1px 4px', borderRadius: 3 }}>fii-dii/latest.json</code> in your GitHub repo. Update daily.
          </div>
          {fiiInterp ? (
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: fiiInterp.color, marginBottom: 4 }}>{fiiInterp.label}</div>
              <div style={{ fontSize: 10, color: '#64748b' }}>{fiiInterp.detail}</div>
            </div>
          ) : (
            <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 10 }}>No FII/DII data loaded</div>
          )}
          <button className="btn" onClick={() => loadFIIDII(gh, true)}
            style={{ width: '100%', fontSize: 11, background: '#f0fdf4', color: '#16a34a', border: '1px solid #86efac', borderRadius: 7, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
            🔄 Reload FII/DII Data
          </button>
        </div>

        {/* ── GitHub / Signal Log ── */}
        <div className="setting-card">
          <h4>📋 Signal Log (GitHub)</h4>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, lineHeight: 1.7 }}>
            Logs every signal as daily JSON files. Settings sync across browsers automatically.<br />
            <a href="https://github.com/settings/tokens/new?scopes=repo&description=FRIDAY+Signal+Log"
              target="_blank" rel="noreferrer" style={{ color: '#16a34a', fontWeight: 700 }}>
              Generate GitHub Token (repo scope) →
            </a>
          </div>
          <SetRow label="GitHub Token (PAT)" sub="repo scope · stored locally only">
            <input className="set-inp" type="text" placeholder="ghp_xxxx" value={ghLocal.token}
              onChange={e => setGhLocal(p => ({ ...p, token: e.target.value.trim() }))} style={{ width: 140 }} />
          </SetRow>
          <SetRow label="GitHub Username" sub="Your GitHub username">
            <input className="set-inp" type="text" placeholder="username" value={ghLocal.user}
              onChange={e => setGhLocal(p => ({ ...p, user: e.target.value.trim() }))} />
          </SetRow>
          <SetRow label="Repository Name" sub="Paste full URL or repo name">
            <input className="set-inp" type="text" placeholder="Scanner" value={ghLocal.repo}
              onChange={e => setGhLocal(p => ({ ...p, repo: e.target.value.trim() }))} />
          </SetRow>
          <button className="btn" onClick={handleTestGH} disabled={ghTesting}
            style={{ width: '100%', marginTop: 8, fontSize: 11, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #93c5fd', borderRadius: 7, padding: '8px 12px', fontWeight: 700, cursor: 'pointer' }}>
            {ghTesting ? '⏳ Testing...' : '🔗 Test Connection & Sync'}
          </button>
          {ghStatus && (
            <div style={{ marginTop: 8, fontSize: 10, color: ghStatus.startsWith('✅') ? '#16a34a' : '#dc2626', fontWeight: 600, lineHeight: 1.6 }}>
              {ghStatus}
            </div>
          )}
        </div>

        {/* ── Notifications ── */}
        <div className="setting-card">
          <h4>🔔 Browser Notifications</h4>
          <div style={{ fontSize: 10, color: '#64748b', marginBottom: 10, lineHeight: 1.7 }}>
            Alerts for high confidence signals (≥80%), BB Squeeze, RSI divergence, Target/SL hit.
          </div>
          {notifPerm === 'granted' ? (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 13px', fontSize: 11, color: '#15803d', fontWeight: 600 }}>✅ Notifications enabled</div>
          ) : notifPerm === 'denied' ? (
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 13px', fontSize: 11, color: '#991b1b', fontWeight: 600 }}>❌ Blocked — allow in browser site settings</div>
          ) : notifPerm === 'unsupported' ? (
            <div style={{ fontSize: 11, color: '#94a3b8' }}>Not supported in this browser</div>
          ) : (
            <button className="btn btn-g" onClick={async () => { const p = await Notification.requestPermission(); setNotifPerm(p); if (p === 'granted') showToast('🔔 Notifications enabled!'); }}
              style={{ width: '100%', fontSize: 11, borderRadius: 7, padding: '9px 14px', fontWeight: 700 }}>
              🔔 Enable Notifications
            </button>
          )}
        </div>

        {/* ── Token Management ── */}
        <div className="setting-card">
          <h4>🔐 Upstox Token</h4>
          {tokenSavedDate && <div style={{ fontSize: 10, color: '#16a34a', fontWeight: 600, marginBottom: 8 }}>✅ Token saved: {tokenSavedDate}</div>}
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 8 }}>Tokens expire daily. Paste a fresh token each morning.</div>
          <textarea className="token-area" rows={3} value={tokenInput} onChange={e => setTokenInput(e.target.value)}
            placeholder="Paste new Upstox access token here..." />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-g" style={{ flex: 1, fontSize: 11, borderRadius: 7 }}
              onClick={() => {
                const v = tokenInput.trim();
                if (!v || v.length < 20) { showToast('⚠ Token too short', '#dc2626'); return; }
                localStorage.setItem('friday_token', v);
                localStorage.setItem('friday_token_date', new Date().toDateString());
                setTokenInput('');
                showToast('✅ Token updated! Refresh the page to apply.');
              }}>
              💾 Save Token
            </button>
            <button className="btn" onClick={clearToken}
              style={{ background: '#fee2e2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 7, padding: '7px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
              🚪 Log Out
            </button>
          </div>
        </div>

        {/* ── Sticky Save Bar ── */}
        <div style={{ gridColumn: '1 / -1', position: 'sticky', bottom: 0, background: 'linear-gradient(to top,#f8fafc 80%,transparent)', padding: '14px 0 4px', zIndex: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-g" onClick={handleSave}
              style={{ flex: 1, padding: 13, fontSize: 13, fontWeight: 800, borderRadius: 10 }}>
              💾 Save All Settings
            </button>
            <button className="btn" onClick={handleReset}
              style={{ background: '#fee2e2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 10, padding: '13px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              ↺ Reset
            </button>
          </div>
          {saveStatus && <div style={{ textAlign: 'center', fontSize: 10, color: '#64748b', marginTop: 6 }}>{saveStatus}</div>}
        </div>

      </div>
    </div>
  );
}

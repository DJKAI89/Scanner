import React, { useState, useEffect } from 'react';
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

export default function SettingsPane() {
  const {
    cfg, saveCfg, resetCfg,
    gh, saveGh,
    clearToken, showToast,
    stocksStatus, loadStocks,
    fiiInterp, loadFIIDII,
    ghSettingsPulled,
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

  // Re-sync whenever GitHub settings are pulled on boot
  useEffect(() => {
    setLocal({ ...cfg });
    setGhLocal({ ...gh });
  }, [cfg, gh, ghSettingsPulled]);

  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));

  // Sanitise GitHub input (handles pasted URLs)
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
        headers: { Authorization: 'token ' + cleaned.token, Accept: 'application/vnd.github.v3+json' },
      });
      if (r.ok) {
        saveGh(cleaned);
        setGhStatus(`✅ Connected! ${cleaned.user}/${cleaned.repo} — Pulling settings...`);
        const pulled = await pullSettingsFromGH(cleaned);
        if (pulled) { saveCfg({ ...cfg, ...pulled }); setLocal({ ...cfg, ...pulled }); setGhStatus(s => s + ' ✅ Settings loaded!'); }
        else setGhStatus(s => s + ' · No remote settings yet');
        loadStocks(cleaned, true);
        loadFIIDII(cleaned, true);
      } else if (r.status === 401) setGhStatus('❌ Token invalid — regenerate with repo scope');
      else if (r.status === 404)   setGhStatus(`❌ Repo '${cleaned.user}/${cleaned.repo}' not found`);
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

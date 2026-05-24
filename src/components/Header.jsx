import React from 'react';
import { useApp } from '../context/AppContext';
import { TABS } from '../constants/config';

export default function Header({ onMenuToggle }) {
  const {
    booted, statusDot, statusTxt, activeTab, marketStatus,
    scanning, setLogOpen,
  } = useApp();

  const currentTab = TABS.find((t) => t.id === activeTab);
  const displayDot = marketStatus?.open ? statusDot : 'err';
  const displayTxt = marketStatus?.open
    ? statusTxt
    : (marketStatus?.msg?.includes('Pre-market') ? 'Pre-market' : 'Closed');

  return (
    <div className="hdr">
      {/* Pre-login logo */}
      {!booted && (
        <div className="logo">
          <div className="logo-ic"><span>F</span></div>
          <div>
            <div className="logo-txt">F.R.I.D.A.Y</div>
            <div className="logo-sub">PROFESSIONAL NSE SCANNER</div>
          </div>
        </div>
      )}

      {/* Post-login: hamburger + page label */}
      {booted && (
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <button className="menu-btn" aria-label="Menu" onClick={onMenuToggle}>
            <span /><span /><span />
          </button>
          <span className="active-page-lbl">{currentTab?.pageLabel || '📈 Stocks'}</span>
        </div>
      )}

      {/* Right controls */}
      {booted && (
        <div className="hdr-r">
          {/* Live dot */}
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <div className={`dot ${displayDot}`} />
            <span style={{ fontSize:10, color:'#64748b' }}>{displayTxt}</span>
          </div>

          {/* Scan button */}
          <button
            className="btn btn-g"
            disabled={scanning}
            style={{ fontWeight:700, fontSize:12, padding:'7px 14px' }}
            onClick={() => document.dispatchEvent(new CustomEvent('friday:scan'))}
          >
            {scanning ? '⏳' : '▶ Scan'}
          </button>

          {/* Log toggle */}
          <button className="btn btn-s" onClick={() => setLogOpen(v => !v)} title="Scan log">🔍</button>
        </div>
      )}
    </div>
  );
}

import React, { useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { TABS } from '../constants/config';

export default function Header({ onMenuToggle }) {
  const {
    booted, statusDot, statusTxt, activeTab,
    scanning, setLogOpen, scanSecs, setScanSecs, cfg,
  } = useApp();

  const currentTab = TABS.find((t) => t.id === activeTab);

  // Format countdown mm:ss
  const fmtSecs = (s) => {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const timerColor = scanSecs <= 30 ? '#dc2626' : scanSecs <= 90 ? '#d97706' : '#374151';

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
          {/* Countdown + status */}
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', minWidth:52 }}>
            <div style={{ fontSize:15, fontWeight:800, color:timerColor, lineHeight:1 }}>
              {fmtSecs(scanSecs)}
            </div>
            <div style={{ fontSize:7, color:'#94a3b8', fontWeight:600, letterSpacing:'.3px' }}>NEXT SCAN</div>
          </div>

          {/* Live dot */}
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <div className={`dot ${statusDot}`} />
            <span style={{ fontSize:10, color:'#64748b' }}>{statusTxt}</span>
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

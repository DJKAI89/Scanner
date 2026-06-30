import React from 'react';
import { useApp } from '../context/AppContext';
import { TABS } from '../constants/config';

export default function Header({ menuOpen, onMenuToggle }) {
  const {
    booted,
    statusDot,
    statusTxt,
    activeTab,
    marketStatus,
    scanning,
    setLogOpen,
  } = useApp();

  const currentTab = TABS.find((t) => t.id === activeTab);
  const showScanButton = activeTab === 'stocks' || activeTab === 'options' || activeTab === 'optAnalysis';
  const displayDot = marketStatus?.open ? statusDot : 'err';
  const displayTxt = marketStatus?.open
    ? statusTxt
    : (marketStatus?.msg?.includes('Pre-market') ? 'Pre-market' : 'Closed');

  return (
    <div className="hdr">
      {!booted && (
        <div className="logo">
          <div className="logo-ic"><span>F</span></div>
          <div>
            <div className="logo-txt">F.R.I.D.A.Y</div>
            <div className="logo-sub">PROFESSIONAL NSE SCANNER</div>
          </div>
        </div>
      )}

      {booted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className={'menu-btn' + (menuOpen ? ' open' : '')}
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={onMenuToggle}
          >
            <span /><span /><span />
          </button>
          <span className="active-page-lbl">{currentTab?.pageLabel || 'Stocks'}</span>
        </div>
      )}

      {booted && (
        <div className="hdr-r">
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div className={`dot ${displayDot}`} />
            <span style={{ fontSize: 10, color: '#64748b' }}>{displayTxt}</span>
          </div>

          {showScanButton && (
            <button
              className="btn btn-g"
              disabled={scanning}
              style={{ fontWeight: 700, fontSize: 12, padding: '7px 14px' }}
              onClick={() => document.dispatchEvent(new CustomEvent('friday:scan'))}
            >
              {scanning ? 'Scanning...' : 'Scan'}
            </button>
          )}

          <button className="btn btn-s" onClick={() => setLogOpen((v) => !v)} title="Scan log">
            Log
          </button>
        </div>
      )}
    </div>
  );
}

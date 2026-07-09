import React from 'react';
import { useApp } from '../context/AppContext';
import { TABS } from '../constants/config';

export default function NavDrawer({ open, onClose }) {
  const { activeTab, setActiveTab, userName, userId, marketStatus, badges } = useApp();

  function handleTab(id) {
    setActiveTab(id);
    onClose();
  }

  return (
    <>
      {/* Overlay */}
      <div
        className={'nav-overlay' + (open ? ' visible' : '')}
        onClick={onClose}
      />

      {/* Drawer */}
      <div className={'nav-drawer' + (open ? ' open' : '')}>
        {/* Header */}
        <div className="nav-hdr">
          <div className="nav-logo-ic"><span>F</span></div>
          <div>
            <div className="nav-logo-txt">{userName || 'Scanner'}</div>
            <div className="nav-logo-sub">
              {userId ? `ID: ${userId} · NSE` : 'PROFESSIONAL NSE SCANNER'}
            </div>
          </div>
        </div>

        {/* Market status */}
        <div
          className="nav-mkt"
          style={{ color: marketStatus.open ? '#16a34a' : '#dc2626' }}
        >
          {marketStatus.open ? '● NSE Market Open' : (marketStatus.msg || '● NSE Market Closed')}
        </div>

        {/* Nav items */}
        <nav className="nav-items">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={'nav-item' + (activeTab === tab.id ? ' active' : '')}
              onClick={() => handleTab(tab.id)}
            >
              <span className="nav-icon">{tab.icon}</span>
              <span className="nav-label">{tab.label}</span>
              {badges[tab.id] !== undefined && (
                <span className="nav-badge">{badges[tab.id]}</span>
              )}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="nav-footer">
          <div>Not SEBI-registered advice · DYODD</div>
        </div>
      </div>
    </>
  );
}

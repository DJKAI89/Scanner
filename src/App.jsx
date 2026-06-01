import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import Header     from './components/Header';
import NavDrawer  from './components/NavDrawer';
import Ticker     from './components/Ticker';
import TokenGate  from './components/TokenGate';
import { LogDrawer, Toast } from './components/common.jsx';

// ── Lazy pane imports ──
import StocksPane   from './panes/StocksPane';
import OptionsPane  from './panes/OptionsPane';
import PortfolioPane from './panes/PortfolioPane';
import LookupPane   from './panes/LookupPane';
import LogPane      from './panes/LogPane';
import AnalysisPane from './panes/AnalysisPane';
import SettingsPane from './panes/SettingsPane';

// ── Pane registry ──
const PANES = {
  stocks:    StocksPane,
  options:   OptionsPane,
  portfolio: PortfolioPane,
  lookup:    LookupPane,
  log:       LogPane,
  analysis:  AnalysisPane,
  settings:  SettingsPane,
};

function AppShell() {
  const {
    booted, activeTab, logOpen, setLogOpen, logLines, setLogLines, toast,
  } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);

  const ActivePane = PANES[activeTab] || StocksPane;

  return (
    <div>
      {/* ── Always-visible Header ── */}
      <Header
        menuOpen={menuOpen}
        onMenuToggle={() => setMenuOpen((v) => !v)}
      />

      {/* ── Ticker tape ── */}
      <Ticker />

      {/* ── Pre-login ── */}
      {!booted && <TokenGate />}

      {/* ── Post-login App ── */}
      {booted && (
        <>
          {/* Slide nav drawer */}
          <NavDrawer
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
          />

          {/* Log drawer (below header, above panes) */}
          <div style={{ padding: '0 12px' }}>
            <LogDrawer
              open={logOpen}
              lines={logLines}
              onClear={() => setLogLines([])}
            />
          </div>

          {/* Active pane */}
          <div className="pane active">
            <ActivePane />
          </div>
        </>
      )}

      {/* ── Global toast ── */}
      {toast && <Toast msg={toast.msg} color={toast.color} />}
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}

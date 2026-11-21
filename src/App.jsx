import React, { useState, Suspense, lazy } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import Header from './components/Header';
import NavDrawer from './components/NavDrawer';
import Ticker from './components/Ticker';
import TokenGate from './components/TokenGate';
import ErrorBoundary from './components/ErrorBoundary';
import { LogDrawer, Toast } from './components/common.jsx';

// ── Lazy pane imports — only the active tab's code is fetched/parsed,
// instead of every pane loading upfront on first paint. ──
const StocksPane = lazy(() => import('./panes/StocksPane'));
const OptionsPane = lazy(() => import('./panes/OptionsPane'));
const OptionAnalysisPane = lazy(() => import('./panes/OptionAnalysisPane'));
const PortfolioPane = lazy(() => import('./panes/PortfolioPane'));
const LookupPane = lazy(() => import('./panes/LookupPane'));
const LogPane = lazy(() => import('./panes/LogPane'));
const AnalysisPane = lazy(() => import('./panes/AnalysisPane'));
const HeatmapPane = lazy(() => import('./panes/HeatmapPane'));
const SettingsPane = lazy(() => import('./panes/SettingsPane'));

// ── Pane registry ──
const PANES = {
  stocks: StocksPane,
  options: OptionsPane,
  optAnalysis: OptionAnalysisPane,
  portfolio: PortfolioPane,
  lookup: LookupPane,
  log: LogPane,
  analysis: AnalysisPane,
  heatmap: HeatmapPane,
  settings: SettingsPane,
};

function PaneFallback() {
  return (
    <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 12, fontWeight: 700 }}>
      Loading…
    </div>
  );
}

function AppShell() {
  const { booted, activeTab, logOpen, setLogOpen, logLines, setLogLines, toast } = useApp();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paneKey, setPaneKey] = useState(0); // bump to force-remount pane after an error-boundary retry

  const ActivePane = PANES[activeTab] || StocksPane;

  return (
    <div>
      {/* ── Always-visible Header ── */}
      <Header menuOpen={menuOpen} onMenuToggle={() => setMenuOpen((v) => !v)} />

      {/* ── Ticker tape ── */}
      <Ticker />

      {/* ── Pre-login ── */}
      {!booted && <TokenGate />}

      {/* ── Post-login App ── */}
      {booted && (
        <>
          {/* Slide nav drawer */}
          <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />

          {/* Log drawer (below header, above panes) */}
          <div style={{ padding: '0 12px' }}>
            <LogDrawer open={logOpen} lines={logLines} onClear={() => setLogLines([])} />
          </div>

          {/* Active pane — isolated so a crash here doesn't take down the whole app */}
          <div className="pane active">
            <ErrorBoundary key={activeTab + paneKey} onRetry={() => setPaneKey((k) => k + 1)}>
              <Suspense fallback={<PaneFallback />}>
                <ActivePane />
              </Suspense>
            </ErrorBoundary>
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

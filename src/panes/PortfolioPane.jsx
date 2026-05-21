import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { Spinner, ErrorBanner, StatCard, EmptyState, LastUpdated } from '../components/common.jsx';
import { fetchPortfolio, resolveAccessToken } from '../services/api';
import { fmt, fmtC } from '../utils/formatters';
import { getIST } from '../utils/marketTime';
import { useMarketFeed } from '../hooks/useMarketFeed';

export default function PortfolioPane() {
  const { token, onTokenExpired, lg, updateBadge, marketStatus } = useApp();
  const accessToken = resolveAccessToken(token);

  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [positions, setPositions] = useState([]);
  const [holdings, setHoldings]   = useState([]);
  const [updTime, setUpdTime]     = useState('');
  const [tab, setTab]             = useState('holdings');

  function getInstrumentKey(item) {
    return item.instrument_key || item.instrumentKey || item.instrument_token || item.instrumentToken || item.token || '';
  }

  function num(...values) {
    for (const v of values) {
      const n = Number(v);
      if (Number.isFinite(n) && n !== 0) return n;
    }
    return 0;
  }

  // ── Collect all instrument keys for WebSocket ──
  const allKeys = useMemo(() => {
    const keys = [
      ...positions.map(getInstrumentKey),
      ...holdings.map(getInstrumentKey),
    ].filter(Boolean);
    return [...new Set(keys)];
  }, [positions, holdings]);

  // ── WebSocket live feed ──
  const { connected: wsConnected, lastPrices } = useMarketFeed(
    accessToken, allKeys, allKeys.length > 0, { pollFallback: false }
  );

  useEffect(() => { if (accessToken) load(); }, [accessToken]); // eslint-disable-line
  useEffect(() => {
    if (Object.keys(lastPrices).length > 0) setUpdTime('Live: ' + getIST());
  }, [lastPrices]);

  async function load() {
    setLoading(true); setError('');
    try {
      const { positions: pos, holdings: hld } = await fetchPortfolio(accessToken, onTokenExpired);
      setPositions(pos);
      setHoldings(hld);
      updateBadge('portfolio', String(pos.length + hld.length));
      setUpdTime('Updated: ' + getIST());
      lg(`Portfolio: ${pos.length} positions, ${hld.length} holdings`, 'o');
    } catch (e) {
      setError(e.message);
      lg('Portfolio error: ' + e.message, 'e');
    } finally { setLoading(false); }
  }

  // ── Enrich with live WebSocket prices ──
  function enrich(arr) {
    return arr.map((item) => {
      const key = getInstrumentKey(item);
      const live = lastPrices[key];
      const ltp  = num(live?.ltp, item.last_price, item.ltp, item.close_price);
      const qty  = num(item.quantity, item.used_quantity, item.available_quantity, item.t1_quantity, item.qty);
      const avg  = num(item.average_price, item.average_cost, item.avg_price, item.buy_price);
      const prevClose = num(live?.cp, item.close_price, item.previous_close, item.prev_close, item.ohlc?.close);
      const pnl  = avg > 0 ? (ltp - avg) * qty : num(item.pnl, item.profit_and_loss);
      const pnlPct = avg > 0 ? ((ltp - avg) / avg) * 100 : 0;
      const todayPnl = prevClose > 0 ? (ltp - prevClose) * qty : num(item.day_pnl, item.dayPnl);
      const todayPnlPct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
      const value = ltp * qty;
      return { ...item, key, ltp, qty, avg, prevClose, pnl, pnlPct, todayPnl, todayPnlPct, value, isLive: !!live };
    });
  }

  const enrichedPos = useMemo(() => enrich(positions), [positions, lastPrices]); // eslint-disable-line
  const enrichedHld = useMemo(() =>
    enrich(holdings).sort((a, b) =>
      (a.tradingsymbol || a.symbol || '').localeCompare(b.tradingsymbol || b.symbol || '')
    ), [holdings, lastPrices]); // eslint-disable-line

  const portfolioRows = [...enrichedPos, ...enrichedHld];
  const totalPnl  = portfolioRows.reduce((s, i) => s + (i.pnl || 0), 0);
  const invested  = portfolioRows.reduce((s, i) => s + (i.avg * i.qty), 0);
  const todayPnl  = portfolioRows.reduce((s, i) => s + (i.todayPnl || 0), 0);
  const totalValue = portfolioRows.reduce((s, i) => s + (i.value || 0), 0);

  const current = tab === 'positions' ? enrichedPos : enrichedHld;

  function Row({ item }) {
    const pos = item.pnl >= 0;
    return (
      <div className="ptbl-r">
        <div>
          <div style={{ fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
            {item.tradingsymbol || item.symbol}
            {item.isLive && marketStatus.open && (
              <span style={{ fontSize: 7, background: '#dcfce7', color: '#16a34a', borderRadius: 4, padding: '1px 4px', fontWeight: 800 }}>⚡ LIVE</span>
            )}
          </div>
          <div style={{ fontSize: 9, color: '#94a3b8' }}>{item.exchange || 'NSE'}</div>
        </div>
        <div style={{ fontWeight: 600 }}>{item.qty}</div>
        <div>₹{fmt(item.avg)}</div>
        <div style={{ fontWeight: 700, color: pos ? '#16a34a' : '#dc2626' }}>₹{fmt(item.ltp)}</div>
        <div style={{ fontWeight: 700, color: pos ? '#16a34a' : '#dc2626' }}>
          {pos ? '+' : ''}₹{fmt(Math.abs(item.pnl))}
        </div>
        <div style={{ fontWeight: 600, color: pos ? '#16a34a' : '#dc2626' }}>{fmtC(item.pnlPct)}</div>
        <div>₹{fmt(item.value)}</div>
      </div>
    );
  }

  return (
    <div>
      {error && <ErrorBanner title="⚠ Portfolio Error" message={error} onRetry={load} />}
      {loading ? (
        <Spinner label="Loading portfolio..." sub="Positions · Holdings" />
      ) : (
        <div>
          {/* WS status */}
          {allKeys.length > 0 && (
            <div style={{ fontSize: 9, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: wsConnected ? '#16a34a' : '#94a3b8', flexShrink: 0 }} />
              <span style={{ color: '#94a3b8' }}>
                {wsConnected ? `⚡ Live P&L — ${allKeys.length} instruments streaming` : 'WebSocket connecting...'}
              </span>
            </div>
          )}

          {updTime && <LastUpdated time={updTime} />}

          {/* Summary */}
          <div className="stats-g">
            <StatCard label="INVESTED"    value={`₹${fmt(invested)}`}    valClass="bl" />
            <StatCard label="VALUE"       value={`₹${fmt(totalValue)}`}  valClass="pu" />
            <StatCard label="TODAY P&L"   value={(todayPnl >= 0 ? '+₹' : '-₹') + fmt(Math.abs(todayPnl))} valClass={todayPnl >= 0 ? 'up' : 'dn'} />
            <StatCard label="TOTAL P&L"   value={(totalPnl >= 0 ? '+₹' : '-₹') + fmt(Math.abs(totalPnl))} valClass={totalPnl >= 0 ? 'up' : 'dn'} />
            <StatCard label="POSITIONS"   value={positions.length} valClass="am" />
            <StatCard label="HOLDINGS"    value={holdings.length}  valClass="pu" />
          </div>

          {/* Tab toggle */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 12, background: '#f1f5f9', borderRadius: 10, padding: 3 }}>
            {[
              { id: 'holdings',  label: `💼 Holdings (${holdings.length})`   },
              { id: 'positions', label: `📊 Positions (${positions.length})` },
            ].map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
                fontSize: 12, fontWeight: 700, cursor: 'pointer',
                background: tab === t.id ? '#fff' : 'transparent',
                color:      tab === t.id ? '#1d4ed8' : '#64748b',
                boxShadow:  tab === t.id ? '0 1px 4px rgba(0,0,0,.1)' : 'none',
              }}>{t.label}</button>
            ))}
          </div>

          {current.length === 0 ? (
            <EmptyState>No {tab} found in your Upstox account</EmptyState>
          ) : (
            <div className="ptbl">
              <div className="ptbl-h">
                <span>SYMBOL</span><span>QTY</span><span>AVG</span>
                <span>LTP ⚡</span><span>P&L</span><span>P&L %</span><span>VALUE</span>
              </div>
              {current.map((item, i) => <Row key={i} item={item} />)}
            </div>
          )}

          <div className="disc">
            ⚡ P&L updates in real-time via Upstox WebSocket during market hours. Actual P&L may differ due to charges and settlement.
          </div>
        </div>
      )}
    </div>
  );
}

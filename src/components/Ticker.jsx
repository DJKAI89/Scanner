import React from 'react';
import { useApp } from '../context/AppContext';
import { useMarketFeed } from '../hooks/useMarketFeed';
import { fmt } from '../utils/formatters';

// Same keys StocksPane.tsx already uses successfully over WebSocket
// (INDEX_WS_KEYS there) — proves NSE_INDEX/BSE_INDEX tick fine over WS in
// this app, so the ticker uses that same live mechanism instead of a
// separate 5s REST poll.
const TICKER_KEYS = [
  { key: 'NSE_INDEX|Nifty 50',   label: 'NIFTY 50' },
  { key: 'NSE_INDEX|Nifty Bank', label: 'BANK NIFTY' },
  { key: 'BSE_INDEX|SENSEX',     label: 'SENSEX' },
];

export default function Ticker() {
  const { token, booted } = useApp();
  // Unlike the old REST-poll version, this doesn't need to pause during
  // scans — a healthy WS connection doesn't touch the shared REST throttle
  // (api.js THROTTLE_MS) that scans compete for. pollFallback defaults to
  // true in useMarketFeed, so it still degrades gracefully to REST polling
  // if the WS connection ever drops, same safety net Stocks/Options rely on.
  const { lastPrices } = useMarketFeed(token, TICKER_KEYS.map(i => i.key), booted);

  if (!booted) return null;

  return (
    <div className="idx-strip">
      {TICKER_KEYS.map((idx, i) => {
        const live = lastPrices[idx.key];
        const ltp  = live?.ltp || 0;
        const cp   = live?.cp  || 0;
        const pts  = cp > 0 ? ltp - cp : 0;
        const pct  = cp > 0 ? (pts / cp) * 100 : 0;
        const up   = pts >= 0;
        return (
          <div className="idx-card" key={idx.key} style={i > 0 ? { borderLeft: '1px solid #e2e8f0' } : undefined}>
            <div className="idx-card-lbl">{idx.label}</div>
            {ltp > 0 ? (
              <div className="idx-card-val">
                <span className="idx-card-ltp">{fmt(ltp)}</span>
                <span className={up ? 'idx-card-up' : 'idx-card-dn'}>
                  {up ? '+' : ''}{fmt(pts)} ({up ? '+' : ''}{pct.toFixed(2)}%)
                </span>
              </div>
            ) : (
              <div className="idx-card-val idx-card-loading">—</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

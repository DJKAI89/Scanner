import React from 'react';
import { useApp } from '../context/AppContext';
import { useIndexFeed } from '../hooks/useIndexFeed';

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function Ticker() {
  const { token, onTokenExpired, cfg } = useApp();
  const { nifty, banknifty, sensex } = useIndexFeed(token, onTokenExpired, cfg.tick || 15, !!token);

  const liveLine = [
    nifty ? `NIFTY ${fmtNum(nifty.ltp)} [${nifty.pts >= 0 ? '+' : ''}${fmtNum(nifty.pts)} pts]` : 'NIFTY --',
    banknifty ? `BANKNIFTY ${fmtNum(banknifty.ltp)} [${banknifty.pts >= 0 ? '+' : ''}${fmtNum(banknifty.pts)} pts]` : 'BANKNIFTY --',
    sensex ? `SENSEX ${fmtNum(sensex.ltp)} [${sensex.pts >= 0 ? '+' : ''}${fmtNum(sensex.pts)} pts]` : 'SENSEX --',
  ].join('  ●  ');

  const staticLine = 'F.R.I.D.A.Y  ●  PROFESSIONAL NSE SCANNER  ●  REAL-TIME SIGNALS  ●  UPSTOX API  ●  RSI · MACD · SUPERTREND · EMA';
  const text = `  ${liveLine}  ●  `;

  return (
    <div className="tkr-w">
      <div className="tkr-i">{text}</div>
    </div>
  );
}

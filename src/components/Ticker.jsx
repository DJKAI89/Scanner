import React from 'react';
import { useApp } from '../context/AppContext';
import { useIndexFeed } from '../hooks/useIndexFeed';

function fmtNum(n, dec = 2) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: dec });
}

export default function Ticker() {
  const { token, onTokenExpired, cfg, tickerStats } = useApp();
  const { nifty, banknifty, sensex } = useIndexFeed(token, onTokenExpired, cfg.tick || 15, !!token);
  const { vix, pcr, sentiment, sentSc, topSec } = tickerStats || {};

  const sign = n => n >= 0 ? '+' : '';
  const liveParts = [
    nifty     ? `NIFTY ₹${fmtNum(nifty.ltp,0)} ${sign(nifty.pts)}${fmtNum(nifty.pts)} pts`      : 'NIFTY --',
    banknifty ? `BANKNIFTY ₹${fmtNum(banknifty.ltp,0)} ${sign(banknifty.pts)}${fmtNum(banknifty.pts)} pts` : 'BANKNIFTY --',
    vix       ? `VIX ${Number(vix).toFixed(1)}`                                                   : null,
    pcr != null ? `PCR ${Number(pcr).toFixed(2)}`                                                 : null,
    sentiment ? `${sentiment} ${sentSc ?? 5}/10`                                                  : null,
    topSec    ? `Top: ${topSec}`                                                                   : null,
  ].filter(Boolean);

  const text = '  ' + liveParts.join('  ●  ') + '  ●  F.R.I.D.A.Y  ●  REAL-TIME NSE SCANNER  ●  ';

  return (
    <div className="tkr-w">
      <div className="tkr-i">{text.repeat(3)}</div>
    </div>
  );
}

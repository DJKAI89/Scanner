import React from 'react';
import { useApp } from '../context/AppContext';
import { useIndexFeed } from '../hooks/useIndexFeed';
import { fmt, fmtC, interpVIX } from '../utils/formatters';

function fmtNum(n, dec = 2) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: dec });
}

export default function Ticker() {
  const { token, onTokenExpired, tickerStats, activeTab } = useApp();
  const feedEnabled = activeTab === 'stocks' || activeTab === 'options';
  const { nifty, banknifty, sensex } = useIndexFeed(token, onTokenExpired, feedEnabled);
  const { vix, pcr, sentiment, sentSc, topSec } = tickerStats || {};

  const sign = n => n >= 0 ? '+' : '';
    const liveParts = [
    sensex ? `SENSEX ${fmt(sensex.ltp)} [${sensex.pts >= 0 ? '+' : ''}${fmt(sensex.pts)} pts]` : 'SENSEX --',
    nifty ? `NIFTY ${fmt(nifty.ltp)} [${nifty.pts >= 0 ? '+' : ''}${fmt(nifty.pts)} pts]` : 'NIFTY --',
    banknifty ? `BANKNIFTY ${fmt(banknifty.ltp)} [${banknifty.pts >= 0 ? '+' : ''}${fmt(banknifty.pts)} pts]` : 'BANKNIFTY --',
    // vix       ? `VIX ${Number(vix).toFixed(1)}`                                                   : null,
    // pcr != null ? `PCR ${Number(pcr).toFixed(2)}`                                                 : null,
    // sentiment ? `${sentiment} ${sentSc ?? 5}/10`                                                  : null,
    // topSec    ? `Top: ${topSec}`                                                                   : null,
  ].filter(Boolean);

  const text = '  ' + liveParts.join('  ●  ') + '  ';

  // return (
  //   <div className="tkr-w">
  //     <div className="tkr-i">{text.repeat(5)}</div>
  //   </div>
  // );
  return(
    null
  );
}

import React from 'react';
import { useApp } from '../context/AppContext';
import { useIndexFeed } from '../hooks/useIndexFeed';
import { fmt } from '../utils/formatters';

const INDICES = [
  { key: 'nifty',     label: 'NIFTY 50' },
  { key: 'banknifty', label: 'BANK NIFTY' },
  { key: 'sensex',    label: 'SENSEX' },
];

export default function Ticker() {
  const { token, onTokenExpired, booted, scanning } = useApp();
  // Always on once logged in — not tied to any specific tab/pane's state,
  // so it keeps updating (5s poll, same as before) no matter which page
  // is open. useIndexFeed itself no-ops without a token, so this is safe
  // to mount unconditionally.
  const feed = useIndexFeed(token, onTokenExpired, booted, scanning);

  if (!booted) return null;

  return (
    <div className="idx-strip">
      {INDICES.map((idx, i) => {
        const d = feed[idx.key];
        const up = (d?.pts ?? 0) >= 0;
        return (
          <div className="idx-card" key={idx.key} style={i > 0 ? { borderLeft: '1px solid #e2e8f0' } : undefined}>
            <div className="idx-card-lbl">{idx.label}</div>
            {d ? (
              <div className="idx-card-val">
                <span className="idx-card-ltp">{fmt(d.ltp)}</span>
                <span className={up ? 'idx-card-up' : 'idx-card-dn'}>
                  {up ? '+' : ''}{fmt(d.pts)} ({up ? '+' : ''}{d.chgPct}%)
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


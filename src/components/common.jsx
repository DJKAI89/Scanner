import React from 'react';

// ── Spinner ──────────────────────────────────────────────────
export function Spinner({ label = 'Loading...', sub = '', progress = '' }) {
  return (
    <div className="spin-wrap">
      <div className="spin" />
      <p style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{label}</p>
      {progress && <p style={{ fontSize: 11, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>{progress}</p>}
      {sub && <p style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>{sub}</p>}
    </div>
  );
}

// ── ErrorBanner ───────────────────────────────────────────────
export function ErrorBanner({ title = '⚠ Error', message, onRetry }) {
  return (
    <div className="err-b">
      <h4>{title}</h4>
      {message && <p>{message}</p>}
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            marginTop: 7, background: '#dc2626', color: '#fff',
            border: 'none', borderRadius: 5, padding: '4px 11px',
            fontSize: 10, cursor: 'pointer', fontWeight: 600,
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ── StatCard ─────────────────────────────────────────────────
export function StatCard({ label, value, sub, note, valClass = '' }) {
  return (
    <div className="sc">
      <div className="sc-lbl">{label}</div>
      <div className={`sc-val ${valClass}`}>{value}</div>
      {sub  && <div className={`sc-sub ${valClass}`}>{sub}</div>}
      {note && <div className={`sc-note ${valClass}`}>{note}</div>}
    </div>
  );
}

// ── Toast ─────────────────────────────────────────────────────
export function Toast({ msg, color = '#16a34a' }) {
  if (!msg) return null;
  return (
    <div
      className="friday-toast"
      style={{ borderLeft: `4px solid ${color}`, opacity: 1 }}
    >
      {msg}
    </div>
  );
}

// ── MarketClosedBanner ────────────────────────────────────────
export function MarketClosedBanner({ msg }) {
  if (!msg) return null;
  return <div className="mkt-closed">{msg}</div>;
}

// ── LastUpdated ───────────────────────────────────────────────
export function LastUpdated({ time, dotColor = '#16a34a' }) {
  return (
    <div className="last-upd">
      <div className="upd-dot" style={dotColor !== '#16a34a' ? { background: dotColor } : {}} />
      <span>{time}</span>
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────
export function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>;
}

// ── LogDrawer ──────────────────────────────────────────────────
export function LogDrawer({ open, lines, onClear }) {
  if (!open) return null;
  return (
    <div className="log-drawer">
      <div className="log-hdr">
        <span>SCAN LOG</span>
        <button
          onClick={onClear}
          style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 9 }}
        >
          Clear
        </button>
      </div>
      <div className="log-body">
        {lines.map((l, i) => (
          <div key={i} className={'ll' + (l.t === 'e' ? ' e' : l.t === 'o' ? ' o' : l.t === 'w' ? ' w' : '')}>
            [{l.ts}] {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

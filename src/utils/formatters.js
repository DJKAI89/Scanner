// ── Number & string formatters ──

export function fmt(n, d = 2) {
  return Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function fmtC(n) {
  return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';
}

export function fmtVol(n) {
  if (!n) return '—';
  if (n >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

export function clr(n) {
  return n >= 0 ? 'up' : 'dn';
}

export function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0;
  const prev = (q.ohlc && q.ohlc.close) || ltp;
  if (!prev) return 0;
  return ((ltp - prev) / prev) * 100;
}

export function interpVIX(vix) {
  if (!vix) return { txt: 'N/A', cls: 'bl', sc: 50 };
  if (vix < 12)  return { txt: 'Very Low 😴',  cls: 'bl', sc: 85 };
  if (vix < 16)  return { txt: 'Low 🟢',        cls: 'up', sc: 80 };
  if (vix < 20)  return { txt: 'Moderate 🟡',   cls: 'am', sc: 60 };
  if (vix < 24)  return { txt: 'High 🔴',        cls: 'dn', sc: 35 };
  return           { txt: 'Extreme 💀',           cls: 'dn', sc: 15 };
}

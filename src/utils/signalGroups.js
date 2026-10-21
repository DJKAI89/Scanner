// Several option signals on the same underlying, side, expiry, day and action are really ONE market
// view taken more than once (e.g. two UNIONBANK puts logged in the same scan). Grouping them lets the
// Log page show combined exposure at a glance. Stocks, and option signals with no sibling, stay single.
export function groupCorrelated(signals) {
  const rows = [];
  const idx = new Map();
  signals.forEach((sig, i) => {
    if (sig.type === 'OPTION' && sig.optType && sig.expiry) {
      const k = [sig.stock || sig.name || sig.und || sig.symbol, sig.optType, sig.expiry, sig.date, sig.signal || sig.action || ''].join('|');
      if (idx.has(k)) { idx.get(k).members.push(sig); return; }
      const g = { kind: 'group', key: k, members: [sig] };
      idx.set(k, g); rows.push(g); return;
    }
    rows.push({ kind: 'single', sig, key: sig.id ?? i });
  });
  // a "group" of one is just a signal
  return rows.map((r) => (r.kind === 'group' && r.members.length === 1 ? { kind: 'single', sig: r.members[0], key: r.members[0].id ?? r.key } : r));
}

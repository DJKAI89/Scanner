import fs from 'node:fs';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const store = new Map(); let n = 0;
const put = (p, o) => store.set(p, { content: JSON.stringify(o), sha: 's' + (++n) });
const mk = (id, key) => ({ id, type: 'STOCK', stock: id, instrKey: key, signal: 'BUY', date: today, time: '09:20', entry: 100, sl: 98, target: 106, targetT1: 102, targetT2: 104, targetT3: 106, confidence: 80, status: 'OPEN' });
put('signal-logs/u1/index.json', { dates: [today], dailyStats: { [today]: { open: 4 } } });
put(`signal-logs/u1/${today}.json`, { signals: [mk('STOP_FIRST', 'K1'), mk('TARGET_HIT_CASE', 'K2'), mk('BOTH_SAME_CANDLE', 'K3'), mk('UNTOUCHED', 'K4')] });
const candle = (hhmm, o, h, l, c) => [`${today}T${hhmm}:00+05:30`, o, h, l, c, 1000, 0];
const candles = {
  K1: [candle('09:25', 100, 101, 97.5, 99)],
  K2: [candle('09:25', 100, 107, 99, 106)],
  K3: [candle('09:25', 100, 107, 97, 100)],
  K4: [candle('09:25', 100, 101, 99.2, 100.3)],
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.github.com')) {
    const path = decodeURIComponent(u.match(/\/contents\/(.*)$/)[1]);
    if ((opts.method || 'GET') === 'PUT') {
      const body = JSON.parse(opts.body); const sha = 's' + (++n);
      store.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha }); return json({ content: { sha } });
    }
    const f = store.get(path);
    if (f) return json({ content: Buffer.from(f.content).toString('base64'), sha: f.sha });
    const kids = new Map();
    for (const k of store.keys()) if (k.startsWith(path + '/')) { const rest = k.slice(path.length + 1); kids.set(rest.split('/')[0], rest.includes('/') ? 'dir' : 'file'); }
    return kids.size ? json([...kids].map(([name, type]) => ({ name, type }))) : json({ message: 'Not Found' }, 404);
  }
  if (u.includes('/v2/market/holidays')) return json({ data: [] });
  if (u.includes('/market-quote/quotes')) {
    const keys = decodeURIComponent(u.split('instrument_key=')[1] || '').split(',');
    return json({ data: Object.fromEntries(keys.map((k) => [k, { last_price: 100 }])) });
  }
  const m = u.match(/historical-candle\/(?:intraday\/)?([^/]+)\//);
  if (m) { const key = decodeURIComponent(m[1]); return json({ data: { candles: [...(candles[key] || [])].reverse() } }); }
  return json({}, 404);
};
process.on('exit', () => {
  const day = JSON.parse(store.get(`signal-logs/u1/${today}.json`).content);
  for (const s of day.signals) console.log(s.id.padEnd(18), s.status.padEnd(11), 'exit', s.exitPrice ?? '-', 'pnl%', s.pnlPct ?? '-');
});

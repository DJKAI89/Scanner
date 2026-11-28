import fs from 'node:fs';
const FILE = process.env.MOCK_STORE;
const store = fs.existsSync(FILE) ? new Map(Object.entries(JSON.parse(fs.readFileSync(FILE, 'utf8')))) : new Map();
const save = () => fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(store)));
let n = store.size;
if (!store.has('signal-logs/u1/index.json')) {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const byDay = {}, shadowByDay = {};
  const dayStr = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  for (let i = 0; i < 700; i++) {
    const d = dayStr(Math.floor(i / 3)), conf = 40 + rnd() * 45, isOpt = i % 2 === 0, shadow = i % 4 === 1;
    const win = rnd() < 0.35 + (conf - 40) / 150;
    const base = { id: `${d}-${i}`, date: d, time: `10:${String(10 + (i % 40))}`, confidence: conf, status: win ? 'TARGET_HIT' : 'SL_HIT', pnlPct: win ? 40 : -30, exitDate: d, exitTime: '14:00', action: 'BUY', signal: 'BUY' };
    const sig = isOpt
      ? { ...base, type: 'OPTION', optType: i % 4 === 0 ? 'CE' : 'PE', stock: i % 6 === 0 ? 'NIFTY' : 'RELIANCE', strike: 1400, spot: 1350 + rnd() * 20, entry: 5 + rnd() * 30, sl: 3, target: 9, rr: 2, iv: 20, delta: .3, theta: -1, oi: 5000 + rnd() * 9000, dte: 5, trendAligned: true }
      : { ...base, type: 'STOCK', stock: 'S' + (i % 20), entry: 1000, sl: 970, target: 1060, rr: 2, numInds: 3, atr: 20, ema50: 990, ema200: 900, hi52: 1200, lo52: 700, risk: 40 };
    if (shadow) { sig.id = 'shadow-' + sig.id; sig.shadow = true; (shadowByDay[d] ||= []).push(sig); } else (byDay[d] ||= []).push(sig);
  }
  const put = (p, o) => store.set(p, { content: JSON.stringify(o), sha: 's' + (++n) });
  put('signal-logs/u1/index.json', { dates: Object.keys(byDay).sort() });
  for (const [d, signals] of Object.entries(byDay)) put(`signal-logs/u1/${d}.json`, { signals });
  for (const [d, signals] of Object.entries(shadowByDay)) put(`signal-logs/u1/shadow/${d}.json`, { signals });
  save();
}
globalThis.fetch = async (url, opts = {}) => {
  const m = String(url).match(/\/contents\/(.*)$/); const path = decodeURIComponent(m[1]);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if ((opts.method || 'GET') === 'PUT') {
    const body = JSON.parse(opts.body); const cur = store.get(path);
    if (cur && body.sha !== cur.sha) return json({ message: 'sha mismatch' }, 409);
    const sha = 's' + (++n); store.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha, putAt: Date.now() }); save();
    return json({ content: { sha } });
  }
  const f = store.get(path);
  if (f) return json({ content: Buffer.from(f.content).toString('base64'), sha: f.sha });
  const kids = new Map();
  for (const k of store.keys()) if (k.startsWith(path + '/')) { const rest = k.slice(path.length + 1); const name = rest.split('/')[0]; kids.set(name, rest.includes('/') ? 'dir' : 'file'); }
  if (kids.size) return json([...kids].map(([name, type]) => ({ name, type })));
  return json({ message: 'Not Found' }, 404);
};

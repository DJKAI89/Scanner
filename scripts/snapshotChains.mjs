// Option-chain snapshots → chain-snapshots/<date>.json
//
// Upstox sells no history of past option chains, so the only way to ever train a model
// on OI / IV / PCR / spread is to record it yourself from today. This runs inside the
// existing monitor job (same token, same trigger — no extra scheduler to babysit) and
// appends one compact snapshot per index per run, during market hours only.
//
// Per contract it keeps: ltp, oi, prevOi, volume, bid, ask, bidQty, askQty, iv, delta
// (Upstox returns bid/ask already; the app just never used them).
//
// Size guard: nearest expiry only, ±SNAPSHOT_STRIKES strikes around ATM (default 8)
// ≈ 5 KB per run → ~130 KB/day, safely under GitHub's 1 MB contents-API read limit.
// Env: SNAPSHOT_STRIKES (8), SNAPSHOT_EXPIRIES (1), SNAPSHOT_CHAINS=0 to disable.

const GH_API = 'https://api.github.com';
const UPSTOX = 'https://api.upstox.com/v2';

export const SNAPSHOT_INDICES = [
  { u: 'NIFTY',     key: 'NSE_INDEX|Nifty 50' },
  { u: 'BANKNIFTY', key: 'NSE_INDEX|Nifty Bank' },
  { u: 'SENSEX',    key: 'BSE_INDEX|SENSEX' },
];
export const CELL_FIELDS = ['ltp', 'oi', 'prevOi', 'volume', 'bid', 'ask', 'bidQty', 'askQty', 'iv', 'delta'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (Number.isFinite(+v) ? +(+v).toFixed(2) : 0);

export function compactCell(side) {
  const m = side?.market_data || {};
  const g = side?.option_greeks || {};
  return [m.ltp, m.oi, m.prev_oi, m.volume, m.bid_price, m.ask_price, m.bid_qty, m.ask_qty, g.iv, g.delta].map(num);
}

// Pure: raw Upstox chain rows → ±N strikes around ATM, compact arrays.
export function compactChain(raw, spot, nStrikes = 8) {
  const rows = (raw || []).filter((r) => r?.strike_price > 0).sort((a, b) => a.strike_price - b.strike_price);
  if (!rows.length) return [];
  let atm = 0, best = Infinity;
  rows.forEach((r, i) => { const d = Math.abs(r.strike_price - spot); if (d < best) { best = d; atm = i; } });
  return rows.slice(Math.max(0, atm - nStrikes), atm + nStrikes + 1)
    .map((r) => [r.strike_price, compactCell(r.call_options), compactCell(r.put_options)]);
}

async function upstoxGet(path, token) {
  const r = await fetch(UPSTOX + path, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Upstox ${path.split('?')[0]}: ${r.status}`);
  return r.json();
}

export function marketIsOpen(nowStr) {
  const [h, m] = String(nowStr).split(':').map((x) => parseInt(x, 10));
  const min = h * 60 + m;
  return min >= 9 * 60 + 15 && min <= 15 * 60 + 30;
}

async function ghGetFile(gh, path) {
  const r = await fetch(`${GH_API}/repos/${gh.user}/${gh.repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GH read ${path}: ${r.status}`);
  return r.json();
}

async function appendSnaps(gh, path, today, newSnaps, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const f = await ghGetFile(gh, path);
    let doc = { date: today, fields: CELL_FIELDS, snaps: [] };
    if (f) { try { doc = JSON.parse(Buffer.from(f.content, 'base64').toString('utf8')); } catch (_) { /* start fresh */ } }
    doc.snaps = [...(doc.snaps || []), ...newSnaps];
    const r = await fetch(`${GH_API}/repos/${gh.user}/${gh.repo}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json' },
      body: JSON.stringify({
        message: `chore: chain snapshot ${today}`,
        content: Buffer.from(JSON.stringify(doc)).toString('base64'), // compact: no pretty-print
        ...(f?.sha ? { sha: f.sha } : {}),
      }),
    });
    if (r.ok) return doc.snaps.length;
    if (r.status !== 409 && r.status !== 422) throw new Error(`GH write ${path}: ${r.status}`);
    await sleep(400 + Math.random() * 400);
  }
  throw new Error('chain snapshot write conflict');
}

export async function snapshotChains({ gh, upstoxToken, today, nowStr, log = console.log }) {
  if (process.env.SNAPSHOT_CHAINS === '0') return 0;
  if (!marketIsOpen(nowStr)) return 0;
  const nStrikes = Math.max(3, parseInt(process.env.SNAPSHOT_STRIKES || '8', 10));
  const nExp = Math.max(1, parseInt(process.env.SNAPSHOT_EXPIRIES || '1', 10));
  const hhmm = String(nowStr).slice(0, 5);

  let vix = null;
  try {
    const q = await upstoxGet('/market-quote/quotes?instrument_key=' + encodeURIComponent('NSE_INDEX|India VIX'), upstoxToken);
    vix = num(Object.values(q?.data || {})[0]?.last_price) || null;
  } catch (e) { log('snapshot: VIX unavailable: ' + e.message); }

  const snaps = [];
  for (const ix of SNAPSHOT_INDICES) {
    try {
      const c = await upstoxGet('/option/contract?instrument_key=' + encodeURIComponent(ix.key), upstoxToken);
      const expiries = [...new Set((c?.data || []).map((x) => x.expiry).filter((e) => e && e >= today))].sort().slice(0, nExp);
      await sleep(350);
      for (const exp of expiries) {
        const d = await upstoxGet(`/option/chain?instrument_key=${encodeURIComponent(ix.key)}&expiry_date=${exp}`, upstoxToken);
        const raw = d?.data || [];
        const spot = num(raw.find((r) => r?.underlying_spot_price)?.underlying_spot_price);
        const rows = compactChain(raw, spot, nStrikes);
        if (spot && rows.length) snaps.push({ t: hhmm, u: ix.u, exp, spot, vix, rows });
        await sleep(350);
      }
    } catch (e) { log(`snapshot ${ix.u} failed: ${e.message}`); }
  }
  if (!snaps.length) return 0;
  const total = await appendSnaps(gh, `chain-snapshots/${today}.json`, today, snaps);
  log(`snapshot: +${snaps.length} (day total ${total})`);
  return snaps.length;
}

// Server-side signal monitor. Runs headlessly under GitHub Actions cron —
// same evaluateSignalExit logic as AppContext.jsx's runSignalMonitor, just
// without a browser. Requires UPSTOX_ACCESS_TOKEN + GH_TOKEN/GH_USER/GH_REPO
// env vars (set as repo secrets). Upstox tokens expire ~3:30am IST daily —
// you (or a separate login-automation step) must refresh the secret once a
// day; there is no refresh-token grant in Upstox's API to avoid this.
import { evaluateSignalExit } from '../src/services/tradeManagement.js';

const GH_API = 'https://api.github.com';
const gh = { token: process.env.GH_TOKEN, user: process.env.GH_USER, repo: process.env.GH_REPO };
const upstoxToken = process.env.UPSTOX_ACCESS_TOKEN;
// Must match localStorage 'friday_user_id' in the app (Settings page) — set
// as a repo secret. Defaults to 'default', same as github.js's fallback.
const uid = (process.env.GH_USER_ID || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
const folder = `signal-logs/${uid}`;

function computeLogStats(signals) {
  const hits = signals.filter((s) => s.status === 'TARGET_HIT').length;
  const sls = signals.filter((s) => s.status === 'SL_HIT').length;
  const open = signals.filter((s) => s.status === 'OPEN').length;
  const closed = hits + sls;
  return { total: signals.length, hits, sls, open, winRate: closed ? Math.round(hits / closed * 100) : null };
}

async function ghGet(path) {
  const r = await fetch(`${GH_API}/repos/${gh.user}/${gh.repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json' },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GH read ${path}: ${r.status}`);
  return r.json();
}
async function ghPut(path, contentObj, sha) {
  const body = {
    message: `chore: signal monitor update ${path}`,
    content: Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64'),
    ...(sha ? { sha } : {}),
  };
  const r = await fetch(`${GH_API}/repos/${gh.user}/${gh.repo}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GH write ${path}: ${r.status} ${await r.text()}`);
}

async function fetchQuotes(keys) {
  if (!keys.length) return {};
  const url = `https://api.upstox.com/v3/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(','))}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${upstoxToken}`, Accept: 'application/json' } });
  if (!r.ok) return {};
  const d = await r.json();
  return d?.data || {};
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

// Fetches NSE's live trading-holiday calendar. NSE blocks bare requests
// (same issue as the sector-map builder) — needs browser-like headers plus
// a homepage hit first to pick up cookies, with retry.
async function fetchNseHolidays() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    Accept: 'application/json', Referer: 'https://www.nseindia.com/',
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const jar = await fetch('https://www.nseindia.com/', { headers });
      const cookie = jar.headers.get('set-cookie') || '';
      const r = await fetch('https://www.nseindia.com/api/holiday-master?type=trading', {
        headers: { ...headers, Cookie: cookie },
      });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.includes('json')) throw new Error(`non-JSON (${r.status})`);
      const d = await r.json();
      const dates = (d?.CM || []).map((h) => {
        // NSE returns "26-Jan-2026" style — normalize to YYYY-MM-DD
        const dt = new Date(h.tradingDate);
        return isNaN(dt) ? null : dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      }).filter(Boolean);
      if (dates.length) return dates;
    } catch (e) {
      console.warn(`NSE holiday fetch attempt ${attempt + 1} failed: ${e.message}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  console.warn('Could not fetch NSE holiday calendar — proceeding without holiday skip');
  return [];
}

async function main() {
  if (!gh.token || !gh.user || !gh.repo || !upstoxToken) {
    console.error('Missing GH_TOKEN/GH_USER/GH_REPO/UPSTOX_ACCESS_TOKEN'); process.exit(1);
  }
  const today0 = todayIST();
  const holidays = await fetchNseHolidays();
  if (holidays.includes(today0)) { console.log('NSE holiday — skipping'); return; }
  const index = await ghGet(`${folder}/index.json`);
  if (!index) { console.log('No signal index yet'); return; }
  const { dates, dailyStats } = JSON.parse(Buffer.from(index.content, 'base64').toString('utf8'));
  const openDates = dates.filter((d) => (dailyStats[d]?.open || 0) > 0);
  if (!openDates.length) { console.log('No open signals'); return; }

  const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const today = todayIST();

  for (const date of openDates) {
    const file = await ghGet(`${folder}/${date}.json`);
    if (!file) continue;
    const wrapper = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    const signals = wrapper.signals || [];
    const open = signals.filter((s) => s.status === 'OPEN');
    if (!open.length) continue;

    const keys = [...new Set(open.map((s) => s.instrKey || s.key).filter(Boolean))];
    const quotes = await fetchQuotes(keys);

    let changed = false;
    const updated = signals.map((s) => {
      if (s.status !== 'OPEN') return s;
      const instrK = s.instrKey || s.key;
      const ltp = quotes[instrK]?.last_price ?? null;
      if (!ltp && !(s.type === 'OPTION' && s.expiry && today > s.expiry)) return s;
      const result = evaluateSignalExit(s, ltp ?? s.entry, today, now, {});
      if (!result) return s;
      changed = true;
      console.log(result.status ? `${result.status}: ${s.stock || s.sym}` : `update: ${s.stock || s.sym}`);
      return { ...s, ...result };
    });

    if (changed) {
      const payload = { signals: updated, lastUpdated: new Date().toISOString(), date, stats: computeLogStats(updated) };
      await ghPut(`${folder}/${date}.json`, payload, file.sha);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

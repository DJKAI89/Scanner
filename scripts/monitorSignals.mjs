// Server-side signal monitor. Runs headlessly under GitHub Actions cron —
// same evaluateSignalExit logic as AppContext.jsx's runSignalMonitor, just
// without a browser. Requires UPSTOX_ACCESS_TOKEN + GH_TOKEN env vars.
// GH_USER/GH_REPO are optional and fall back to GITHUB_REPOSITORY.
// Upstox tokens expire ~3:30am IST daily —
// you (or a separate login-automation step) must refresh the secret once a
// day; there is no refresh-token grant in Upstox's API to avoid this.
//
// If SCANNER_USER_ID / GH_USER_ID is unset, auto-discovers every user folder under
// signal-logs/ (same pattern as scripts/train-ai-model.mjs) — no per-user
// secret needed.
import { evaluateSignalExit } from '../src/services/tradeManagement.js';

const GH_API = 'https://api.github.com';
const [repoOwner = '', repoName = ''] = (process.env.GITHUB_REPOSITORY || '').split('/');
const gh = {
  token: process.env.GH_TOKEN,
  user: process.env.GH_USER || repoOwner,
  repo: process.env.GH_REPO || repoName,
};
const upstoxToken = process.env.UPSTOX_ACCESS_TOKEN;
const fixedUid = (process.env.SCANNER_USER_ID || process.env.GH_USER_ID || '').replace(/[^a-zA-Z0-9_-]/g, '_') || null;

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
  if (r.status === 401) throw new Error(`GH read ${path}: 401 Unauthorized — AI_GH_TOKEN is invalid/expired`);
  if (r.status === 403) throw new Error(`GH read ${path}: 403 Forbidden — AI_GH_TOKEN lacks repo access, or check GH_USER/GH_REPO are correct (currently "${gh.user}/${gh.repo}")`);
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
  if (r.status === 401) throw new Error(`GH write ${path}: 401 Unauthorized — AI_GH_TOKEN is invalid/expired`);
  if (r.status === 403) throw new Error(`GH write ${path}: 403 Forbidden — AI_GH_TOKEN needs "Contents: write" permission`);
  if (!r.ok) throw new Error(`GH write ${path}: ${r.status} ${await r.text()}`);
}

async function ghUpdateIndex(uid, date, stats) {
  const path = `signal-logs/${uid}/index.json`;
  const index = await ghGet(path);
  const decoded = index ? JSON.parse(Buffer.from(index.content, 'base64').toString('utf8')) : { dates: [], dailyStats: {} };
  const dates = decoded.dates?.includes(date) ? decoded.dates : [...(decoded.dates || []), date].sort();
  const dailyStats = { ...(decoded.dailyStats || {}), [date]: stats };
  await ghPut(path, {
    dates: dates.slice(-90),
    dailyStats,
    lastUpdated: new Date().toISOString(),
  }, index?.sha);
}

async function listUserFolders() {
  if (fixedUid) return [fixedUid];
  const folder = await ghGet('signal-logs');
  if (!Array.isArray(folder)) return [];
  return folder.filter((item) => item?.type === 'dir' && item?.name).map((item) => item.name);
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

// Live trading-holiday calendar via Upstox's official endpoint (same token,
// no bot-block risk like scraping nseindia.com directly).
async function fetchNseHolidays() {
  try {
    const r = await fetch('https://api.upstox.com/v2/market/holidays', {
      headers: { Authorization: `Bearer ${upstoxToken}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json();
    return (d?.data || [])
      .filter((h) => !h.closed_exchanges?.length || h.closed_exchanges.includes('NSE') || (h.open_exchanges || []).every((e) => e.exchange !== 'NSE'))
      .map((h) => h.date);
  } catch (e) {
    console.warn('Upstox holiday fetch failed — proceeding without holiday skip:', e.message);
    return [];
  }
}

async function processUser(uid, today, now) {
  const folder = `signal-logs/${uid}`;
  const index = await ghGet(`${folder}/index.json`);
  if (!index) { console.log(`[${uid}] No signal index yet`); return; }
  const { dates, dailyStats } = JSON.parse(Buffer.from(index.content, 'base64').toString('utf8'));
  const openDates = dates.filter((d) => (dailyStats[d]?.open || 0) > 0);
  if (!openDates.length) { console.log(`[${uid}] No open signals`); return; }

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
      console.log(`[${uid}] ${result.status ? result.status : 'update'}: ${s.stock || s.sym}`);
      return { ...s, ...result };
    });

    if (changed) {
      const stats = computeLogStats(updated);
      const payload = { signals: updated, lastUpdated: new Date().toISOString(), date, stats };
      await ghPut(`${folder}/${date}.json`, payload, file.sha);
      await ghUpdateIndex(uid, date, stats);
    }
  }
}

async function main() {
  const missing = [];
  if (!gh.token) missing.push('GH_TOKEN');
  if (!gh.user) missing.push('GH_USER or GITHUB_REPOSITORY owner');
  if (!gh.repo) missing.push('GH_REPO or GITHUB_REPOSITORY repo');
  if (!upstoxToken) missing.push('UPSTOX_ACCESS_TOKEN — not set yet. Paste your Upstox token in the app once (Settings/TokenGate) to auto-create this secret, or set it manually in repo Secrets.');
  if (missing.length) {
    console.error('Missing required config:\n- ' + missing.join('\n- '));
    process.exit(1);
  }
  const today0 = todayIST();
  const holidays = await fetchNseHolidays();
  if (holidays.includes(today0)) { console.log('NSE holiday — skipping'); return; }

  const uids = await listUserFolders();
  if (!uids.length) { console.log('No user folders found in signal-logs'); return; }

  const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const today = todayIST();
  for (const uid of uids) await processUser(uid, today, now);
}

main().catch((e) => { console.error(e); process.exit(1); });

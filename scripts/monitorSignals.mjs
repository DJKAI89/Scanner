// Server-side signal monitor. Runs headlessly under GitHub Actions cron —
// same evaluateSignalExit logic as AppContext.jsx's runSignalMonitor, just
// without a browser. Requires UPSTOX_ACCESS_TOKEN + GH_TOKEN/GH_USER/GH_REPO
// env vars (set as repo secrets). Upstox tokens expire ~3:30am IST daily —
// you (or a separate login-automation step) must refresh the secret once a
// day; there is no refresh-token grant in Upstox's API to avoid this.
//
// If GH_USER_ID is unset, auto-discovers every user folder under
// signal-logs/ (same pattern as scripts/train-ai-model.mjs) — no per-user
// secret needed.
import { evaluateSignalExit } from '../src/services/tradeManagement.js';
import { isBullSignal } from '../src/services/github.js';
import { snapshotChains } from './snapshotChains.mjs';

const GH_API = 'https://api.github.com';
const gh = { token: process.env.GH_TOKEN, user: process.env.GH_USER, repo: process.env.GH_REPO };
const upstoxToken = process.env.UPSTOX_ACCESS_TOKEN;
const fixedUid = process.env.GH_USER_ID ? process.env.GH_USER_ID.replace(/[^a-zA-Z0-9_-]/g, '_') : null;

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
async function ghPut(path, contentObj, sha, _retried = false) {
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
  if (r.status === 409 && !_retried) {
    // Stale SHA — another overlapping writer (the client's own
    // runSignalMonitor, or another run of this same script) wrote in
    // between our read and write. Previously this just re-PUT the SAME
    // (now-stale) contentObj with a fresh SHA — which can silently
    // OVERWRITE and destroy whatever the other writer just correctly
    // wrote (e.g. this retry blindly re-asserting "still OPEN" on top of
    // a resolution the client just persisted a moment earlier). Now it
    // re-fetches the fresh signals and merges: a signal we've resolved
    // (non-OPEN) always wins over a still-OPEN version, whichever side
    // it came from — same rule github.js's ghWriteDay already uses.
    console.warn(`GH write ${path}: 409 conflict — refetching and merging before retry`);
    const fresh = await ghGet(path);
    if (fresh?.sha && Array.isArray(contentObj?.signals)) {
      let freshSignals = [];
      try { freshSignals = JSON.parse(Buffer.from(fresh.content, 'base64').toString('utf8')).signals || []; }
      catch (e) { freshSignals = []; }
      const existingIds = new Set(freshSignals.map((s) => s.id));
      const merged = freshSignals.map((sig) => {
        const ours = contentObj.signals.find((item) => item.id === sig.id);
        return (ours && ours.status !== 'OPEN' && sig.status === 'OPEN') ? ours : sig;
      });
      merged.push(...contentObj.signals.filter((sig) => !existingIds.has(sig.id)));
      const mergedPayload = { ...contentObj, signals: merged, stats: computeLogStats(merged) };
      return ghPut(path, mergedPayload, fresh.sha, true);
    }
    if (fresh?.sha) return ghPut(path, contentObj, fresh.sha, true);
  }
  if (!r.ok) throw new Error(`GH write ${path}: ${r.status} ${await r.text()}`);
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

// ── Phone alerts (optional) ─────────────────────────────────────
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as repo secrets to receive a message when a REAL signal
// hits target/stop or expires. Silent no-op when either is missing. Shadow signals never notify.
async function sendTelegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.warn('telegram failed (ignored): ' + e.message); }
}
function describeSignal(s) {
  return s.type === 'OPTION' ? `${s.stock || s.sym} ${s.strike || ''} ${s.optType || ''}`.trim() : (s.stock || s.sym);
}
async function notifyClosed(before, after) {
  const label = { TARGET_HIT: '✅ Target hit', SL_HIT: '🛑 Stop hit', EXPIRED: '⌛ Expired' }[after.status];
  if (!label) return;
  const pnl = typeof after.pnlPct === 'number' ? ` ${after.pnlPct > 0 ? '+' : ''}${after.pnlPct.toFixed(1)}%` : '';
  await sendTelegram(`${label}: ${describeSignal(before)}${pnl}\nEntry ${before.entry} → exit ${after.exitPrice ?? '—'}`);
}

// ── Intraday outcome labels ─────────────────────────────────────
// The last traded price can miss a target or stop that was touched between two checks. Replaying the
// 5-minute candles since entry finds what was really hit first. Inside one candle the order is not
// known, so the adverse side is applied first (a stop wins over a target in the same candle).
const IST_OFFSET_MS = 330 * 60000;
const istDate = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istTime = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19);
const entryEpoch = (s) => {
  const t = String(s.time || '09:15');
  const hhmmss = t.length === 5 ? t + ':00' : t;
  const ms = Date.parse(`${s.date}T${hhmmss}+05:30`);
  return Number.isFinite(ms) ? ms : 0;
};
const MAX_CANDLE_KEYS_PER_RUN = 150;
const candleCache = new Map();
let candleCalls = 0;

async function fetchCandles5m(key, fromDate, toDate) {
  const ck = `${key}|${fromDate}`;
  if (candleCache.has(ck)) return candleCache.get(ck);
  if (candleCalls >= MAX_CANDLE_KEYS_PER_RUN) return [];
  candleCalls++;
  const enc = encodeURIComponent(key);
  const urls = fromDate === toDate
    ? [`https://api.upstox.com/v3/historical-candle/intraday/${enc}/minutes/5`]
    : [`https://api.upstox.com/v3/historical-candle/${enc}/minutes/5/${toDate}/${fromDate}`,
       `https://api.upstox.com/v3/historical-candle/intraday/${enc}/minutes/5`];
  let rows = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${upstoxToken}`, Accept: 'application/json' } });
      if (!r.ok) continue;
      const d = await r.json();
      rows = rows.concat(d?.data?.candles || []);
    } catch (_) { /* try next */ }
  }
  // [ts, o, h, l, c, v, oi] newest-first -> oldest-first, de-duplicated
  const seen = new Set();
  const asc = rows.filter((c) => !seen.has(c[0]) && seen.add(c[0])).sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  candleCache.set(ck, asc);
  await new Promise((res) => setTimeout(res, 120)); // stay well inside Upstox rate limits
  return asc;
}

// Walks the candles with evaluateSignalExit so partial targets, break-even and trailing stops behave
// exactly as in live monitoring. Returns { state, closed }.
function replayCandles(sig, candles) {
  let state = sig;
  const isBuy = isBullSignal(sig);
  const startAt = entryEpoch(sig);
  for (const c of candles) {
    const start = Date.parse(c[0]);
    if (!Number.isFinite(start) || start < startAt) continue;   // skip the candle the signal was born in
    const hi = +c[2], lo = +c[3];
    if (!(hi > 0) || !(lo > 0)) continue;
    const d = istDate(start), t = istTime(start + 5 * 60000);
    const feed = (price) => {
      const r = evaluateSignalExit(state, price, d, t, {});
      if (!r) return null;
      state = { ...state, ...r };
      return r.status ? r : null;
    };
    const adverse = isBuy ? lo : hi;
    const effSL = state.trailSL != null ? state.trailSL : state.sl;
    const stopHit = effSL > 0 && (isBuy ? adverse <= effSL : adverse >= effSL);
    if (feed(stopHit ? effSL : adverse)) return { state, closed: true };      // exit at the stop level, not the wick
    const fav = isBuy ? hi : lo;
    // Every target level, nearest first (T1, T2, T3 and the single `target` of older signals).
    const levels = [...new Set([state.targetT1, state.targetT2, state.targetT3, state.target].filter((v) => v > 0))]
      .sort((a, b) => (isBuy ? a - b : b - a));
    for (const lvl of levels) {
      if (isBuy ? fav >= lvl : fav <= lvl) { if (feed(lvl)) return { state, closed: true }; }
    }
  }
  return { state, closed: false };
}

// Shared by real and shadow signals: candle replay first, then the live price (time stops, expiry,
// anything the candles did not decide).
async function resolveSignals(signals, today, now, quotes, { notify, tag, uid }) {
  let changed = false;
  const fromDateFor = (s) => (s.date < today ? s.date : today);
  const out = [];
  for (const s of signals) {
    if (s.status !== 'OPEN') { out.push(s); continue; }
    const key = s.instrKey || s.key;
    let state = s;
    let result = null;
    if (key && !(s.type === 'OPTION' && s.expiry && today > s.expiry)) {
      const candles = await fetchCandles5m(key, fromDateFor(s), today);
      if (candles.length) {
        const rp = replayCandles(s, candles);
        state = rp.state;
        if (rp.closed) result = state;
      }
    }
    if (!result) {
      const ltp = quotes[key]?.last_price ?? null;
      if (ltp || (s.type === 'OPTION' && s.expiry && today > s.expiry)) {
        const r = evaluateSignalExit(state, ltp ?? s.entry, today, now, {});
        if (r) { state = { ...state, ...r }; if (r.status) result = state; }
      }
    }
    if (state !== s) {
      changed = true;
      console.log(`[${uid}] ${tag}${state.status && state.status !== 'OPEN' ? state.status : 'update'}: ${s.stock || s.sym}`);
      if (notify && state.status && state.status !== 'OPEN') await notifyClosed(s, state);
    }
    out.push(state);
  }
  return { updated: out, changed };
}

async function processUser(uid, today, now) {
  const folder = `signal-logs/${uid}`;
  const index = await ghGet(`${folder}/index.json`);
  if (!index) { console.log(`[${uid}] No signal index yet`); return; }
  let dates, dailyStats;
  try {
    ({ dates, dailyStats } = JSON.parse(Buffer.from(index.content, 'base64').toString('utf8')));
  } catch (e) {
    console.warn(`[${uid}] index.json is corrupt/empty (${e.message}) — skipping this user for this run`);
    return;
  }
  const openDates = (dates || []).filter((d) => (dailyStats?.[d]?.open || 0) > 0);
  if (!openDates.length) { console.log(`[${uid}] No open signals`); return; }

  for (const date of openDates) {
    const file = await ghGet(`${folder}/${date}.json`);
    if (!file) continue;
    let wrapper;
    try {
      wrapper = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    } catch (e) {
      console.warn(`[${uid}] ${date}.json is corrupt/empty (${e.message}) — skipping this file, not the whole run`);
      continue;
    }
    const signals = wrapper.signals || [];
    const open = signals.filter((s) => s.status === 'OPEN');
    if (!open.length) continue;

    const keys = [...new Set(open.map((s) => s.instrKey || s.key).filter(Boolean))];
    const quotes = await fetchQuotes(keys);

    const { updated, changed } = await resolveSignals(signals, today, now, quotes, { notify: true, tag: '', uid });

    if (changed) {
      const payload = { signals: updated, lastUpdated: new Date().toISOString(), date, stats: computeLogStats(updated) };
      await ghPut(`${folder}/${date}.json`, payload, file.sha);
    }
  }
}


// Shadow signals (picks the gate rejected) — resolved with the exact same exit
// logic so their outcomes are comparable to real signals. Lives in
// signal-logs/<uid>/shadow/<date>.json, separate from the real log.
async function processShadow(uid, today, now) {
  const folder = await ghGet(`signal-logs/${uid}/shadow`);
  if (!Array.isArray(folder)) return;
  const names = folder.map((i) => i.name).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(-6);
  for (const name of names) {
    const path = `signal-logs/${uid}/shadow/${name}`;
    const file = await ghGet(path);
    if (!file) continue;
    let wrapper;
    try { wrapper = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')); } catch (e) { continue; }
    const signals = wrapper.signals || [];
    const open = signals.filter((s) => s.status === 'OPEN');
    if (!open.length) continue;
    const keys = [...new Set(open.map((s) => s.instrKey || s.key).filter(Boolean))];
    const quotes = await fetchQuotes(keys);
    const { updated, changed } = await resolveSignals(signals, today, now, quotes, { notify: false, tag: 'shadow ', uid });
    if (changed) await ghPut(path, { ...wrapper, signals: updated, lastUpdated: new Date().toISOString() }, file.sha);
  }
}

async function main() {
  const missing = [];
  if (!gh.token) missing.push('GH_TOKEN (AI_GH_TOKEN secret)');
  if (!gh.user) missing.push('GH_USER (AI_GH_USER secret)');
  if (!gh.repo) missing.push('GH_REPO (AI_GH_REPO secret)');
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
  for (const uid of uids) {
    try { await processUser(uid, today, now); await processShadow(uid, today, now); }
    catch (e) { console.error(`[${uid}] processUser failed: ${e.message} — continuing with other users`); }
  }
  // Record option-chain snapshots (OI / IV / bid-ask) for future model training.
  // Isolated: a failure here must never affect signal monitoring.
  try { await snapshotChains({ gh, upstoxToken, today, nowStr: now }); }
  catch (e) { console.warn('chain snapshot failed (ignored): ' + e.message); }
}

main().catch((e) => { console.error(e); process.exit(1); });

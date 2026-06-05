// ── GitHub API service ── exact port from HTML ──

// ── userId helper — sanitised same as HTML ──
function _uid() {
  return (localStorage.getItem('friday_user_id') || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Settings path — MATCHES HTML exactly ──
// HTML: user-settings/{safe_userId}.json
function getSettingsFilePath() {
  return `user-settings/${_uid()}.json`;
}

// ── Signal log paths — MATCHES HTML exactly ──
function getLogFolder()      { return `signal-logs/${_uid()}`; }
function getLogDayPath(date) { return `${getLogFolder()}/${date}.json`; }
function getLogIndexPath()   { return `${getLogFolder()}/index.json`; }

// ── Base GitHub fetch ──
async function _ghFetch(gh, path) {
  if (!gh.token || !gh.user || !gh.repo) return null;
  try {
    const r = await fetch(
      `https://api.github.com/repos/${gh.user}/${gh.repo}/contents/${path}`,
      { headers: { Authorization: 'token ' + gh.token, Accept: 'application/vnd.github.v3+json' } }
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  } catch (e) { return null; }
}

// ── Base GitHub PUT ──
async function _ghPut(gh, path, content, sha, message) {
  if (!gh.token || !gh.user || !gh.repo) return null;
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 2))));
  const body = { message, content: encoded };
  if (sha) body.sha = sha;
  return fetch(
    `https://api.github.com/repos/${gh.user}/${gh.repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: 'token ' + gh.token,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
}

// ── Decode GitHub content (handles both escape styles) ──
function _decode(content) {
  try { return JSON.parse(decodeURIComponent(escape(atob(content.replace(/[\r\n\s]/g, ''))))); }
  catch (e) { return JSON.parse(atob(content.replace(/\n/g, ''))); }
}

// ══════════════════════════════════════════════════════════
// SETTINGS — user-settings/{safe_userId}.json
// Payload: { settings: CFG, upstoxId, savedAt, version }
// Matches HTML exactly
// ══════════════════════════════════════════════════════════

export async function pushSettingsToGH(gh, cfg) {
  if (!gh.token || !gh.user || !gh.repo) return false;
  try {
    const path = getSettingsFilePath();
    const existing = await _ghFetch(gh, path);
    const sha = existing?.sha || null;
    // Build payload — exact same structure as HTML
    const settingsPayload = { ...cfg };
    delete settingsPayload._token; // never store token in GitHub
    const payload = {
      settings: settingsPayload,
      upstoxId: localStorage.getItem('friday_user_id') || 'unknown',
      savedAt:  new Date().toISOString(),
      version:  'v4',
    };
    const r = await _ghPut(gh, path, payload, sha, 'FRIDAY settings sync');
    return r?.ok ?? false;
  } catch (e) { return false; }
}

export async function pullSettingsFromGH(gh) {
  if (!gh.token || !gh.user || !gh.repo) return null;
  try {
    const d = await _ghFetch(gh, getSettingsFilePath());
    if (!d) return null;
    const payload = _decode(d.content);
    if (!payload?.settings) return null;
    return payload.settings; // return just the settings object (same as HTML)
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════
// SIGNAL LOG — signal-logs/{userId}/YYYY-MM-DD.json
// ══════════════════════════════════════════════════════════

// In-memory day cache: date → { signals, sha, loadedAt }
const _ghDayCache = {};
function _cachePut(date, signals, sha) { _ghDayCache[date] = { signals, sha, loadedAt: Date.now() }; }
function _cacheGet(date, maxAgeMs = 90000) {
  const c = _ghDayCache[date];
  if (!c || Date.now() - c.loadedAt > maxAgeMs) return null;
  return c;
}

export async function ghReadDay(gh, date) {
  const cached = _cacheGet(date);
  if (cached) return { signals: cached.signals, sha: cached.sha };
  const d = await _ghFetch(gh, getLogDayPath(date));
  if (!d) return { signals: [], sha: null };
  try {
    const content = _decode(d.content);
    const signals = content.signals || [];
    _cachePut(date, signals, d.sha);
    return { signals, sha: d.sha };
  } catch (e) { return { signals: [], sha: null }; }
}

function computeLogStats(signals = []) {
  const hits = signals.filter((s) => s.status === 'TARGET_HIT').length;
  const sls = signals.filter((s) => s.status === 'SL_HIT').length;
  const open = signals.filter((s) => s.status === 'OPEN').length;
  const closed = hits + sls;
  return {
    total: signals.length,
    hits,
    sls,
    open,
    winRate: closed ? Math.round(hits / closed * 100) : null,
  };
}

export async function ghWriteDay(gh, signals, sha, date, retryCount = 0) {
  const payload = {
    signals,
    lastUpdated: new Date().toISOString(),
    upstoxId:    _uid(),
    date,
    stats:       computeLogStats(signals),
  };
  let r = await _ghPut(gh, getLogDayPath(date), payload, sha, `FRIDAY signal log · ${_uid()} · ${date}`);
  if (r?.ok) {
    const rd = await r.json();
    const newSha = rd?.content?.sha || sha;
    _cachePut(date, signals, newSha);
    return newSha;
  }

  if (r && (r.status === 409 || r.status === 422) && retryCount < 2) {
    const fresh = await _ghFetch(gh, getLogDayPath(date));
    if (!fresh) {
      return ghWriteDay(gh, signals, null, date, retryCount + 1);
    }

    let freshSignals = [];
    try {
      freshSignals = _decode(fresh.content).signals || [];
    } catch (e) {
      freshSignals = [];
    }

    const existingIds = new Set(freshSignals.map((s) => s.id));
    const merged = freshSignals.map((sig) => {
      const ours = signals.find((item) => item.id === sig.id);
      return (ours && ours.status !== 'OPEN' && sig.status === 'OPEN') ? ours : sig;
    });
    merged.push(...signals.filter((sig) => !existingIds.has(sig.id)));
    return ghWriteDay(gh, merged, fresh.sha || null, date, retryCount + 1);
  }

  return null;
}

export async function ghReadIndex(gh) {
  const d = await _ghFetch(gh, getLogIndexPath());
  if (!d) return { dates: [], dailyStats: {}, sha: null };
  try {
    const content = _decode(d.content);
    return { dates: content.dates || [], dailyStats: content.dailyStats || {}, sha: d.sha };
  } catch (e) { return { dates: [], dailyStats: {}, sha: null }; }
}

export async function ghUpdateIndex(gh, date, stats) {
  const { dates, dailyStats, sha } = await ghReadIndex(gh);
  const newDates   = dates.includes(date) ? dates : [...dates, date].sort();
  const pruned     = newDates.slice(-90);
  const newStats   = { ...dailyStats, [date]: stats };
  for (const d of Object.keys(newStats)) { if (!pruned.includes(d)) delete newStats[d]; }
  await _ghPut(gh, getLogIndexPath(), {
    dates: pruned, dailyStats: newStats,
    lastUpdated: new Date().toISOString(), upstoxId: _uid(),
  }, sha, `FRIDAY index · ${_uid()}`);
}

export async function ghReadMultipleDays(gh, maxDays = 30) {
  const { dates } = await ghReadIndex(gh);
  if (!dates.length) return [];
  const toFetch = dates.slice(-maxDays);
  const all = [];
  for (let i = 0; i < toFetch.length; i += 5) {
    const batch = toFetch.slice(i, i + 5);
    const res = await Promise.allSettled(batch.map((d) => ghReadDay(gh, d)));
    for (const r of res) { if (r.status === 'fulfilled') all.push(...r.value.signals); }
  }
  return all;
}

// ══════════════════════════════════════════════════════════════
// SIGNAL BUILDERS — EXACT port from HTML
// ══════════════════════════════════════════════════════════════

function _istNow() {
  const d = new Date();
  return {
    date: d.toLocaleDateString('en-CA',    { timeZone: 'Asia/Kolkata' }),
    time: d.toLocaleTimeString('en-IN',    { timeZone: 'Asia/Kolkata', hour12: false }),
  };
}

export function buildStockSignal(p, vixVal) {
  const { date, time } = _istNow();
  const rec = (p.rec || '').toUpperCase();
  const holdDays = rec.includes('STRONG') ? 5 : rec === 'BUY' || rec === 'SELL' ? 3 : rec === 'MODERATE' ? 2 : 1;
  return {
    id:             `${date}-${time.replace(/:/g,'').slice(0,4)}-${p.s}-STOCK`,
    date, time,
    type:           'STOCK',
    stock:          p.s,
    instrKey:       p.key || null,
    name:           p.n,
    signal:         p.rec,
    confidence:     p.conf,
    strength:       p.strength || '',
    numInds:        p.numInds  || 0,
    entry:          +p.ltp.toFixed(2),
    sl:             +p.sl.toFixed(2),
    target:         +(p.target || p.pot?.mod || 0).toFixed(2),
    targetCons:     +(p.pot?.cons || 0).toFixed(2),
    targetMod:      +(p.pot?.mod  || 0).toFixed(2),
    targetAgg:      +(p.pot?.agg  || 0).toFixed(2),
    rr:             p.pot?.rr || 0,
    winRateEst:     p.pot?.wr || 0,
    risk:           p.risk || 0,
    rsi:            p.rsi  || null,
    vix:            vixVal || null,
    reversal:       p.reversal?.type || 'NONE',
    trigger:        p.entryTrigger?.trigger || p.ltp,
    triggerMethod:  p.entryTrigger?.method  || 'Market',
    compositeScore: p.compositeScore || null,
    status:         'OPEN',
    holdDays,
    exitPrice: null, exitTime: null, exitDate: null, pnlPct: null, note: '',
  };
}

export function buildOptionSignal(p, vixVal) {
  const { date, time } = _istNow();
  const instrKey = p.instrKey || p.key || p.instrument_key || p.instrumentKey || null;
  return {
    id:             `${date}-${time.replace(/:/g,'').slice(0,4)}-${p.und}-${p.strike}-${p.type}`,
    date, time,
    type:           'OPTION',
    stock:          p.und,
    instrKey,
    key:            instrKey,
    name:           `${p.und} ${p.strike} ${p.type}`,
    optType:        p.type,
    strike:         p.strike,
    expiry:         p.expiry,
    signal:         p.action === 'BUY' ? (p.type === 'CE' ? 'CALL' : 'PUT') : p.action,
    confidence:     p.confidence || 0,
    entry:          +p.entry.toFixed(2),
    sl:             +p.sl.toFixed(2),
    target:         +(p.tgt || 0).toFixed(2),
    rr:             p.rr || 0,
    lot:            p.lot  || 0,
    iv:             p.iv   || 0,
    delta:          p.delta || 0,
    theta:          p.theta || 0,
    vix:            vixVal || null,
    compositeScore: p.compositeScore || null,
    priceZone:      p.priceZone || '',
    oiBuildType:    p.oiBuildType || '',
    trendAligned:   p.trendAligned || false,
    status:         'OPEN',
    holdDays:       1,
    exitPrice:      null, 
    exitTime:       null, 
    exitDate:       null, 
    pnlPct:         null, 
    note:           '',
  };
}

// ── logSignals — auto-log after each scan (port from HTML logSignals) ──
function signalChangedSignificantly(existing, newSig) {
  const pctDiff = (a, b) => a && b ? Math.abs((a - b) / a * 100) : 0;
  return pctDiff(existing.entry, newSig.entry) > 1 ||
         pctDiff(existing.sl,    newSig.sl)    > 1 ||
         pctDiff(existing.target, newSig.target) > 1;
}

export async function logSignals(gh, newSignals, vixVal, lg = () => {}) {
  if (!gh.token || !gh.user || !gh.repo) { lg('Signal log: GitHub not configured', 'w'); return; }
  if (!newSignals?.length) return;
  try {
    const istDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const { signals, sha } = await ghReadDay(gh, istDate);
    let added = 0, skipped = 0;
    for (const ns of newSignals) {
      const existing = signals.filter(s =>
        s.date === istDate && s.status === 'OPEN' &&
        (s.type === 'STOCK'
          ? s.stock === ns.stock && s.type === 'STOCK'
          : s.stock === ns.stock && s.strike === ns.strike && s.optType === (ns.optType || ns.type))
      ).sort((a, b) => b.time.localeCompare(a.time))[0];
      if (existing && !signalChangedSignificantly(existing, ns)) { skipped++; continue; }
      signals.push(ns);
      added++;
    }
    if (!added) { lg(`Signal log: ${skipped} skipped (no change)`, 'o'); return; }
    const newSha = await ghWriteDay(gh, signals, sha, istDate);
    if (newSha) {
      const stats = {
        total: signals.length,
        hits:  signals.filter(s => s.status === 'TARGET_HIT').length,
        sls:   signals.filter(s => s.status === 'SL_HIT').length,
        open:  signals.filter(s => s.status === 'OPEN').length,
        winRate: null,
      };
      const closed = signals.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
      if (closed.length) stats.winRate = Math.round(stats.hits / closed.length * 100);
      ghUpdateIndex(gh, istDate, stats).catch(() => {});
    }
    lg(`Signal log: ✅ +${added} · ${skipped} unchanged`, 'o');
  } catch (e) { lg('logSignals: ' + e.message, 'w'); }
}

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

export async function ghWriteDay(gh, signals, sha, date) {
  const payload = {
    signals,
    lastUpdated: new Date().toISOString(),
    upstoxId:    _uid(),
    date,
  };
  const r = await _ghPut(gh, getLogDayPath(date), payload, sha, `FRIDAY signal log · ${_uid()} · ${date}`);
  if (r?.ok) {
    const rd = await r.json();
    const newSha = rd?.content?.sha || sha;
    _cachePut(date, signals, newSha);
    return newSha;
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

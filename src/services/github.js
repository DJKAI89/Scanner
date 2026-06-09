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
  if (!d) {
    // Cache the "file doesn't exist yet" state briefly (5 s) so concurrent
    // Stocks + Options scans share the same empty baseline instead of both
    // hitting GitHub and racing to create the file simultaneously.
    _cachePut(date, [], null);
    _ghDayCache[date].loadedAt = Date.now() - 85000; // expire in ~5 s (maxAge=90000)
    return { signals: [], sha: null };
  }
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

  if (r && r.status !== 409 && r.status !== 422) {
    // Unexpected failure — log status for debugging
    console.warn(`[FRIDAY] ghWriteDay: GitHub PUT returned HTTP ${r.status} for ${getLogDayPath(date)}`);
  }

  if (r && (r.status === 409 || r.status === 422) && retryCount < 2) {
    await new Promise(res => setTimeout(res, 1200 + Math.random() * 800)); // match HTML sleep
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
  try {
    const { dates, dailyStats, sha } = await ghReadIndex(gh);
    const newDates   = dates.includes(date) ? dates : [...dates, date].sort();
    const pruned     = newDates.slice(-90);
    const newStats   = { ...dailyStats, [date]: stats };
    for (const d of Object.keys(newStats)) { if (!pruned.includes(d)) delete newStats[d]; }
    const r = await _ghPut(gh, getLogIndexPath(), {
      dates: pruned, dailyStats: newStats,
      lastUpdated: new Date().toISOString(), upstoxId: _uid(),
    }, sha, `FRIDAY index · ${_uid()}`);
    if (r && !r.ok) console.warn(`[FRIDAY] ghUpdateIndex: HTTP ${r.status}`);
  } catch (e) { console.warn('[FRIDAY] ghUpdateIndex failed:', e.message); }
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
  // strength label — exact HTML: getSignalStrength(numInds, conf, reversal).label
  const ni = p.numInds || 0, cf = p.conf || 0;
  const revBoost = p.reversal?.type && p.reversal.type !== 'NONE' ? 1 : 0;
  const eff = ni + revBoost;
  const strengthLabel = (eff >= 5 && cf >= 70) ? 'STRONG' : (eff >= 3 || cf >= 55) ? 'MODERATE' : 'WEAK';
  return {
    id:             `${date}-${time.replace(/:/g,'').slice(0,4)}-${p.s}-STOCK`,
    date, time,
    type:           'STOCK',
    stock:          p.s,
    instrKey:       p.key || null,
    name:           p.n,
    signal:         p.rec,
    confidence:     p.conf,
    strength:       strengthLabel,
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
    // SL/Target method labels — exact HTML: from slTargets
    slMethod:       p.slTargets?.consMethod?.includes('R1') || p.slTargets?.consMethod?.includes('R2') ? 'S1 support' : 'ATR+VIX',
    tgtMethod:      p.slTargets?.modMethod || '2:1 R:R',
    compositeScore: p.compositeScore || null,
    momentumScore:  p.momentumScore  ?? null,
    // ── Indicator snapshot — used by adaptWeights to learn which signals predict wins ──
    indicators: {
      macdBull:         p.macdBull              === true,
      macdBullCross:    p.macd?.bullCross        === true,
      macdBearCross:    p.macd?.bearCross        === true,
      bbSqueeze:        p.bb?.squeeze            === true,
      bbNearLower:      p.bb?.nearLowerBand      === true,
      adxBull:          p.adx?.bullTrend         === true,
      adxBear:          p.adx?.bearTrend         === true,
      rsiDiv:           p.rsiDiv?.bullish        === true,
      rsiDivHidden:     p.rsiDiv?.hidden_bullish === true,
      rsiBearDiv:       p.rsiDiv?.bearish        === true,
      a50:              p.a50                    === true,
      a200:             p.a200                   === true,
      nearSupp:         !!p.nearSupp,
      aboveVWAP:        p.aboveVWAP              === true,
      vwapNearLower:    p.vwapBands?.nearLowerBand === true,
      engulfing:        p.patterns?.bullishEngulfing === true,
      hammer:           p.patterns?.hammer       === true,
      morningStar:      p.patterns?.morningStar  === true,
      reversalFired:    (p.reversal?.type || 'NONE') !== 'NONE',
      delivHigh:        (p.delivPct ?? 0) >= 60,
      delivLow:         (p.delivPct ?? 100) <= 25,
      numInds:          p.numInds || 0,
    },
    status:         'OPEN',
    holdDays,
    exitPrice: null, exitTime: null, exitDate: null, pnlPct: null, note: '',
  };
}

export function buildOptionSignal(p, vixVal) {
  const { date, time } = _istNow();
  const instrKey = p.instrKey || p.key || p.instrument_key || p.instrumentKey || null;
  const conf = p.confidence || 0;
  const strengthLabel = conf >= 75 ? 'STRONG' : conf >= 55 ? 'MODERATE' : 'WEAK';
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
    // signal stores the raw action (BUY or SELL) — exact match with HTML
    signal:         p.action,
    action:         p.action,
    confidence:     conf,
    strength:       strengthLabel,
    numInds:        p.score || 0,
    entry:          +p.entry.toFixed(2),
    sl:             +p.sl.toFixed(2),
    target:         +(p.tgt || 0).toFixed(2),
    rr:             p.rr || 0,
    lot:            p.lot  || 0,
    iv:             p.iv   || 0,
    delta:          p.delta || 0,
    theta:          p.theta || 0,
    capitalReq:     p.amtRequired || 0,
    vix:            vixVal || null,
    slTgtMethod:    p.slTgtMethod  || null,
    compositeScore: p.compositeScore  ?? null,
    momentumScore:  p.momentumScore   ?? null,
    emaCross:       p.emaCross        ?? null,
    priceZone:      p.priceZone       || '',
    oiBuildType:    p.oiBuildType     || '',
    trendAligned:   p.trendAligned    || false,
    // ── Indicator snapshot for adaptWeights ──
    indicators: {
      trendAligned:   p.trendAligned    || false,
      emaBull:        p.emaTrendBull    === true,
      emaBearish:     p.emaTrendBull    === false,
      freshCross:     p.emaCross === 'bullish_cross' || p.emaCross === 'bearish_cross',
      momentumFresh:  p.momentumFresh   || false,
      volSpike:       (p.volRatio ?? 0) >= 1.5,
      lowVol:         (p.volRatio ?? 1) < 0.7,
      nearPDH:        p.priceZone === 'PDH_BREAK' || p.priceZone === 'NEAR_PDH',
      nearPDL:        p.priceZone === 'PDL_BREAK' || p.priceZone === 'NEAR_PDL',
      oiBuildUp:      p.oiBuildType === 'CE_BUILD' || p.oiBuildType === 'PE_BUILD',
      compositeHigh:  Math.abs(p.compositeScore ?? 0) >= 2,
      compositeMed:   Math.abs(p.compositeScore ?? 0) >= 1,
      atm:            p.atm             || false,
    },
    status:         'OPEN',
    holdDays:       1,
    exitPrice:      null,
    exitTime:       null,
    exitDate:       null,
    pnlPct:         null,
    note:           '',
  };
}

// ── One-time migration from legacy single file → daily files (exact HTML port) ──
export async function ghMigrateIfNeeded(gh, lg = () => {}) {
  if (!gh.token || !gh.user || !gh.repo) return;
  const migKey = `friday_log_migrated_v2_${_uid()}`;
  if (localStorage.getItem(migKey)) return; // already done
  try {
    const legacyPath = `signal-logs/${_uid()}.json`;
    const d = await _ghFetch(gh, legacyPath);
    if (!d) { localStorage.setItem(migKey, '1'); return; } // no legacy file
    lg('📦 Migrating legacy signal log to daily files...', 'o');
    const content = _decode(d.content);
    const signals = content.signals || [];
    if (!signals.length) { localStorage.setItem(migKey, '1'); return; }
    // Group by date
    const byDate = {};
    for (const sig of signals) {
      if (!sig.date) continue;
      if (!byDate[sig.date]) byDate[sig.date] = [];
      byDate[sig.date].push(sig);
    }
    let written = 0;
    for (const [date, daySigs] of Object.entries(byDate)) {
      const { sha } = await ghReadDay(gh, date);
      const newSha = await ghWriteDay(gh, daySigs, sha, date);
      if (newSha) {
        await ghUpdateIndex(gh, date, computeLogStats(daySigs));
        written++;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    localStorage.setItem(migKey, '1');
    lg(`✅ Migration complete: ${written} day files from ${signals.length} signals`, 'o');
  } catch (e) { lg('ghMigrateIfNeeded: ' + e.message, 'w'); }
}

// ── isBullSignal — exact HTML port + legacy CALL/PUT backwards compat ──
export function isBullSignal(sig) {
  // Handle legacy React values where BUY CE was stored as 'CALL', BUY PE as 'PUT'
  if (sig.signal === 'CALL' || sig.signal === 'PUT') return true;
  return sig.signal !== 'SELL';
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
      lg(`Signal log: ✅ +${added} saved · ${skipped} unchanged`, 'o');
    } else {
      lg(`Signal log: ⚠ GitHub write failed — ${added} signals NOT saved. Check repo/token in ⚙ Settings`, 'w');
    }
  } catch (e) { lg('logSignals: ' + e.message, 'w'); }
}

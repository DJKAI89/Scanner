// ── Multi-timeframe (top-down) analysis ──────────────────────────────────────
// How discretionary traders actually use timeframes:
//   weekly + daily  → direction and WHERE price is (key levels, room to run)
//   60-min          → is the move in a pullback or being rejected?
//   15-min (5-min)  → entry timing
//   A conflict between the higher timeframes and the trade direction = skip, not
//   "a few points off". Targets must have room before the next higher-timeframe level.
//
// Pure analysis (analyzeTimeframe / keyLevels / gradeMtf) is separate from fetching so it
// can be tested without the network. Fetching is cached per instrument and timeframe.
//
// Missing data NEVER blocks a trade: with fewer timeframes available the grade is
// computed on what exists (partial=true), and with nothing usable getMtf returns null
// so callers behave exactly as before.

import { fetchCandles, fetchCandlesV3, fetchIntradayV3 } from './api';

export const MTF_DEFAULTS = {
  // Per-timeframe weights: [agree, against]
  weights: { w: [1.5, -2.0], d: [2.0, -3.0], h1: [1.5, -2.0], m15: [1.0, -1.5], m5: [0.5, -0.5] },
  gradeA: 4.5,
  gradeB: 2.5,
  roomCapCATR: 0.5,    // pressed this close under/over a STRUCTURAL level → grade capped at C
  roomCapBATR: 1.0,    // less than this → cap at B
  roomGoodATR: 1.5,    // A-grade needs at least this (or no known level)
  adj: { A: 6, B: 2, C: -6 },
  minLevelGapPct: 0.15,
  clusterPct: 0.3,
};

// Never more than MAX_CONC history requests in flight, spaced SPACING_MS apart. A first scan can need
// 60-140 calls; without this they fire in bursts and trip Upstox's rate limit (HTTP 429).
const MAX_CONC = 4, SPACING_MS = 120;
let _active = 0;
const _queue = [];
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function limited(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      _active++;
      try { await _sleep(SPACING_MS); resolve(await fn()); }
      catch (e) { reject(e); }
      finally { _active--; const next = _queue.shift(); if (next) next(); }
    };
    if (_active < MAX_CONC) run(); else _queue.push(run);
  });
}

const TTL = { w: 12 * 3600e3, d: 6 * 3600e3, h1: 60 * 60e3, m15: 20 * 60e3, today: 4 * 60e3 };
const _cache = new Map();
async function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn();
  _cache.set(key, { at: Date.now(), v });
  return v;
}
export function clearMtfCache() { _cache.clear(); }

// ── bars ─────────────────────────────────────────────────────
const ts = (c) => Date.parse(c?.[0]);
// Upstox candle → {t,o,h,l,c,v}, oldest-first, de-duplicated by timestamp.
export function toBars(candles) {
  const seen = new Set();
  const out = [];
  for (const c of candles || []) {
    const t = ts(c);
    if (!Number.isFinite(t) || seen.has(t)) continue;
    const o = +c[1], h = +c[2], l = +c[3], cl = +c[4];
    if (!(h > 0) || !(l > 0) || !(cl > 0)) continue;
    seen.add(t);
    out.push({ t, o, h, l, c: cl, v: +c[5] || 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Drop a still-forming bar (its end time is in the future).
export function closedOnly(bars, durMin, nowMs = Date.now()) {
  return bars.filter((b) => b.t + durMin * 60000 <= nowMs);
}

// Drop today's partial DAILY bar so "prior day / prior week / 52w" mean completed periods.
export function dropToday(bars, istDate) {
  const d = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return bars.filter((b) => d(b.t) < istDate);
}

// ── indicators on bars ───────────────────────────────────────
function emaSeries(vals, p) {
  if (vals.length < p) return [];
  const k = 2 / (p + 1);
  let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const out = [e];
  for (let i = p; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
  return out;
}
export function atrOf(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  const last = trs.slice(-period);
  return last.reduce((a, b) => a + b, 0) / last.length;
}

// Fractal pivots: a high (low) that is the highest (lowest) of k bars each side.
export function pivots(bars, k = 3) {
  const highs = [], lows = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(bars[i].h > bars[i - j].h && bars[i].h >= bars[i + j].h)) isH = false;
      if (!(bars[i].l < bars[i - j].l && bars[i].l <= bars[i + j].l)) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) highs.push({ i, price: bars[i].h });
    if (isL) lows.push({ i, price: bars[i].l });
  }
  return { highs, lows };
}

// Trend of one timeframe: EMA alignment confirmed by swing structure.
//   dir  +1 up / -1 down / 0 mixed (EMAs unaligned, or EMAs and structure disagree)
export function analyzeTimeframe(bars, { fast = 20, slow = 50, pivotK = 3 } = {}) {
  if (!bars || bars.length < slow + 5) return { ok: false, dir: 0 };
  const closes = bars.map((b) => b.c);
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  if (!ef.length || !es.length) return { ok: false, dir: 0 };
  const close = closes[closes.length - 1];
  const emaFast = ef[ef.length - 1], emaSlow = es[es.length - 1];
  let emaDir = 0;
  if (close > emaFast && emaFast > emaSlow) emaDir = 1;
  else if (close < emaFast && emaFast < emaSlow) emaDir = -1;

  const { highs, lows } = pivots(bars, pivotK);
  let struct = 0;
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) struct = 1; else if (lh && ll) struct = -1;
  }
  let dir = 0;
  if (emaDir !== 0 && struct !== -emaDir) dir = emaDir;
  return { ok: true, dir, emaDir, struct, close, emaFast, emaSlow };
}

// ── key levels ───────────────────────────────────────────────
// Candidates: weekly/daily/60-min swing pivots, prior day & prior week range, 52-week range.
// Nearby levels are merged (clusterPct) so one zone isn't counted several times.
export function keyLevels({ wBars, dBars, h1Bars }, cfg = MTF_DEFAULTS) {
  const raw = [];
  const add = (price, src, weight) => { if (price > 0) raw.push({ price, src, weight }); };
  if (wBars?.length >= 10) {
    const p = pivots(wBars, 2);
    [...p.highs, ...p.lows].slice(-14).forEach((x) => add(x.price, 'weekly swing', 3));
    const prevW = wBars[wBars.length - 2];
    if (prevW) { add(prevW.h, 'prior week high', 2); add(prevW.l, 'prior week low', 2); }
  }
  if (dBars?.length >= 10) {
    const p = pivots(dBars, 3);
    [...p.highs, ...p.lows].slice(-16).forEach((x) => add(x.price, 'daily swing', 2));
    const prevD = dBars[dBars.length - 1];       // dBars already excludes today's partial bar
    // Tactical, not structural: yesterday's high/low is nearly always within half an ATR of price, so it
    // is shown but (weight < 2) never used to veto a trade for lack of room.
    add(prevD.h, 'prior day high', 1.5); add(prevD.l, 'prior day low', 1.5);
    const yr = dBars.slice(-252);
    // Informational only (weight < 2): a stock AT its 52-week high is a breakout, not 'no room'.
    add(Math.max(...yr.map((b) => b.h)), '52-week high', 1.8);
    add(Math.min(...yr.map((b) => b.l)), '52-week low', 1.8);
  }
  if (h1Bars?.length >= 30) {
    const p = pivots(h1Bars, 3);
    [...p.highs, ...p.lows].slice(-10).forEach((x) => add(x.price, '60-min swing', 1));
  }
  raw.sort((a, b) => a.price - b.price);
  const merged = [];
  for (const lv of raw) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(lv.price - last.price) / last.price * 100 <= cfg.clusterPct) {
      if (lv.weight > last.weight) { last.src = lv.src; last.weight = lv.weight; }
      last.touches = (last.touches || 1) + 1;
      last.price = +((last.price * (last.touches - 1) + lv.price) / last.touches).toFixed(2);
    } else merged.push({ ...lv, touches: 1 });
  }
  return merged;
}

export function nearestLevels(levels, price, cfg = MTF_DEFAULTS) {
  const gap = price * cfg.minLevelGapPct / 100;
  const above = levels.filter((l) => l.price > price + gap).sort((a, b) => a.price - b.price)[0] || null;
  const below = levels.filter((l) => l.price < price - gap).sort((a, b) => b.price - a.price)[0] || null;
  return { resistance: above, support: below };
}

// ── context + grade ──────────────────────────────────────────
// bars = { w, d, h1, m15, m5 } (chronological; d without today's partial bar; h1/m15/m5
// closed bars only). Any may be missing.
export function buildMtfContext(bars, price) {
  const tf = {
    w: bars.w ? analyzeTimeframe(bars.w, { fast: 10, slow: 30, pivotK: 2 }) : { ok: false, dir: 0 },
    d: bars.d ? analyzeTimeframe(bars.d, { fast: 20, slow: 50, pivotK: 3 }) : { ok: false, dir: 0 },
    h1: bars.h1 ? analyzeTimeframe(bars.h1, { fast: 20, slow: 50, pivotK: 3 }) : { ok: false, dir: 0 },
    m15: bars.m15 ? analyzeTimeframe(bars.m15, { fast: 20, slow: 50, pivotK: 3 }) : { ok: false, dir: 0 },
    m5: bars.m5 ? analyzeTimeframe(bars.m5, { fast: 9, slow: 21, pivotK: 3 }) : { ok: false, dir: 0 },
  };
  const usable = ['w', 'd', 'h1', 'm15', 'm5'].filter((k) => tf[k].ok);
  if (!tf.w.ok && !tf.d.ok) return null; // no higher-timeframe view → do not pretend
  const levels = keyLevels({ wBars: bars.w, dBars: bars.d, h1Bars: bars.h1 });
  const atrD = bars.d ? atrOf(bars.d, 14) : null;
  return { tf, usable, levels, atrD, price, partial: usable.length < 4 };
}

const NAMES = { w: 'weekly', d: 'daily', h1: '60-min', m15: '15-min', m5: '5-min' };
const arrow = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : 'mixed');

// Grade a trade in direction dir (+1 long / -1 short).
export function gradeMtf(ctx, dir, cfg = MTF_DEFAULTS) {
  if (!ctx) return null;
  const { tf, levels, atrD, price } = ctx;
  let score = 0;
  const reasons = [];
  const against = [];
  for (const k of ['w', 'd', 'h1', 'm15', 'm5']) {
    if (!tf[k].ok) continue;
    const rel = tf[k].dir * dir;
    const [wa, wg] = cfg.weights[k];
    if (rel > 0) { score += wa; reasons.push(`${NAMES[k]} ${arrow(tf[k].dir)}: agrees`); }
    else if (rel < 0) { score += wg; against.push(k); reasons.push(`${NAMES[k]} ${arrow(tf[k].dir)}: against the trade`); }
    else reasons.push(`${NAMES[k]} mixed`);
  }

  // Room to the next opposing level, measured in daily ATR. Room never VETOES here (a stock pushing
  // into its highs is a breakout, and the scanner does not know the stop); it caps the grade:
  //   structural level (weight >= 3: weekly swing pivots) closer than roomCapCATR  -> capped at C
  //   any significant level (weight >= 2: + daily swings, prior week) closer than roomCapBATR -> capped at B
  // 60-min swings, prior-day levels and the 52-week range are informational only.
  const nearAny = nearestLevels(levels.filter((l) => l.weight >= 2), price, cfg);
  const nearStrong = nearestLevels(levels.filter((l) => l.weight >= 3), price, cfg);
  const opp = dir > 0 ? nearAny.resistance : nearAny.support;
  const oppStrong = dir > 0 ? nearStrong.resistance : nearStrong.support;
  const near = nearAny;
  let roomATR = null, roomStrongATR = null;
  if (opp && atrD > 0) roomATR = +(Math.abs(opp.price - price) / atrD).toFixed(2);
  if (oppStrong && atrD > 0) roomStrongATR = +(Math.abs(oppStrong.price - price) / atrD).toFixed(2);
  if (opp) reasons.push(`next ${dir > 0 ? 'resistance' : 'support'} ${Math.round(opp.price).toLocaleString('en-IN')} (${opp.src})${roomATR != null ? `, ${roomATR} ATR away` : ''}`);

  // Veto rules: higher timeframes outrank the entry timeframe.
  let veto = false, why = null;
  const dAgainst = against.includes('d'), wAgainst = against.includes('w'), hAgainst = against.includes('h1');
  if (dAgainst && (wAgainst || hAgainst)) { veto = true; why = 'Daily trend and another higher timeframe are against this trade'; }
  else if (wAgainst && hAgainst) { veto = true; why = 'Weekly and 60-min trends are against this trade'; }

  let grade;
  if (veto) grade = 'AVOID';
  else if (score >= cfg.gradeA && against.length === 0) grade = 'A';
  else if (score >= cfg.gradeB && !dAgainst) grade = 'B';
  else grade = 'C';
  if (!veto) {
    if (roomATR != null && roomATR < cfg.roomGoodATR && grade === 'A') grade = 'B';
    if (roomATR != null && roomATR < cfg.roomCapBATR && grade === 'A') grade = 'B';
    if (roomStrongATR != null && roomStrongATR < cfg.roomCapCATR && grade !== 'C') {
      grade = 'C';
      why = `Pressed ${roomStrongATR} ATR against ${oppStrong.src} ${Math.round(oppStrong.price).toLocaleString('en-IN')}`;
    }
  }

  return {
    grade, veto, why, score: +score.toFixed(1),
    adj: veto ? 0 : (cfg.adj[grade] ?? 0),
    dirs: `W${arrow(tf.w.dir)[0]} D${arrow(tf.d.dir)[0]} H${arrow(tf.h1.dir)[0]} M15${arrow(tf.m15.dir)[0]}`,
    support: near.support ? Math.round(near.support.price) : null,
    resistance: near.resistance ? Math.round(near.resistance.price) : null,
    roomATR, partial: ctx.partial, reasons,
  };
}

// ── fetching (cached) ────────────────────────────────────────
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const merge = (a, b) => [...(a || []), ...(b || [])];

async function fetchWeekly(key, token, onTokenExpired, today) {
  return cached(`w:${key}`, TTL.w, async () => {
    const from = ymd(Date.now() - 3 * 365 * 86400e3);
    try { const c = await limited(() => fetchCandlesV3(key, 'weeks', 1, from, today, token, onTokenExpired)); if (c.length >= 20) return c; } catch (_) { /* fall back */ }
    return limited(() => fetchCandles(key, from, today, 'week', token, onTokenExpired)).catch(() => []);
  });
}
async function fetchDaily(key, token, onTokenExpired, today) {
  return cached(`d:${key}`, TTL.d, async () => {
    const from = ymd(Date.now() - 2 * 365 * 86400e3);
    try { const c = await limited(() => fetchCandlesV3(key, 'days', 1, from, today, token, onTokenExpired)); if (c.length >= 60) return c; } catch (_) { /* fall back */ }
    return limited(() => fetchCandles(key, from, today, 'day', token, onTokenExpired)).catch(() => []);
  });
}
// 60-min: history (<= 1 quarter per request, stay under it) + today's bars.
async function fetchH1(key, token, onTokenExpired, today) {
  const hist = await cached(`h1:${key}`, TTL.h1, async () => {
    const from = ymd(Date.now() - 85 * 86400e3);
    return limited(() => fetchCandlesV3(key, 'hours', 1, from, today, token, onTokenExpired)).catch(() => []);
  });
  const now = await cached(`h1t:${key}`, TTL.today, () => limited(() => fetchIntradayV3(key, 'hours', 1, token, onTokenExpired)).catch(() => []));
  return merge(hist, now);
}
// 15-min: history (1-15 min requests are capped at 1 month → use 28 days) + today's bars.
async function fetchM15(key, token, onTokenExpired, today) {
  const hist = await cached(`m15:${key}`, TTL.m15, async () => {
    const from = ymd(Date.now() - 28 * 86400e3);
    return limited(() => fetchCandlesV3(key, 'minutes', 15, from, today, token, onTokenExpired)).catch(() => []);
  });
  const now = await cached(`m15t:${key}`, TTL.today, () => limited(() => fetchIntradayV3(key, 'minutes', 15, token, onTokenExpired)).catch(() => []));
  return merge(hist, now);
}

// Load everything for one instrument and return the context (or null).
//   opts.daily / opts.weekly : candles the caller already has (saves calls)
//   opts.m5                  : today's 5-min candles the caller already has
export async function getMtf({ key, price, token, onTokenExpired, daily, weekly, m5, lg = () => {} }) {
  if (!key || !(price > 0)) return null;
  const today = ymd(Date.now());
  try {
    const [w, d, h1, m15] = await Promise.all([
      weekly?.length >= 100 ? weekly : fetchWeekly(key, token, onTokenExpired, today),
      daily?.length >= 150 ? daily : fetchDaily(key, token, onTokenExpired, today),
      fetchH1(key, token, onTokenExpired, today),
      fetchM15(key, token, onTokenExpired, today),
    ]);
    const bars = {
      w: toBars(w),
      d: dropToday(toBars(d), today),
      h1: closedOnly(toBars(h1), 60),
      m15: closedOnly(toBars(m15), 15),
      m5: m5?.length ? closedOnly(toBars(m5), 5) : null,
    };
    const ctx = buildMtfContext(bars, price);
    if (!ctx) lg(`MTF ${key}: no usable weekly/daily history (weekly ${bars.w.length} bars, daily ${bars.d.length} bars)`, 'w');
    return ctx;
  } catch (e) { lg(`MTF ${key}: ${e.message}`, 'w'); return null; }
}

// ── For screens ──────────────────────────────────────────────
const TF_LABEL = { w: 'Weekly', d: 'Daily', h1: '60-min', m15: '15-min', m5: '5-min' };
const TF_RULE = { w: 'EMA10 / EMA30', d: 'EMA20 / EMA50', h1: 'EMA20 / EMA50', m15: 'EMA20 / EMA50', m5: 'EMA9 / EMA21' };

// Everything a panel needs, from a context.
export function describeMtf(ctx) {
  if (!ctx) return null;
  const rows = ['w', 'd', 'h1', 'm15', 'm5'].map((k) => {
    const t = ctx.tf[k];
    return {
      key: k, label: TF_LABEL[k], rule: TF_RULE[k], ok: !!t.ok,
      dir: t.ok ? t.dir : null,
      state: !t.ok ? 'no data' : t.dir > 0 ? 'Uptrend' : t.dir < 0 ? 'Downtrend' : 'Mixed',
      emaFast: t.ok ? +t.emaFast.toFixed(2) : null, emaSlow: t.ok ? +t.emaSlow.toFixed(2) : null,
      structure: !t.ok ? null : t.struct > 0 ? 'higher highs / lows' : t.struct < 0 ? 'lower highs / lows' : 'no clear structure',
    };
  });
  const lv = ctx.levels.filter((l) => l.weight >= 1.5);
  const above = lv.filter((l) => l.price > ctx.price).sort((a, b) => a.price - b.price).slice(0, 3);
  const below = lv.filter((l) => l.price < ctx.price).sort((a, b) => b.price - a.price).slice(0, 3);
  const withDist = (l) => ({ price: Math.round(l.price), src: l.src, atr: ctx.atrD > 0 ? +(Math.abs(l.price - ctx.price) / ctx.atrD).toFixed(2) : null });
  return {
    rows, price: ctx.price, atrD: ctx.atrD ? +ctx.atrD.toFixed(2) : null, partial: ctx.partial,
    above: above.map(withDist), below: below.map(withDist),
    long: gradeMtf(ctx, 1), short: gradeMtf(ctx, -1),
  };
}

// Live self-test: fetch each timeframe for one instrument (bypassing the cache) and report what came
// back. This is the "is multi-timeframe really working with MY token" check on the Settings page.
export async function mtfDiagnostics({ key, price, token, onTokenExpired }) {
  const today = ymd(Date.now());
  const steps = [];
  const bars = {};
  const run = async (tf, label, fn, durMin) => {
    const t0 = Date.now();
    try {
      const { candles, source } = await fn();
      let b = toBars(candles);
      if (tf === 'd') b = dropToday(b, today);
      if (durMin) b = closedOnly(b, durMin);
      bars[tf] = b;
      steps.push({ tf, label, ok: b.length >= 20, source, bars: b.length,
        from: b.length ? new Date(b[0].t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null,
        to: b.length ? new Date(b[b.length - 1].t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : null,
        ms: Date.now() - t0, error: b.length >= 20 ? null : `only ${b.length} bars` });
    } catch (e) { steps.push({ tf, label, ok: false, source: '-', bars: 0, ms: Date.now() - t0, error: e.message }); }
  };
  const v3orV2 = async (v3, v2) => {
    try { const c = await v3(); if (c.length >= 20) return { candles: c, source: 'V3' }; } catch (_) { /* try v2 */ }
    return { candles: await v2(), source: 'v2 fallback' };
  };
  await run('w', 'Weekly', () => v3orV2(
    () => fetchCandlesV3(key, 'weeks', 1, ymd(Date.now() - 3 * 365 * 86400e3), today, token, onTokenExpired),
    () => fetchCandles(key, ymd(Date.now() - 3 * 365 * 86400e3), today, 'week', token, onTokenExpired)));
  await run('d', 'Daily', () => v3orV2(
    () => fetchCandlesV3(key, 'days', 1, ymd(Date.now() - 2 * 365 * 86400e3), today, token, onTokenExpired),
    () => fetchCandles(key, ymd(Date.now() - 2 * 365 * 86400e3), today, 'day', token, onTokenExpired)));
  await run('h1', '60-min', async () => ({ candles: merge(
    await fetchCandlesV3(key, 'hours', 1, ymd(Date.now() - 85 * 86400e3), today, token, onTokenExpired),
    await fetchIntradayV3(key, 'hours', 1, token, onTokenExpired).catch(() => [])), source: 'V3' }), 60);
  await run('m15', '15-min', async () => ({ candles: merge(
    await fetchCandlesV3(key, 'minutes', 15, ymd(Date.now() - 28 * 86400e3), today, token, onTokenExpired),
    await fetchIntradayV3(key, 'minutes', 15, token, onTokenExpired).catch(() => [])), source: 'V3' }), 15);
  const ctx = buildMtfContext(bars, price);
  return { steps, ok: steps.every((s) => s.ok), ctx, summary: describeMtf(ctx) };
}

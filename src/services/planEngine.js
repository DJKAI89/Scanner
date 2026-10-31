// ── Today's Plan engine (pure functions, no I/O) ─────────────────────────────
// Top-down: (1) market view for the day → (2) three named setups, each with an
// explicit trigger / invalidation / targets → (3) one option contract per plan with
// the stop DERIVED from the index invalidation level (not a flat % of premium) →
// (4) size from the risk rule → (5) day-level guardrails (trade cap, daily loss
// limit, one idea per direction).
//
// Index options only in v1. Every threshold is in PLAN_DEFAULTS so it can be tuned
// from evidence (the setup scorecard) instead of by feel.

import { toChronological } from './technical.js';
import { calculatePositionSize } from './tradeManagement.js';

export const PLAN_DEFAULTS = {
  maxTrades: 3,
  dailyLossR: 2,
  orMinutes: 30,                 // opening range = first 30 minutes (9:15–9:45)
  orbFromMin: 10 * 60 + 15,      // no entries before 10:15 IST
  noNewAfterMin: 14 * 60 + 15,   // no fresh entries after 14:15 IST (theta + closing noise)
  vixNoTrade: 24,                // VIX at/above → stand aside
  biasMinScore: 2.5,
  minDte: 1,
  maxStopPremiumPct: 45,         // implied option stop wider than this → skip
  minStopPremiumPct: 12,         // tighter than this is just noise → floor it here
  scorecardMinSample: 20,
};

export const SETUP_LABELS = {
  TREND_PULLBACK: 'Trend pullback to VWAP',
  ORB: 'Opening range breakout',
  OI_WALL: 'OI wall rejection',
};

const pad = (n) => String(n).padStart(2, '0');
export const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const r2 = (n) => +(+n).toFixed(2);

function emaLast(vals, p) {
  if (!vals || vals.length < p) return null;
  const k = 2 / (p + 1);
  let e = vals.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}

// Minute-of-day (IST) from an Upstox candle timestamp like 2026-10-30T09:15:00+05:30
export function candleMinute(c) {
  const m = /T(\d{2}):(\d{2})/.exec(String(c?.[0] ?? ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

// ── 1a. Daily trend ──────────────────────────────────────────
export function dailyTrend(dailyIn) {
  const candles = toChronological(dailyIn || []);
  const closes = candles.map((c) => +c[4]).filter((v) => v > 0);
  if (closes.length < 55) return { ok: false, dir: 0, reasons: ['Not enough daily history to judge the trend'] };
  const close = closes[closes.length - 1];
  const ema20 = emaLast(closes, 20), ema50 = emaLast(closes, 50);
  let dir = 0;
  if (close > ema20 && ema20 > ema50) dir = 1;
  else if (close < ema20 && ema20 < ema50) dir = -1;
  const reasons = [];
  reasons.push(dir === 1 ? 'Daily trend up: price above EMA20, EMA20 above EMA50'
    : dir === -1 ? 'Daily trend down: price below EMA20, EMA20 below EMA50'
    : 'Daily trend mixed: price and EMAs not aligned');
  return { ok: true, dir, close, ema20: r2(ema20), ema50: r2(ema50), reasons };
}

// ── 1b. Intraday state (only CLOSED 5-min candles) ───────────
export function intradayState(candlesIn, nowMin, cfg = PLAN_DEFAULTS) {
  const all = toChronological(candlesIn || []).filter((c) => candleMinute(c) != null);
  const closed = all.filter((c) => candleMinute(c) + 5 <= nowMin);
  if (closed.length < 3) return { ok: false, closed };
  const orEnd = 9 * 60 + 15 + cfg.orMinutes;
  const orC = closed.filter((c) => candleMinute(c) < orEnd);
  const orDone = nowMin >= orEnd && orC.length >= Math.floor(cfg.orMinutes / 5) - 1;
  const orHigh = Math.max(...orC.map((c) => +c[2]));
  const orLow = Math.min(...orC.map((c) => +c[3]));
  let pv = 0, vol = 0, tp = 0;
  for (const c of closed) {
    const t = (+c[2] + +c[3] + +c[4]) / 3;
    pv += t * (+c[5] || 0); vol += (+c[5] || 0); tp += t;
  }
  // Index candles often carry no volume → fall back to the day's average typical price.
  const vwap = vol > 0 ? pv / vol : tp / closed.length;
  const last = closed[closed.length - 1];
  return {
    ok: true, closed, orDone, orHigh, orLow, orMid: (orHigh + orLow) / 2, orRange: orHigh - orLow,
    vwap, vwapKind: vol > 0 ? 'VWAP' : 'avg price',
    last: { o: +last[1], h: +last[2], l: +last[3], c: +last[4], min: candleMinute(last) },
    recent: closed.slice(-6).map((c) => ({ o: +c[1], h: +c[2], l: +c[3], c: +c[4] })),
    nowMin,
  };
}

// ── 1c. Market view ──────────────────────────────────────────
export function marketView({ daily, intra, summary, vix, dayChgPct = 0, nowMin, cfg = PLAN_DEFAULTS }) {
  const reasons = [];
  const blockers = [];
  let score = 0;

  const dt = dailyTrend(daily);
  reasons.push(...dt.reasons);
  if (dt.ok) score += dt.dir * 2;
  else blockers.push(dt.reasons[0]);

  if (!intra?.ok) blockers.push('Not enough intraday candles yet');
  else {
    if (intra.last.c > intra.vwap) { score += 1; reasons.push(`Holding above ${intra.vwapKind} ${Math.round(intra.vwap).toLocaleString('en-IN')}`); }
    else if (intra.last.c < intra.vwap) { score -= 1; reasons.push(`Holding below ${intra.vwapKind} ${Math.round(intra.vwap).toLocaleString('en-IN')}`); }
    if (intra.orDone) {
      if (intra.last.c > intra.orHigh) { score += 1; reasons.push('Closed above the opening range high'); }
      else if (intra.last.c < intra.orLow) { score -= 1; reasons.push('Closed below the opening range low'); }
      else reasons.push('Still inside the opening range');
    }
  }
  if (dayChgPct >= 0.4) score += 0.5; else if (dayChgPct <= -0.4) score -= 0.5;

  if (summary) {
    if (summary.pcrLabel === 'Bullish') score += 0.5; else if (summary.pcrLabel === 'Bearish') score -= 0.5;
    if (/Puts building faster/.test(summary.flowLabel || '')) { score += 0.5; reasons.push('Put OI building faster than calls'); }
    else if (/Calls building faster/.test(summary.flowLabel || '')) { score -= 0.5; reasons.push('Call OI building faster than puts'); }
  }

  if (nowMin < cfg.orbFromMin) blockers.push(`Wait until ${fmtMin(cfg.orbFromMin)}: opening range still forming`);
  if (nowMin >= cfg.noNewAfterMin) blockers.push(`No fresh entries after ${fmtMin(cfg.noNewAfterMin)}`);
  if (vix >= cfg.vixNoTrade) blockers.push(`VIX ${r2(vix)} is at or above ${cfg.vixNoTrade}: stand aside`);

  let bias = 'NO_TRADE';
  if (!blockers.length) {
    if (score >= cfg.biasMinScore) bias = 'BULLISH';
    else if (score <= -cfg.biasMinScore) bias = 'BEARISH';
    else blockers.push('Signals are mixed: no clear bias');
    // Intraday must not fight the daily trend.
    if (bias !== 'NO_TRADE' && dt.dir !== 0 && ((bias === 'BULLISH') !== (dt.dir === 1))) {
      bias = 'NO_TRADE';
      blockers.push('Intraday direction disagrees with the daily trend');
    }
  }
  return {
    bias, score: r2(score), reasons, blockers, vix,
    levels: summary ? { support: summary.putWall, resistance: summary.callWall, maxPain: summary.maxPain } : {},
  };
}

// ── 2. Setups ────────────────────────────────────────────────
function finishLevels(dir, entry, inval, spot, extra = {}) {
  const minRisk = spot * 0.0008;
  const risk = Math.max(Math.abs(entry - inval), minRisk);
  return {
    entryLevel: r2(entry), invalidation: r2(inval), riskIdx: r2(risk),
    t1Level: r2(entry + dir * (extra.t1Mult ?? 1.5) * risk),
    t2Level: r2(entry + dir * (extra.t2Mult ?? 2.5) * risk),
  };
}

// Keep T1 nearer than T2, and both on the profit side of the entry.
function orderTargets(dir, lv) {
  if (dir * (lv.t1Level - lv.entryLevel) <= 0) lv.t1Level = r2(lv.entryLevel + dir * lv.riskIdx);
  if (dir * (lv.t2Level - lv.t1Level) <= 0) lv.t2Level = r2(lv.t1Level + dir * lv.riskIdx);
  return lv;
}

// Never plan a target beyond the heavy OI wall that sits in the way.
function capByWall(dir, level, wall, entry) {
  if (!(wall > 0)) return level;
  if (dir === 1 && wall > entry && level > wall) return wall;
  if (dir === -1 && wall < entry && level < wall) return wall;
  return level;
}

export function evalSetups({ view, intra, summary, spot, cfg = PLAN_DEFAULTS }) {
  if (!view || view.bias === 'NO_TRADE' || !intra?.ok) return [];
  const dir = view.bias === 'BULLISH' ? 1 : -1;
  const side = dir === 1 ? 'CE' : 'PE';
  const { last, recent, vwap } = intra;
  const out = [];
  const wallOpp = dir === 1 ? summary?.callWall : summary?.putWall;

  // a) Trend pullback to VWAP ──────────────────────────────
  {
    const touched = recent.some((c) => (dir === 1 ? c.l <= vwap * 1.001 : c.h >= vwap * 0.999));
    const trendSide = dir === 1 ? last.c > vwap : last.c < vwap;
    const rejectCandle = dir === 1 ? last.c > last.o : last.c < last.o;
    const brokeAgainst = dir === 1 ? last.c < vwap * (1 - 0.002) : last.c > vwap * (1 + 0.002);
    const swing = dir === 1 ? Math.min(...recent.map((c) => c.l), vwap) : Math.max(...recent.map((c) => c.h), vwap);
    const inval = dir === 1 ? swing * (1 - 0.0005) : swing * (1 + 0.0005);
    let state = 'WAITING', text = `Pullback to ${intra.vwapKind} ${Math.round(vwap).toLocaleString('en-IN')}, then a rejection candle`;
    if (brokeAgainst) state = 'INVALIDATED';
    else if (touched && trendSide && rejectCandle) { state = 'TRIGGERED'; text = 'Pullback held and rejected: trigger met'; }
    const entry = state === 'TRIGGERED' ? last.c : vwap;
    const lv = finishLevels(dir, entry, state === 'TRIGGERED' ? inval : (dir === 1 ? vwap * 0.998 : vwap * 1.002), spot);
    lv.t2Level = r2(capByWall(dir, lv.t2Level, wallOpp, entry));
    orderTargets(dir, lv);
    out.push({ setup: 'TREND_PULLBACK', dir, side, state, triggerText: text, ...lv });
  }

  // b) Opening range breakout ──────────────────────────────
  if (intra.orDone && intra.orRange > 0) {
    const level = dir === 1 ? intra.orHigh : intra.orLow;
    const beyond = dir === 1 ? last.c > level : last.c < level;
    const ext = Math.abs(last.c - level);
    const insideAgain = dir === 1 ? last.c < intra.orMid : last.c > intra.orMid;
    let state = 'WAITING', text = `${dir === 1 ? 'Close above' : 'Close below'} the opening range ${dir === 1 ? 'high' : 'low'} ${Math.round(level).toLocaleString('en-IN')}`;
    if (insideAgain) state = 'INVALIDATED';
    else if (beyond && ext > 1.0 * intra.orRange) { state = 'MISSED'; text = 'Breakout already ran more than one range away'; }
    else if (beyond && ext <= 0.5 * intra.orRange) { state = 'TRIGGERED'; text = 'Closed beyond the opening range: trigger met'; }
    else if (beyond) text = 'Broke out but is extended: wait for a pullback, do not chase';
    const entry = state === 'TRIGGERED' ? last.c : level;
    const lv = finishLevels(dir, entry, intra.orMid, spot, { t1Mult: 1.0 * intra.orRange / Math.max(Math.abs(entry - intra.orMid), 1), t2Mult: 1.5 * intra.orRange / Math.max(Math.abs(entry - intra.orMid), 1) });
    orderTargets(dir, lv);
    const wide = Math.abs(entry - intra.orMid) > spot * 0.007;
    out.push({ setup: 'ORB', dir, side, state: wide && state === 'WAITING' ? 'SKIPPED' : state, skipReason: wide ? 'Opening range too wide to risk' : null, triggerText: text, ...lv });
  }

  // c) OI wall rejection ───────────────────────────────────
  {
    const wall = dir === 1 ? summary?.putWall : summary?.callWall;
    if (wall > 0 && Math.abs(wall - spot) / spot <= 0.006) {
      const touched = recent.some((c) => (dir === 1 ? c.l <= wall * 1.001 : c.h >= wall * 0.999));
      const heldSide = dir === 1 ? last.c > wall : last.c < wall;
      const rejectCandle = dir === 1 ? last.c > last.o : last.c < last.o;
      const broke = dir === 1 ? last.c < wall * (1 - 0.0015) : last.c > wall * (1 + 0.0015);
      let state = 'WAITING', text = `${dir === 1 ? 'Put' : 'Call'} wall ${Math.round(wall).toLocaleString('en-IN')} tested and rejected`;
      if (broke) state = 'INVALIDATED';
      else if (touched && heldSide && rejectCandle) { state = 'TRIGGERED'; text = 'Wall held and rejected: trigger met'; }
      const entry = state === 'TRIGGERED' ? last.c : wall;
      const inval = dir === 1 ? wall * (1 - 0.0015) : wall * (1 + 0.0015);
      const lv = finishLevels(dir, entry, inval, spot);
      const mp = summary?.maxPain;
      if (mp && ((dir === 1 && mp > entry) || (dir === -1 && mp < entry)) && Math.abs(mp - entry) >= 1.2 * lv.riskIdx) lv.t1Level = r2(mp);
      lv.t2Level = r2(capByWall(dir, lv.t2Level, dir === 1 ? summary?.callWall : summary?.putWall, entry));
      orderTargets(dir, lv);
      out.push({ setup: 'OI_WALL', dir, side, state, triggerText: text, ...lv });
    }
  }
  return out;
}

// ── 3. Contract + stop derived from the index invalidation ───
export function pickContract({ rows, spot, plan, lot, cfg, expiry, dte, planCfg = PLAN_DEFAULTS }) {
  const side = plan.side;
  const minOi = cfg?.minOptOI ?? 500;
  const cands = (rows || [])
    .map((r) => ({ strike: r.strike, cell: r[side] }))
    .filter((c) => c.cell && c.cell.ltp >= 5 && (c.cell.oi || 0) >= minOi && Math.abs(c.cell.delta || 0) >= 0.3 && Math.abs(c.cell.delta || 0) <= 0.7)
    .sort((a, b) => Math.abs(Math.abs(a.cell.delta) - 0.5) - Math.abs(Math.abs(b.cell.delta) - 0.5));
  const best = cands[0];
  if (!best) return { ok: false, skipReason: 'No liquid contract with delta 0.3–0.7' };
  const { cell } = best;
  const d = Math.abs(cell.delta);
  const ltp = cell.ltp;
  const moveInval = Math.abs(plan.entryLevel - plan.invalidation);
  let stop = ltp - d * moveInval;
  const maxDrop = ltp * (planCfg.maxStopPremiumPct / 100);
  const minDrop = ltp * (planCfg.minStopPremiumPct / 100);
  if (ltp - stop > maxDrop) return { ok: false, skipReason: `Invalidation implies a ${Math.round((ltp - stop) / ltp * 100)}% premium stop: too wide` };
  if (ltp - stop < minDrop) stop = ltp - minDrop;
  const t1 = ltp + d * Math.abs(plan.t1Level - plan.entryLevel);
  const t2 = ltp + d * Math.abs(plan.t2Level - plan.entryLevel);
  const risk = ltp - stop;
  const sizing = calculatePositionSize({
    accountCapital: cfg?.portSize, maxRiskPerTradePct: cfg?.riskPct,
    entryPrice: ltp, stopLossPrice: stop, lotSize: lot, type: 'OPTION',
  });
  const budget = (cfg?.portSize || 0) * (cfg?.riskPct || 0) / 100;
  const base = {
    strike: best.strike, optType: side, expiry, dte, instrKey: cell.instrKey, ltp: r2(ltp), delta: r2(cell.delta),
    iv: r2(cell.iv || 0), theta: r2(cell.theta || 0), oi: cell.oi || 0, lot,
    stop: r2(stop), t1: r2(t1), t2: r2(t2), rr: r2((t1 - ltp) / risk),
    oneLotRisk: Math.round(risk * lot), riskBudget: Math.round(budget),
    sizing,
  };
  if (sizing.riskTooHigh) return { ok: false, ...base, skipReason: `1 lot risks ₹${base.oneLotRisk.toLocaleString('en-IN')}, above your ₹${base.riskBudget.toLocaleString('en-IN')} limit` };
  if (cfg?.maxOptCapital > 0 && sizing.totalCapitalAllocated > cfg.maxOptCapital) {
    return { ok: false, ...base, skipReason: `Needs ₹${Math.round(sizing.totalCapitalAllocated).toLocaleString('en-IN')}, above your max capital` };
  }
  return { ok: true, ...base };
}

// ── 4. Day-level assembly ────────────────────────────────────
// perIndex: [{ name, spot, lot, rows, expiry, dte, view, intra, summary }]
export function buildDayPlan({ perIndex, cfg, limits = {}, tradedToday = [], planCfg = PLAN_DEFAULTS }) {
  const L = { ...planCfg, ...limits };
  const all = [];
  for (const ix of perIndex) {
    const setups = evalSetups({ view: ix.view, intra: ix.intra, summary: ix.summary, spot: ix.spot, cfg: L });
    for (const s of setups) {
      const plan = { id: `plan-${ix.date}-${ix.name}-${s.setup}`, und: ix.name, setupLabel: SETUP_LABELS[s.setup], ...s, view: ix.view?.bias };
      if (s.state === 'INVALIDATED' || s.state === 'MISSED') { plan.status = 'DROPPED'; plan.skipReason = s.state === 'MISSED' ? s.triggerText : 'Invalidated before the trigger'; all.push(plan); continue; }
      if (s.state === 'SKIPPED') { plan.status = 'SKIPPED'; all.push(plan); continue; }
      const c = pickContract({ rows: ix.rows, spot: ix.spot, plan: s, lot: ix.lot, cfg, expiry: ix.expiry, dte: ix.dte, planCfg: L });
      plan.contract = c;
      if (!c.ok) { plan.status = 'SKIPPED'; plan.skipReason = c.skipReason; }
      else plan.status = 'OK';
      all.push(plan);
    }
  }
  // Ranking: triggered first, then better reward-to-risk.
  const ok = all.filter((p) => p.status === 'OK').sort((a, b) =>
    (b.state === 'TRIGGERED') - (a.state === 'TRIGGERED') || (b.contract.rr - a.contract.rr));

  const meter = riskMeter(tradedToday, L, cfg?.portSize && cfg?.riskPct ? cfg.portSize * cfg.riskPct / 100 : 0);
  const loggedIds = new Set(tradedToday.map((t) => t.id));
  const skipped = all.filter((p) => p.status !== 'OK' && !loggedIds.has(p.id));
  const slots = Math.max(0, L.maxTrades - tradedToday.length);
  const dirsTaken = new Set(tradedToday.map((t) => (t.optType === 'CE' ? 1 : -1)));
  const trades = [];
  for (const p of ok) {
    if (loggedIds.has(p.id)) continue; // already entered: shown from the log with its live status
    const skip = (reason) => skipped.push({ ...p, status: 'SKIPPED', skipReason: reason });
    if (meter.halted) { skip(meter.haltReason); continue; }
    if (dirsTaken.has(p.dir)) { skip('Same direction as an idea already taken: counts as one position'); continue; }
    if (trades.length >= slots) { skip(`Trade cap of ${L.maxTrades} reached`); continue; }
    trades.push(p);
    dirsTaken.add(p.dir);
  }
  return { trades, skipped, meter };
}

// ── 5. Risk meter + scorecard ────────────────────────────────
// Plan signals carry planRiskPct (premium % at risk) and planRiskRupees.
export function riskMeter(planSignalsToday, cfg = PLAN_DEFAULTS, riskPerTradeRupees = 0) {
  let realizedR = 0, lossRupees = 0, openRisk = 0, open = 0;
  for (const s of planSignalsToday || []) {
    const rp = s.planRiskPct || 0;
    if (s.status === 'OPEN') { openRisk += s.planRiskRupees || 0; open++; continue; }
    if (s.status === 'TARGET_HIT' || s.status === 'SL_HIT' || s.status === 'EXPIRED') {
      const R = rp > 0 && s.pnlPct != null ? s.pnlPct / rp : 0;
      realizedR += R;
      if (R < 0) lossRupees += -R * (s.planRiskRupees || 0);
    }
  }
  const limitRupees = Math.round((cfg.dailyLossR || 2) * riskPerTradeRupees);
  const hitLimit = realizedR <= -(cfg.dailyLossR || 2);
  const capHit = (planSignalsToday || []).length >= (cfg.maxTrades || 3);
  return {
    realizedR: r2(realizedR), lossRupees: Math.round(lossRupees), openRisk: Math.round(openRisk), open,
    trades: (planSignalsToday || []).length, maxTrades: cfg.maxTrades || 3, dailyLossR: cfg.dailyLossR || 2, limitRupees,
    halted: hitLimit, haltReason: hitLimit ? `Daily loss limit of ${cfg.dailyLossR || 2}R reached: no new trades today` : null,
    capHit,
  };
}

export function setupScorecard(planSignals, minSample = PLAN_DEFAULTS.scorecardMinSample) {
  const by = {};
  for (const s of planSignals || []) {
    if (!s.setup || !(s.status === 'TARGET_HIT' || s.status === 'SL_HIT' || s.status === 'EXPIRED')) continue;
    const rp = s.planRiskPct || 0;
    if (!(rp > 0) || s.pnlPct == null) continue;
    (by[s.setup] ||= []).push(s.pnlPct / rp);
  }
  return Object.entries(by).map(([setup, rs]) => ({
    setup, label: SETUP_LABELS[setup] || setup, n: rs.length,
    avgR: r2(rs.reduce((a, b) => a + b, 0) / rs.length),
    winRate: Math.round(rs.filter((x) => x > 0).length / rs.length * 100),
    tooFew: rs.length < minSample,
  })).sort((a, b) => b.n - a.n);
}

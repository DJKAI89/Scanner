// ── Trade management engine ───────────────────────────────────────
// Shared by AppContext's runSignalMonitor, logService's checkAllOutcomes,
// and logService's resolveSignalsAgainstLivePrices — one implementation so
// trailing-stop/break-even/partial-exit logic can't drift out of sync across
// the 3 places signals get resolved (the SELL-direction bug earlier in this
// project happened exactly because the same check existed in 3 places).
//
// Adds on top of plain Entry/SL/Target:
//  - T1/T2/T3 partial exits (close part of the position at each level)
//  - Break-even: once T1 hits, stop loss moves to entry
//  - ATR (stocks) / R-multiple (options) trailing stop — ratchets favorably,
//    never loosens
//  - Generic time-stop using the signal's own `holdDays` budget
//  - Option expiry (existing EXPIRED behavior, kept as highest priority)
//
// A signal's pnlPct on a fully-closed trade is the size-weighted blend across
// every partial tranche, not just the last fill.

import { isBullSignal } from './github';

const DEFAULTS = {
  t1ClosePct:    50,   // % of original position closed at T1
  t2ClosePct:    30,   // % of original position closed at T2 (T3 closes the rest)
  atrTrailMult:  1.5,  // stocks: trailing distance = ATR * this, once break-even active
  optionTrailMult: 0.6, // options: trailing distance = risk-distance * this
};

function signedPnlPct(sig, exitPrice) {
  if (!sig?.entry) return 0;
  const isBuy = isBullSignal(sig);
  return isBuy
    ? +((exitPrice - sig.entry) / sig.entry * 100).toFixed(2)
    : +((sig.entry - exitPrice) / sig.entry * 100).toFixed(2);
}

function getTrailUnit(sig, cfg) {
  if (sig.type === 'OPTION') return sig.riskDist || Math.abs((sig.entry||0) - (sig.sl||0));
  return sig.atr || Math.abs((sig.entry||0) - (sig.sl||0));
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA), b = new Date(dateB);
  return Math.round((b - a) / 86400000);
}

// Builds the final blended-pnl close, backfilling any target levels that were
// gapped through without being recorded as their own partial tranche.
function finalizeClose(sig, ltp, istDate, istTime, reason) {
  const partials = [...(sig.partials || [])];
  const hasHit = (level) => partials.some(p => p.level === level);
  let usedPct = partials.reduce((s, p) => s + p.pctClosed, 0);

  if (reason === 'TARGET') {
    // Backfill any skipped levels at their own price (gapped through), then
    // close whatever remains at the current ltp.
    if (!hasHit('T1') && sig.targetT1) { const pct = Math.min(DEFAULTS.t1ClosePct, 100 - usedPct); if (pct > 0) { partials.push({ level: 'T1', price: sig.targetT1, time: istTime, pctClosed: pct }); usedPct += pct; } }
    if (!hasHit('T2') && sig.targetT2) { const pct = Math.min(DEFAULTS.t2ClosePct, 100 - usedPct); if (pct > 0) { partials.push({ level: 'T2', price: sig.targetT2, time: istTime, pctClosed: pct }); usedPct += pct; } }
  }
  const remaining = Math.max(0, 100 - usedPct);
  if (remaining > 0) partials.push({ level: reason === 'TARGET' ? 'T3' : reason, price: ltp, time: istTime, pctClosed: remaining });

  const blended = partials.reduce((s, t) => s + signedPnlPct(sig, t.price) * (t.pctClosed / 100), 0);
  const status = blended >= 0 ? 'TARGET_HIT' : 'SL_HIT';
  return {
    status, exitPrice: +ltp.toFixed(2), exitTime: istTime, exitDate: istDate,
    pnlPct: +blended.toFixed(2), exitReason: reason, partials, remainingPct: 0,
    livePrice: null, livePnlPct: null,
  };
}

// Main entry point. Returns null if nothing changed, otherwise a partial
// update object to merge onto the signal (status/exit fields if it just
// closed, or partials/trailSL/beActive/maxFavPrice if it's still open but
// trade management adjusted something).
export function evaluateSignalExit(sig, ltp, istDate, istTime, cfgIn = {}) {
  if (!sig || sig.status !== 'OPEN' || !ltp || !sig.entry) return null;
  const cfg = { ...DEFAULTS, ...cfgIn };
  const isBuy = isBullSignal(sig);

  // 1) Option expiry — highest priority, the contract itself stops trading
  if (sig.type === 'OPTION' && sig.expiry && istDate > sig.expiry) {
    return finalizeClose(sig, ltp, istDate, istTime, 'EXPIRY');
  }

  // 2) Generic time-stop — signal's own holdDays budget exceeded
  if (sig.holdDays && daysBetween(sig.date, istDate) > sig.holdDays) {
    return finalizeClose(sig, ltp, istDate, istTime, 'TIME_STOP');
  }

  const t1 = sig.targetT1, t2 = sig.targetT2, t3 = sig.targetT3;
  const partials = sig.partials || [];
  const hasHit = (level) => partials.some(p => p.level === level);
  const effSL = sig.trailSL != null ? sig.trailSL : sig.sl;
  const favorable   = (v) => v > 0 && (isBuy ? ltp >= v : ltp <= v);
  const unfavorable = (v) => v > 0 && (isBuy ? ltp <= v : ltp >= v);

  // 3) Stop loss / trailing stop hit — direction-aware, uses trailSL once active
  if (unfavorable(effSL)) {
    return finalizeClose(sig, ltp, istDate, istTime, sig.beActive ? 'TRAIL_STOP' : 'SL');
  }

  // 4) T3 — final target, closes whatever remains
  if (favorable(t3) && !hasHit('T3')) {
    return finalizeClose(sig, ltp, istDate, istTime, 'TARGET');
  }

  const update = {};
  let touched = false;

  // 5) T2 — partial exit (backfills T1 if price gapped straight through it)
  if (favorable(t2) && !hasHit('T2')) {
    const next = [...partials];
    let usedPct = next.reduce((s, p) => s + p.pctClosed, 0);
    if (!hasHit('T1')) { next.push({ level: 'T1', price: t1 || ltp, time: istTime, pctClosed: cfg.t1ClosePct }); usedPct += cfg.t1ClosePct; }
    const t2Pct = Math.min(cfg.t2ClosePct, 100 - usedPct);
    next.push({ level: 'T2', price: ltp, time: istTime, pctClosed: t2Pct });
    update.partials = next;
    update.remainingPct = Math.max(0, 100 - usedPct - t2Pct);
    update.beActive = true;
    touched = true;
  }
  // 6) T1 — first partial exit
  else if (favorable(t1) && !hasHit('T1')) {
    update.partials = [...partials, { level: 'T1', price: ltp, time: istTime, pctClosed: cfg.t1ClosePct }];
    update.remainingPct = Math.max(0, 100 - cfg.t1ClosePct);
    update.beActive = true;
    touched = true;
  }

  const beNowActive = update.beActive || sig.beActive;

  // 7) Break-even — once a partial has been taken, SL moves to entry (ratchets only)
  if (beNowActive) {
    const isBetter = sig.trailSL == null || (isBuy ? sig.entry > sig.trailSL : sig.entry < sig.trailSL);
    if (isBetter && update.trailSL == null) { update.trailSL = sig.entry; touched = true; }
  }

  // 8) Trailing stop ratchet — only once break-even is active
  if (beNowActive) {
    const prevFav = sig.maxFavPrice ?? sig.entry;
    const favPrice = isBuy ? Math.max(prevFav, ltp) : Math.min(prevFav, ltp);
    if (favPrice !== prevFav) { update.maxFavPrice = favPrice; touched = true; }
    const unit = getTrailUnit(sig, cfg);
    const mult = sig.type === 'OPTION' ? cfg.optionTrailMult : cfg.atrTrailMult;
    if (unit > 0) {
      const candidate = isBuy ? favPrice - unit * mult : favPrice + unit * mult;
      const curTrail  = update.trailSL ?? sig.trailSL ?? sig.entry;
      const nextTrail = isBuy ? Math.max(curTrail, candidate) : Math.min(curTrail, candidate);
      if (nextTrail !== curTrail) { update.trailSL = nextTrail; touched = true; }
    }
  }

  if (!touched) {
    // No structural change — just refresh the live price/pnl shown in the UI
    return { livePrice: +ltp.toFixed(2), livePnlPct: signedPnlPct(sig, ltp) };
  }
  return { ...update, livePrice: +ltp.toFixed(2), livePnlPct: signedPnlPct(sig, ltp) };
}

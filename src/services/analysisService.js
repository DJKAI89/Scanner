// ── Analysis service — signal history stats aggregation ──────────
// Extracted from AnalysisPane.jsx so the pane only handles UI/state wiring.
// All calculation and GitHub-read logic for the Analysis tab lives here.

import { ghReadMultipleDays, ghReadShadow, isBullSignal } from './github';
import { runMlBacktest, estimateCostPct, signalWin } from './mlRanking';

// ── Pure helpers (exported for reuse in pane render where needed) ──
export function wr(arr) {
  if (!arr?.length) return null;
  const h = arr.filter(s => s.status === 'TARGET_HIT').length;
  return { h, t: arr.length, r: Math.round(h / arr.length * 100) };
}

export function avgOf(arr) {
  const v = arr.filter(s => s.pnlPct != null);
  return v.length ? +(v.reduce((a, s) => a + s.pnlPct, 0) / v.length).toFixed(1) : null;
}

// ── Main aggregation ────────────────────────────────────────────
// ctx: { gh, days, mlModels, lg, updateBadge }
export async function loadAnalysisData(ctx) {
  const { gh, days, mlModels, lg, updateBadge } = ctx;
  if (!gh.token || !gh.user || !gh.repo) throw new Error('GitHub not configured — go to ⚙ Settings.');

  const signals = await ghReadMultipleDays(gh, days);
  if (!signals.length) return { empty: true };

  const closed  = signals.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
  const expired = signals.filter(s => s.status === 'EXPIRED');
  const open    = signals.filter(s => s.status === 'OPEN');
  const total   = closed.length;

  if (total < 5) return { insufficient: true, total, open: open.length };

  const overall   = wr(closed);
  const avgConf   = Math.round(closed.reduce((a, s) => a + (s.confidence || 50), 0) / total);
  const avgPnlAll = avgOf(closed);
  const avgPnlTgt = avgOf(closed.filter(s => s.status === 'TARGET_HIT'));
  const avgPnlSL  = avgOf(closed.filter(s => s.status === 'SL_HIT'));
  const mlBacktest = runMlBacktest(closed, mlModels);

  // Streak
  const recent = [...closed].reverse();
  let streak = 0, streakType = '';
  for (const s of recent) {
    const hit = s.status === 'TARGET_HIT';
    if (!streakType) streakType = hit ? 'W' : 'L';
    if ((streakType === 'W') === hit) streak++; else break;
  }

  // Sparkline points
  const byDate2 = {};
  closed.forEach(s => {
    const d = s.exitDate || s.date;
    if (!byDate2[d]) byDate2[d] = { hits: 0, t: 0 };
    byDate2[d].t++;
    if (s.status === 'TARGET_HIT') byDate2[d].hits++;
  });
  const sparkPoints = Object.entries(byDate2)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, d]) => d.t >= 2 ? Math.round(d.hits / d.t * 100) : null)
    .filter(v => v !== null);

  // By underlying
  const underlyings = [...new Set(closed.map(s => s.stock || s.name?.split(' ')[0]))];
  const byUnderlying = underlyings.map(u => {
    const g = closed.filter(s => (s.stock || s.name?.split(' ')[0]) === u);
    return { u, ...(wr(g) || { h: 0, t: 0, r: null }) };
  }).filter(x => x.t >= 3).sort((a, b) => (b.r || 0) - (a.r || 0)).slice(0, 8);

  // CE vs PE
  const ceSignals = closed.filter(s => s.optType === 'CE' || s.signal === 'CALL');
  const peSignals = closed.filter(s => s.optType === 'PE' || s.signal === 'PUT');

  // Signal types
  const sigTypes = ['BUY', 'SELL', 'MODERATE'].map(type => ({
    type,
    ...(wr(closed.filter(s => s.signal === type)) || { h: 0, t: 0, r: null }),
    avg: avgOf(closed.filter(s => s.signal === type)),
  })).filter(x => x.t >= 3);

  // Confidence bands
  const confBands = [60, 65, 70, 75, 80, 85, 90, 95].map(b => {
    const g = closed.filter(s => (s.confidence || 50) >= b && (s.confidence || 50) < b + 5);
    return { band: `${b}–${b + 4}%`, ...(wr(g) || { h: 0, t: 0, r: null }) };
  }).filter(x => x.t >= 2);

  // Sessions — non-overlapping, gap-free hour buckets (9:15–15:30 IST trading window)
  const getH = s => parseInt((s.time || '').split(':')[0]) || 0;
  const getM = s => parseInt((s.time || '').split(':')[1]) || 0;
  const sessions = [
    { label: 'Opening 9:15–9:45',  fn: s => { const h = getH(s), m = getM(s); return h === 9 && m >= 15 && m <= 45; } },
    { label: 'Early 9:45–10:30',   fn: s => { const h = getH(s), m = getM(s); return (h === 9 && m > 45) || (h === 10 && m <= 30); } },
    { label: 'Mid 10:30–12:30',    fn: s => { const h = getH(s), m = getM(s); return (h === 10 && m > 30) || h === 11 || (h === 12 && m <= 30); } },
    { label: 'Afternoon 12:30–2',  fn: s => { const h = getH(s), m = getM(s); return (h === 12 && m > 30) || h === 13; } },
    { label: 'Pre-close 2–3:30',   fn: s => { const h = getH(s); return h >= 14; } },
  ];
  const timeBreak = sessions.map(({ label, fn }) => ({
    label, ...(wr(closed.filter(fn)) || { h: 0, t: 0, r: null }),
  })).filter(x => x.t >= 2);

  // Daily rows
  const byDate = {};
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  closed.forEach(s => {
    // Use exitDate as the "closed on" date — prefer it over entry date
    // For signals without exitDate, only use entry date if it's today (just resolved)
    const cd = s.exitDate || (s.date === todayIST ? todayIST : s.date);
    if (!byDate[cd]) byDate[cd] = { hits:0, sls:0, pnl:0, signals:[] };
    byDate[cd][s.status==='TARGET_HIT'?'hits':'sls']++;
    byDate[cd].pnl += (s.pnlPct||0);
    byDate[cd].signals.push(s);
  });
  const dailyRows = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10);

  // CS buckets
  const scoredSignals = closed.filter(s => s.compositeScore != null);
  const csBuckets = [
    { label: 'Strong Bear ≤-2',    min: -99,  max: -2   },
    { label: 'Weak Bear -2..-0.5', min: -2,   max: -0.5 },
    { label: 'Neutral ±0.5',       min: -0.5, max: 0.5  },
    { label: 'Weak Bull 0.5..2',   min: 0.5,  max: 2    },
    { label: 'Strong Bull ≥2',     min: 2,    max: 99   },
  ];
  const csRows = scoredSignals.length >= 5
    ? csBuckets.map(b => {
        const g  = scoredSignals.filter(s => s.compositeScore >= b.min && s.compositeScore < b.max);
        const r2 = wr(g);
        return r2 && r2.t >= 2 ? { label: b.label, r: r2.r, t: r2.t } : null;
      }).filter(Boolean)
    : [];

  // ── Cost-adjusted net P&L ── real edge after estimated liquidity-scaled
  // transaction cost (mlRanking.estimateCostPct), not just raw target/SL %.
  const costRows = closed.filter(s => s.pnlPct != null);
  const avgRawPct = avgOf(costRows);
  const avgNetPct = costRows.length
    ? +(costRows.reduce((sum, s) => sum + (s.pnlPct - estimateCostPct(s, s.type)), 0) / costRows.length).toFixed(2)
    : null;
  const netAdjusted = costRows.length >= 5
    ? { avgRawPct, avgNetPct, costDragPct: (avgRawPct != null && avgNetPct != null) ? +(avgRawPct - avgNetPct).toFixed(2) : null, t: costRows.length }
    : null;

  // ── Liquidity (OI) impact — options only ── validates whether thin-OI
  // contracts actually lose more to spread, as the cost model assumes.
  const optClosed = closed.filter(s => s.type === 'OPTION');
  const oiBandDefs = [
    { band: '0 / no OI', min: 0,     max: 0 },
    { band: '<1k',       min: 1,     max: 999 },
    { band: '1k–3k',     min: 1000,  max: 2999 },
    { band: '3k–10k',    min: 3000,  max: 9999 },
    { band: '10k+',      min: 10000, max: Infinity },
  ];
  const liquidityBands = oiBandDefs.map(b => {
    const g = optClosed.filter(s => (s.oi || 0) >= b.min && (s.oi || 0) <= b.max);
    const r2 = wr(g);
    if (!r2 || r2.t < 2) return null;
    const avgNet = +(g.reduce((sum, s) => sum + ((s.pnlPct || 0) - estimateCostPct(s, 'OPTION')), 0) / g.length).toFixed(2);
    return { band: b.band, ...r2, avgNet };
  }).filter(Boolean);

  // ── Volatility regime-shift impact ── validates whether signals fired
  // right after a VIX spike/collapse actually perform worse (mlRanking
  // feature `volRegimeShift`). Older logged signals won't have this field.
  const shiftEligible = closed.filter(s => s.volRegimeShift != null);
  const shiftBandDefs = [
    { band: 'Stable (<0.3)',      min: 0,   max: 0.3 },
    { band: 'Moderate (0.3–0.6)', min: 0.3, max: 0.6 },
    { band: 'Sharp shift (0.6+)', min: 0.6, max: 1.01 },
  ];
  const regimeShiftBands = shiftEligible.length >= 5
    ? shiftBandDefs.map(b => {
        const g = shiftEligible.filter(s => s.volRegimeShift >= b.min && s.volRegimeShift < b.max);
        const r2 = wr(g);
        return r2 && r2.t >= 2 ? { band: b.band, ...r2 } : null;
      }).filter(Boolean)
    : [];

  // ── Which model served each signal ── global vs. a specific segment (see
  // mlRanking.describeServingLabel). Only signals logged after this field
  // was added will have it, so this fills in over time.
  const segmentEligible = closed.filter(s => s.mlSegment);
  const segmentLabels = [...new Set(segmentEligible.map(s => s.mlSegment))];
  const modelAttribution = segmentEligible.length >= 5
    ? segmentLabels.map(label => {
        const g = segmentEligible.filter(s => s.mlSegment === label);
        const r2 = wr(g);
        return r2 && r2.t >= 2 ? { label, ...r2 } : null;
      }).filter(Boolean).sort((a, b) => b.t - a.t)
    : [];

  // ── Planned RR vs. realized R-multiple ── are wins/losses landing near
  // their planned target/SL, or getting cut short / running long?
  const rrPoints = closed
    .filter(s => s.entry > 0 && s.sl > 0 && s.entry !== s.sl)
    .map(s => {
      const riskPct = Math.abs((s.entry - s.sl) / s.entry * 100);
      if (riskPct <= 0) return null;
      return {
        plannedRR: s.rr ?? s.pot?.rr ?? null,
        realizedR: +((s.pnlPct || 0) / riskPct).toFixed(2),
      };
    }).filter(Boolean);
  const plannedList = rrPoints.filter(p => p.plannedRR != null).map(p => p.plannedRR);
  const avgPlannedRR = plannedList.length ? +(plannedList.reduce((a, b) => a + b, 0) / plannedList.length).toFixed(2) : null;
  const avgRealizedR = rrPoints.length ? +(rrPoints.reduce((a, p) => a + p.realizedR, 0) / rrPoints.length).toFixed(2) : null;
  const rBucketDefs = [
    { label: '< -1R',    min: -Infinity, max: -1 },
    { label: '-1R to 0', min: -1,        max: 0 },
    { label: '0 to 1R',  min: 0,         max: 1 },
    { label: '1R to 2R', min: 1,         max: 2 },
    { label: '2R+',      min: 2,         max: Infinity },
  ];
  const rrHistogram = rBucketDefs.map(b => ({
    label: b.label,
    t: rrPoints.filter(p => p.realizedR >= b.min && p.realizedR < b.max).length,
  }));
  const rrRealized = rrPoints.length >= 5 ? { avgPlannedRR, avgRealizedR, t: rrPoints.length, histogram: rrHistogram } : null;

  // ── Filter check: did the rejected picks (shadow signals) do better or worse than accepted? ──
  const netOf = s => (s.pnlPct ?? 0) - estimateCostPct(s, s.type);
  const mean = arr => arr.length ? +(arr.reduce((x, y) => x + y, 0) / arr.length).toFixed(2) : null;
  const shadowAll = await ghReadShadow(gh, days).catch(() => []);
  const shadowClosed = shadowAll.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
  let shadow = null;
  if (shadowAll.length) {
    const reasons = {};
    shadowClosed.forEach(s => { (reasons[s.shadowReason || 'unknown'] ||= []).push(s); });
    shadow = {
      logged: shadowAll.length,
      closed: shadowClosed.length,
      shadowWR: shadowClosed.length ? Math.round(shadowClosed.filter(signalWin).length / shadowClosed.length * 100) : null,
      shadowNet: mean(shadowClosed.map(netOf)),
      acceptedWR: Math.round(closed.filter(signalWin).length / closed.length * 100),
      acceptedNet: mean(closed.map(netOf)),
      byReason: Object.entries(reasons).map(([reason, arr]) => ({
        reason, n: arr.length,
        wr: Math.round(arr.filter(signalWin).length / arr.length * 100),
        net: mean(arr.map(netOf)),
      })).sort((x, y) => y.n - x.n),
    };
  }

  // ── Trade journal: taken vs skipped, paper vs actual fills ──
  const takenSigs = signals.filter(s => s.taken === true);
  const skippedSigs = signals.filter(s => s.taken === false);
  let journal = null;
  if (takenSigs.length || skippedSigs.length) {
    const doneT = takenSigs.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
    const doneS = skippedSigs.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
    const filled = doneT.filter(s => s.fillEntry > 0 && s.fillExit > 0 && s.entry > 0);
    const dirOf = s => (isBullSignal(s) ? 1 : -1);
    const realPct = s => dirOf(s) * (s.fillExit - s.fillEntry) / s.fillEntry * 100;
    // adverse slippage: positive = you got a worse price than the signal's paper price
    const entrySlip = s => dirOf(s) * (s.fillEntry - s.entry) / s.entry * 100;
    const exitSlip = s => (s.exitPrice > 0 ? -dirOf(s) * (s.fillExit - s.exitPrice) / s.exitPrice * 100 : null);
    journal = {
      taken: takenSigs.length, skipped: skippedSigs.length,
      takenClosed: doneT.length, skippedClosed: doneS.length,
      takenWR: doneT.length ? Math.round(doneT.filter(signalWin).length / doneT.length * 100) : null,
      skippedWR: doneS.length ? Math.round(doneS.filter(signalWin).length / doneS.length * 100) : null,
      withFills: filled.length,
      paperAvg: mean(filled.map(s => s.pnlPct ?? 0)),
      realAvg: mean(filled.map(realPct)),
      entrySlipAvg: mean(filled.map(entrySlip)),
      exitSlipAvg: mean(filled.map(exitSlip).filter(v => v != null)),
    };
  }

  // Alerts
  const alerts = [];
  if (overall.r < 35) alerts.push({ level: 'danger', msg: `Win rate ${overall.r}% — signals losing systematically. Raise min confidence to 75%+.` });
  if (streak >= 4 && streakType === 'L') alerts.push({ level: 'danger', msg: `${streak} consecutive losses — pause and review signal quality.` });
  const badSess = timeBreak.filter(x => x.r !== null && x.t >= 5).sort((a, b) => (a.r || 0) - (b.r || 0))[0];
  if (badSess?.r < 15) alerts.push({ level: 'warn', msg: `${badSess.label}: only ${badSess.r}% win rate — skip this window.` });
  if (avgConf > 72 && overall.r < 25) alerts.push({ level: 'warn', msg: `${avgConf}% avg confidence but only ${overall.r}% win rate — calibration needed.` });

  updateBadge('analysis', String(signals.length));
  lg(`Analysis: ${total} closed, ${open.length} open`, 'o');

  return {
    signals, closed, open, expired, total, overall, avgConf,
    avgPnlAll, avgPnlTgt, avgPnlSL,
    streak, streakType, sparkPoints,
    byUnderlying, ceSignals, peSignals,
    ceWR: wr(ceSignals), peWR: wr(peSignals),
    sigTypes, confBands, timeBreak, dailyRows,
    csRows, scoredSignals, alerts, mlBacktest,
    netAdjusted, liquidityBands, regimeShiftBands, modelAttribution, rrRealized,
    shadow, journal,
  };
}

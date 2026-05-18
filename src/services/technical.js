// ── Technical Analysis Engine ──
// Ported from original index.html — all functions mirror the vanilla JS exactly

// ── EMA ──────────────────────────────────────────────────────
export function calcEMA(closes, period) {
  if (!closes || closes.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return +ema.toFixed(2);
}

export function isAboveMA(closes, period) {
  if (!closes || closes.length < period) return null;
  return closes[closes.length - 1] > calcEMA(closes, period);
}

export function calcEMACrossover(closes) {
  if (!closes || closes.length < 10) return null;
  const e50  = calcEMA(closes, Math.min(50, closes.length));
  const e200 = calcEMA(closes, Math.min(200, closes.length));
  const prev50  = calcEMA(closes.slice(0, -1), Math.min(50, closes.length - 1));
  const prev200 = calcEMA(closes.slice(0, -1), Math.min(200, closes.length - 1));
  const ltp = closes[closes.length - 1];

  const goldenCross = closes.length >= 200 && prev50 <= prev200 && e50 > e200;
  const deathCross  = closes.length >= 200 && prev50 >= prev200 && e50 < e200;
  const nearCross   = closes.length >= 50 && !goldenCross && !deathCross && Math.abs(e50 - e200) / e200 < 0.005;
  const uptrend     = e50 > e200 || (closes.length < 200 && ltp > e50);

  return { e50, e200, goldenCross, deathCross, nearCross, uptrend, ema50: e50, ema200: e200 };
}

// ── RSI ──────────────────────────────────────────────────────
export function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const slice = (arr) => arr.slice(-period);
  const avgG = slice(gains).reduce((s, v) => s + v, 0) / period || 1e-10;
  const avgL = slice(losses).reduce((s, v) => s + v, 0) / period || 1e-10;
  return +(100 - 100 / (1 + avgG / avgL)).toFixed(2);
}

// ── MACD ─────────────────────────────────────────────────────
export function calcMACD(closes) {
  if (!closes || closes.length < 35) return { macdLine: 0, signal: 0, hist: 0, bull: null };
  const fast   = calcEMA(closes, 12);
  const slow   = calcEMA(closes, 26);
  const macdLine = fast - slow;
  // 9-period EMA of MACD (approximate with last 9 values)
  const macdValues = [];
  for (let i = 9; i <= closes.length; i++) macdValues.push(calcEMA(closes.slice(0, i), 12) - calcEMA(closes.slice(0, i), 26));
  const signal = calcEMA(macdValues, 9);
  return { macdLine: +macdLine.toFixed(4), signal: +signal.toFixed(4), hist: +(macdLine - signal).toFixed(4), bull: macdLine > signal };
}

// ── ATR ──────────────────────────────────────────────────────
export function calcATR(candles, period = 14) {
  if (!candles || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = +candles[i][2], l = +candles[i][3], pc = +candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return +(recent.reduce((s, v) => s + v, 0) / recent.length).toFixed(2);
}

// ── Supertrend (7,3) ─────────────────────────────────────────
export function calcSupertrend(candles, period = 7, mult = 3) {
  if (!candles || candles.length < period + 2) return null;
  const data = candles.slice().reverse(); // oldest→newest
  const atrs = [];
  for (let i = 1; i < data.length; i++) {
    const h = +data[i][2], l = +data[i][3], pc = +data[i - 1][4];
    atrs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let trend = 'UP', prevUB = 0, prevLB = 0;
  let crossed = false;
  for (let i = period; i < data.length; i++) {
    const sliceATR = atrs.slice(i - period, i);
    const atr = sliceATR.reduce((s, v) => s + v, 0) / sliceATR.length;
    const hl2 = (+data[i][2] + +data[i][3]) / 2;
    const ub = hl2 + mult * atr;
    const lb = hl2 - mult * atr;
    const finalUB = ub < prevUB || +data[i - 1][4] > prevUB ? ub : prevUB;
    const finalLB = lb > prevLB || +data[i - 1][4] < prevLB ? lb : prevLB;
    const prevTrend = trend;
    const close = +data[i][4];
    if (prevTrend === 'DOWN' && close > finalUB) trend = 'UP';
    else if (prevTrend === 'UP'  && close < finalLB) trend = 'DOWN';
    if (i === data.length - 1 && prevTrend !== trend) crossed = true;
    prevUB = finalUB; prevLB = finalLB;
  }
  const last   = data[data.length - 1];
  const value  = trend === 'UP' ? prevLB : prevUB;
  const dist   = +((+last[4] - value) / +last[4] * 100).toFixed(2);
  return { trend, crossed, value: +value.toFixed(2), dist };
}

// ── Bollinger Bands Squeeze ───────────────────────────────────
export function calcBBSqueeze(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const recent = closes.slice(-period);
  const mean   = recent.reduce((s, v) => s + v, 0) / period;
  const std    = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const upper  = mean + 2 * std, lower = mean - 2 * std;
  const bw     = (upper - lower) / mean;   // bandwidth
  const squeeze = bw < 0.05;
  const extremeSqueeze = bw < 0.025;
  const ltp    = closes[closes.length - 1];
  return { upper: +upper.toFixed(2), lower: +lower.toFixed(2), mean: +mean.toFixed(2), bw: +bw.toFixed(4), squeeze, extremeSqueeze, aboveUpper: ltp > upper, belowLower: ltp < lower };
}

// ── NR7 (Narrow Range 7 / 4) ─────────────────────────────────
export function calcNR7(candles) {
  if (!candles || candles.length < 7) return null;
  const ranges = candles.slice(0, 7).map((c) => +c[2] - +c[3]);
  const todayR = ranges[0];
  const isNR7  = todayR === Math.min(...ranges);
  const isNR4  = todayR === Math.min(...ranges.slice(0, 4));
  return { isNR7, isNR4, range: +todayR.toFixed(2), avgRange: +(ranges.reduce((s,v)=>s+v,0)/7).toFixed(2) };
}

// ── ADX ──────────────────────────────────────────────────────
export function calcADX(candles, period = 14) {
  if (!candles || candles.length < period + 2) return null;
  const data = candles.slice().reverse();
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < data.length; i++) {
    const h = +data[i][2], l = +data[i][3], ph = +data[i-1][2], pl = +data[i-1][3], pc = +data[i-1][4];
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const upMove = h - ph, downMove = pl - l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const slice = (arr) => arr.slice(-period);
  const smoothTR  = slice(trs).reduce((s,v)=>s+v, 0);
  const smoothPDM = slice(plusDMs).reduce((s,v)=>s+v, 0);
  const smoothMDM = slice(minusDMs).reduce((s,v)=>s+v, 0);
  if (!smoothTR) return null;
  const plusDI  = (smoothPDM / smoothTR) * 100;
  const minusDI = (smoothMDM / smoothTR) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return { adx: +dx.toFixed(1), plusDI: +plusDI.toFixed(1), minusDI: +minusDI.toFixed(1) };
}

// ── Support & Resistance ──────────────────────────────────────
export function calcSR(candles, lookback = 20) {
  if (!candles || candles.length < lookback) return { support: 0, resistance: 0 };
  const slice = candles.slice(0, lookback);
  const highs = slice.map((c) => +c[2]);
  const lows  = slice.map((c) => +c[3]);
  return { support: +Math.min(...lows).toFixed(2), resistance: +Math.max(...highs).toFixed(2) };
}

// ── VWAP ─────────────────────────────────────────────────────
export function calcVWAP(candles) {
  let tpv = 0, vol = 0;
  for (const c of candles) { const tp = (+c[2] + +c[3] + +c[4]) / 3; tpv += tp * +c[5]; vol += +c[5]; }
  return vol > 0 ? +(tpv / vol).toFixed(2) : 0;
}

// ── Candle patterns ───────────────────────────────────────────
export function detectPatterns(candles) {
  if (!candles || candles.length < 3) return [];
  const patterns = [];
  const [c0, c1, c2] = candles.map((c) => ({ o: +c[1], h: +c[2], l: +c[3], c: +c[4] }));
  const body0 = Math.abs(c0.c - c0.o), body1 = Math.abs(c1.c - c1.o);
  // Hammer
  const lowerWick0 = c0.o > c0.c ? c0.c - c0.l : c0.o - c0.l;
  if (c0.c > c0.o && lowerWick0 > body0 * 2 && (c0.h - c0.c) < body0 * 0.5)
    patterns.push('HAMMER');
  // Bullish Engulfing
  if (c1.c < c1.o && c0.c > c0.o && c0.o <= c1.c && c0.c >= c1.o)
    patterns.push('BULLISH_ENGULFING');
  // Bearish Engulfing
  if (c1.c > c1.o && c0.c < c0.o && c0.o >= c1.c && c0.c <= c1.o)
    patterns.push('BEARISH_ENGULFING');
  // Doji
  if (body0 < (c0.h - c0.l) * 0.1)
    patterns.push('DOJI');
  // Morning Star
  if (c2.c < c2.o && body1 < body0 * 0.3 && c0.c > c0.o && c0.c > (c2.o + c2.c) / 2)
    patterns.push('MORNING_STAR');
  return patterns;
}

// ── PDH/PDL Breakout ─────────────────────────────────────────
export function detectPDHLBreakout(ltp, candles) {
  if (!candles || candles.length < 2) return null;
  const pdh = +candles[1][2], pdl = +candles[1][3];
  const pdHDist = pdh > 0 ? +((ltp - pdh) / pdh * 100).toFixed(2) : 0;
  const pdLDist = pdl > 0 ? +((ltp - pdl) / pdl * 100).toFixed(2) : 0;
  return {
    pdh, pdl,
    bullBreakout: pdHDist >= 0.3,
    bearBreakout: pdLDist <= -0.3,
    nearPDH:      pdHDist >= 0 && pdHDist < 0.3,
    nearPDL:      pdLDist <= 0 && pdLDist > -0.3,
    pdHDist, pdLDist,
  };
}

// ── 52-Week High/Low ─────────────────────────────────────────
export function calc52WkBreakout(ltp, candles) {
  if (!candles || candles.length < 10) return null;
  const highs = candles.map((c) => +c[2]), lows = candles.map((c) => +c[3]);
  const hi52 = Math.max(...highs), lo52 = Math.min(...lows);
  const rangePos = hi52 > lo52 ? +(((ltp - lo52) / (hi52 - lo52)) * 100).toFixed(1) : 50;
  return {
    hi52: +hi52.toFixed(2), lo52: +lo52.toFixed(2), rangePos,
    breakHigh: ltp > hi52 * 0.997,
    atHigh:    ltp >= hi52 * 0.97 && ltp <= hi52 * 0.997,
    breakLow:  ltp < lo52 * 1.003,
    atLow:     ltp <= lo52 * 1.03  && ltp >= lo52 * 1.003,
  };
}

// ── Volume Surge ─────────────────────────────────────────────
export function calcVolumeSurge(candles, lookback = 20) {
  if (!candles || candles.length < 5) return null;
  const recent = candles.slice(0, lookback);
  const avgVol = recent.reduce((s, c) => s + +c[5], 0) / recent.length;
  const todayVol = +candles[0][5];
  const ratio = avgVol > 0 ? +(todayVol / avgVol).toFixed(2) : 1;
  return {
    todayVol, avgVol: +avgVol.toFixed(0), ratio,
    strong:    ratio >= 2,
    confirmed: ratio >= 1.2,
    weak:      ratio >= 0.8 && ratio < 1.2,
    dry:       ratio < 0.5,
  };
}

// ── Gap Detection ─────────────────────────────────────────────
export function detectGap(candles) {
  if (!candles || candles.length < 2) return null;
  const todayOpen = +candles[0][1], prevClose = +candles[1][4];
  if (!todayOpen || !prevClose) return null;
  const gapPct = +((todayOpen - prevClose) / prevClose * 100).toFixed(2);
  return {
    gapPct, gapUp: gapPct >= 0.5, gapDown: gapPct <= -0.5,
    bigGapUp: gapPct >= 1.5, bigGapDown: gapPct <= -1.5,
    todayOpen: +todayOpen.toFixed(2), prevClose: +prevClose.toFixed(2),
  };
}

// ── Wick Rejection ───────────────────────────────────────────
export function calcWickRejection(candles) {
  if (!candles || candles.length < 1) return null;
  const c = candles[0];
  const o = +c[1], h = +c[2], l = +c[3], cl = +c[4];
  const body      = Math.abs(cl - o);
  const range     = h - l || 1;
  const upperWick = h - Math.max(o, cl);
  const lowerWick = Math.min(o, cl) - l;
  const closePos  = range > 0 ? (cl - l) / range : 0.5;
  const bearRejected = upperWick > body * 2 && upperWick > range * 0.4; // long upper wick = bears rejected bulls
  const bullRejected = lowerWick > body * 2 && lowerWick > range * 0.4; // long lower wick = bulls rejected bears
  const bullStrong   = closePos > 0.7;
  return { upperWick: +upperWick.toFixed(2), lowerWick: +lowerWick.toFixed(2), closePos: +closePos.toFixed(2), bearRejected, bullRejected, bullStrong };
}

// ── Relative Strength vs Nifty ───────────────────────────────
export function calcRelativeStrength(closes, niftyCloses) {
  if (!closes || !niftyCloses || closes.length < 6 || niftyCloses.length < 6) return null;
  const n    = Math.min(closes.length, niftyCloses.length, 20);
  const sRet = +((closes.at(-1) - closes.at(-n)) / closes.at(-n) * 100).toFixed(2);
  const nRet = +((niftyCloses.at(-1) - niftyCloses.at(-n)) / niftyCloses.at(-n) * 100).toFixed(2);
  const rs   = +(sRet - nRet).toFixed(2);
  return { rs, stockRet: sRet, niftyRet: nRet, outperforming: rs > 1, underperforming: rs < -1, strongly: Math.abs(rs) > 3 };
}

// ── Momentum Confluence ───────────────────────────────────────
export function calcMomentumConfluence(closes, isBull) {
  if (!closes || closes.length < 35) return null;
  const rsi  = calcRSI(closes);
  const macd = calcMACD(closes);
  const rsiBull = rsi < 55 && rsi > 40;
  const rsiBear = rsi > 45 && rsi < 60;
  const macdBull = macd.bull === true;
  const macdBear = macd.bull === false;
  const bullConf = macdBull && rsiBull;
  const bearConf = macdBear && rsiBear;
  const contra   = isBull ? (!macdBull && rsi > 60) : (macdBull && rsi < 40);
  return { rsi, macdBull, macdBear, rsiBull, rsiBear, bullConf, bearConf, contra };
}

// ── Weekly MTF ────────────────────────────────────────────────
export function calcWeeklyMTF(weeklyCandles, ltp, isBull) {
  if (!weeklyCandles || weeklyCandles.length < 2) return null;
  const [wc0, wc1] = weeklyCandles;
  const wOpen  = +wc0[1], wHigh = +wc0[2], wLow = +wc0[3], wClose = +wc0[4];
  const prevWHigh = +wc1[2], prevWLow = +wc1[3];
  const wBullish   = wClose > wOpen && wClose >= wOpen + (wHigh - wOpen) * 0.5;
  const wBearish   = wClose < wOpen && wClose <= wOpen - (wOpen - wLow) * 0.5;
  const wBreakHigh = wHigh > prevWHigh, wBreakLow = wLow < prevWLow;
  const wCloses    = weeklyCandles.map((c) => +c[4]).reverse();
  const wEMA20     = wCloses.length >= 20 ? calcEMA(wCloses, 20) : null;
  const aboveWEMA  = wEMA20 != null ? ltp > wEMA20 : null;
  const aligned    = isBull ? (wBullish || wBreakHigh) && aboveWEMA !== false : (wBearish || wBreakLow) && aboveWEMA === false;
  const confirms   = isBull ? wBullish && wBreakHigh : wBearish && wBreakLow;
  return { wBullish, wBearish, wBreakHigh, wBreakLow, wEMA20: wEMA20 ? +wEMA20.toFixed(2) : null, aboveWEMA, aligned, confirms };
}

// ── Risk Calculator (PRO port) ────────────────────────────────
export function calcRisk(ltp, sl, target, atr, vix) {
  const atrPct  = atr && ltp > 0 ? (atr / ltp) * 100 : 2;
  const volRisk = atrPct < 1.5 ? 15 : atrPct < 3.0 ? 30 : atrPct < 5.0 ? 50 : 70;
  const slPct   = ltp > 0 && sl > 0 ? Math.abs((ltp - sl) / ltp) * 100 : 4;
  let posRisk   = slPct < 2 ? 10 : slPct < 4 ? 20 : slPct < 6 ? 35 : slPct < 10 ? 50 : 70;
  const rr      = sl > 0 && ltp > sl ? (target - ltp) / (ltp - sl) : 0.5;
  if (rr >= 3.0) posRisk *= 0.70; else if (rr >= 2.0) posRisk *= 0.85; else if (rr < 1.0) posRisk *= 1.30;
  posRisk = Math.min(100, posRisk);
  const mktRisk  = vix < 12 ? 10 : vix < 15 ? 20 : vix < 18 ? 30 : vix < 22 ? 45 : vix < 28 ? 60 : 80;
  const timeRisk = 15;
  return +(volRisk * 0.30 + posRisk * 0.25 + mktRisk * 0.25 + timeRisk * 0.20).toFixed(1);
}

// ── Potential Calculator (PRO port) ──────────────────────────
export function calcPotential(ltp, target, sl, numInds, rec) {
  const base = ltp > 0 ? (target - ltp) / ltp * 100 : 0;
  const rr   = Math.min(3.0, ltp > sl && sl > 0 ? (target - ltp) / (ltp - sl) : 1);
  let wr = rec === 'STRONG BUY' ? 68 : rec === 'BUY' ? 62 : rec === 'MODERATE' ? 57 : rec === 'WATCH' ? 52 : 45;
  if (numInds >= 5) wr += 8; else if (numInds >= 4) wr += 5; else if (numInds >= 3) wr += 2; else if (numInds <= 1) wr -= 6;
  wr = Math.min(75, Math.max(35, wr));
  const adj     = base * (wr / 100) * rr;
  const slDist  = ltp > 0 && sl > 0 ? Math.abs((ltp - sl) / ltp * 100) : base / 2;
  const ev      = (wr / 100) * base - (1 - wr / 100) * slDist;
  const riskAmt = sl > 0 && ltp > sl ? ltp - sl : ltp * 0.03;
  return {
    base: +base.toFixed(2), rr: +rr.toFixed(2), wr: +wr.toFixed(0),
    adj: +adj.toFixed(2), ev: +ev.toFixed(2),
    cons: +(ltp + riskAmt * 1.5).toFixed(2),
    mod:  +target.toFixed(2),
    agg:  +(ltp + riskAmt * 4.0).toFixed(2),
  };
}

// ── Confidence Calculator (PRO port) ─────────────────────────
// Technical 35% + Market 25% + Volume 20% + Pattern 20%
export function calcConfidence(rsi, macdBull, aboveMa50, aboveMa200, volRatio, patterns, vix, pcrNeutral, niftyChgPct) {
  // Technical 35%
  let tech = 50;
  if (rsi < 35)       tech = 90; else if (rsi < 45) tech = 75; else if (rsi > 70) tech = 15; else if (rsi > 60) tech = 30; else tech = 55;
  if (macdBull)       tech = Math.min(95, tech + 15); else if (macdBull === false) tech = Math.max(10, tech - 15);
  if (aboveMa50)      tech = Math.min(95, tech + 10); else if (aboveMa50 === false) tech = Math.max(10, tech - 10);
  if (aboveMa200)     tech = Math.min(95, tech + 5);  else if (aboveMa200 === false) tech = Math.max(5, tech - 5);

  // Market 25%
  let mkt = 50;
  if (vix < 13)        mkt = 80; else if (vix < 16) mkt = 65; else if (vix > 24) mkt = 20; else if (vix > 20) mkt = 30;
  if (pcrNeutral)      mkt = Math.min(80, mkt + 10);
  if (Math.abs(niftyChgPct || 0) < 0.5) mkt = Math.max(20, mkt - 10);

  // Volume 20%
  const vol = volRatio >= 2 ? 95 : volRatio >= 1.2 ? 70 : volRatio >= 0.8 ? 40 : 20;

  // Pattern 20%
  const bullPatterns = ['BULLISH_ENGULFING','HAMMER','MORNING_STAR'];
  const bearPatterns = ['BEARISH_ENGULFING'];
  const hasBull = patterns?.some((p) => bullPatterns.includes(p));
  const hasBear = patterns?.some((p) => bearPatterns.includes(p));
  const pat = hasBull ? 85 : hasBear ? 20 : 50;

  return Math.min(98, Math.max(5, Math.round(tech * 0.35 + mkt * 0.25 + vol * 0.20 + pat * 0.20)));
}

// ── IV Percentile ─────────────────────────────────────────────
export function calcIVPercentile(iv, closes) {
  if (!iv || iv <= 0 || !closes || closes.length < 30) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const recent = returns.slice(-20);
  const mean   = recent.reduce((s, r) => s + r, 0) / recent.length;
  const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
  const hv20   = +(Math.sqrt(variance * 252) * 100).toFixed(1);
  const ivHvRatio = hv20 > 0 ? +(iv / hv20).toFixed(2) : 1;
  const cheap  = ivHvRatio < 0.75;
  const rich   = ivHvRatio > 1.30;
  return { iv: +iv.toFixed(1), hv20, ivHvRatio, cheap, rich, fair: !cheap && !rich };
}

// ── Intraday Phase ────────────────────────────────────────────
export function getIntradayPhase() {
  const now  = new Date();
  const h    = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }) % 24;
  const m    = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: 'numeric' });
  const day  = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return 'holiday';
  const total = h * 60 + m;
  if (total < 9 * 60 + 15)  return 'pre';
  if (total > 15 * 60 + 30) return 'closed';
  if (total <= 9 * 60 + 45)  return 'opening';
  if (total <= 10 * 60 + 30) return 'early';
  if (total <= 14 * 60)      return 'midday';
  if (total <= 15 * 60)      return 'pre_close';
  return 'closing';
}

// ── Composite Breakout Score (0–10) ──────────────────────────
export function boScore(ema, pdhl, st, vol, wk52, mom, nr7, bb, weeklyMTF, gap, adx, rs, wick, sectorScore, phase) {
  let bull = 0, bear = 0;
  if (ema) {
    if (ema.goldenCross)     bull += 4;
    else if (ema.deathCross) bear += 4;
    else if (ema.nearCross)  { bull += 2; bear += 2; }
    else if (ema.uptrend)    bull += 1;
    else                     bear += 1;
  }
  if (pdhl) {
    if (pdhl.bullBreakout)      bull += 3; else if (pdhl.bearBreakout) bear += 3;
    else if (pdhl.nearPDH)      bull += 1; else if (pdhl.nearPDL)      bear += 1;
  }
  if (st) { if (st.crossed) { st.trend === 'UP' ? (bull += 3) : (bear += 3); } else { st.trend === 'UP' ? (bull += 1) : (bear += 1); } }
  if (vol) {
    const vPts = vol.strong ? 3 : vol.confirmed ? 2 : vol.weak ? 1 : 0;
    bull += vPts; bear += vPts;
    if (vol.dry) { bull = Math.max(0, bull - 1); bear = Math.max(0, bear - 1); }
  }
  if (wk52) {
    if (wk52.breakHigh) bull += 3; else if (wk52.atHigh) bull += 2;
    if (wk52.breakLow)  bear += 3; else if (wk52.atLow)  bear += 2;
  }
  if (mom) {
    if (mom.bullConf) bull += 2; else if (mom.rsiBull || mom.macdBull) bull += 1;
    if (mom.bearConf) bear += 2; else if (mom.rsiBear || mom.macdBear) bear += 1;
  }
  if (nr7 && (nr7.isNR7 || nr7.isNR4))         { bull += 2; bear += 2; }
  if (bb  && (bb.squeeze || bb.extremeSqueeze)) { bull += 2; bear += 2; }
  if (weeklyMTF) {
    if (weeklyMTF.confirms)     { bull += 2; bear += 2; }
    else if (weeklyMTF.aligned) { weeklyMTF.wBullish ? (bull += 1) : (bear += 1); }
  }
  if (gap) {
    if (gap.bigGapUp)   bull += 2; else if (gap.gapUp)   bull += 1;
    if (gap.bigGapDown) bear += 2; else if (gap.gapDown) bear += 1;
  }
  if (adx) {
    if (adx.strong)  { bull += 1; bear += 1; }
    if (adx.adx < 20) { bull = Math.max(0, bull - 2); bear = Math.max(0, bear - 2); }
  }
  if (rs) {
    if (rs.outperforming  && rs.strongly) bull += 1;
    if (rs.underperforming && rs.strongly) bear += 1;
  }
  if (wick) {
    if (wick.bearRejected) bull = Math.max(0, bull - 3);
    if (wick.bullRejected) bear = Math.max(0, bear - 3);
    if (wick.bullStrong)   { bull += 1; bear += 1; }
  }
  if (sectorScore > 0) bull += 1; else if (sectorScore < 0) bear += 1;
  const phaseMulti = phase === 'midday' ? 1.0 : phase === 'early' ? 0.95 : phase === 'pre_close' ? 0.9 : 0.8;
  const finalBull  = Math.min(10, Math.round(bull * phaseMulti));
  const finalBear  = Math.min(10, Math.round(bear * phaseMulti));
  return { bullScore: finalBull, bearScore: finalBear, score: Math.max(finalBull, finalBear) };
}

export function boDirection(ema, pdhl, st) {
  let bull = 0, bear = 0;
  if (ema?.goldenCross)     bull += 3; if (ema?.deathCross)      bear += 3;
  if (ema?.uptrend)         bull += 1; if (ema && !ema.uptrend)  bear += 1;
  if (pdhl?.bullBreakout)   bull += 3; if (pdhl?.bearBreakout)   bear += 3;
  if (pdhl?.nearPDH)        bull += 1; if (pdhl?.nearPDL)        bear += 1;
  if (st?.trend === 'UP')   bull += 2; if (st?.trend === 'DOWN') bear += 2;
  return bull >= bear ? 'BULL' : 'BEAR';
}

// ── SL / Target for breakout ──────────────────────────────────
export function boSLTarget(ltp, atr, isBull, pdh, pdl, ema200) {
  const atrMult = 1.5;
  let sl, target;
  if (isBull) {
    sl     = pdl > 0 ? Math.min(ltp - atr * atrMult, pdl * 0.99) : ltp - atr * atrMult;
    target = pdh > ltp ? pdh * 1.005 : ltp + atr * 3;
  } else {
    sl     = pdh > 0 ? Math.max(ltp + atr * atrMult, pdh * 1.01) : ltp + atr * atrMult;
    target = pdl < ltp ? pdl * 0.995 : ltp - atr * 3;
  }
  sl = Math.max(0, +sl.toFixed(2)); target = Math.max(0, +target.toFixed(2));
  const rr = sl > 0 && ltp !== sl ? +((Math.abs(target - ltp) / Math.abs(ltp - sl))).toFixed(2) : 1;
  return { sl, target, rr };
}

// ── Fibonacci Levels ──────────────────────────────────────────
export function calcFibLevels(swingLow, swingHigh) {
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  return {
    range, swingLow, swingHigh,
    fib236: +(swingHigh - range * 0.236).toFixed(2),
    fib382: +(swingHigh - range * 0.382).toFixed(2),
    fib500: +(swingHigh - range * 0.500).toFixed(2),
    fib618: +(swingHigh - range * 0.618).toFixed(2),
    fib786: +(swingHigh - range * 0.786).toFixed(2),
    ext618: +(swingHigh + range * 0.618).toFixed(2),
    ext100: +(swingHigh + range * 1.000).toFixed(2),
    ext162: +(swingHigh + range * 1.618).toFixed(2),
  };
}

// ── Professional SL (VIX + RSI + ATR + Pivot) ────────────────
export function calcProfessionalSL(entry, sr, atr, swingL, low, vix, rsi) {
  const v        = atr || entry * 0.02;
  const liveVix  = vix || 15;
  const vixMult  = 1.3 + liveVix / 100;
  const rsiAdj   = (rsi || 50) > 70 ? -0.15 : (rsi || 50) < 35 ? 0.15 : 0;
  const finalMult = vixMult + rsiAdj;
  const atrSL    = +(entry - v * finalMult).toFixed(2);
  const slSwing  = swingL > 0 ? +(swingL * 0.995).toFixed(2) : 0;
  const slS1     = sr?.pivotS1 > 0 ? +(sr.pivotS1 * 0.995).toFixed(2) : 0;
  let sl = atrSL;
  if (slSwing > 0 && sl > slSwing) sl = slSwing;
  if (slS1    > 0 && sl > slS1)    sl = slS1;
  sl = Math.min(sl, +(entry - v * 1.0).toFixed(2));
  sl = Math.max(sl, +(entry - v * 3.0).toFixed(2));
  if (low > 0) sl = Math.max(sl, +(low * 0.99).toFixed(2));
  return +sl.toFixed(2);
}

// ── Professional Targets (R2/R1 Pivot + Fibonacci) ───────────
export function calcProfessionalTargets(entry, sl, sr, atr, vix) {
  let risk = entry - sl;
  if (risk <= 0) risk = entry * 0.02;
  const r1   = sr?.pivotR1 || 0, r2 = sr?.pivotR2 || 0;
  const w52H = sr?.week52H || 0, v  = atr || risk;
  const rrOf = (t) => risk > 0 ? (t - entry) / risk : 0;
  const rrT15 = +(entry + risk * 1.5).toFixed(2);
  let cons = (r1 > entry && rrOf(r1) >= 1.2 && rrOf(r1) <= 3.0) ? +r1.toFixed(2) : rrT15;
  const rrT20 = +(entry + risk * 2.0).toFixed(2);
  let mod;
  if (r2 > entry && rrOf(r2) >= 1.8 && rrOf(r2) <= 4.0)      mod = +r2.toFixed(2);
  else if (r1 > entry && rrOf(r1) >= 1.8)                      mod = +r1.toFixed(2);
  else                                                          mod = rrT20;
  const fibT3 = +(entry + risk * 1.618).toFixed(2);
  let agg = Math.max(fibT3, +(entry + risk * 3.0).toFixed(2));
  if (w52H > entry && w52H < agg) agg = +w52H.toFixed(2);
  if ((vix || 15) > 22) agg = Math.min(agg, +(entry + risk * 2.5).toFixed(2));
  mod = Math.max(mod, +(cons + risk * 0.5).toFixed(2));
  agg = Math.max(agg, +(mod  + risk * 0.5).toFixed(2));
  return { cons, mod, agg, rrCons: +rrOf(cons).toFixed(2), rrMod: +rrOf(mod).toFixed(2), rrAgg: +rrOf(agg).toFixed(2), risk: +risk.toFixed(2) };
}

// ── Smart Options SL/Target (IV + DTE + Delta) ───────────────
export function calcSmartOptionSLTarget(entry, spot, strike, iv, delta, theta, expiry, vix) {
  const today   = new Date();
  const expDate = expiry ? new Date(expiry) : today;
  const dte     = Math.max(0, Math.round((expDate - today) / 86400000));
  const ivDec   = (iv || 20) / 100;
  const timeFrac = dte === 0 ? (1 / 252) * 0.5 : (1 / 252);
  const dailySpotMove    = spot * ivDec * Math.sqrt(timeFrac);
  const absDelta         = Math.abs(delta) || 0.4;
  const dailyPremiumMove = dailySpotMove * absDelta;
  const liveVix   = vix || 15;
  const vixFactor = liveVix > 20 ? 1.15 : liveVix < 13 ? 0.90 : 1.0;
  const moneyness = spot > 0 ? Math.abs(strike - spot) / spot : 0;
  const atmFactor = moneyness < 0.01 ? 1.1 : moneyness > 0.04 ? 0.85 : 1.0;
  const thetaEatsPct = entry > 0 ? Math.abs(theta || 0) / entry : 0;
  let slMinPct, slMaxPct;
  if (absDelta >= 0.45)       { slMinPct = 0.15; slMaxPct = 0.25; }
  else if (absDelta >= 0.35)  { slMinPct = 0.20; slMaxPct = 0.30; }
  else                        { slMinPct = 0.15; slMaxPct = 0.25; }
  const slWidth = dailyPremiumMove * vixFactor * atmFactor;
  const rawSL   = entry - Math.max(slWidth, entry * slMinPct);
  const sl      = +Math.min(entry * (1 - slMinPct), Math.max(entry * (1 - slMaxPct), rawSL)).toFixed(2);
  const risk    = entry - sl;
  let baseRR = dte === 0 ? 1.2 : dte <= 2 ? 1.5 : dte <= 7 ? 1.8 : 2.0;
  if (thetaEatsPct > 0.10) baseRR = Math.max(1.2, baseRR - 0.30);
  else if (thetaEatsPct > 0.06) baseRR = Math.max(1.2, baseRR - 0.15);
  const maxGainPct = dte === 0 ? 0.40 : dte <= 2 ? 0.60 : 1.00;
  const rawTarget  = +(entry + risk * baseRR).toFixed(2);
  const tgt        = +Math.min(entry * (1 + maxGainPct), rawTarget).toFixed(2);
  const rr         = risk > 0 ? +((tgt - entry) / risk).toFixed(2) : baseRR;
  return { sl, tgt, rr, dte, method: `IV ${(iv||20).toFixed(0)}% | DTE ${dte} | Δ ${absDelta.toFixed(2)}` };
}

// ── Max Pain ─────────────────────────────────────────────────
export function calcMaxPain(chain) {
  if (!chain || chain.length < 3) return 0;
  const strikes = chain.map((r) => r.strike_price).filter(Boolean).sort((a, b) => a - b);
  let minLoss = Infinity, maxPainStrike = strikes[0];
  for (const testStrike of strikes) {
    let totalLoss = 0;
    for (const row of chain) {
      const sp     = row.strike_price;
      const callOI = row.call_options?.market_data?.oi || 0;
      const putOI  = row.put_options?.market_data?.oi  || 0;
      if (testStrike > sp) totalLoss += (testStrike - sp) * callOI;
      if (testStrike < sp) totalLoss += (sp - testStrike) * putOI;
    }
    if (totalLoss < minLoss) { minLoss = totalLoss; maxPainStrike = testStrike; }
  }
  return maxPainStrike;
}

// ── OI Walls ─────────────────────────────────────────────────
export function calcOIWalls(chain) {
  if (!chain || chain.length < 3) return { callWall: 0, putWall: 0 };
  let maxCallOI = 0, maxPutOI = 0, callWall = 0, putWall = 0;
  for (const row of chain) {
    const callOI = row.call_options?.market_data?.oi || 0;
    const putOI  = row.put_options?.market_data?.oi  || 0;
    if (callOI > maxCallOI) { maxCallOI = callOI; callWall = row.strike_price; }
    if (putOI  > maxPutOI)  { maxPutOI  = putOI;  putWall  = row.strike_price; }
  }
  return { callWall, putWall, callWallOI: maxCallOI, putWallOI: maxPutOI };
}

// ── FII/DII Interpretation ────────────────────────────────────
export function interpretFIIDII(d) {
  if (!d) return { bias: 0, label: 'No Data', color: '#94a3b8', detail: '' };
  const fiiNet = d.fii_net || 0, diiNet = d.dii_net || 0;
  const netFlow = fiiNet + diiNet;
  let cashBias = netFlow > 5000 ? 10 : netFlow > 2000 ? 7 : netFlow > 500 ? 4 : netFlow > -500 ? 0 : netFlow > -2000 ? -4 : netFlow > -5000 ? -7 : -10;
  if (fiiNet > 1000)  cashBias = Math.min(cashBias + 2, 10);
  if (fiiNet < -1000) cashBias = Math.max(cashBias - 2, -10);
  let futBias = 0;
  const futLong = d.fii_idx_fut_long || 0, futShort = d.fii_idx_fut_short || 0;
  if (futLong + futShort > 0) {
    const lp = futLong / (futLong + futShort) * 100;
    futBias = lp > 65 ? 5 : lp > 55 ? 3 : lp > 45 ? 0 : lp > 35 ? -3 : -5;
  }
  const totalBias = cashBias + futBias;
  const label = totalBias >= 8 ? 'STRONG BUY' : totalBias >= 3 ? 'FII BUYING' : totalBias >= -2 ? 'NEUTRAL' : totalBias >= -7 ? 'FII SELLING' : 'HEAVY SELL';
  const color = totalBias >= 8 ? '#16a34a' : totalBias >= 3 ? '#22c55e' : totalBias >= -2 ? '#d97706' : totalBias >= -7 ? '#f97316' : '#dc2626';
  const crFmt = (v) => (v >= 0 ? '+₹' : '-₹') + Math.abs(v).toFixed(0) + ' Cr';
  return { bias: totalBias, label, color, detail: `FII ${crFmt(fiiNet)} · DII ${crFmt(diiNet)} · Net ${crFmt(netFlow)}`, fiiNet, diiNet, netFlow };
}

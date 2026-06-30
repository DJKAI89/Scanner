// ── Technical Analysis Engine — EXACT port from index.html ──

// ── EMA ──────────────────────────────────────────────────────
export function calcEMA(closes, period) {
  if (!closes || closes.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return +ema.toFixed(2);
}

export function calcEMACrossover(closes) {
  if (!closes || closes.length < 10) return null;
  const e50  = calcEMA(closes, Math.min(50,  closes.length));
  const e200 = calcEMA(closes, Math.min(200, closes.length));
  const prev50  = calcEMA(closes.slice(0, -1), Math.min(50,  closes.length - 1));
  const prev200 = calcEMA(closes.slice(0, -1), Math.min(200, closes.length - 1));
  const ltp = closes[closes.length - 1];
  const goldenCross = closes.length >= 200 && prev50 <= prev200 && e50 > e200;
  const deathCross  = closes.length >= 200 && prev50 >= prev200 && e50 < e200;
  const nearCross   = closes.length >= 50 && !goldenCross && !deathCross && Math.abs(e50 - e200) / (e200 || 1) < 0.005;
  const uptrend     = e50 > e200 || (closes.length < 200 && ltp > e50);
  return { e50, e200, ema50: e50, ema200: e200, goldenCross, deathCross, nearCross, uptrend };
}

// ── RSI ──────────────────────────────────────────────────────
export function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0); losses.push(d < 0 ? -d : 0);
  }
  const sl = (arr) => arr.slice(-period);
  const avgG = sl(gains).reduce((s, v) => s + v, 0) / period || 1e-10;
  const avgL = sl(losses).reduce((s, v) => s + v, 0) / period || 1e-10;
  return +(100 - 100 / (1 + avgG / avgL)).toFixed(2);
}

// ── RSI Divergence ────────────────────────────────────────────
// Exact port of HTML detectRSIDivergence — swing high/low based
export function calcRSIDivergence(candlesOrCloses, period = 14) {
  const result = { bullish: false, bearish: false, hidden_bullish: false, hidden_bearish: false, strength: 0 };
  // Accept either candles (2D newest-first) or closes (1D oldest-first)
  let candles;
  if (Array.isArray(candlesOrCloses[0])) {
    candles = candlesOrCloses; // already candles newest-first
  } else {
    // closes oldest-first — convert to fake candles (close only, newest-first)
    candles = [...candlesOrCloses].reverse().map(c => [0, c, c, c, c, 0]);
  }
  if (!candles || candles.length < 20) return result;
  const closes = candles.map(c => +c[4]).reverse(); // oldest-first
  if (closes.length < 16) return result;

  // Build RSI array
  const rsiArr = [];
  for (let end = 15; end <= closes.length; end++) rsiArr.push(calcRSI(closes.slice(0, end)));

  const n = Math.min(15, candles.length - 1);
  const swingLows = [], swingHighs = [];
  for (let i = 1; i < n - 1; i++) {
    const price  = +candles[i][4];
    const rsiIdx = rsiArr.length - 1 - i;
    if (rsiIdx < 0 || rsiIdx >= rsiArr.length) continue;
    const rsi = rsiArr[rsiIdx];
    if (!rsi) continue;
    if (price < +candles[i-1][4] && price < +candles[i+1][4]) swingLows.push({ i, price, rsi });
    if (price > +candles[i-1][4] && price > +candles[i+1][4]) swingHighs.push({ i, price, rsi });
  }

  const currPrice = +candles[0][4];
  const currRSI   = rsiArr[rsiArr.length - 1];
  if (!currRSI) return result;

  // Bullish: price lower low, RSI higher low
  if (swingLows.length >= 1) {
    const prev = swingLows[0];
    if (currPrice < prev.price && currRSI > prev.rsi + 2) {
      result.bullish  = true;
      result.strength = Math.round((currRSI - prev.rsi) * 2);
    }
  }
  // Bearish: price higher high, RSI lower high
  if (swingHighs.length >= 1) {
    const prev = swingHighs[0];
    if (currPrice > prev.price && currRSI < prev.rsi - 2) {
      result.bearish  = true;
      result.strength = Math.round((prev.rsi - currRSI) * 2);
    }
  }
  // Hidden bullish: price higher low, RSI lower low
  if (swingLows.length >= 1) {
    const prev = swingLows[0];
    if (currPrice > prev.price && currRSI < prev.rsi - 2 && currRSI < 50) result.hidden_bullish = true;
  }
  // Hidden bearish: price lower high, RSI higher high
  if (swingHighs.length >= 1) {
    const prev = swingHighs[0];
    if (currPrice < prev.price && currRSI > prev.rsi + 2 && currRSI > 50) result.hidden_bearish = true;
  }
  return result;
}
export function calcMACD(closes) {
  if (!closes || closes.length < 35) return { macdLine: 0, signal: 0, hist: 0, bull: null, bullCross: false, bearCross: false, histRising: false, bullish: false };
  const fast = calcEMA(closes, 12), slow = calcEMA(closes, 26);
  const macdLine = fast - slow;
  const macdValues = [];
  for (let i = 9; i <= closes.length; i++) macdValues.push(calcEMA(closes.slice(0, i), 12) - calcEMA(closes.slice(0, i), 26));
  const signal = calcEMA(macdValues, 9);
  const hist = macdLine - signal;
  const prevMacdValues = macdValues.slice(0, -1);
  const prevSignal = calcEMA(prevMacdValues, 9);
  const prevMacdLine = prevMacdValues[prevMacdValues.length - 1] || 0;
  const prevHist = prevMacdLine - prevSignal;
  const bullCross = prevMacdLine <= prevSignal && macdLine > signal;
  const bearCross = prevMacdLine >= prevSignal && macdLine < signal;
  const histRising = hist > prevHist;
  const bullish = macdLine > signal;
  return { macdLine: +macdLine.toFixed(4), signal: +signal.toFixed(4), hist: +hist.toFixed(4), bull: bullish, bullCross, bearCross, histRising, bullish };
}

// ── ATR ───────────────────────────────────────────────────────
export function calcATR(candles, period = 14) {
  if (!candles || candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = +candles[i][2], l = +candles[i][3], pc = +candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return +(trs.slice(-period).reduce((s, v) => s + v, 0) / Math.min(period, trs.length)).toFixed(2);
}

// ── Supertrend (7,3) ─────────────────────────────────────────
export function calcSupertrend(candles, period = 7, mult = 3) {
  if (!candles || candles.length < period + 2) return null;
  const data = candles.slice().reverse();
  const atrs = [];
  for (let i = 1; i < data.length; i++) {
    const h = +data[i][2], l = +data[i][3], pc = +data[i - 1][4];
    atrs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let trend = 'UP', prevUB = 0, prevLB = 0, crossed = false;
  for (let i = period; i < data.length; i++) {
    const atr = atrs.slice(i - period, i).reduce((s, v) => s + v, 0) / period;
    const hl2 = (+data[i][2] + +data[i][3]) / 2;
    const ub = hl2 + mult * atr, lb = hl2 - mult * atr;
    const finalUB = ub < prevUB || +data[i - 1][4] > prevUB ? ub : prevUB;
    const finalLB = lb > prevLB || +data[i - 1][4] < prevLB ? lb : prevLB;
    const prevTrend = trend;
    const close = +data[i][4];
    if (prevTrend === 'DOWN' && close > finalUB) trend = 'UP';
    else if (prevTrend === 'UP' && close < finalLB) trend = 'DOWN';
    if (i === data.length - 1 && prevTrend !== trend) crossed = true;
    prevUB = finalUB; prevLB = finalLB;
  }
  const last = data[data.length - 1];
  const value = trend === 'UP' ? prevLB : prevUB;
  return { trend, crossed, value: +value.toFixed(2), dist: +((+last[4] - value) / +last[4] * 100).toFixed(2) };
}

// ── Bollinger Bands Advanced ──────────────────────────────────
export function calcBBSqueeze(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const recent  = closes.slice(-period);
  const mean    = recent.reduce((s, v) => s + v, 0) / period;
  const std     = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const upper   = mean + 2 * std, lower = mean - 2 * std;
  const ltp     = closes[closes.length - 1];
  const percentB = std > 0 ? (ltp - lower) / (upper - lower) : 0.5;
  const bw      = mean > 0 ? +((upper - lower) / mean * 100).toFixed(2) : 0;

  // Historical squeeze: same as HTML — bw at 20-period low (need 50+ points)
  let squeeze = false, extremeSqueeze = false;
  if (closes.length >= period + 30) {
    const bwHistory = [];
    for (let i = period; i <= closes.length; i++) {
      const sl = closes.slice(i - period, i);
      const m  = sl.reduce((a, b) => a + b, 0) / period;
      const s  = Math.sqrt(sl.reduce((a, x) => a + (x - m) ** 2, 0) / period);
      bwHistory.push(m > 0 ? (m + 2*s - (m - 2*s)) / m * 100 : 0);
    }
    const mn = Math.min(...bwHistory), mx = Math.max(...bwHistory);
    squeeze       = bw < mn + (mx - mn) * 0.2;
    extremeSqueeze = bw < mn + (mx - mn) * 0.05;
  }

  // nearLowerBand: HTML uses ltp <= mid - sd*0.8 && ltp >= mid - sd*2.2
  const nearLowerBand = ltp <= mean - std * 0.8 && ltp >= mean - std * 2.2;

  return {
    upper: +upper.toFixed(2), lower: +lower.toFixed(2), mean: +mean.toFixed(2),
    bw, squeeze, extremeSqueeze,
    aboveUpper: ltp > upper, belowLower: ltp < lower,
    nearLowerBand, nearUpperBand: percentB > 0.8,
    percentB: +percentB.toFixed(3),
  };
}

// ── ADX Advanced ──────────────────────────────────────────────
export function calcADX(candles, period = 14) {
  if (!candles || candles.length < period + 2) return null;
  const data = candles.slice().reverse();
  const trs = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < data.length; i++) {
    const h = +data[i][2], l = +data[i][3], ph = +data[i-1][2], pl = +data[i-1][3], pc = +data[i-1][4];
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const u = h - ph, d = pl - l;
    plusDMs.push(u > d && u > 0 ? u : 0);
    minusDMs.push(d > u && d > 0 ? d : 0);
  }
  const sl = (arr) => arr.slice(-period);
  const sTR = sl(trs).reduce((s,v)=>s+v,0) || 1;
  const plusDI  = sl(plusDMs).reduce((s,v)=>s+v,0) / sTR * 100;
  const minusDI = sl(minusDMs).reduce((s,v)=>s+v,0) / sTR * 100;
  const adx = +( Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100 ).toFixed(1);
  const bullTrend = adx >= 25 && plusDI > minusDI;
  const bearTrend = adx >= 25 && minusDI > plusDI;
  const trending  = adx >= 20;
  const weakTrend = adx >= 15 && adx < 20;
  return { adx, plusDI: +plusDI.toFixed(1), minusDI: +minusDI.toFixed(1), bullTrend, bearTrend, trending, weakTrend, strong: adx >= 25 };
}

// ── Pivot Points ──────────────────────────────────────────────
export function calcPivots(high, low, close) {
  const pp = (high + low + close) / 3;
  return {
    pp:     +pp.toFixed(2),
    pivotR1: +(2 * pp - low).toFixed(2),
    pivotR2: +(pp + (high - low)).toFixed(2),
    pivotS1: +(2 * pp - high).toFixed(2),
    pivotS2: +(pp - (high - low)).toFixed(2),
  };
}

// ── Support & Resistance (includes Pivots + 52-week) ─────────
export function calcSR(candles, lookback = 20) {
  if (!candles || candles.length < 2) return { support: 0, resistance: 0 };
  const recent  = candles.slice(0, lookback);
  const support     = +Math.min(...recent.map(c => +c[3])).toFixed(2);
  const resistance  = +Math.max(...recent.map(c => +c[2])).toFixed(2);
  const prevH = +candles[1][2], prevL = +candles[1][3], prevC = +candles[1][4];
  const pivots = calcPivots(prevH, prevL, prevC);
  const week52H = +Math.max(...candles.map(c => +c[2])).toFixed(2);
  const week52L = +Math.min(...candles.map(c => +c[3])).toFixed(2);
  return { support, resistance, week52H, week52L, ...pivots };
}

export function isNearSupport(ltp, sr, low) {
  if (!sr || !ltp) return false;
  const threshold = 0.02; // within 2%
  if (sr.pivotS1 > 0 && Math.abs((ltp - sr.pivotS1) / ltp) < threshold) return true;
  if (sr.pivotS2 > 0 && Math.abs((ltp - sr.pivotS2) / ltp) < threshold) return true;
  if (low > 0 && Math.abs((ltp - low) / ltp) < threshold) return true;
  return false;
}

// ── VWAP ─────────────────────────────────────────────────────
export function calcVWAP(candles) {
  let tpv = 0, vol = 0;
  for (const c of candles) { const tp = (+c[2] + +c[3] + +c[4]) / 3; tpv += tp * +c[5]; vol += +c[5]; }
  return vol > 0 ? +(tpv / vol).toFixed(2) : 0;
}

export function calcVWAPBands(candles) {
  if (!candles || candles.length < 5) return null;
  const recent = candles.slice(0, 20);
  let sumPV = 0, sumV = 0;
  const tpArr = [];
  for (const c of recent) {
    const tp = (+c[2] + +c[3] + +c[4]) / 3, v = +c[5] || 1;
    sumPV += tp * v; sumV += v; tpArr.push({ tp, v });
  }
  if (sumV === 0) return null;
  const vwap = sumPV / sumV;
  let sumPV2 = 0;
  for (const { tp, v } of tpArr) sumPV2 += (tp - vwap) ** 2 * v;
  const sd  = Math.sqrt(sumPV2 / sumV);
  const ltp = +candles[0][4];
  // SD-based positions — exact match with HTML
  let position;
  if      (ltp > vwap + sd * 2) position = 'FAR_ABOVE';
  else if (ltp > vwap + sd)     position = 'ABOVE_1SD';
  else if (ltp > vwap)          position = 'ABOVE_VWAP';
  else if (ltp > vwap - sd)     position = 'BELOW_VWAP';
  else if (ltp > vwap - sd * 2) position = 'BELOW_1SD';
  else                          position = 'FAR_BELOW';
  const distPct = +((ltp - vwap) / vwap * 100).toFixed(2);
  return {
    vwap:       +vwap.toFixed(2),
    upper1:     +(vwap + sd).toFixed(2),
    upper2:     +(vwap + sd * 2).toFixed(2),
    lower1:     +(vwap - sd).toFixed(2),
    lower2:     +(vwap - sd * 2).toFixed(2),
    sd:         +sd.toFixed(2),
    position,
    distPct,
    aboveVWAP:  ltp >= vwap,
    // nearLowerBand: HTML = ltp <= vwap-sd*0.8 && ltp >= vwap-sd*2.2
    nearLowerBand: ltp <= vwap - sd * 0.8 && ltp >= vwap - sd * 2.2,
  };
}

// ── Candle Patterns — returns object with boolean fields ──────
export function detectPatterns(candles) {
  if (!candles || candles.length < 3) return {};
  const c0 = { o:+candles[0][1], h:+candles[0][2], l:+candles[0][3], c:+candles[0][4] };
  const c1 = { o:+candles[1][1], h:+candles[1][2], l:+candles[1][3], c:+candles[1][4] };
  const c2 = { o:+candles[2][1], h:+candles[2][2], l:+candles[2][3], c:+candles[2][4] };
  const body0 = Math.abs(c0.c - c0.o), range0 = c0.h - c0.l || 1;
  const body1 = Math.abs(c1.c - c1.o);
  const lowerWick0 = Math.min(c0.o, c0.c) - c0.l;
  const upperWick0 = c0.h - Math.max(c0.o, c0.c);

  const hammer           = c0.c > c0.o && lowerWick0 > body0 * 2 && upperWick0 < body0 * 0.5;
  const shootingStar     = c0.c < c0.o && upperWick0 > body0 * 2 && lowerWick0 < body0 * 0.5;
  const doji             = body0 < range0 * 0.1;
  const bullishEngulfing = c1.c < c1.o && c0.c > c0.o && c0.o <= c1.c && c0.c >= c1.o;
  const bearishEngulfing = c1.c > c1.o && c0.c < c0.o && c0.o >= c1.c && c0.c <= c1.o;
  const morningStar      = c2.c < c2.o && body1 < body0 * 0.3 && c0.c > c0.o && c0.c > (c2.o + c2.c) / 2;
  const eveningStar      = c2.c > c2.o && body1 < body0 * 0.3 && c0.c < c0.o && c0.c < (c2.o + c2.c) / 2;

  return { hammer, shootingStar, doji, bullishEngulfing, bearishEngulfing, morningStar, eveningStar };
}

// ── Pivot/PDH/PDL Breakout ────────────────────────────────────
export function detectPDHLBreakout(ltp, candles) {
  if (!candles || candles.length < 2) return null;
  const pdh = +candles[1][2], pdl = +candles[1][3], pdc = +candles[1][4];
  if (!pdh || !pdl || pdh <= 0 || pdl <= 0) return null;
  const pdHDist = pdh > 0 ? +((ltp - pdh) / pdh * 100).toFixed(2) : 0;
  const pdLDist = pdl > 0 ? +((ltp - pdl) / pdl * 100).toFixed(2) : 0;
  return {
    pdh, pdl, pdc,
    bullBreakout: pdHDist > 0.3,
    bearBreakout: pdLDist < -0.3,
    nearPDH: pdHDist > -0.7 && pdHDist <= 0.3,
    nearPDL: pdLDist < 0.7 && pdLDist >= -0.3,
    pdHDist, pdLDist,
  };
}

export function calc52WkBreakout(ltp, candles) {
  if (!candles || candles.length < 20) return null;
  const yr = candles.slice(0, Math.min(252, candles.length));
  const hi52 = Math.max(...yr.map(c => +c[2]));
  const lo52 = Math.min(...yr.map(c => +c[3]));
  if (!hi52 || !lo52) return null;
  const rangePos = hi52 > lo52 ? +(((ltp - lo52) / (hi52 - lo52)) * 100).toFixed(1) : 50;
  return {
    hi52: +hi52.toFixed(2),
    lo52: +lo52.toFixed(2),
    rangePos,
    breakHigh: ltp > hi52 * 1.005,
    atHigh: ltp >= hi52 * 0.995,
    breakLow: ltp < lo52 * 0.995,
    atLow: ltp <= lo52 * 1.005,
  };
}

export function calcVolumeSurge(candles, lookback = 20) {
  if (!candles || candles.length < 6) return null;
  const todayVol = +candles[0][5];
  if (!todayVol || todayVol <= 0) return null;
  const past = candles.slice(1, Math.min(lookback + 1, candles.length));
  if (past.length < 5) return null;
  const avgVol = past.reduce((s, c) => s + +c[5], 0) / past.length;
  if (!avgVol || avgVol <= 0) return null;
  const ratio = avgVol > 0 ? +(todayVol / avgVol).toFixed(2) : 1;
  return {
    todayVol,
    avgVol: +avgVol.toFixed(0),
    ratio,
    confirmed: ratio >= 1.5,
    strong: ratio >= 2.5,
    weak: ratio >= 1.0 && ratio < 1.5,
    dry: ratio < 0.8,
  };
}

export function detectGap(candles) {
  if (!candles || candles.length < 2) return null;
  const todayOpen = +candles[0][1], prevClose = +candles[1][4];
  if (!todayOpen || !prevClose) return null;
  const gapPct = +((todayOpen - prevClose) / prevClose * 100).toFixed(2);
  return { gapPct, gapUp: gapPct >= 0.5, gapDown: gapPct <= -0.5, bigGapUp: gapPct >= 1.5, bigGapDown: gapPct <= -1.5, todayOpen: +todayOpen.toFixed(2), prevClose: +prevClose.toFixed(2) };
}

export function calcWickRejection(candles) {
  if (!candles || candles.length < 1) return null;
  const c = candles[0], o = +c[1], h = +c[2], l = +c[3], cl = +c[4];
  const body = Math.abs(cl - o), range = h - l || 1;
  const upperWick = h - Math.max(o, cl), lowerWick = Math.min(o, cl) - l;
  const closePos = range > 0 ? (cl - l) / range : 0.5;
  return { upperWick: +upperWick.toFixed(2), lowerWick: +lowerWick.toFixed(2), closePos: +closePos.toFixed(2), bearRejected: upperWick > body * 2 && upperWick > range * 0.4, bullRejected: lowerWick > body * 2 && lowerWick > range * 0.4, bullStrong: closePos > 0.7 };
}

export function calcNR7(candles) {
  if (!candles || candles.length < 7) return null;
  const ranges = candles.slice(0, 7).map(c => +c[2] - +c[3]);
  const todayR = ranges[0];
  return { isNR7: todayR === Math.min(...ranges), isNR4: todayR === Math.min(...ranges.slice(0, 4)), range: +todayR.toFixed(2), avgRange: +(ranges.reduce((s,v)=>s+v,0)/7).toFixed(2) };
}

// ── Market regime detection ───────────────────────────────────
// Classifies the current market into a regime bucket from a normalized
// trend-strength signal (0 = no clear direction, 1 = strongly trending) and
// VIX, then suppresses confidence in choppy/high-vol conditions — where false
// breakouts cluster — and gives a small boost to calm trending conditions.
// normTrendStrength should already be 0-1 by the time it reaches here; each
// caller normalizes its own best-available trend signal (compositeScore where
// computed, day-change % as a lighter proxy where it isn't).
export function classifyMarketRegime(normTrendStrength, vix) {
  const ts = Math.max(0, Math.min(1, normTrendStrength || 0));
  const highVol = (vix || 0) >= 22;
  const lowVol  = (vix || 0) > 0 && vix <= 13;
  const choppy   = ts < 0.3;
  const trending = ts >= 0.6;
  if (choppy && highVol) return 'CHOPPY_HIGH_VOL';
  if (choppy)             return 'CHOPPY';
  if (trending && lowVol) return 'TRENDING_CALM';
  if (trending)            return 'TRENDING';
  return 'NEUTRAL';
}

export function applyRegimeAdjustment(conf, regime, cfg = {}) {
  const adj = {
    CHOPPY_HIGH_VOL: cfg.regimeChoppyHighVolPenalty ?? -18,
    CHOPPY:          cfg.regimeChoppyPenalty ?? -8,
    TRENDING_CALM:   cfg.regimeTrendingBonus ?? 4,
    TRENDING:        Math.round((cfg.regimeTrendingBonus ?? 4) * 0.5),
    NEUTRAL: 0,
  }[regime] ?? 0;
  return Math.min(99, Math.max(1, Math.round((conf || 0) + adj)));
}

// ── Confluence engine ──────────────────────────────────────────
// Counts how many independent modules (Trend, Momentum, Volume, Price Action,
// Institutional, Market Context) agree with the signal's proposed direction,
// vs simple point-addition which can't distinguish "4 weak agreements" from
// "1 strong confirmation". Each module is a -1 (bearish) / 0 (no opinion) / +1
// (bullish) vote; actionDir is +1 for BUY/bullish, -1 for SELL/bearish.
export function computeConfluence(modules, actionDir) {
  const dir = actionDir >= 0 ? 1 : -1;
  let agree = 0, conflicting = 0, total = 0;
  for (const v of Object.values(modules)) {
    if (!v) continue; // module had no opinion — doesn't count either way
    total++;
    if (Math.sign(v) === dir) agree++; else conflicting++;
  }
  return { agree, conflicting, total, ratio: total > 0 ? agree / total : 0 };
}

export function applyConfluenceAdjustment(conf, confluence, cfg = {}) {
  if (!confluence || confluence.total === 0) return conf;
  const { agree, conflicting, ratio } = confluence;
  let adj = 0;
  if (conflicting >= 2)                       adj = cfg.confluenceConflictPenalty ?? -12; // multiple modules actively disagree
  else if (ratio >= 0.8 && agree >= 5)         adj = cfg.confluenceFullBonus ?? 12;        // near-total agreement, doc's "Stock B"
  else if (ratio >= 0.65 && agree >= 4)        adj = cfg.confluenceStrongBonus ?? 7;       // solid majority
  else if (ratio < 0.5)                        adj = cfg.confluenceWeakPenalty ?? -8;      // scattered, weak agreement
  return Math.min(99, Math.max(1, Math.round((conf || 0) + adj)));
}

export function calcRelativeStrength(closes, niftyCloses) {
  if (!closes || !niftyCloses || closes.length < 6 || niftyCloses.length < 6) return null;
  const n = Math.min(closes.length, niftyCloses.length, 20);
  const sRet = +((closes.at(-1) - closes.at(-n)) / closes.at(-n) * 100).toFixed(2);
  const nRet = +((niftyCloses.at(-1) - niftyCloses.at(-n)) / niftyCloses.at(-n) * 100).toFixed(2);
  const rs = +(sRet - nRet).toFixed(2);
  return { rs, stockRet: sRet, niftyRet: nRet, outperforming: rs > 1, underperforming: rs < -1, strongly: Math.abs(rs) > 3 };
}

export function calcMomentumConfluence(closes, isBull) {
  if (!closes || closes.length < 35) return null;
  const rsi = calcRSI(closes), macd = calcMACD(closes);
  const rsiBull = rsi > 55;
  const rsiBear = rsi < 45;
  const macdBull = macd?.bullish === true;
  const macdBear = macd?.bullish === false;
  const bullConf = rsiBull && macdBull;
  const bearConf = rsiBear && macdBear;
  return {
    rsi: +rsi.toFixed(1),
    macdBull,
    macdBear,
    rsiBull,
    rsiBear,
    bullConf,
    bearConf,
    aligned: isBull ? bullConf : bearConf,
    contra: isBull ? bearConf : bullConf,
  };
}

export function calcWeeklyMTF(weeklyCandles, ltp, isBull) {
  if (!weeklyCandles || weeklyCandles.length < 2) return null;
  const [wc0, wc1] = weeklyCandles;
  const wOpen = +wc0[1], wHigh = +wc0[2], wLow = +wc0[3], wClose = +wc0[4];
  const prevWHigh = +wc1[2], prevWLow = +wc1[3];
  const wBullish  = wClose > wOpen && wClose >= wOpen + (wHigh - wOpen) * 0.5;
  const wBearish  = wClose < wOpen && wClose <= wOpen - (wOpen - wLow) * 0.5;
  const wBreakHigh = wHigh > prevWHigh, wBreakLow = wLow < prevWLow;
  const wCloses = weeklyCandles.map(c => +c[4]).reverse();
  const wEMA20  = wCloses.length >= 20 ? calcEMA(wCloses, 20) : null;
  const aboveWEMA = wEMA20 != null ? ltp > wEMA20 : null;
  const aligned   = isBull ? (wBullish || wBreakHigh) && aboveWEMA !== false : (wBearish || wBreakLow) && aboveWEMA === false;
  const confirms  = isBull ? wBullish && wBreakHigh : wBearish && wBreakLow;
  return { wBullish, wBearish, wBreakHigh, wBreakLow, wEMA20: wEMA20 ? +wEMA20.toFixed(2) : null, aboveWEMA, aligned, confirms };
}

// ── Time of Day Penalty — EXACT port from HTML ────────────────
export function getTimeOfDayPenalty() {
  const now = new Date();
  const h   = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }) % 24;
  const m   = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: 'numeric' });
  const day = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return -8;
  const t = h * 60 + m;
  if (t < 9 * 60 + 15)   return -20; // pre-market — no trade
  if (t <= 9 * 60 + 30)   return -18; // first 15 min — extreme noise, fakeouts
  if (t <= 9 * 60 + 45)   return -12; // 9:30-9:45 — still volatile, wide spreads
  if (t <= 10 * 60 + 15)  return -5;  // 9:45-10:15 — settling, mild caution
  if (t <= 10 * 60 + 30)  return 0;   // 10:15-10:30 — early session OK
  if (t <= 14 * 60)        return 5;   // midday — most reliable window
  if (t <= 14 * 60 + 45)  return 0;   // 2-2:45 — acceptable
  if (t <= 15 * 60)        return -8;  // 2:45-3 — pre-close caution
  return -18;                          // 3-3:30 — closing noise, avoid
}

export function getIntradayPhase() {
  const now = new Date();
  const h   = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }) % 24;
  const m   = +now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: 'numeric' });
  const day = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return 'holiday';
  const t = h * 60 + m;
  if (t < 9 * 60 + 15)  return 'pre';
  if (t > 15 * 60 + 30) return 'closed';
  if (t <= 9 * 60 + 45)  return 'opening';
  if (t <= 10 * 60 + 30) return 'early';
  if (t <= 14 * 60)       return 'midday';
  if (t <= 15 * 60)       return 'pre_close';
  return 'closing';
}

// ── Sector Mapping — EXACT port from HTML getSector ───────────
export function getSector(sym) {
  const SECTORS = {
    BANKING: ['HDFCBANK','ICICIBANK','SBIN','KOTAKBANK','AXISBANK','INDUSINDBK','IDFCFIRSTB','BANDHANBNK','RBLBANK','FEDERALBNK','INDIANB','BANKINDIA','BANKBARODA','CANBK','PNB','UNIONBANK'],
    IT:      ['TCS','INFY','WIPRO','HCLTECH','TECHM','LTIM','MPHASIS','COFORGE','PERSISTENT','KPITTECH','TATAELXSI','OFSS'],
    AUTO:    ['MARUTI','TATAMOTORS','M&M','EICHERMOT','HEROMOTOCO','BAJAJ-AUTO','TVSMOTOR','ASHOKLEY'],
    PHARMA:  ['SUNPHARMA','DRREDDY','CIPLA','DIVISLAB','APOLLOHOSP','LUPIN','AUROPHARMA','ALKEM','MANKIND'],
    ENERGY:  ['RELIANCE','ONGC','BPCL','IOC','COALINDIA','NTPC','POWERGRID','GAIL','HINDPETRO','ADANIENT','ADANIENSOL','TATAPOWER'],
    FMCG:    ['HINDUNILVR','ITC','NESTLEIND','BRITANNIA','TATACONSUM','DABUR','MARICO','COLPAL'],
    METAL:   ['TATASTEEL','JSWSTEEL','HINDALCO','VEDL','SAIL','NMDC','HINDZINC'],
    NBFC:    ['BAJFINANCE','BAJAJFINSV','SHRIRAMFIN','CHOLAFIN','MUTHOOTFIN','LTF'],
    INFRA:   ['LT','DLF','GODREJPROP','LODHA','PRESTIGE','OBEROIRLTY'],
    CEMENT:  ['ULTRACEMCO','SHREECEM','AMBUJACEM','ACC','DALBHARAT','JKCEMENT'],
    TELECOM: ['BHARTIARTL','VBL','IDEA'],
  };
  for (const [sector, stocks] of Object.entries(SECTORS)) {
    if (stocks.includes(sym)) return sector;
  }
  return 'OTHER';
}

// ── countIndicatorsEx — EXACT port from HTML ──────────────────
export function countIndicatorsEx(rsi, macdBull, a50, a200, volOk, nearSupp, patterns, rec, macdObj, bbObj, adxObj, rsiDivObj) {
  const isBuy = rec === 'BUY' || rec === 'STRONG BUY' || rec === 'MODERATE';
  let count = 0;
  if (rsi !== null && rsi !== undefined && rsi >= 40 && rsi <= 70) count++;
  if (macdObj?.bullCross && isBuy)     count++;
  else if (macdBull === true && isBuy) count++;
  if (a50  === true && isBuy) count++;
  if (a200 === true && isBuy) count++;
  if (volOk === true)         count++;
  if (nearSupp && isBuy)      count++;
  if (patterns && (patterns.bullishEngulfing || patterns.hammer || patterns.morningStar)) count++;
  if (bbObj?.nearLowerBand && isBuy)  count++;
  if (adxObj?.bullTrend && isBuy)     count++;
  if (rsiDivObj?.bullish && isBuy)    count++;
  return count;
}

// ── calcConfidence — EXACT port from HTML ─────────────────────
// Weighted: SignalStrength(35%) + MarketContext(25%) + VolumeProfile(20%) + PriceAction(20%) + timeAdj
export function calcConfidence(inds, vixSc, pcrSc, niftyBull, secSc, vol, avgVol, patterns, rec, numIndsOverride) {
  const numInds = (numIndsOverride !== undefined && numIndsOverride !== null)
    ? numIndsOverride
    : (inds ? inds.filter(Boolean).length : 0);

  // Component 1: Signal Strength (35%) — exact HTML port
  let sigScore = numInds >= 5 ? 90 : numInds === 4 ? 75 : numInds === 3 ? 60 : numInds === 2 ? 45 : 30;
  if      (rec === 'STRONG BUY') sigScore = Math.min(100, sigScore + 10);
  else if (rec === 'BUY')        sigScore = Math.min(100, sigScore + 5);
  else if (rec === 'AVOID')      sigScore = Math.max(0,   sigScore - 10);

  // Component 2: Market Context (25%) — exact HTML port with vixSc + pcrSc + secSc
  const vixAdj = (vixSc||50) > 80 ? 20 : (vixSc||50) > 60 ? 10 : (vixSc||50) > 40 ? 0 : -10;
  const pcrAdj = (pcrSc||50) > 70 ? 15 : (pcrSc||50) > 50 ?  5 : 0;
  const secAdj = (secSc||50) > 70 ? 10 : (secSc||50) > 50 ?  5 : (secSc||50) > 30 ? 0 : -5;
  const mktScore = Math.min(100, (niftyBull ? 60 : 25) + vixAdj + pcrAdj + secAdj);

  // Component 3: Volume Profile (20%)
  const volRatio = avgVol > 0 ? vol / avgVol : 1;
  const volScore = volRatio >= 2.0 ? 95 : volRatio >= 1.5 ? 85 : volRatio >= 1.2 ? 70 : volRatio >= 0.8 ? 50 : 30;

  // Component 4: Price Action Quality (20%)
  let paScore = 50;
  if (patterns?.bullishEngulfing) paScore += 15;
  if (patterns?.hammer)           paScore += 10;
  if (patterns?.morningStar)      paScore += 15;
  if (rec === 'BUY' || rec === 'STRONG BUY') {
    if (patterns?.bearishEngulfing) paScore -= 15;
    if (patterns?.shootingStar)     paScore -= 10;
    if (patterns?.eveningStar)      paScore -= 15;
  }
  paScore = Math.min(100, Math.max(0, paScore));

  const timeAdj = getTimeOfDayPenalty();
  return +(Math.min(99, Math.max(1, sigScore * 0.35 + mktScore * 0.25 + volScore * 0.20 + paScore * 0.20 + timeAdj))).toFixed(1);
}

// ── getRec — EXACT port from HTML ─────────────────────────────
export function getRec(conf, pot, risk, rr) {
  if (conf >= 80 && pot >= 5  && risk <= 30 && rr >= 2.5) return 'STRONG BUY';
  if (conf >= 70 && pot >= 3  && risk <= 40 && rr >= 2.0) return 'BUY';
  if (conf >= 60 && pot >= 2  && risk <= 50)               return 'MODERATE';
  // Tightened: WATCH was 13% WR on 734 signals — raise bar to both conf AND pot
  if (conf >= 55 && pot >= 4)                               return 'WATCH';
  return 'AVOID';
}

// ── detectReversal — EXACT port from HTML ─────────────────────
export function detectReversal(ltp, rsi, patterns, sr, vix, pcr, nBull, chgPct, atr, high, low) {
  const signals = [];
  let bullRev = 0, bearRev = 0;
  if (rsi != null) {
    if (rsi <= 25)      { bullRev += 3; signals.push('RSI Extreme Oversold (' + rsi + ')'); }
    else if (rsi <= 32) { bullRev += 2; signals.push('RSI Oversold (' + rsi + ')'); }
    if (rsi >= 75)      { bearRev += 3; signals.push('RSI Extreme Overbought (' + rsi + ')'); }
    else if (rsi >= 68) { bearRev += 2; signals.push('RSI Overbought (' + rsi + ')'); }
  }
  if (pcr > 0) {
    if (pcr >= 1.5)       { bullRev += 3; signals.push('PCR Extreme Bearish (' + pcr + ')'); }
    else if (pcr >= 1.3)  { bullRev += 2; signals.push('PCR High (' + pcr + ')'); }
    if (pcr <= 0.5)       { bearRev += 3; signals.push('PCR Extreme Bullish (' + pcr + ')'); }
    else if (pcr <= 0.65) { bearRev += 2; signals.push('PCR Low (' + pcr + ')'); }
  }
  if (patterns) {
    if (patterns.hammer           && !nBull) { bullRev += 3; signals.push('Hammer'); }
    if (patterns.morningStar      && !nBull) { bullRev += 4; signals.push('Morning Star'); }
    if (patterns.bullishEngulfing && !nBull) { bullRev += 3; signals.push('Bullish Engulfing'); }
    if (patterns.shootingStar     && nBull)  { bearRev += 3; signals.push('Shooting Star'); }
    if (patterns.eveningStar      && nBull)  { bearRev += 4; signals.push('Evening Star'); }
    if (patterns.bearishEngulfing && nBull)  { bearRev += 3; signals.push('Bearish Engulfing'); }
  }
  if (sr && ltp > 0) {
    if (sr.pivotS1 > 0 && Math.abs((ltp - sr.pivotS1) / ltp * 100) < 1.5) { bullRev += 2; signals.push('Price at Pivot Support'); }
    if (sr.week52L > 0 && Math.abs((ltp - sr.week52L) / ltp * 100) < 2)   { bullRev += 3; signals.push('Near 52-Week Low'); }
    if (sr.pivotR1 > 0 && Math.abs((ltp - sr.pivotR1) / ltp * 100) < 1.5) { bearRev += 2; signals.push('Price at Pivot R1'); }
    if (sr.week52H > 0 && Math.abs((ltp - sr.week52H) / ltp * 100) < 2)   { bearRev += 3; signals.push('Near 52-Week High'); }
  }
  if (vix > 25)     { bullRev += 2; signals.push('VIX High Fear (' + vix.toFixed(1) + ')'); }
  else if (vix < 12){ bearRev += 1; signals.push('VIX Very Low (' + vix.toFixed(1) + ')'); }
  if (chgPct != null) {
    if (chgPct <= -3 && sr?.pivotS1 > 0) { bullRev += 2; signals.push('Large down day near support'); }
    if (chgPct >= 3  && sr?.pivotR1 > 0) { bearRev += 2; signals.push('Large up day near resistance'); }
  }
  const maxRev = Math.max(bullRev, bearRev);
  if (maxRev < 4) return { type: 'NONE', strength: '', signalCount: 0, signals: [], bullScore: bullRev, bearScore: bearRev };
  const type = bullRev >= bearRev ? 'BULLISH_REVERSAL' : 'BEARISH_REVERSAL';
  const strength = maxRev >= 9 ? 'STRONG' : maxRev >= 6 ? 'MODERATE' : 'WEAK';
  return { type, strength, signalCount: signals.length, signals, bullScore: bullRev, bearScore: bearRev };
}

// ── calcEntryTrigger — EXACT port from HTML ───────────────────
export function calcEntryTrigger(ltp, high, sr, atr, rec, vwap, chgPct) {
  if (rec === 'BUY' || rec === 'STRONG BUY' || rec === 'MODERATE') {
    const a = atr || ltp * 0.015;
    let trigger = 0, method = '', note = '';
    if (sr?.pivotR1 > 0 && sr.pivotR1 > ltp && (sr.pivotR1 - ltp) / ltp * 100 < 3) {
      if (!trigger || sr.pivotR1 < trigger) { trigger = +(sr.pivotR1 * 1.002).toFixed(2); method = 'Break above Pivot R1'; note = 'R1 ₹' + sr.pivotR1.toFixed(0); }
    }
    if (high > ltp * 1.001) {
      const dhTrig = +(high * 1.003).toFixed(2);
      if (!trigger || dhTrig < trigger) { trigger = dhTrig; method = 'Break above Day High'; note = 'Day high ₹' + high.toFixed(0); }
    }
    if (vwap > 0 && vwap > ltp && (vwap - ltp) / ltp * 100 < 1.5) {
      if (!trigger || vwap < trigger) { trigger = +(vwap * 1.002).toFixed(2); method = 'Break above VWAP'; note = 'VWAP ₹' + vwap.toFixed(0); }
    }
    if (!trigger) { trigger = +(ltp + a * 0.5).toFixed(2); method = 'ATR Breakout'; note = '+0.5× ATR'; }
    if (trigger && trigger <= ltp * 1.001) return { trigger: ltp, method: 'Market (already triggered)', note: 'Act now', alreadyTriggered: true };
    return { trigger: trigger || ltp, method, note, alreadyTriggered: false };
  }
  return { trigger: ltp, method: 'Market', note: '', alreadyTriggered: false };
}

// ── autoSLTarget — EXACT port from HTML ──────────────────────
export function autoSLTarget(ltp, high, low, atr, sr, vix, rsi) {
  const a = atr || ltp * 0.02;
  const liveVix = vix || 15;
  const vixMult = 1.3 + liveVix / 100;
  const rsiAdj  = (rsi || 50) > 70 ? -0.15 : (rsi || 50) < 35 ? 0.15 : 0;
  const finalMult = vixMult + rsiAdj;
  const atrSL   = +(ltp - a * finalMult).toFixed(2);
  const slSwing = low > 0 ? +(low * 0.995).toFixed(2) : 0;
  const slS1    = sr?.pivotS1 > 0 ? +(sr.pivotS1 * 0.995).toFixed(2) : 0;
  let sl = atrSL;
  if (slSwing > 0 && sl > slSwing) sl = slSwing;
  if (slS1    > 0 && sl > slS1)    sl = slS1;
  sl = Math.min(sl, +(ltp - a * 1.0).toFixed(2));
  sl = Math.max(sl, +(ltp - a * 3.0).toFixed(2));
  if (low > 0) sl = Math.max(sl, +(low * 0.99).toFixed(2));
  sl = Math.max(0, +sl.toFixed(2));
  // Targets using pivots + fibonacci
  const risk = ltp - sl;
  const r1 = sr?.pivotR1 || 0, r2 = sr?.pivotR2 || 0;
  const rrOf = (t) => risk > 0 ? (t - ltp) / risk : 0;
  const rrT15 = +(ltp + risk * 1.5).toFixed(2);
  let cons = (r1 > ltp && rrOf(r1) >= 1.2 && rrOf(r1) <= 3.0) ? +r1.toFixed(2) : rrT15;
  const rrT20 = +(ltp + risk * 2.0).toFixed(2);
  let mod;
  if (r2 > ltp && rrOf(r2) >= 1.8 && rrOf(r2) <= 4.0)     mod = +r2.toFixed(2);
  else if (r1 > ltp && rrOf(r1) >= 1.8)                    mod = +r1.toFixed(2);
  else                                                       mod = rrT20;
  const fibT3 = +(ltp + risk * 1.618).toFixed(2);
  let target = Math.max(fibT3, +(ltp + risk * 3.0).toFixed(2));
  if ((vix || 15) > 22) target = Math.min(target, +(ltp + risk * 2.5).toFixed(2));
  mod = Math.max(mod, +(cons + risk * 0.5).toFixed(2));
  target = Math.max(target, +(mod + risk * 0.5).toFixed(2));
  const targets = { cons, mod, agg: target };
  return { sl, target: mod, targets };
}

// ── calcRisk — EXACT port from HTML ──────────────────────────
export function calcRisk(ltp, sl, target, atr, vix) {
  const atrPct  = atr && ltp > 0 ? (atr / ltp) * 100 : 2;
  const volRisk = atrPct < 1.5 ? 15 : atrPct < 3.0 ? 30 : atrPct < 5.0 ? 50 : 70;
  const slPct   = ltp > 0 && sl > 0 ? Math.abs((ltp - sl) / ltp) * 100 : 4;
  let posRisk   = slPct < 2 ? 10 : slPct < 4 ? 20 : slPct < 6 ? 35 : slPct < 10 ? 50 : 70;
  const rr      = sl > 0 && ltp > sl && ltp !== sl ? (target - ltp) / (ltp - sl) : 0.5;
  if      (rr >= 3.0) posRisk *= 0.70;
  else if (rr >= 2.0) posRisk *= 0.85;
  else if (rr < 1.0)  posRisk *= 1.30;
  posRisk = Math.min(100, posRisk);
  const mktRisk  = vix < 12 ? 10 : vix < 15 ? 20 : vix < 18 ? 30 : vix < 22 ? 45 : vix < 28 ? 60 : 80;
  return +(volRisk * 0.30 + posRisk * 0.25 + mktRisk * 0.25 + 15 * 0.20).toFixed(1);
}

// ── calcPotential — EXACT port from HTML ─────────────────────
export function calcPotential(ltp, target, sl, numInds, rec) {
  const base = ltp > 0 ? (target - ltp) / ltp * 100 : 0;
  const rr   = Math.min(3.0, ltp > sl && sl > 0 ? (target - ltp) / (ltp - sl) : 1);
  let wr = rec === 'STRONG BUY' ? 68 : rec === 'BUY' ? 62 : rec === 'MODERATE' ? 57 : rec === 'WATCH' ? 52 : 45;
  if      (numInds >= 5) wr += 8;
  else if (numInds >= 4) wr += 5;
  else if (numInds >= 3) wr += 2;
  else if (numInds <= 1) wr -= 6;
  wr = Math.min(75, Math.max(35, wr));
  const adj    = base * (wr / 100) * rr;
  const slDist = ltp > 0 && sl > 0 ? Math.abs((ltp - sl) / ltp * 100) : base / 2;
  const ev     = (wr / 100) * base - (1 - wr / 100) * slDist;
  const riskAmt = sl > 0 && ltp > sl ? ltp - sl : ltp * 0.03;
  return { base: +base.toFixed(2), rr: +rr.toFixed(2), wr: +wr.toFixed(0), adj: +adj.toFixed(2), ev: +ev.toFixed(2), cons: +(ltp + riskAmt * 1.5).toFixed(2), mod: +target.toFixed(2), agg: +(ltp + riskAmt * 4.0).toFixed(2) };
}

// ── Breakout Scoring — EXACT port from HTML boScore ───────────
export function boScore(ema, pdhl, st, vol, wk52, mom, nr7, bb, weeklyMTF, gap, adx, rs, wick, sectorScore, phase) {
  let bull = 0, bear = 0;

  // ── Tier 1: Primary breakout triggers (weight 5) ──────
  // These alone are enough to make a tradeable signal
  if (ema) {
    if      (ema.goldenCross) bull += 5;        // EMA 50 crossed above 200 — strongest trend signal
    else if (ema.deathCross)  bear += 5;
    else if (ema.nearCross)   { bull += 2; bear += 2; } // approaching cross
    else if (ema.uptrend)     bull += 1;
    else                      bear += 1;
  }
  if (wk52) {
    if (wk52.breakHigh) bull += 5;              // 52-week high breakout = major momentum
    else if (wk52.atHigh) bull += 2;
    if (wk52.breakLow)  bear += 5;
    else if (wk52.atLow)  bear += 2;
  }

  // ── Tier 2: Breakout confirmation (weight 4) ──────────
  // Strong signals that validate the breakout
  if (pdhl) {
    if (pdhl.bullBreakout) bull += 4;           // PDH break = proven intraday level broken
    else if (pdhl.bearBreakout) bear += 4;
    else if (pdhl.nearPDH) bull += 1;
    else if (pdhl.nearPDL) bear += 1;
  }
  if (st) {
    if (st.crossed) {
      st.trend === 'UP' ? (bull += 4) : (bear += 4); // SuperTrend crossover = strong signal
    } else {
      st.trend === 'UP' ? (bull += 1) : (bear += 1);
    }
  }
  if (gap) {
    if (gap.bigGapUp)   bull += 4;              // Big gap = major institutional move
    else if (gap.gapUp)   bull += 2;
    if (gap.bigGapDown) bear += 4;
    else if (gap.gapDown) bear += 2;
  }

  // ── Tier 3: Trend strength (weight 3) ─────────────────
  if (weeklyMTF) {
    if (weeklyMTF.confirms) { bull += 3; bear += 3; } // weekly + daily aligned = high conviction
    else if (weeklyMTF.aligned) { weeklyMTF.wBullish ? (bull += 2) : (bear += 2); }
  }
  if (adx) {
    if (adx.strong) { bull += 2; bear += 2; }  // ADX > 25 = trending market
    if (adx.veryStrong) { bull += 1; bear += 1; } // ADX > 35 = very strong trend
    if (adx.adx < 20) { bull = Math.max(0, bull - 2); bear = Math.max(0, bear - 2); } // choppy market penalty
  }
  if (rs) {
    if (rs.outperforming && rs.strongly)   bull += 3;  // strongly outperforming Nifty
    else if (rs.outperforming)             bull += 1;
    if (rs.underperforming && rs.strongly) bear += 3;
    else if (rs.underperforming)           bear += 1;
  }

  // ── Tier 4: Volume confirmation (weight 3) ────────────
  // Volume breakout alone is not a signal but confirms everything else
  if (vol) {
    if (vol.strong)     { bull += 3; bear += 3; }  // 2× average = strong confirmation
    else if (vol.confirmed) { bull += 2; bear += 2; }
    else if (vol.weak)  { bull += 1; bear += 1; }
    if (vol.dry) { bull = Math.max(0, bull - 2); bear = Math.max(0, bear - 2); } // very low volume = fake move
  }

  // ── Tier 5: Setup quality (weight 2) ──────────────────
  // These improve quality but shouldn't drive the signal alone
  if (mom) {
    if (mom.bullConf)                   bull += 2;
    else if (mom.rsiBull || mom.macdBull) bull += 1;
    if (mom.bearConf)                   bear += 2;
    else if (mom.rsiBear || mom.macdBear) bear += 1;
  }
  if (nr7)  { if (nr7.isNR7) { bull += 2; bear += 2; } else if (nr7.isNR4) { bull += 1; bear += 1; } }
  if (bb)   { if (bb.extremeSqueeze) { bull += 2; bear += 2; } else if (bb.squeeze) { bull += 1; bear += 1; } }
  if (sectorScore > 0) { bull += 2; } else if (sectorScore < 0) { bear += 2; } // sector momentum

  // ── Tier 6: Wick rejection (weight 1) ─────────────────
  if (wick) {
    if (wick.bearRejected) { bull = Math.max(0, bull - 3); } // strong bearish wick kills bull signal
    if (wick.bullRejected) { bear = Math.max(0, bear - 3); }
    if (wick.bullStrong)   { bull += 1; }
    if (wick.bearStrong)   { bear += 1; }
  }

  // ── Cross-signal conflicts (penalty) ──────────────────
  // Bull breakout but bearish wick = questionable
  if (pdhl?.bullBreakout && wick?.bearRejected) bull  = Math.max(0, bull - 2);
  if (pdhl?.bearBreakout && wick?.bullRejected) bear  = Math.max(0, bear - 2);
  // EMA below all but trying to breakout bull = trend fight
  if (ema && !ema.uptrend && pdhl?.bullBreakout) bull = Math.max(0, bull - 3);
  if (ema?.uptrend && pdhl?.bearBreakout) bear = Math.max(0, bear - 3);

  // ── Time-of-day penalty ────────────────────────────────
  const dominant = Math.max(bull, bear);
  const conflict = Math.min(bull, bear);
  // Max possible raw ≈ 5+5+4+4+4+3+3+3+3+2+2+2+2+1 = 43
  // Normalise with conflict reduction, divide by 4.3 → 10
  let raw = (dominant - conflict * 0.4) / 4.3;
  if (phase === 'opening') raw -= 1.0;  // first 15 min — volatile
  else if (phase === 'closing') raw -= 0.5; // last 30 min
  const score = Math.min(10, Math.max(1, Math.round(raw)));
  return { bullScore: bull, bearScore: bear, score };
}

// ── applyIntradayBoost — add intraday signals to boScore result ──────────
// Called after main boScore when 5-min candles are available
export function applyIntradayBoost(scoreResult, intraData) {
  if (!intraData) return scoreResult;
  const { bullScore, bearScore, score } = scoreResult;
  let boost = 0;
  const isBull = bullScore >= bearScore;

  if (intraData.confirm)           boost += 2; // PDH/PDL confirmed on 5m
  if (intraData.volRatio >= 2)     boost += 2; // strong intraday volume surge
  else if (intraData.volRatio >= 1.5) boost += 1;
  if (intraData.emaBull && isBull) boost += 1; // 5m EMA aligned with direction
  if (intraData.accelerating)      boost += 1; // momentum building intraday
  if (intraData.aboveVWAP && isBull) boost += 1; // above VWAP = bullish
  if (!intraData.aboveVWAP && !isBull) boost += 1; // below VWAP = bearish

  // Negative: breakout WITHOUT volume is suspect
  if (intraData.confirm && intraData.volRatio < 1) boost -= 2;

  const newScore = Math.min(10, Math.max(1, Math.round(score + boost / 2)));
  return { ...scoreResult, score: newScore, intraBoost: boost };
}

export function boDirection(ema, pdhl, st) {
  let bull = 0, bear = 0;
  if (ema) {
    if (ema.goldenCross) bull += 3;
    else if (ema.deathCross) bear += 3;
    else if (ema.uptrend) bull += 1;
    else bear += 1;
  }
  if (pdhl) {
    if (pdhl.bullBreakout) bull += 3;
    else if (pdhl.bearBreakout) bear += 3;
    else if (pdhl.nearPDH) bull += 1;
    else if (pdhl.nearPDL) bear += 1;
  }
  if (st) {
    if (st.crossed) {
      if (st.trend === 'UP') bull += 2;
      else bear += 2;
    } else {
      if (st.trend === 'UP') bull += 1;
      else bear += 1;
    }
  }
  return bull > bear ? 'BULL' : 'BEAR';
}

export function boSLTarget(ltp, atr, isBull, pdh, pdl, ema200) {
  // Cap ATR to 3% of LTP — prevents oversized SL on high-price stocks (₹5000+)
  const rawAtr = atr || ltp * 0.018;
  const a = Math.min(rawAtr, ltp * 0.03);
  let sl, target;
  if (isBull) {
    sl = +(ltp - a * 1.5).toFixed(2);
    if (pdl > 0 && pdl < ltp && pdl > sl) sl = +(pdl * 0.995).toFixed(2);
    if (ema200 > 0 && ema200 < ltp && ema200 > sl) sl = +(ema200 * 0.995).toFixed(2);
    const risk = ltp - sl;
    target = +(ltp + risk * 2).toFixed(2);
  } else {
    sl = +(ltp + a * 1.5).toFixed(2);
    if (pdh > 0 && pdh > ltp && pdh < sl) sl = +(pdh * 1.005).toFixed(2);
    if (ema200 > 0 && ema200 > ltp && ema200 < sl) sl = +(ema200 * 1.005).toFixed(2);
    const risk = sl - ltp;
    target = +(ltp - risk * 2).toFixed(2);
  }
  const rr = sl > 0 && Math.abs(ltp - sl) > 0 ? +((Math.abs(target - ltp) / Math.abs(ltp - sl))).toFixed(2) : 2;
  return { sl, target, rr, method: 'ATR SL · 2:1 R:R' };
}

// ── Max Pain & OI Walls ───────────────────────────────────────
export function calcMaxPain(chain) {
  if (!chain || chain.length < 3) return 0;
  const strikes = chain.map(r => r.strike_price).filter(Boolean).sort((a, b) => a - b);
  let minLoss = Infinity, maxPainStrike = strikes[0];
  for (const testStrike of strikes) {
    let totalLoss = 0;
    for (const row of chain) {
      const sp = row.strike_price, callOI = row.call_options?.market_data?.oi || 0, putOI = row.put_options?.market_data?.oi || 0;
      if (testStrike > sp) totalLoss += (testStrike - sp) * callOI;
      if (testStrike < sp) totalLoss += (sp - testStrike) * putOI;
    }
    if (totalLoss < minLoss) { minLoss = totalLoss; maxPainStrike = testStrike; }
  }
  return maxPainStrike;
}

export function calcOIWalls(chain) {
  if (!chain || chain.length < 3) return { callWall: 0, putWall: 0 };
  let maxCallOI = 0, maxPutOI = 0, callWall = 0, putWall = 0;
  for (const row of chain) {
    const callOI = row.call_options?.market_data?.oi || 0, putOI = row.put_options?.market_data?.oi || 0;
    if (callOI > maxCallOI) { maxCallOI = callOI; callWall = row.strike_price; }
    if (putOI  > maxPutOI)  { maxPutOI  = putOI;  putWall  = row.strike_price; }
  }
  return { callWall, putWall, callWallOI: maxCallOI, putWallOI: maxPutOI };
}

// ── Option Analysis page — lightweight per-strike scanner ─────
// Unlike scanChain (which filters down to only tradeable candidates: ≥2 signals,
// minimum OI, etc.), this computes confidence + OI buildup for EVERY strike/side
// in range so the chain table can show a number next to every row, the way a
// broker's option-chain screen does. Reuses the same confidence formula and OI
// buildup classification as scanChain for consistency with the rest of the app.
export function scanChainAnalysis(chain, atm, spot, niftyBullish, vix, maxPain, stockPCR, marketCtx, cfg, lot = 1) {
  const rows = [];
  const compositeScore = marketCtx?.compositeScore ?? (niftyBullish ? 1 : -1);
  const priceBull = compositeScore > 0.5, priceBear = compositeScore < -0.5;
  const oi_thresh = cfg?.oi ?? 15;
  const marginPct = (cfg?.optionMarginPct ?? 11) / 100;

  for (const row of chain) {
    const sp = row.strike_price;
    if (!spot || Math.abs(sp - atm) > spot * 0.15) continue;
    const out = { strike: sp, atm: sp === atm };

    for (const [side, optType] of [['call_options', 'CE'], ['put_options', 'PE']]) {
      const opt = row[side];
      const md = opt?.market_data, gr = opt?.option_greeks;
      if (!opt || !md?.ltp) { out[optType] = null; continue; }

      const ltp = md.ltp, delta = gr?.delta || 0, iv = gr?.iv || 0, theta = gr?.theta || 0;
      const oi = md?.oi || 0, prevOI = md?.prev_oi || oi;
      const oiChg = prevOI > 0 ? ((oi - prevOI) / prevOI * 100) : 0;
      const isCEOpt = optType === 'CE';
      const oiRising = oiChg >= oi_thresh, oiFalling = oiChg <= -oi_thresh;

      let oiBuildType = 'NEUTRAL', oiBuildBonus = 0;
      if (isCEOpt) {
        if (priceBull && oiRising)  { oiBuildType = 'LONG_BUILD';  oiBuildBonus = +15; }
        if (priceBull && oiFalling) { oiBuildType = 'SHORT_COVER'; oiBuildBonus =  +5; }
        if (priceBear && oiRising)  { oiBuildType = 'SHORT_BUILD'; oiBuildBonus = -15; }
        if (priceBear && oiFalling) { oiBuildType = 'LONG_UNWIND'; oiBuildBonus =  -8; }
      } else {
        if (priceBear && oiRising)  { oiBuildType = 'LONG_BUILD';  oiBuildBonus = +15; }
        if (priceBear && oiFalling) { oiBuildType = 'SHORT_COVER'; oiBuildBonus =  +5; }
        if (priceBull && oiRising)  { oiBuildType = 'SHORT_BUILD'; oiBuildBonus = -15; }
        if (priceBull && oiFalling) { oiBuildType = 'LONG_UNWIND'; oiBuildBonus =  -8; }
      }
      if (!oiRising && !oiFalling) oiBuildBonus = 0;

      const signals = []; // confidence formula reads signals.length for one minor term only
      if (Math.abs(delta) >= (cfg?.delta || 0.40)) signals.push({ l: 'Delta', s: 3 });
      if (iv >= (cfg?.iv || 15)) signals.push({ l: 'IV', s: 2 });

      let confidence = calcOptConfidenceFull(delta, iv, oiChg, theta, signals, spot, sp, optType, niftyBullish, vix, maxPain, stockPCR, marketCtx);
      confidence = Math.round(Math.min(100, Math.max(0, confidence + oiBuildBonus)));

      // Margin is an estimate only (SPAN+exposure is computed by the exchange/broker
      // at order time) — this gives a rough sense of capital needed to WRITE this
      // strike, not to buy it. Buying capital is just ltp × lot, shown separately.
      const marginEst = +(spot * lot * marginPct).toFixed(0);

      out[optType] = {
        ltp: +ltp.toFixed(2), oi, oiChg: +oiChg.toFixed(1), delta: +delta.toFixed(2), iv: +iv.toFixed(1), theta: +theta.toFixed(2),
        confidence, oiBuildType, oiBuildBonus, buyCapital: +(ltp * lot).toFixed(0), marginEst,
        instrKey: opt.instrument_key || null,
      };
    }
    rows.push(out);
  }
  return rows.sort((a, b) => a.strike - b.strike);
}

// ── IV Percentile ─────────────────────────────────────────────
export function calcIVPercentile(iv, closes) {
  if (!iv || iv <= 0 || !closes || closes.length < 30) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const recent = returns.slice(-20), mean = recent.reduce((s, r) => s + r, 0) / recent.length;
  const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
  const hv20 = +(Math.sqrt(variance * 252) * 100).toFixed(1);
  const ivHvRatio = hv20 > 0 ? +(iv / hv20).toFixed(2) : 1;
  return { iv: +iv.toFixed(1), hv20, ivHvRatio, cheap: ivHvRatio < 0.75, rich: ivHvRatio > 1.30, fair: ivHvRatio >= 0.75 && ivHvRatio <= 1.30 };
}

// ── Smart Options SL/Target (IV+DTE+Delta) ────────────────────
export function calcSmartOptionSLTarget(entry, spot, strike, iv, delta, theta, expiry, vix) {
  const today = new Date(), expDate = expiry ? new Date(expiry) : today;
  const dte   = Math.max(0, Math.round((expDate - today) / 86400000));
  const ivDec = (iv || 20) / 100, timeFrac = dte === 0 ? (1/252)*0.5 : (1/252);
  const dailySpotMove = spot * ivDec * Math.sqrt(timeFrac);
  const absD = Math.abs(delta) || 0.4;
  const dailyPremiumMove = dailySpotMove * absD;
  const vixFactor = (vix||15) > 20 ? 1.15 : (vix||15) < 13 ? 0.90 : 1.0;
  const moneyness = spot > 0 ? Math.abs(strike - spot) / spot : 0;
  const atmFactor = moneyness < 0.01 ? 1.1 : moneyness > 0.04 ? 0.85 : 1.0;
  let slMinPct = 0.20, slMaxPct = 0.30;
  if (absD >= 0.45) { slMinPct = 0.15; slMaxPct = 0.25; }
  const slWidth = dailyPremiumMove * vixFactor * atmFactor;
  const rawSL = entry - Math.max(slWidth, entry * slMinPct);
  const sl = +Math.min(entry * (1 - slMinPct), Math.max(entry * (1 - slMaxPct), rawSL)).toFixed(2);
  const risk = entry - sl;
  let baseRR = dte === 0 ? 1.2 : dte <= 2 ? 1.5 : dte <= 7 ? 1.8 : 2.0;
  const maxGainPct = dte === 0 ? 0.40 : dte <= 2 ? 0.60 : 1.00;
  const tgt = +Math.min(entry * (1 + maxGainPct), +(entry + risk * baseRR).toFixed(2)).toFixed(2);
  const rr  = risk > 0 ? +((tgt - entry) / risk).toFixed(2) : baseRR;
  return { sl, tgt, rr, dte, method: `IV ${(iv||20).toFixed(0)}% | DTE ${dte} | Δ ${absD.toFixed(2)}` };
}

// ── FII/DII Interpretation ────────────────────────────────────
export function interpretFIIDII(d) {
  if (!d) return { bias: 0, label: 'No Data', color: '#94a3b8', detail: '' };
  const fiiNet = d.fii_net || 0, diiNet = d.dii_net || 0, netFlow = fiiNet + diiNet;

  // Cash bias still drives the overall strength score (net market flow)
  let cashBias = netFlow > 5000 ? 10 : netFlow > 2000 ? 7 : netFlow > 500 ? 4 : netFlow > -500 ? 0 : netFlow > -2000 ? -4 : netFlow > -5000 ? -7 : -10;
  if (fiiNet > 1000) cashBias = Math.min(cashBias + 2, 10);
  if (fiiNet < -1000) cashBias = Math.max(cashBias - 2, -10);

  let futBias = 0;
  const futLong = d.fii_idx_fut_long || 0, futShort = d.fii_idx_fut_short || 0;
  if (futLong + futShort > 0) { const lp = futLong / (futLong + futShort) * 100; futBias = lp > 65 ? 5 : lp > 55 ? 3 : lp > 45 ? 0 : lp > 35 ? -3 : -5; }
  const totalBias = cashBias + futBias;

  // ── Label now reflects WHO is actually buying/selling, not just net flow ──
  // This prevents misleading labels like "FII BUYING" when FII is actually net selling
  // but DII bought enough to make the combined net positive.
  const fiiBuying = fiiNet > 200;   // small threshold to ignore noise
  const fiiSelling = fiiNet < -200;
  const diiBuying = diiNet > 200;
  const diiSelling = diiNet < -200;

  let label, color;
  if (fiiBuying && diiBuying) {
    label = totalBias >= 8 ? 'STRONG BUY — BOTH BUYING' : 'BOTH BUYING';
    color = totalBias >= 8 ? '#16a34a' : '#22c55e';
  } else if (fiiSelling && diiSelling) {
    label = totalBias <= -7 ? 'HEAVY SELL — BOTH SELLING' : 'BOTH SELLING';
    color = totalBias <= -7 ? '#dc2626' : '#f97316';
  } else if (fiiSelling && diiBuying) {
    // This is the AEGISLOG-style case: FII selling, DII absorbing/buying more
    label = netFlow > 0 ? 'DII BUYING (FII SELLING)' : 'FII SELLING (DII PARTIAL)';
    color = netFlow > 0 ? '#0ea5e9' : '#f97316'; // blue = DII-led, not pure bullish green
  } else if (fiiBuying && diiSelling) {
    label = netFlow > 0 ? 'FII BUYING (DII SELLING)' : 'DII SELLING (FII PARTIAL)';
    color = netFlow > 0 ? '#0ea5e9' : '#f97316';
  } else {
    label = 'NEUTRAL';
    color = '#d97706';
  }

  const crFmt = (v) => (v >= 0 ? '+₹' : '-₹') + Math.abs(v).toFixed(0) + ' Cr';
  return {
    bias: totalBias, label, color,
    detail: `FII ${crFmt(fiiNet)} · DII ${crFmt(diiNet)} · Net ${crFmt(netFlow)}`,
    fiiNet, diiNet, netFlow,
    fiiBuying, fiiSelling, diiBuying, diiSelling,
  };
}

// ── isWeeklyExpiryDay — EXACT port from HTML ─────────────────
export function isWeeklyExpiryDay() {
  const day = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' });
  return day === 'Thu';
}

// ── applyExpiryDayAdjustment — EXACT port ─────────────────────
export function applyExpiryDayAdjustment(slTgt, delta, iv, entry, spot, strike) {
  if (!isWeeklyExpiryDay()) return slTgt;
  const moneyness = spot > 0 ? Math.abs(strike - spot) / spot : 0;
  let { sl, tgt, rr, method, dte } = slTgt;
  if (dte > 1) return slTgt;
  if (moneyness < 0.01) {
    sl  = Math.max(sl,  +(entry * 0.75).toFixed(2));
    tgt = Math.max(tgt, +(entry * 1.60).toFixed(2));
  } else if (moneyness > 0.03) {
    sl  = +(entry * 0.70).toFixed(2);
    tgt = +(entry * 1.40).toFixed(2);
  }
  const risk = entry - sl;
  rr = risk > 0 ? +((tgt - entry) / risk).toFixed(2) : rr;
  return { sl, tgt, rr, method: method + ' | EXPIRY DAY', dte };
}

// ── applyFIIBias — EXACT port from HTML ──────────────────────
// Call after calcConfidence/calcOptConfidence with FII data from context
export function applyFIIBias(baseConf, isBuySignal, fiiData) {
  if (!fiiData) return baseConf;
  const { bias } = interpretFIIDII(fiiData);
  const direction  = isBuySignal ? 1 : -1;
  const adjustment = Math.round((bias / 20) * 8 * direction);
  return Math.min(99, Math.max(1, baseConf + adjustment));
}

// ── applyCalibration — EXACT port from HTML ──────────────────
// Uses GitHub signal history to calibrate confidence scores
export function applyCalibration(rawConf, calibration) {
  if (!calibration) return rawConf;
  const bucket = Math.floor(rawConf / 10) * 10;
  const cal = calibration[bucket] || calibration[bucket - 10] || null;
  if (!cal || cal.total < 5) return rawConf;
  return Math.min(99, Math.max(1, rawConf + cal.adj));
}

// ── applyAdaptWeights — apply per-indicator learned adjustments ──────────────
// Called after calcConfidence / calcOptConfidenceFull with indicator snapshot
// adaptW: the adaptWeights object from AppContext (stock or option sub-object)
// indicators: boolean map of which indicators fired for this signal
// Returns adjusted confidence, clamped to 1–99
export function applyAdaptWeights(conf, adaptW, indicators) {
  if (!adaptW || !indicators) return conf;
  let adj = 0;
  let appliedCount = 0;
  for (const [ind, data] of Object.entries(adaptW)) {
    if (!data || typeof data.adj !== 'number') continue;
    if (indicators[ind] === true) {
      adj += data.adj;
      appliedCount++;
    }
  }
  if (!appliedCount) return conf;
  // Dampen total adjustment: each additional indicator contributes less
  // to avoid stacking bonuses that push scores to 99 artificially
  const dampened = adj > 0
    ? Math.min(18, adj * (1 - appliedCount * 0.04))
    : Math.max(-18, adj * (1 - appliedCount * 0.04));
  return Math.min(99, Math.max(1, conf + dampened));
}

// ── getSignalStrength — EXACT port from HTML ─────────────────
export function getSignalStrength(numInds, conf, reversal) {
  const revBoost = reversal?.type !== 'NONE' ? 1 : 0;
  const eff = numInds + revBoost;
  if (eff >= 5 && conf >= 70) return { label: 'STRONG',   color: '#16a34a', bg: '#dcfce7', border: '#86efac' };
  if (eff >= 3 || conf >= 55) return { label: 'MODERATE', color: '#d97706', bg: '#fef3c7', border: '#fcd34d' };
  return                              { label: 'WEAK',     color: '#dc2626', bg: '#fee2e2', border: '#fca5a5' };
}

// ── computeCtxFromCandles — EXACT port from HTML ─────────────
// Builds composite market direction from 5-min intraday candles
// Used for EVERY index individually and for stock option scanning
export function computeCtxFromCandles(candles, spot, chgPct, vix, pdhl = null) {
  const _ema = (closes, period) => {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  };

  let momentumScore = 0, momentumLabel = 'N/A', intradayVWAP = 0;
  let emaCtx = {
    ema9: null, ema21: null, emaCross: null, emaCrossCandles: 999,
    emaTrendBull: null, momentumFresh: false, volumeSpike: false, volRatio: null,
  };

  if (candles.length >= 3) {
    const closes  = candles.map(c => +c[4]);
    const volumes = candles.map(c => +c[5]);
    const n       = candles.length;

    if (n >= 9)  emaCtx.ema9  = _ema(closes, 9);
    if (n >= 21) emaCtx.ema21 = _ema(closes, 21);
    if (emaCtx.ema9 != null && emaCtx.ema21 != null)
      emaCtx.emaTrendBull = emaCtx.ema9 > emaCtx.ema21;

    if (n >= 22) {
      let crossFound = null, crossAge = 999;
      for (let lb = 1; lb <= 3; lb++) {
        const prev9  = _ema(closes.slice(0, n - lb), 9);
        const prev21 = _ema(closes.slice(0, n - lb), 21);
        if (prev9 == null || prev21 == null) break;
        const wasBull = prev9 > prev21;
        if (emaCtx.emaTrendBull && !wasBull) { crossFound = 'bullish_cross'; crossAge = lb; break; }
        if (!emaCtx.emaTrendBull && wasBull) { crossFound = 'bearish_cross'; crossAge = lb; break; }
      }
      emaCtx.emaCross        = crossFound || 'no_cross';
      emaCtx.emaCrossCandles = crossAge;
    }

    if (n >= 3) {
      const last2 = candles.slice(-2), prev2 = candles.slice(-4, -2);
      const last2Bull = last2.every(c => +c[4] > +c[1]);
      const last2Bear = last2.every(c => +c[4] < +c[1]);
      const prev2Bear = prev2.length >= 2 && prev2.every(c => +c[4] < +c[1]);
      const prev2Bull = prev2.length >= 2 && prev2.every(c => +c[4] > +c[1]);
      emaCtx.momentumFresh = (last2Bull && prev2Bear) || (last2Bear && prev2Bull);
    }

    if (n >= 5) {
      const lb  = Math.min(10, n - 1);
      const avg = volumes.slice(-lb - 1, -1).reduce((a, b) => a + b, 0) / lb;
      emaCtx.volRatio    = avg > 0 ? +(volumes[n - 1] / avg).toFixed(2) : null;
      emaCtx.volumeSpike = emaCtx.volRatio != null && emaCtx.volRatio >= 1.5;
    }

    const recent    = candles.slice(-6);
    const movePct   = (+recent[recent.length - 1][4] - +recent[0][1]) / +recent[0][1] * 100;
    const upCandles = recent.filter(c => +c[4] > +c[1]).length;
    const dnCandles = recent.filter(c => +c[4] < +c[1]).length;
    if      (movePct > 0.4)  momentumScore += 2;
    else if (movePct > 0.15) momentumScore += 1;
    else if (movePct < -0.4)  momentumScore -= 2;
    else if (movePct < -0.15) momentumScore -= 1;
    if      (upCandles >= 4)  momentumScore += 1;
    else if (dnCandles >= 4)  momentumScore -= 1;
    momentumScore = Math.max(-3, Math.min(3, momentumScore));

    momentumLabel = momentumScore >= 2 ? 'RISING STRONGLY' : momentumScore >= 1 ? 'RISING' :
                    momentumScore <= -2 ? 'FALLING STRONGLY' : momentumScore <= -1 ? 'FALLING' : 'FLAT';

    let tpvSum = 0, volSum = 0;
    for (const c of candles) { const tp = (+c[2] + +c[3] + +c[4]) / 3, v = +c[5]; tpvSum += tp * v; volSum += v; }
    intradayVWAP = volSum > 0 ? tpvSum / volSum : 0;
  }

  // ── Composite score — 4-factor model (EXACT weights from HTML) ──
  // EMA(2.0) + VWAP(1.5) + Momentum(1.0) + DayChange(0.3)
  const dayScore  = chgPct > 1 ? 2 : chgPct > 0.3 ? 1 : chgPct < -1 ? -2 : chgPct < -0.3 ? -1 : 0;
  const vwapScore = intradayVWAP > 0 ? (spot >= intradayVWAP ? 1 : -1) : 0;
  const emaScore  = emaCtx.emaTrendBull == null ? 0 : emaCtx.emaTrendBull ? 1 : -1;
  const emaCrossBonus = (emaCtx.emaCross === 'bullish_cross' && emaCtx.emaCrossCandles <= 2) ?  0.5
                      : (emaCtx.emaCross === 'bearish_cross' && emaCtx.emaCrossCandles <= 2) ? -0.5
                      : 0;
  const emaFactor      = emaScore + emaCrossBonus;
  const compositeScore = +(momentumScore * 1.0 + dayScore * 0.3 + vwapScore * 1.5 + emaFactor * 2.0).toFixed(2);

  const deadBand  = candles.length >= 3 ? 0.5 : 1.0;
  const isBullish = compositeScore > 0;
  const isNeutral = Math.abs(compositeScore) < deadBand;

  return {
    spot, vwap: intradayVWAP, momentumScore, momentumLabel,
    dayChange: chgPct, dayScore, vwapScore,
    compositeScore, bullish: isBullish, neutral: isNeutral, vix,
    ema9:            emaCtx.ema9,
    ema21:           emaCtx.ema21,
    emaTrendBull:    emaCtx.emaTrendBull,
    emaCross:        emaCtx.emaCross,
    emaCrossCandles: emaCtx.emaCrossCandles,
    momentumFresh:   emaCtx.momentumFresh,
    volumeSpike:     emaCtx.volumeSpike,
    volRatio:        emaCtx.volRatio,
    pdh: pdhl?.pdh || null,
    pdl: pdhl?.pdl || null,
    pdc: pdhl?.pdc || null,
  };
}

// ── Full calcOptConfidence — EXACT port with marketCtx ────────
export function calcOptConfidenceFull(delta, iv, oiChg, theta, signals, spot, strike, optType, niftyBullish, vix, maxPain, stockPCR, marketCtx) {
  const absD = Math.abs(delta), isCE = optType === 'CE';

  // Direction multiplier using compositeScore (not binary niftyBullish)
  let dirMult;
  const cs = marketCtx?.compositeScore ?? (niftyBullish ? 1 : -1);
  const isNeutral = marketCtx?.neutral === true;
  // Tightened: neutral market now gets 0.70 (was 0.90) — your data shows 37% WR in neutral
  // Also raised threshold from 1.0 to 1.2 to catch weak signals
  if (isNeutral || Math.abs(cs) < 1.2) {
    dirMult = 0.70;
  } else {
    const aligned = (isCE && cs > 0) || (!isCE && cs < 0);
    const absCs   = Math.abs(cs);
    dirMult = aligned
      ? (absCs >= 3 ? 1.05 : absCs >= 2 ? 1.0 : absCs >= 1.5 ? 0.90 : 0.80)
      : (absCs >= 3 ? 0.20 : absCs >= 2 ? 0.30 : 0.40);
  }

  // Momentum bonus
  let momentumBonus = 0;
  if (marketCtx?.momentumScore != null) {
    const ms = marketCtx.momentumScore;
    const mAligned = (isCE && ms > 0) || (!isCE && ms < 0);
    if      (mAligned  && Math.abs(ms) >= 2) momentumBonus =  8;
    else if (mAligned  && Math.abs(ms) >= 1) momentumBonus =  4;
    else if (!mAligned && Math.abs(ms) >= 2) momentumBonus = -6;
  }

  // EMA crossover bonus
  let emaBonus = 0;
  if (marketCtx?.emaTrendBull != null) {
    const emaAligned = (isCE && marketCtx.emaTrendBull) || (!isCE && !marketCtx.emaTrendBull);
    const cross    = marketCtx.emaCross;
    const crossAge = marketCtx.emaCrossCandles ?? 999;
    if (emaAligned) {
      emaBonus = cross === (isCE ? 'bullish_cross' : 'bearish_cross')
        ? (crossAge <= 1 ? 15 : crossAge <= 2 ? 10 : 6)
        : 5;
    } else {
      emaBonus = cross === (isCE ? 'bearish_cross' : 'bullish_cross') ? -15 : -8;
    }
  }

  // Freshness bonus
  let freshnessBonus = 0;
  if (marketCtx?.momentumFresh === true) {
    const freshAligned = (isCE && (marketCtx.compositeScore ?? 0) > 0) || (!isCE && (marketCtx.compositeScore ?? 0) < 0);
    freshnessBonus = freshAligned ? 8 : 0;
  }

  // Volume bonus
  let volumeBonus = 0;
  if (marketCtx?.volRatio != null) {
    if      (marketCtx.volRatio >= 2.0) volumeBonus =  10;
    else if (marketCtx.volRatio >= 1.5) volumeBonus =   6;
    else if (marketCtx.volRatio <  0.7) volumeBonus =  -8;
  }

  // Delta score (30%)
  const deltaScore = absD >= 0.7 ? 90 : absD >= 0.5 ? 78 : absD >= 0.3 ? 60 : absD >= 0.15 ? 42 : 25;

  // IV score (20%)
  const ivScore = iv >= 60 ? 20 : iv >= 40 ? 35 : iv >= 25 ? 60 : iv >= 15 ? 80 : 55;

  // OI/PCR trend score (25%) — uses pcrTrend from marketCtx (not raw oiChg)
  const pcrTrend = marketCtx?.pcrTrend ?? 0;
  let oiScore;
  if (Math.abs(pcrTrend) < 0.03) {
    oiScore = 50;
  } else {
    const pcrBull = pcrTrend < 0;
    const aligned = (isCE && pcrBull) || (!isCE && !pcrBull);
    const strength = Math.abs(pcrTrend);
    oiScore = aligned
      ? (strength > 0.15 ? 90 : strength > 0.08 ? 75 : 62)
      : (strength > 0.15 ? 25 : strength > 0.08 ? 35 : 45);
  }

  // Moneyness (15%)
  const moneyness = spot > 0 ? Math.abs((strike - spot) / spot * 100) : 10;
  const atmScore  = moneyness <= 1 ? 90 : moneyness <= 3 ? 80 : moneyness <= 6 ? 65 : moneyness <= 10 ? 45 : 25;

  // Theta (10%)
  const thetaScore = theta < -10 ? 20 : theta < -3 ? 40 : theta < -1 ? 62 : theta < -0.3 ? 75 : 85;

  // Signal bonus
  const sigBonus = Math.min(12, (signals || []).filter(s => s.s >= 2).length * 6);

  // Expiry bonus
  let expiryBonus = 0;
  if (isWeeklyExpiryDay()) {
    const expMoney = spot > 0 ? Math.abs(strike - spot) / spot : 0;
    if      (expMoney < 0.005) expiryBonus = 12;
    else if (expMoney < 0.01)  expiryBonus =  7;
    else if (expMoney > 0.04)  expiryBonus = -10;
    else if (expMoney > 0.025) expiryBonus =  -5;
  }

  // IV percentile adjustment
  const _ivRatioConf = vix > 0 && iv > 0 ? iv / vix : 1;
  const ivPercentileAdj = _ivRatioConf < 0.80 ? 6 : _ivRatioConf > 1.40 ? -8 : 0;
  const isBuyAction  = (isCE && (marketCtx?.compositeScore ?? 1) > 0) || (!isCE && (marketCtx?.compositeScore ?? -1) < 0);
  const ivAdjFinal   = isBuyAction ? ivPercentileAdj : -ivPercentileAdj;

  // IV trend bonus
  let ivTrendBonus = 0;
  const ivTrend = marketCtx?.ivTrend ?? 0;
  if (isBuyAction) {
    if      (ivTrend >= 1.5)  ivTrendBonus =  10;
    else if (ivTrend >= 0.5)  ivTrendBonus =   5;
    else if (ivTrend <= -1.5) ivTrendBonus = -15;
    else if (ivTrend <= -0.5) ivTrendBonus =  -8;
  } else {
    if      (ivTrend <= -1.0) ivTrendBonus =  6;
    else if (ivTrend >= 1.5)  ivTrendBonus = -5;
  }

  const _timeAdj = getTimeOfDayPenalty();
  let raw = deltaScore * 0.30 + ivScore * 0.20 + oiScore * 0.25 + atmScore * 0.15 + thetaScore * 0.10
    + sigBonus + momentumBonus + emaBonus + freshnessBonus + volumeBonus + ivTrendBonus + expiryBonus + ivAdjFinal;

  // VIX impact
  if      (vix > 30) raw -= 15;
  else if (vix > 25) raw -= 8;
  else if (vix > 20) raw -= 4;
  else if (vix < 14) raw += 5;

  // Max Pain gravity (expiry day only)
  if (maxPain && maxPain > 0 && spot > 0 && isWeeklyExpiryDay()) {
    const towardMP = (optType === 'CE' && maxPain > spot && strike <= maxPain)
                  || (optType === 'PE' && maxPain < spot && strike >= maxPain);
    const mpDist   = Math.abs((maxPain - spot) / spot * 100);
    if (towardMP && mpDist > 1.5) raw += 6;
    else if (towardMP && mpDist > 0.5) raw += 3;
  }

  raw = raw * dirMult;
  raw += _timeAdj;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// ── Full scanChain — EXACT port from HTML ─────────────────────
export function scanChain(chain, atm, spot, name, expiry, lotSize, niftyBullish, vix, maxPain, stockPCR, marketCtx, cfg) {
  const picks = [];
  const isNeutral      = marketCtx?.neutral === true;
  const compositeScore = marketCtx?.compositeScore ?? (niftyBullish ? 1 : -1);

  // Gate: consolidating market
  if (marketCtx?.isConsolidating) return [];

  // PDH/PDL zone
  const pdh = marketCtx?.pdh || null, pdl = marketCtx?.pdl || null;
  let priceZone = 'mid';
  if (pdh && pdl && spot > 0) {
    const pdhDist = (spot - pdh) / pdh * 100;
    const pdlDist = (pdl - spot) / pdl * 100;
    if      (pdhDist >= 0)    priceZone = 'abovePDH';
    else if (pdhDist >= -0.3) priceZone = 'nearPDH';
    else if (pdlDist >= 0)    priceZone = 'belowPDL';
    else if (pdlDist >= -0.3) priceZone = 'nearPDL';
  }

  const dirFlipPenalty = marketCtx?.directionFlipped ? -15 : 0;
  const delta_thresh   = cfg?.delta || 0.40;
  const iv_thresh      = cfg?.iv    || 15;
  const oi_thresh      = cfg?.oi    || 15;

  for (const row of chain) {
    const sp = row.strike_price;
    if (!spot || Math.abs(sp - atm) > spot * 0.15) continue;

    for (const [side, optType] of [['call_options', 'CE'], ['put_options', 'PE']]) {
      const opt = row[side]; if (!opt) continue;
      const md = opt.market_data, gr = opt.option_greeks;
      const instrKey = opt.instrument_key || null;
      if (!md?.ltp || md.ltp < 0.5) continue;
      const ltp = md.ltp, delta = gr?.delta || 0, iv = gr?.iv || 0, theta = gr?.theta || 0;
      const absD0 = Math.abs(delta);
      if (iv === 0 && absD0 > 0.95) continue;
      if (iv === 0 && ltp < 1)      continue;
      const oi = md?.oi || 0, prevOI = md?.prev_oi || oi;
      // Liquidity gate — a calculated SL is meaningless if the contract barely trades;
      // thin OI means price can gap straight through the SL before it's ever caught.
      if (oi < (cfg?.minOptOI ?? 500)) continue;
      const oiChg = prevOI > 0 ? ((oi - prevOI) / prevOI * 100) : 0;
      const absD  = Math.abs(delta);

      // Signals array (same gate as HTML: need ≥2)
      const signals = [];
      if (absD  >= delta_thresh)  signals.push({ l: 'Delta ' + delta.toFixed(2),        s: 3 });
      if (iv    >= iv_thresh)     signals.push({ l: 'IV ' + iv.toFixed(1) + '%',          s: 2 });
      if (oiChg >= oi_thresh)     signals.push({ l: 'OI +' + oiChg.toFixed(0) + '%',     s: 2 });
      if (oiChg <= -oi_thresh)    signals.push({ l: 'OI ' + oiChg.toFixed(0) + '% UW',   s: 1 });
      if (theta < -0.5)           signals.push({ l: 'Θ ' + theta.toFixed(2),              s: 1 });
      if (sp === atm)             signals.push({ l: 'ATM',                                 s: 1 });
      if (signals.length < 2)     continue;

      // OI build classification
      const priceBull = compositeScore > 0.5, priceBear = compositeScore < -0.5;
      const oiRising  = oiChg >= oi_thresh,   oiFalling = oiChg <= -oi_thresh;
      const isCEOpt   = optType === 'CE';
      let oiBuildType = 'NEUTRAL', oiBuildBonus = 0;
      if (isCEOpt) {
        if (priceBull && oiRising)  { oiBuildType = 'LONG_BUILD';  oiBuildBonus = +15; }
        if (priceBull && oiFalling) { oiBuildType = 'SHORT_COVER'; oiBuildBonus =  +5; }
        if (priceBear && oiRising)  { oiBuildType = 'SHORT_BUILD'; oiBuildBonus = -15; }
        if (priceBear && oiFalling) { oiBuildType = 'LONG_UNWIND'; oiBuildBonus =  -8; }
      } else {
        if (priceBear && oiRising)  { oiBuildType = 'LONG_BUILD';  oiBuildBonus = +15; }
        if (priceBear && oiFalling) { oiBuildType = 'SHORT_COVER'; oiBuildBonus =  +5; }
        if (priceBull && oiRising)  { oiBuildType = 'SHORT_BUILD'; oiBuildBonus = -15; }
        if (priceBull && oiFalling) { oiBuildType = 'LONG_UNWIND'; oiBuildBonus =  -8; }
      }
      if (!oiRising && !oiFalling) oiBuildBonus = 0;

      // IV environment
      const ivTrendVal = marketCtx?.ivTrend ?? 0;
      const ivEnv = ivTrendVal >= 1.5 ? 'EXPANDING' : ivTrendVal >= 0.5 ? 'RISING' :
                    ivTrendVal <= -1.5 ? 'CONTRACTING' : ivTrendVal <= -0.5 ? 'FALLING' : 'STABLE';
      if (ivEnv === 'EXPANDING')   signals.push({ l: 'IV Expanding ↑',   s: 2 });
      if (ivEnv === 'CONTRACTING') signals.push({ l: 'IV Contracting ↓', s: 1 });

      // SL/Target — use smart IV+DTE+Delta model, clamped to cfg.optSL/optTgt %
      const entry    = ltp;
      const _optSlPct  = (cfg?.optSL  || 25) / 100;  // fallback SL %
      const _optTgtPct = (cfg?.optTgt || 50) / 100;  // fallback Target %
      const _opt     = calcSmartOptionSLTarget(entry, spot, sp, iv, delta, theta, expiry, vix);
      const _optAdj  = applyExpiryDayAdjustment(_opt, delta, iv, entry, spot, sp);
      let { sl, tgt, rr, method: slTgtMethod } = _optAdj;
      // Apply cfg.optSL/optTgt as minimum bounds (don't go tighter than user setting)
      const _minSL  = +(entry * (1 - _optSlPct)).toFixed(2);
      const _minTgt = +(entry * (1 + _optTgtPct)).toFixed(2);
      if (sl > _minSL)  sl  = _minSL;   // SL can't be tighter than optSL%
      if (tgt < _minTgt) tgt = _minTgt; // Target can't be smaller than optTgt%
      rr = (entry - sl) > 0 ? +((tgt - entry) / (entry - sl)).toFixed(2) : rr;

      // Confidence — full formula with marketCtx
      let confidence = calcOptConfidenceFull(delta, iv, oiChg, theta, signals, spot, sp, optType, niftyBullish, vix, maxPain, stockPCR, marketCtx);

      // Zone adjustment
      let zoneAdj = 0;
      const isCE_ = optType === 'CE';
      if      (priceZone === 'abovePDH' &&  isCE_) zoneAdj = +10;
      else if (priceZone === 'nearPDH'  &&  isCE_) zoneAdj =  +5;
      else if (priceZone === 'belowPDL' && !isCE_) zoneAdj = +10;
      else if (priceZone === 'nearPDL'  && !isCE_) zoneAdj =  +5;
      else if (priceZone === 'mid')                 zoneAdj = -18;
      if (priceZone === 'belowPDL' &&  isCE_) zoneAdj = -25;
      if (priceZone === 'abovePDH' && !isCE_) zoneAdj = -25;

      confidence = Math.round(Math.min(100, Math.max(0, confidence + zoneAdj + dirFlipPenalty + oiBuildBonus)));

      // Direction
      // Raised from 1.0 to 1.5 — weak direction signals generated too many WATCH/low-conf picks
      const effectiveNeutral = isNeutral || Math.abs(compositeScore) < 1.5;
      const isCE = optType === 'CE';
      const trendAligned = effectiveNeutral ? false : (isCE ? compositeScore > 0 : compositeScore < 0);
      const momentumDir  = isNeutral ? 'NEUTRAL' : compositeScore > 2 ? 'STRONGLY BULLISH' : compositeScore > 0 ? 'BULLISH' : compositeScore < -2 ? 'STRONGLY BEARISH' : 'BEARISH';

      // Action — use THIS instrument's own compositeScore (same as trendAligned above),
      // not the cross-index niftyBullish flag. Using niftyBullish here meant every
      // non-NIFTY underlying (SENSEX/BANKNIFTY/FINNIFTY/stocks) had its BUY/SELL
      // decision driven by NIFTY's move instead of its own — a major source of
      // wrong-direction entries whenever the two diverged.
      const aligned = (isCE && compositeScore > 0) || (!isCE && compositeScore < 0);
      let action = 'WATCH';
      if (!aligned && !isNeutral) { if (absD >= delta_thresh && oiChg <= -oi_thresh) action = 'SELL'; }
      else                        { if (absD >= delta_thresh) action = 'BUY'; }
      if (iv >= iv_thresh && oiChg <= -oi_thresh) action = 'SELL';

      // SELL: flip SL/Target
      if (action === 'SELL') {
        const riskPct   = entry > 0 ? (entry - sl)  / entry : 0.25;
        const rewardPct = entry > 0 ? (tgt - entry) / entry : 0.50;
        sl  = +(entry * (1 + riskPct)).toFixed(2);
        tgt = +Math.max(0.5, entry * (1 - rewardPct)).toFixed(2);
        rr  = riskPct > 0 ? +(rewardPct / riskPct).toFixed(2) : rr;
        slTgtMethod += ' · SELL (flipped)';
      }

      // Multi-target levels (T1/T2/T3) for partial-exit trade management.
      // T2 = the existing risk-validated target; T1/T3 are R-multiple steps
      // around it in the same direction (SL/Target already flipped above for SELL).
      const dir      = action === 'SELL' ? -1 : 1;
      const riskDist = Math.abs(entry - sl);
      const t1 = riskDist > 0 ? +(entry + dir * riskDist * 1.0).toFixed(2) : tgt;
      const t2 = tgt;
      const t3 = riskDist > 0 ? +(entry + dir * riskDist * (Math.abs(rr || 2) * 1.5)).toFixed(2) : tgt;

      const lot       = lotSize || 1;
      const maxLoss   = +(action === 'SELL' ? (sl - entry) * lot : (entry - sl) * lot).toFixed(0);
      const maxProfit = +(action === 'SELL' ? (entry - tgt) * lot : (tgt - entry) * lot).toFixed(0);

      picks.push({
        instrKey,
        strike: sp, type: optType, entry, sl, tgt, rr, t1, t2, t3,
        iv, delta, theta, oi, oiChg, action, signals,
        score: signals.reduce((a, s) => a + s.s, 0),
        confidence, atm: sp === atm, spot, expiry, und: name,
        lot, amtRequired: +(ltp * lot).toFixed(0), maxLoss, maxProfit,
        trendAligned, trendDir: momentumDir, compositeScore, slTgtMethod,
        stockPCR: stockPCR || null, vix: vix || 15, priceZone,
        pdh: pdh || null, pdl: pdl || null,
        zoneAdj, dirFlipPenalty, oiBuildType, oiBuildBonus, ivEnv,
        emaTrendBull: marketCtx?.emaTrendBull ?? null,
        emaCross: marketCtx?.emaCross ?? null,
        momentumFresh: marketCtx?.momentumFresh || false,
        volRatio: marketCtx?.volRatio ?? null,
        candles: marketCtx?.candles?.slice(-20) || [],
      });
    }
  }
  return picks.sort((a, b) => b.confidence - a.confidence);
}

// Self-calibration built from closed signals. Shared by the app (AppContext) and the scheduled
// server-side scan, so both score signals with exactly the same learned adjustments.
import { signalWin } from './mlRanking.js';

// Layer 1: bucket-level win-rate correction.
export function computeConfCalibration(closed) {
  const bands = {};
  for (const s of closed) {
    const bucket = Math.floor((s.confidence || 50) / 10) * 10;
    if (!bands[bucket]) bands[bucket] = { hits:0, total:0 };
    bands[bucket].total++;
    if (signalWin(s)) bands[bucket].hits++;
  }
  const calibration = {};
  for (const [band, data] of Object.entries(bands)) {
    if (data.total < 3) continue;
    const b = parseInt(band);
    const actualWR = data.hits / data.total;
    const expectedWR = b / 100;
    const rawAdj = Math.round((actualWR - expectedWR) * 100);
    calibration[b] = { adj: Math.max(-15, Math.min(15, rawAdj)), hits:data.hits, total:data.total, winRate:Math.round(actualWR*100) };
  }
  return calibration;
}

// Layer 2: per-indicator win-rate adjustment. Returns null until there is enough indicator data.
export function computeAdaptWeights(closed) {
  const withInds = closed.filter(s => s.indicators && typeof s.indicators === 'object');
  if (withInds.length < 15) return null;   // not enough signals with indicator data yet

  // Baseline win rate across ALL closed signals
  const baselineWR = closed.filter(s => signalWin(s)).length / closed.length;

  // Per-type analysis: stocks and options separately
  const stockClosed = withInds.filter(s => s.type === 'STOCK');
  const optClosed   = withInds.filter(s => s.type === 'OPTION');

  // ── Stock indicator analysis ──
  const STOCK_INDICATORS = [
    'macdBull','macdBullCross','macdHistRising','macdBearCross','bbSqueeze','bbNearLower','bbAboveUpper',
    'adxBull','adxBear','adxNoTrend','rsiDiv','rsiDivHidden','rsiBearDiv','rsiBearDivHidden',
    'a50','a200','nearSupp','aboveVWAP','vwapNearLower','vwapFarAbove',
    'engulfing','hammer','morningStar','reversalFired','reversalBullish','reversalBearish',
    'delivHigh','delivLow','rsiOversold','rsiOverbought','vixVeryLow','vixHighFear',
    'pcrBearishExtreme','pcrBullishExtreme','near52wLow','near52wHigh',
    'confluenceStrong','confluenceWeak','confluenceConflict','fiiAligned','fiiAgainst',
  ];
  const OPT_INDICATORS = [
    'trendAligned','emaBull','emaBearish','freshCross','momentumFresh',
    'volSpike','lowVol','nearPDH','nearPDL','oiBuildUp',
    'compositeHigh','compositeMed','atm','vixVeryLow','vixHighFear',
    'confluenceStrong','confluenceWeak','confluenceConflict','fiiAligned','fiiAgainst',
  ];

  const MIN_SAMPLES = 8; // minimum signals per indicator before trusting it
  const MAX_ADJ     = 12; // max pts adjustment in either direction

  function computeIndWeights(signals, indicators, baseWR) {
    if (!signals.length) return {};
    const weights = {};
    for (const ind of indicators) {
      const withInd    = signals.filter(s => s.indicators[ind] === true);
      const withoutInd = signals.filter(s => s.indicators[ind] === false);
      if (withInd.length < MIN_SAMPLES) continue; // not enough data yet

      const wrWith    = withInd.filter(s => signalWin(s)).length / withInd.length;
      const wrWithout = withoutInd.length >= MIN_SAMPLES
        ? withoutInd.filter(s => signalWin(s)).length / withoutInd.length
        : baseWR;

      // Lift = how much better/worse this indicator is vs baseline
      const liftVsBaseline = wrWith - baseWR;
      // Differential = how much better/worse with vs without
      const liftVsWithout  = wrWith - wrWithout;
      // Weighted average of both measures (baseline more stable, differential more specific)
      const rawLift = liftVsBaseline * 0.6 + liftVsWithout * 0.4;
      // Convert to confidence pts: 10% lift → ~8 pts (diminishing returns)
      const adjPts  = Math.sign(rawLift) * Math.min(MAX_ADJ, Math.abs(rawLift) * 80);

      weights[ind] = {
        adj:     +adjPts.toFixed(1),
        wrWith:  Math.round(wrWith * 100),
        wrBase:  Math.round(baseWR * 100),
        n:       withInd.length,
        lift:    +(liftVsBaseline * 100).toFixed(1),
      };
    }
    return weights;
  }

  const stockWR  = stockClosed.length
    ? stockClosed.filter(s => signalWin(s)).length / stockClosed.length
    : baselineWR;
  const optWR    = optClosed.length
    ? optClosed.filter(s => signalWin(s)).length / optClosed.length
    : baselineWR;

  const stockWeights = computeIndWeights(stockClosed, STOCK_INDICATORS, stockWR);
  const optWeights   = computeIndWeights(optClosed,   OPT_INDICATORS,   optWR);

  const adaptW = {
    stock:        stockWeights,
    option:       optWeights,
    baselineWR:   +baselineWR.toFixed(3),
    stockBaseWR:  +stockWR.toFixed(3),
    optBaseWR:    +optWR.toFixed(3),
    totalSignals: closed.length,
    withIndData:  withInds.length,
    computedAt:   new Date().toISOString(),
  };
  return adaptW;
}

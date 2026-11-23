// The ONE reason a signal fired, logged on every signal so the Analysis page can show win rate per
// strategy. The scan blends many indicators into one confidence score, which hides which of them
// actually make money; this keeps a single primary label per signal (highest-priority condition first).

// f = the stock's boolean indicator flags (_indSnap) plus { volOk, chgPct, nearSupp }.
export function stockTrigger(f = {}) {
  if (f.goldenCrossRecent) return 'GOLDEN_CROSS';
  if (f.breakout52w) return '52W_BREAKOUT';
  if (f.macdBullCross) return 'MACD_CROSS';
  if (f.rsiDiv || f.rsiDivHidden) return 'RSI_DIVERGENCE';
  if (f.bbSqueeze && (f.bbAboveUpper || f.aboveVWAP)) return 'BB_SQUEEZE_BREAK';
  if (f.reversalBullish) return 'REVERSAL';
  if (f.nearSupp) return 'SUPPORT_BOUNCE';
  if (f.volOk && (f.chgPct ?? 0) > 0) return 'VOLUME_SURGE';
  if (f.adxBull) return 'ADX_TREND';
  if (f.a50 && f.a200) return 'TREND_FOLLOW';
  return 'MIXED';
}

// p = an option pick from scanChain.
export function optionTrigger(p = {}) {
  const isCE = p.type === 'CE';
  const zone = p.priceZone;
  if ((zone === 'abovePDH' && isCE) || (zone === 'belowPDL' && !isCE)) return 'LEVEL_BREAK';
  if (p.oiBuildType === 'LONG_BUILD') return 'OI_LONG_BUILD';
  if (p.oiBuildType === 'SHORT_COVER') return 'SHORT_COVER';
  if ((zone === 'nearPDH' && isCE) || (zone === 'nearPDL' && !isCE)) return 'LEVEL_TEST';
  if (p.trendAligned) return 'TREND_ALIGNED';
  return 'DELTA_IV';
}

const STOCK_FEATURES = [
  'baseConf', 'rr', 'riskInv', 'numInds', 'potential', 'expectedWR',
  'composite', 'momentum', 'bullish', 'reversal', 'aboveVWAP', 'nearSupport',
  'deliveryHigh', 'deliveryLow', 'macdBullCross', 'adxBull', 'rsiBullDiv', 'bbSqueeze',
  'weekday', 'phase', 'regime', 'sectorStrength', 'newsSentiment', 'gapType',
];

const OPTION_FEATURES = [
  'baseConf', 'rr', 'score', 'composite', 'momentum', 'bullish',
  'trendAligned', 'freshCross', 'momentumFresh', 'volSpike', 'oiBuildUp',
  'deltaAbs', 'iv', 'thetaAbs', 'atm', 'capitalLoad', 'nearPDH', 'nearPDL',
  'weekday', 'phase', 'regime', 'expiryDay', 'sectorStrength', 'newsSentiment',
  'maxPainDist', 'counterTrend',
];

const BASE_COST_PCT = {
  STOCK: 0.18,
  OPTION: 0.45,
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function logit(p) {
  const safe = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(safe / (1 - safe));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(v) {
  return v === true ? 1 : 0;
}

function safeDateParts(sig) {
  const dateStr = sig?.date || sig?.exitDate || '';
  const d = dateStr ? new Date(`${dateStr}T00:00:00`) : null;
  const weekday = d && !Number.isNaN(d) ? d.getDay() : 1;
  return { weekday };
}

function getPhaseValue(sig) {
  const time = (sig?.time || '').slice(0, 5);
  if (!time) return 0.5;
  const [hh, mm] = time.split(':').map((x) => parseInt(x, 10) || 0);
  const mins = hh * 60 + mm;
  if (mins <= 585) return 0.2;   // 9:45
  if (mins <= 630) return 0.4;   // 10:30
  if (mins <= 750) return 0.7;   // 12:30
  if (mins <= 840) return 0.55;  // 2:00
  return 0.35;
}

function getRegimeValue(sig) {
  const composite = toNum(sig?.compositeScore, 0);
  const momentum = toNum(sig?.momentumScore, 0);
  const vix = toNum(sig?.vix, 18);
  const trend = clamp((Math.abs(composite) / 3.5) * 0.7 + (Math.abs(momentum) / 3) * 0.3, 0, 1);
  const volPenalty = vix >= 22 ? -0.15 : vix <= 13 ? 0.1 : 0;
  return clamp(trend + volPenalty, 0, 1);
}

function getNewsSentiment(sig) {
  return clamp(toNum(sig?.newsSentiment ?? sig?.sentimentScore, 0.5), 0, 1);
}

function getSectorStrength(sig) {
  return clamp(((toNum(sig?.sectorScore, 0) + 5) / 10), 0, 1);
}

function getGapType(sig) {
  const gp = Math.abs(toNum(sig?.gapPct, 0));
  if (gp >= 2) return 1;
  if (gp >= 0.7) return 0.6;
  return 0;
}

function isBullishSignal(sig) {
  const action = (sig?.action || sig?.signal || sig?.rec || '').toUpperCase();
  if (action === 'SELL' || action === 'PUT') return 0;
  if (action === 'BUY' || action === 'CALL' || action.includes('BUY') || action === 'MODERATE') return 1;
  if (sig?.optType === 'PE') return 0;
  return 1;
}

function getIndicators(sig) {
  return sig?._indSnap || sig?.indicators || {};
}

function getOptionSubtype(sig) {
  if (sig?.type !== 'OPTION') return 'stock';
  const stock = (sig?.stock || sig?.und || '').toUpperCase();
  if (['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'].includes(stock)) return 'index';
  return 'stock';
}

function getStockFeatureVector(sig) {
  const ind = getIndicators(sig);
  const pot = sig?.pot || {};
  const entry = toNum(sig?.entry, 0);
  const target = toNum(sig?.target ?? sig?.targetMod, 0);
  const sl = toNum(sig?.sl, 0);
  const impliedPotential = entry > 0 && target > 0 ? ((target - entry) / entry) * 100 : 0;
  const impliedRR = entry > 0 && sl > 0 && target > entry && entry > sl ? (target - entry) / (entry - sl) : 0;
  const { weekday } = safeDateParts(sig);
  return {
    baseConf: clamp(toNum(sig?.confidence ?? sig?.conf, 50) / 100, 0, 1),
    rr: clamp(toNum(sig?.rr ?? pot?.rr, impliedRR) / 4, 0, 1.5),
    riskInv: clamp(1 - toNum(sig?.risk, 50) / 100, 0, 1),
    numInds: clamp(toNum(sig?.numInds, 0) / 10, 0, 1.5),
    potential: clamp(toNum(sig?.pot?.base, impliedPotential) / 15, 0, 1.5),
    expectedWR: clamp(toNum(sig?.pot?.wr ?? sig?.winRateEst, 0) / 100, 0, 1),
    composite: clamp(toNum(sig?.compositeScore, 0) / 4, -1.5, 1.5),
    momentum: clamp(toNum(sig?.momentumScore, 0) / 3, -1.5, 1.5),
    bullish: isBullishSignal(sig),
    reversal: asBool(sig?.reversal?.type ? sig.reversal.type !== 'NONE' : ind.reversalFired),
    aboveVWAP: asBool(ind.aboveVWAP),
    nearSupport: asBool(sig?.nearSupp || ind.nearSupp),
    deliveryHigh: asBool(ind.delivHigh),
    deliveryLow: asBool(ind.delivLow),
    macdBullCross: asBool(ind.macdBullCross),
    adxBull: asBool(ind.adxBull),
    rsiBullDiv: asBool(ind.rsiDiv || ind.rsiDivHidden),
    bbSqueeze: asBool(ind.bbSqueeze),
    weekday: weekday / 6,
    phase: getPhaseValue(sig),
    regime: getRegimeValue(sig),
    sectorStrength: getSectorStrength(sig),
    newsSentiment: getNewsSentiment(sig),
    gapType: getGapType(sig),
  };
}

function getOptionFeatureVector(sig) {
  const ind = getIndicators(sig);
  const { weekday } = safeDateParts(sig);
  const capital = toNum(sig?.amtRequired ?? sig?.capitalReq, 0);
  const spot = toNum(sig?.spot, 0);
  const strike = toNum(sig?.strike, 0);
  const maxPain = toNum(sig?.maxPain, strike);
  const maxPainDist = spot > 0 ? Math.abs(strike - maxPain) / spot : 0;
  return {
    baseConf: clamp(toNum(sig?.confidence, 50) / 100, 0, 1),
    rr: clamp(toNum(sig?.rr, 0) / 4, 0, 1.5),
    score: clamp(toNum(sig?.score ?? sig?.numInds, 0) / 12, 0, 1.5),
    composite: clamp(toNum(sig?.compositeScore, 0) / 4, -1.5, 1.5),
    momentum: clamp(toNum(sig?.momentumScore, 0) / 3, -1.5, 1.5),
    bullish: isBullishSignal(sig),
    trendAligned: asBool(sig?.trendAligned ?? ind.trendAligned),
    freshCross: asBool(ind.freshCross),
    momentumFresh: asBool(ind.momentumFresh),
    volSpike: asBool(ind.volSpike),
    oiBuildUp: asBool(ind.oiBuildUp),
    deltaAbs: clamp(Math.abs(toNum(sig?.delta, 0)), 0, 1.5),
    iv: clamp(toNum(sig?.iv, 0) / 100, 0, 2),
    thetaAbs: clamp(Math.abs(toNum(sig?.theta, 0)) / 2, 0, 2),
    atm: asBool(sig?.atm ?? ind.atm),
    capitalLoad: clamp(capital / 200000, 0, 2),
    nearPDH: asBool(ind.nearPDH),
    nearPDL: asBool(ind.nearPDL),
    weekday: weekday / 6,
    phase: getPhaseValue(sig),
    regime: getRegimeValue(sig),
    expiryDay: clamp(toNum(sig?._dte ?? sig?.dte, 3) <= 1 ? 1 : toNum(sig?._dte ?? sig?.dte, 3) <= 3 ? 0.6 : 0.2, 0, 1),
    sectorStrength: getSectorStrength(sig),
    newsSentiment: getNewsSentiment(sig),
    maxPainDist: clamp(maxPainDist * 20, 0, 2),
    counterTrend: asBool(sig?.trendAligned === false),
  };
}

function getFeatureVector(sig, type) {
  return type === 'STOCK' ? getStockFeatureVector(sig) : getOptionFeatureVector(sig);
}

function vectorize(features, names) {
  return names.map((name) => {
    const v = features[name];
    return Number.isFinite(v) ? v : 0;
  });
}

function collectLeafStats(rows, indices) {
  let grad = 0;
  let hess = 0;
  for (const idx of indices) {
    grad += rows[idx].grad;
    hess += rows[idx].hess;
  }
  return { grad, hess };
}

function leafValue(stats, lambdaL2) {
  return stats.grad / (stats.hess + lambdaL2 + 1e-9);
}

function splitGain(left, right, parent, lambdaL2) {
  return (
    (left.grad * left.grad) / (left.hess + lambdaL2 + 1e-9) +
    (right.grad * right.grad) / (right.hess + lambdaL2 + 1e-9) -
    (parent.grad * parent.grad) / (parent.hess + lambdaL2 + 1e-9)
  );
}

function buildLeafNode(rows, indices, lambdaL2) {
  const stats = collectLeafStats(rows, indices);
  return {
    indices,
    value: leafValue(stats, lambdaL2),
    stats,
    gain: -Infinity,
    split: null,
    left: null,
    right: null,
  };
}

function findBestSplit(rows, indices, featureNames, minDataInLeaf, lambdaL2, minGainToSplit) {
  if (indices.length < minDataInLeaf * 2) return null;
  const parent = collectLeafStats(rows, indices);
  let best = null;

  for (let f = 0; f < featureNames.length; f++) {
    const sorted = indices
      .map((idx) => ({ idx, v: rows[idx].x[f] }))
      .filter((item) => Number.isFinite(item.v))
      .sort((a, b) => a.v - b.v);
    if (sorted.length < minDataInLeaf * 2) continue;

    let leftGrad = 0;
    let leftHess = 0;
    let leftCount = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const row = rows[sorted[i].idx];
      leftGrad += row.grad;
      leftHess += row.hess;
      leftCount++;
      const rightCount = sorted.length - leftCount;
      if (leftCount < minDataInLeaf || rightCount < minDataInLeaf) continue;
      if (sorted[i].v === sorted[i + 1].v) continue;

      const left = { grad: leftGrad, hess: leftHess };
      const right = { grad: parent.grad - leftGrad, hess: parent.hess - leftHess };
      const gain = splitGain(left, right, parent, lambdaL2);
      if (gain <= minGainToSplit) continue;
      if (!best || gain > best.gain) {
        best = { feature: f, threshold: (sorted[i].v + sorted[i + 1].v) / 2, gain };
      }
    }
  }
  if (!best) return null;

  const leftIndices = [];
  const rightIndices = [];
  for (const idx of indices) {
    const v = rows[idx].x[best.feature];
    if (v <= best.threshold) leftIndices.push(idx);
    else rightIndices.push(idx);
  }
  if (leftIndices.length < minDataInLeaf || rightIndices.length < minDataInLeaf) return null;
  return { ...best, leftIndices, rightIndices };
}

function flattenTree(node) {
  if (!node.left || !node.right || !node.split) return { value: node.value };
  return {
    feature: node.split.feature,
    threshold: node.split.threshold,
    gain: node.gain,
    left: flattenTree(node.left),
    right: flattenTree(node.right),
  };
}

function predictTree(tree, vector) {
  let node = tree;
  while (node && node.feature != null) {
    node = vector[node.feature] <= node.threshold ? node.left : node.right;
  }
  return node?.value || 0;
}

function buildLeafWiseTree(rows, featureNames, options) {
  const root = buildLeafNode(rows, rows.map((_, idx) => idx), options.lambdaL2);
  const leaves = [root];
  while (leaves.length < options.maxLeaves) {
    let bestLeaf = null;
    let bestLeafIdx = -1;
    let bestSplit = null;
    for (let i = 0; i < leaves.length; i++) {
      const split = findBestSplit(rows, leaves[i].indices, featureNames, options.minDataInLeaf, options.lambdaL2, options.minGainToSplit);
      if (!split) continue;
      if (!bestSplit || split.gain > bestSplit.gain) {
        bestSplit = split;
        bestLeaf = leaves[i];
        bestLeafIdx = i;
      }
    }
    if (!bestLeaf || !bestSplit) break;
    bestLeaf.split = bestSplit;
    bestLeaf.gain = bestSplit.gain;
    bestLeaf.left = buildLeafNode(rows, bestSplit.leftIndices, options.lambdaL2);
    bestLeaf.right = buildLeafNode(rows, bestSplit.rightIndices, options.lambdaL2);
    leaves.splice(bestLeafIdx, 1, bestLeaf.left, bestLeaf.right);
  }
  return flattenTree(root);
}

function predictScore(model, vector) {
  let score = model.baseScore;
  for (const tree of model.trees) score += model.learningRate * predictTree(tree, vector);
  return score;
}

function fitCalibrator(dataset, model) {
  if (!dataset.length) return null;
  const bins = Array.from({ length: 10 }, (_, i) => ({
    min: i / 10,
    max: (i + 1) / 10,
    total: 0,
    hits: 0,
    avgPred: 0,
  }));
  for (const row of dataset) {
    const p = sigmoid(predictScore(model, row.x));
    const idx = Math.min(9, Math.floor(p * 10));
    bins[idx].total++;
    bins[idx].hits += row.y;
    bins[idx].avgPred += p;
  }
  return bins.map((bin) => ({
    ...bin,
    avgPred: bin.total ? bin.avgPred / bin.total : (bin.min + bin.max) / 2,
    actual: bin.total ? bin.hits / bin.total : null,
  }));
}

function calibrateProbability(prob, calibrator) {
  if (!calibrator?.length) return prob;
  const idx = Math.min(calibrator.length - 1, Math.floor(clamp(prob, 0, 0.9999) * calibrator.length));
  const bin = calibrator[idx];
  if (!bin || bin.actual == null || bin.total < 3) return prob;
  return clamp(bin.actual * 0.7 + prob * 0.3, 0.01, 0.99);
}

function summarizeCostAdjusted(rows, costPct) {
  if (!rows.length) return null;
  const total = rows.length;
  const hits = rows.filter((r) => r.y === 1).length;
  const wr = Math.round((hits / total) * 100);
  const avgNet = rows.reduce((sum, row) => sum + ((toNum(row.pnlPct, 0) - costPct)), 0) / total;
  return { total, wr, avgNet: +avgNet.toFixed(2) };
}

function buildBacktestRows(signals, model, type) {
  return signals
    .filter((sig) => sig?.type === type)
    .map((sig) => {
      const features = getFeatureVector(sig, type);
      const vector = vectorize(features, model.featureNames);
      const rawProb = sigmoid(predictScore(model, vector));
      const mlProb = calibrateProbability(rawProb, model.calibrator);
      return {
        signal: sig,
        mlProb,
        baseConf: clamp(toNum(sig?.confidence ?? sig?.conf, 50) / 100, 0, 1),
        y: sig.status === 'TARGET_HIT' ? 1 : 0,
        pnlPct: toNum(sig.pnlPct, 0),
      };
    });
}

function summarizeBacktest(rows, type, thresholds) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.mlProb - a.mlProb);
  const topN = Math.max(1, Math.floor(sorted.length * 0.25));
  const top = sorted.slice(0, topN);
  const bottom = sorted.slice(-topN);
  const avg = (arr, fn) => arr.reduce((s, x) => s + fn(x), 0) / (arr.length || 1);
  const wr = (arr) => Math.round(avg(arr, (x) => x.y) * 100);
  const overallWr = wr(rows);
  const topQuartileWr = wr(top);
  const bottomQuartileWr = wr(bottom);
  const threshold = thresholds?.probability ?? 0.62;
  const filtered = rows.filter((r) => r.mlProb >= threshold);
  const costSummary = summarizeCostAdjusted(filtered, BASE_COST_PCT[type] || 0.2);
  return {
    total: rows.length,
    overallWr,
    topQuartileWr,
    bottomQuartileWr,
    upliftTopVsAll: topQuartileWr - overallWr,
    spreadTopVsBottom: topQuartileWr - bottomQuartileWr,
    filtered: costSummary,
  };
}

function optimizeThresholds(dataset, model, type) {
  const rows = buildBacktestRows(dataset.map((d) => d.signal || d), model, type);
  if (!rows.length) return { probability: 0.62, minConfidence: 65, maxRisk: 55, minRR: 1.2, maxCapital: 0 };
  const candidates = [0.55, 0.58, 0.6, 0.62, 0.65, 0.68, 0.7, 0.74];
  let best = { probability: 0.62, score: -Infinity };
  for (const p of candidates) {
    const filtered = rows.filter((r) => r.mlProb >= p);
    if (filtered.length < Math.max(6, rows.length * 0.08)) continue;
    const wr = filtered.filter((r) => r.y === 1).length / filtered.length;
    const avgNet = filtered.reduce((sum, r) => sum + (r.pnlPct - (BASE_COST_PCT[type] || 0.2)), 0) / filtered.length;
    const score = wr * 0.7 + (avgNet / 100) * 0.3;
    if (score > best.score) best = { probability: p, score };
  }
  return {
    probability: best.probability,
    minConfidence: Math.round(best.probability * 100),
    maxRisk: type === 'STOCK' ? 48 : 58,
    minRR: type === 'STOCK' ? 1.4 : 1.3,
    maxCapital: type === 'OPTION' ? 120000 : 0,
  };
}

function collectFeatureImportance(model) {
  if (!model?.trees?.length) return [];
  const acc = {};
  const walk = (tree) => {
    if (!tree || tree.feature == null) return;
    const cur = acc[tree.feature] || { gain: 0, splits: 0 };
    cur.gain += tree.gain || 0;
    cur.splits += 1;
    acc[tree.feature] = cur;
    walk(tree.left);
    walk(tree.right);
  };
  model.trees.forEach(walk);
  const totalGain = Object.values(acc).reduce((sum, item) => sum + item.gain, 0) || 1;
  return Object.entries(acc).map(([featureIdx, item]) => ({
    feature: model.featureNames[Number(featureIdx)] || featureIdx,
    gain: +item.gain.toFixed(4),
    splits: item.splits,
    importance: +((item.gain / totalGain) * 100).toFixed(1),
  })).sort((a, b) => b.gain - a.gain);
}

function evaluateModel(model, dataset) {
  let correct = 0;
  let brier = 0;
  for (const row of dataset) {
    const raw = sigmoid(predictScore(model, row.x));
    const p = calibrateProbability(raw, model.calibrator);
    if ((p >= 0.5 ? 1 : 0) === row.y) correct++;
    brier += Math.pow(p - row.y, 2);
  }
  return {
    accuracy: dataset.length ? +(correct / dataset.length).toFixed(3) : 0,
    brier: dataset.length ? +(brier / dataset.length).toFixed(4) : 1,
  };
}

function trainLightGbmStyleModel(dataset, featureNames, type, label) {
  if (dataset.length < 30) return null;
  const positives = dataset.filter((row) => row.y === 1).length;
  const negatives = dataset.length - positives;
  if (positives < 6 || negatives < 6) return null;
  const params = {
    numIterations: dataset.length >= 150 ? 42 : dataset.length >= 90 ? 32 : 24,
    learningRate: dataset.length >= 150 ? 0.07 : 0.09,
    maxLeaves: dataset.length >= 150 ? 10 : 8,
    minDataInLeaf: dataset.length >= 150 ? 10 : 6,
    lambdaL2: 1.5,
    minGainToSplit: 0.0001,
  };
  const baseRate = positives / dataset.length;
  const model = {
    kind: 'lightgbm_style_gbdt_v2',
    type,
    label,
    featureNames,
    baseScore: logit(baseRate),
    learningRate: params.learningRate,
    trees: [],
    trainedOn: dataset.length,
    wins: positives,
    losses: negatives,
    baseRate: +baseRate.toFixed(3),
    computedAt: new Date().toISOString(),
    params,
  };
  const scores = dataset.map(() => model.baseScore);
  for (let iter = 0; iter < params.numIterations; iter++) {
    const rows = dataset.map((row, idx) => {
      const p = sigmoid(scores[idx]);
      return { x: row.x, grad: row.y - p, hess: Math.max(p * (1 - p), 1e-5) };
    });
    const tree = buildLeafWiseTree(rows, featureNames, params);
    model.trees.push(tree);
    for (let i = 0; i < dataset.length; i++) {
      scores[i] += params.learningRate * predictTree(tree, dataset[i].x);
    }
  }
  model.calibrator = fitCalibrator(dataset, model);
  const metrics = evaluateModel(model, dataset);
  const baseBrier = +(baseRate * (1 - baseRate)).toFixed(4);
  return {
    ...model,
    accuracy: metrics.accuracy,
    brier: metrics.brier,
    baseBrier,
    edge: +(baseBrier - metrics.brier).toFixed(4),
    topFeatures: collectFeatureImportance(model).slice(0, 8),
  };
}

function getSegmentLabel(sig, type) {
  if (type === 'STOCK') {
    const phase = getPhaseValue(sig);
    return phase <= 0.25 ? 'stock_opening' : phase >= 0.65 ? 'stock_midday' : 'stock_late';
  }
  const subtype = getOptionSubtype(sig);
  const dir = (sig?.optType || '').toUpperCase();
  return `${subtype}_${dir || 'OPTION'}`.toLowerCase();
}

function buildDataset(signals, type, featureNames, label = null) {
  return signals
    .filter((sig) => sig?.type === type)
    .filter((sig) => !label || getSegmentLabel(sig, type) === label)
    .map((sig) => {
      const features = getFeatureVector(sig, type);
      return {
        signal: sig,
        y: sig.status === 'TARGET_HIT' ? 1 : 0,
        x: vectorize(features, featureNames),
      };
    });
}

function trainWalkForward(dataset, featureNames, type, label) {
  if (dataset.length < 40) return null;
  const sorted = [...dataset].sort((a, b) => `${a.signal.date}${a.signal.time || ''}`.localeCompare(`${b.signal.date}${b.signal.time || ''}`));
  const minTrain = Math.max(25, Math.floor(sorted.length * 0.5));
  let correct = 0;
  let tested = 0;
  let brier = 0;
  for (let i = minTrain; i < sorted.length; i++) {
    const train = sorted.slice(0, i);
    const model = trainLightGbmStyleModel(train, featureNames, type, label);
    if (!model) continue;
    const raw = sigmoid(predictScore(model, sorted[i].x));
    const prob = calibrateProbability(raw, model.calibrator);
    if ((prob >= 0.5 ? 1 : 0) === sorted[i].y) correct++;
    brier += Math.pow(prob - sorted[i].y, 2);
    tested++;
  }
  if (!tested) return null;
  return {
    tested,
    accuracy: +(correct / tested).toFixed(3),
    brier: +(brier / tested).toFixed(4),
  };
}

function chooseRollback(globalModel, segmentModels) {
  const candidates = [globalModel, ...segmentModels.filter(Boolean)];
  return candidates.sort((a, b) => {
    const ea = (a?.edge || 0) + (a?.walkForward?.accuracy || 0) * 0.2;
    const eb = (b?.edge || 0) + (b?.walkForward?.accuracy || 0) * 0.2;
    return eb - ea;
  })[0] || globalModel;
}

function trainFamily(signals, type, featureNames) {
  const baseDataset = buildDataset(signals, type, featureNames);
  const globalModel = trainLightGbmStyleModel(baseDataset, featureNames, type, `${type.toLowerCase()}_global`);
  if (!globalModel) return null;
  globalModel.walkForward = trainWalkForward(baseDataset, featureNames, type, globalModel.label);

  const labelSet = [...new Set(signals.filter((s) => s.type === type).map((s) => getSegmentLabel(s, type)))];
  const segmentModels = labelSet.map((label) => {
    const ds = buildDataset(signals, type, featureNames, label);
    const model = trainLightGbmStyleModel(ds, featureNames, type, label);
    if (!model) return null;
    model.walkForward = trainWalkForward(ds, featureNames, type, label);
    return model;
  }).filter(Boolean);

  const servingModel = chooseRollback(globalModel, segmentModels);
  const thresholds = optimizeThresholds(baseDataset, servingModel, type);
  return {
    global: globalModel,
    segments: Object.fromEntries(segmentModels.map((m) => [m.label, m])),
    servingLabel: servingModel.label,
    thresholds,
    drift: {
      walkForwardAccuracy: servingModel.walkForward?.accuracy ?? globalModel.accuracy,
      stable: (servingModel.walkForward?.accuracy ?? globalModel.accuracy) >= (globalModel.accuracy - 0.08),
      rollbackTo: servingModel.label !== globalModel.label ? servingModel.label : null,
    },
    topFeatures: collectFeatureImportance(servingModel).slice(0, 8),
  };
}

export function trainSignalMlModels(closedSignals = []) {
  const usable = closedSignals.filter((sig) => sig.status === 'TARGET_HIT' || sig.status === 'SL_HIT');
  const stockFamily = trainFamily(usable, 'STOCK', STOCK_FEATURES);
  const optionFamily = trainFamily(usable, 'OPTION', OPTION_FEATURES);
  if (!stockFamily && !optionFamily) return null;
  return {
    modelName: 'AI Ensemble Brain',
    version: 'ai-ensemble-v2',
    computedAt: new Date().toISOString(),
    stock: stockFamily?.global || null,
    option: optionFamily?.global || null,
    families: {
      stock: stockFamily,
      option: optionFamily,
    },
    thresholds: {
      stock: stockFamily?.thresholds || null,
      option: optionFamily?.thresholds || null,
    },
    drift: {
      stock: stockFamily?.drift || null,
      option: optionFamily?.drift || null,
    },
  };
}

function selectServingModel(models, sigLike) {
  if (!models || !sigLike) return null;
  const fam = sigLike.type === 'STOCK' ? models.families?.stock : models.families?.option;
  if (!fam) return sigLike.type === 'STOCK' ? models.stock : models.option;
  const label = getSegmentLabel(sigLike, sigLike.type);
  const seg = fam.segments?.[label];
  if (seg && seg.trainedOn >= 25) return seg;
  if (fam.drift?.rollbackTo && fam.segments?.[fam.drift.rollbackTo]) return fam.segments[fam.drift.rollbackTo];
  return fam.global;
}

function portfolioPenalty(sigLike) {
  const capital = toNum(sigLike?.amtRequired ?? sigLike?.capitalReq, 0);
  const risk = toNum(sigLike?.risk, 45);
  let penalty = 0;
  if (capital > 150000) penalty += 4;
  if (risk > 60) penalty += 5;
  if (sigLike?.type === 'OPTION' && sigLike?.trendAligned === false) penalty += 3;
  return penalty;
}

function regimeAdjustment(sigLike, prob) {
  const regime = getRegimeValue(sigLike);
  const bullish = isBullishSignal(sigLike);
  const composite = toNum(sigLike?.compositeScore, 0);
  if (bullish && composite < -1) return clamp(prob - 0.06, 0.01, 0.99);
  if (!bullish && composite > 1) return clamp(prob - 0.06, 0.01, 0.99);
  if (regime > 0.75) return clamp(prob + 0.03, 0.01, 0.99);
  return prob;
}

function suppressionPenalty(sigLike, modelProb, thresholds) {
  let penalty = 0;
  if (modelProb < (thresholds?.probability || 0.62) - 0.08) penalty += 6;
  if (sigLike?.type === 'OPTION' && toNum(sigLike?.iv, 0) > 45 && sigLike?.trendAligned === false) penalty += 5;
  if (toNum(sigLike?.rr ?? sigLike?.pot?.rr, 0) < (thresholds?.minRR || 1.2)) penalty += 4;
  if (toNum(sigLike?.risk, 0) > (thresholds?.maxRisk || 55)) penalty += 5;
  return penalty;
}

export function explainMlPrediction(sigLike, models) {
  const model = selectServingModel(models, sigLike);
  if (!model) return [];
  const features = getFeatureVector(sigLike, sigLike.type);
  const featureNames = model.featureNames;
  const fullVector = vectorize(features, featureNames);
  const fullProb = calibrateProbability(sigmoid(predictScore(model, fullVector)), model.calibrator);
  return featureNames.map((name, idx) => {
    const partial = [...fullVector];
    partial[idx] = 0;
    const prob = calibrateProbability(sigmoid(predictScore(model, partial)), model.calibrator);
    return {
      feature: name,
      impact: +((fullProb - prob) * 100).toFixed(1),
      value: fullVector[idx],
    };
  }).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 5);
}

export function buildModelSnapshot(models) {
  if (!models) return null;
  return {
    version: models.version,
    modelName: models.modelName,
    computedAt: models.computedAt,
    stock: models.families?.stock ? {
      trainedOn: models.families.stock.global?.trainedOn || 0,
      accuracy: models.families.stock.global?.accuracy || 0,
      edge: models.families.stock.global?.edge || 0,
      walkForward: models.families.stock.global?.walkForward?.accuracy || 0,
      topFeatures: models.families.stock.topFeatures || [],
      servingLabel: models.families.stock.servingLabel || 'stock_global',
    } : null,
    option: models.families?.option ? {
      trainedOn: models.families.option.global?.trainedOn || 0,
      accuracy: models.families.option.global?.accuracy || 0,
      edge: models.families.option.global?.edge || 0,
      walkForward: models.families.option.global?.walkForward?.accuracy || 0,
      topFeatures: models.families.option.topFeatures || [],
      servingLabel: models.families.option.servingLabel || 'option_global',
    } : null,
  };
}

export function runMlBacktest(signals, models) {
  if (!signals?.length || !models) return null;
  const stockModel = selectServingModel(models, { type: 'STOCK', date: signals[0]?.date, time: signals[0]?.time });
  const optionModel = selectServingModel(models, { type: 'OPTION', date: signals[0]?.date, time: signals[0]?.time, stock: 'NIFTY', optType: 'CE' });
  const out = {};
  if (stockModel) out.stock = summarizeBacktest(buildBacktestRows(signals, stockModel, 'STOCK'), 'STOCK', models.thresholds?.stock);
  if (optionModel) out.option = summarizeBacktest(buildBacktestRows(signals, optionModel, 'OPTION'), 'OPTION', models.thresholds?.option);
  return Object.keys(out).length ? out : null;
}

export function getPortfolioAiGuidance(openSignals = [], candidateSignals = [], models) {
  const typeCounts = {};
  const underlyingCounts = {};
  openSignals.forEach((s) => {
    typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
    const u = s.stock || s.und || s.name;
    if (u) underlyingCounts[u] = (underlyingCounts[u] || 0) + 1;
  });

  const suggestions = candidateSignals.slice(0, 10).map((sig) => {
    const explain = explainMlPrediction(sig, models);
    const penalty = portfolioPenalty(sig) + ((underlyingCounts[sig.stock || sig.und] || 0) >= 2 ? 5 : 0);
    const sizePct = clamp(2.2 - penalty * 0.12, 0.4, 2.2);
    const dailyStopPct = sig.type === 'OPTION' ? 2.8 : 1.8;
    return {
      id: sig.id || `${sig.stock}_${sig.time}`,
      symbol: sig.stock || sig.und || sig.name,
      suggestedRiskPct: +sizePct.toFixed(2),
      dailyStopPct,
      clusterPenalty: penalty,
      topReasons: explain,
    };
  });

  return {
    maxConcurrent: openSignals.length >= 8 ? 8 : 6,
    typeExposure: typeCounts,
    underlyingExposure: underlyingCounts,
    suggestions,
  };
}

export function applyMlRanking(confidence, models, sigLike) {
  const model = models?.featureNames ? models : selectServingModel(models, sigLike);
  if (!model || !sigLike) return { confidence, mlProbability: null, mlAdj: 0, aiBlock: false, explanation: [] };
  const familyThresholds = sigLike.type === 'STOCK' ? models?.thresholds?.stock : models?.thresholds?.option;
  const features = getFeatureVector(sigLike, sigLike.type);
  const vector = vectorize(features, model.featureNames);
  const rawProb = sigmoid(predictScore(model, vector));
  let probability = calibrateProbability(rawProb, model.calibrator);
  probability = regimeAdjustment(sigLike, probability);

  const baseProb = clamp(toNum(confidence, 50) / 100, 0.01, 0.99);
  const sampleFactor = clamp(model.trainedOn / 180, 0.2, 1);
  const edgeFactor = clamp((model.edge || 0) / 0.06, 0, 1);
  const walkForwardFactor = clamp((model.walkForward?.accuracy || model.accuracy || 0.5), 0.35, 0.8);
  const trust = 0.18 + (0.28 * sampleFactor) + (0.18 * edgeFactor) + (0.18 * walkForwardFactor);
  let adj = clamp((probability - baseProb) * 100 * trust, -18, 18);
  adj -= portfolioPenalty(sigLike);
  adj -= suppressionPenalty(sigLike, probability, familyThresholds);

  const nextConfidence = clamp(Math.round(confidence + adj), 1, 99);
  const explanation = explainMlPrediction(sigLike, { ...models, featureNames: model.featureNames });
  const aiBlock = probability < ((familyThresholds?.probability || 0.62) - 0.1);
  return {
    confidence: nextConfidence,
    mlProbability: Math.round(probability * 100),
    mlAdj: +adj.toFixed(1),
    aiBlock,
    explanation,
    servingLabel: model.label,
  };
}

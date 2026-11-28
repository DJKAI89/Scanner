import test from 'node:test';
import assert from 'node:assert/strict';
import * as ml from '../src/services/mlRanking.js';

// Small synthetic signal log: win chance rises with confidence and falls with strike distance.
function makeSignals(nOpt, nStk) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < nOpt; i++) {
    const spot = 1300 + rnd() * 100, side = rnd() < 0.5 ? 'CE' : 'PE';
    const strike = Math.round(spot / 10) * 10 + (rnd() * 8 - 2) * 10 * (side === 'CE' ? 1 : -1);
    const conf = 40 + rnd() * 45, otm = Math.abs(strike - spot) / spot;
    const win = rnd() < 0.35 + (conf - 40) / 150 - otm * 3;
    const d = day(Math.floor(i / 3));
    out.push({ type: 'OPTION', optType: side, stock: rnd() < 0.4 ? 'NIFTY' : 'RELIANCE', strike, spot, maxPain: spot, entry: 5 + rnd() * 40, sl: 3, target: 9, rr: 2,
      iv: 15 + rnd() * 20, delta: 0.1 + rnd() * 0.5, theta: -1, oi: 2000 + rnd() * 50000, oiChg: rnd() * 40 - 20, dte: 1 + Math.floor(rnd() * 10),
      confidence: conf, action: 'BUY', status: win ? 'TARGET_HIT' : 'SL_HIT', pnlPct: win ? 40 : -30, date: d, time: '10:' + String(10 + (i % 40)),
      exitDate: d, exitTime: '14:00', trendAligned: rnd() < 0.6 });
  }
  for (let i = 0; i < nStk; i++) {
    const conf = 40 + rnd() * 45, px = 500 + rnd() * 2000, win = rnd() < 0.35 + (conf - 40) / 140;
    const d = day(Math.floor(i / 2));
    out.push({ type: 'STOCK', stock: 'S' + (i % 30), entry: px, sl: px * 0.97, target: px * 1.06, rr: 2, confidence: conf, signal: 'BUY', numInds: 3,
      atr: px * 0.02, ema50: px * 0.98, ema200: px * 0.9, hi52: px * 1.2, lo52: px * 0.7, risk: 40, status: win ? 'TARGET_HIT' : 'SL_HIT',
      pnlPct: win ? 5 : -3, date: d, time: '11:' + String(10 + (i % 40)), exitDate: d, exitTime: '15:00' });
  }
  return out;
}

test('limitLearnedAdj caps the combined learned adjustment at +/-25', () => {
  assert.equal(ml.limitLearnedAdj(40), 25);
  assert.equal(ml.limitLearnedAdj(-40), -25);
  assert.equal(ml.limitLearnedAdj(10), 10);
});

test('cost model can be overridden and read back', () => {
  const before = ml.getCostModel();
  const after = ml.setCostModel({ stockPct: 0.4, orderFeeRs: 10 });
  assert.equal(after.STOCK, 0.4);
  assert.equal(after.orderFeeRs, 10);
  ml.setCostModel({ stockPct: before.STOCK, orderFeeRs: before.orderFeeRs });   // restore for other tests
});

test('decidePromotion keeps the live model when nothing new or when the candidate regressed', () => {
  const fam = (trainedOn, wins, edge) => ({ servingLabel: 'x', global: { trainedOn, wins, oof: { edge } }, segments: {} });
  assert.equal(ml.decidePromotion(fam(100, 50, 0.02), null).promote, true);
  assert.equal(ml.decidePromotion(fam(100, 50, 0.02), fam(100, 50, 0.02)).promote, false);          // no new signals
  assert.equal(ml.decidePromotion(fam(30, 10, 0.02), fam(100, 50, 0.02)).promote, false);           // lost data
  assert.equal(ml.decidePromotion(fam(120, 60, -0.03), fam(100, 50, 0.04)).promote, false);         // regressed
  assert.equal(ml.decidePromotion(fam(120, 60, 0.03), fam(100, 50, 0.02)).promote, true);           // fine
  assert.equal(ml.decidePromotion(fam(100, 50, -0.2), fam(100, 50, 0.04), { force: true }).promote, true);
});

test('training uses unseen-signal calibration and never stores the prediction list', { timeout: 240000 }, () => {
  const models = ml.trainSignalMlModels(makeSignals(500, 300));
  for (const fam of ['stock', 'option']) {
    const g = models.families[fam].global;
    assert.ok(g.trainedOn > 100, `${fam} trained`);
    assert.ok(g.walkForward && !('preds' in g.walkForward), 'prediction list is stripped');
    assert.ok(g.oof && typeof g.oof.edge === 'number', 'honest out-of-fold edge recorded');
    assert.ok(['walk-forward', 'in-sample'].includes(g.calibrationSource));
  }
});

test('a live pick (type CE/PE) resolves to the same segment as a logged option signal, and far strikes score lower', { timeout: 240000 }, () => {
  const models = ml.trainSignalMlModels(makeSignals(500, 300));
  const base = { und: 'NIFTY', spot: 1350, entry: 12, iv: 25, _dte: 5, oi: 30000, oiChg: 5, confidence: 60, action: 'BUY', trendAligned: true, maxPain: 1350, sl: 8, tgt: 20, rr: 2, regime: 'trending', volRegimeShift: 0 };
  ml.setLivePickSegments(true);
  const near = ml.applyMlRanking(60, models, { ...base, type: 'CE', strike: 1360 });
  const far = ml.applyMlRanking(60, models, { ...base, type: 'CE', strike: 1500 });
  const logged = ml.applyMlRanking(60, models, { ...base, type: 'OPTION', optType: 'CE', stock: 'NIFTY', strike: 1360 });
  assert.equal(near.mlSegment, logged.mlSegment, 'with the switch on, a live pick and a logged signal use the same model segment');
  ml.setLivePickSegments(false);
  const legacy = ml.applyMlRanking(60, models, { ...base, type: 'CE', strike: 1360 });
  assert.ok(legacy.mlSegment, 'switch off keeps the previous (blended) behaviour');
  assert.ok(near.mlProbability >= far.mlProbability, `near ${near.mlProbability} should not score below far ${far.mlProbability}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

// The scoring code uses extension-less imports, so bundle it the same way the server scan does.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-')), 'scoring.mjs');
buildSync({ entryPoints: ['src/services/optionScan.js'], bundle: true, platform: 'node', format: 'esm', outfile: out, define: { 'import.meta.env': '{}' }, logLevel: 'silent' });
const mod = await import(pathToFileURL(out).href);

const spot = 1350;
const strikes = []; for (let k = 1300; k <= 1500; k += 10) strikes.push(k);
const chain = strikes.map((k) => ({
  strike_price: k,
  call_options: { instrument_key: 'C' + k, market_data: { ltp: Math.max(0.6, spot - k + 20 + (k > spot ? 5 : 0)), oi: 50000, prev_oi: 40000 + k, bid_price: 5, ask_price: 5.1, close_price: 6 }, option_greeks: { delta: Math.max(0.03, 0.9 - (k - 1300) / 250), iv: 25, theta: -0.8 } },
  put_options: { instrument_key: 'P' + k, market_data: { ltp: Math.max(0.6, k - spot + 20), oi: 60000, prev_oi: 50000, bid_price: 5, ask_price: 5.1, close_price: 6 }, option_greeks: { delta: -0.4, iv: 25, theta: -0.8 } },
}));
const stkCtx = { compositeScore: 2.2, neutral: false, pcrTrend: 0.05, ivTrend: 0.2, isConsolidating: true, spot, dayChange: -1 };
const expiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);   // 5 days out, so the move needed is judged against a realistic expected move
const grid = () => mod.scoreChainForGrid({ chain, atm: 1350, spot, name: 'RELIANCE', expiry, lot: 500, maxPain: 1350, pcr: 0.9, stkCtx,
  env: { niftyBull: true, vixVal: 14 }, deps: { cfg: { delta: 0.4, iv: 15, oi: 15 }, mlModels: null, adaptWeights: null, confCalibration: null, vixHistorySeries: [] } });

test('every strike gets a confidence, even when the Options page would filter it out', () => {
  const g = grid();
  assert.equal(g.size, chain.length * 2);
  for (const p of g.values()) assert.ok(p.confidence >= 1 && p.confidence <= 99);
});

test('far out-of-the-money strikes are capped well below near ones', () => {
  const g = grid();
  const near = g.get('1350|CE').confidence, far = g.get('1500|CE').confidence;
  assert.ok(far <= 50, `far strike should be capped (got ${far})`);
  assert.ok(near > far, `near ${near} should beat far ${far}`);
  assert.ok(g.get('1500|CE').distCap != null, 'cap is recorded on the pick');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Runs the real monitor script against a fake GitHub / Upstox serving hand-made 5-minute candles.
test('monitor labels outcomes from intraday candles (stop wins a tie, exits at the level, not the wick)', { timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, ['--import', './tests/helpers/monitor-mock.mjs', 'scripts/monitorSignals.mjs'], {
    env: { ...process.env, GH_TOKEN: 'x', GH_USER: 'u', GH_REPO: 'r', UPSTOX_ACCESS_TOKEN: 't', GH_USER_ID: 'u1' }, encoding: 'utf8',
  });
  const line = (id) => (r.stdout.split('\n').find((l) => l.startsWith(id)) || '').trim().split(/\s+/);
  assert.equal(line('STOP_FIRST')[1], 'SL_HIT');
  assert.equal(line('STOP_FIRST')[3], '98', 'exit at the stop, not the 97.5 wick');
  assert.equal(line('TARGET_HIT_CASE')[1], 'TARGET_HIT');
  assert.equal(line('BOTH_SAME_CANDLE')[1], 'SL_HIT', 'adverse side first inside one candle');
  assert.equal(line('UNTOUCHED')[1], 'OPEN');
});

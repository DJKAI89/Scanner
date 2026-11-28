import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Runs the real nightly trainer against a fake GitHub holding a synthetic signal log:
// first run promotes the new models, an immediate second run (no new signals) keeps them.
test('nightly trainer promotes once, then keeps the live model when nothing is new', { timeout: 280000 }, () => {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-trainer-')), 'store.json');
  const run = () => spawnSync(process.execPath, ['--import', './tests/helpers/fake-github.mjs', 'scripts/train-ai-model.mjs'], {
    env: { ...process.env, MOCK_STORE: store, GH_TOKEN: 'x', GH_USER: 'u', GH_REPO: 'r', SCANNER_USER_ID: 'u1', AI_LOOKBACK_DAYS: 'all' }, encoding: 'utf8',
  });
  const first = run();
  assert.match(first.stdout, /Loaded \d+ real \+ \d+ resolved shadow signals/, 'shadow signals are loaded');
  assert.match(first.stdout, /stock: ✅ promote/);
  assert.match(first.stdout, /option: ✅ promote/);
  const files = Object.keys(JSON.parse(fs.readFileSync(store, 'utf8'))).filter((k) => k.startsWith('ai-models/') && /(stock|option)\.json$/.test(k));
  assert.equal(files.length, 2, 'both model files written');
  const second = run();
  assert.match(second.stdout, /stock: ⏸️ keep live model/);
  assert.match(second.stdout, /option: ⏸️ keep live model/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { squarify } from '../src/utils/treemap.js';

test('treemap tiles fill the rectangle and keep their area proportional to weight', () => {
  const items = [50, 30, 10, 5, 3, 2].map((weight, i) => ({ weight, id: i }));
  const tiles = squarify(items, 800, 400);
  assert.equal(tiles.length, items.length);
  const area = tiles.reduce((s, t) => s + t.w * t.h, 0);
  assert.ok(Math.abs(area - 800 * 400) < 1, `areas add up to the rectangle (got ${area})`);
  for (const t of tiles) {
    assert.ok(t.x >= -1e-6 && t.y >= -1e-6 && t.x + t.w <= 800 + 1e-6 && t.y + t.h <= 400 + 1e-6, 'tile inside the rectangle');
    assert.ok(Math.abs((t.w * t.h) / (800 * 400) - t.item.weight / 100) < 1e-6, 'area follows weight');
  }
});

test('treemap handles empty input and a single tile', () => {
  assert.deepEqual(squarify([], 100, 100), []);
  const one = squarify([{ weight: 5 }], 100, 50);
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0].w * one[0].h - 5000) < 1e-6);
});

// Squarified treemap layout (Bruls et al.). items: [{ weight, ... }] sorted by weight, descending.
// Returns [{ item, x, y, w, h }] filling a w x h rectangle, each tile's area proportional to its weight.
function layoutRow(row, rect, out) {
  const sum = row.reduce((a, n) => a + n.area, 0);
  if (rect.w >= rect.h) {
    const cw = sum / rect.h; let y = rect.y;
    for (const n of row) { const ch = n.area / cw; out.push({ item: n.item, x: rect.x, y, w: cw, h: ch }); y += ch; }
    return { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
  }
  const rh = sum / rect.w; let x = rect.x;
  for (const n of row) { const cw = n.area / rh; out.push({ item: n.item, x, y: rect.y, w: cw, h: rh }); x += cw; }
  return { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh };
}
export function squarify(items, w, h) {
  const total = items.reduce((a, i) => a + i.weight, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const nodes = items.map((i) => ({ item: i, area: i.weight * scale }));
  const worst = (row, side) => {
    const sum = row.reduce((a, n) => a + n.area, 0);
    const mx = Math.max(...row.map((n) => n.area)), mn = Math.min(...row.map((n) => n.area));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  };
  const out = []; let rect = { x: 0, y: 0, w, h }; let row = []; let i = 0;
  while (i < nodes.length) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, nodes[i]], side) <= worst(row, side)) { row.push(nodes[i]); i++; }
    else { rect = layoutRow(row, rect, out); row = []; }
  }
  if (row.length) layoutRow(row, rect, out);
  return out;
}


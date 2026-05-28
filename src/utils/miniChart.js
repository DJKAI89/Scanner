import { calcEMA } from '../services/technical';

// ── drawMiniCandleChart — exact port from index.html ─────────
// candles: newest-first array [ [ts,o,h,l,c,v], ... ]
// closes:  oldest-first array for EMA overlay
// opts: { entry, target, sl, ema50, ema200, width, height }
export function drawMiniCandleChart(candles, closes, opts = {}) {
  if (!candles || candles.length < 3) return null;

  const W = opts.width  || 320;
  const H = opts.height || 90;
  const PAD = { top: 6, right: 4, bottom: 14, left: 2 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  const raw = candles.slice(0, 20).reverse();
  const N   = raw.length;
  if (N < 2) return null;

  const highs = raw.map(c => +c[2]);
  const lows  = raw.map(c => +c[3]);
  let priceHigh = Math.max(...highs);
  let priceLow  = Math.min(...lows);
  if (opts.target && opts.target > 0) priceHigh = Math.max(priceHigh, opts.target);
  if (opts.sl     && opts.sl     > 0) priceLow  = Math.min(priceLow,  opts.sl);
  if (opts.entry  && opts.entry  > 0) { priceHigh = Math.max(priceHigh, opts.entry); priceLow = Math.min(priceLow, opts.entry); }
  const range = priceHigh - priceLow;
  if (range <= 0) return null;

  const py = p => PAD.top + chartH * (1 - (p - priceLow) / range);
  const slotW   = chartW / N;
  const candleW = Math.max(2, slotW * 0.6);
  const cx = i => PAD.left + (i + 0.5) * slotW;

  // Candles
  let candleSVG = '';
  for (let i = 0; i < N; i++) {
    const [, o, h, l, c] = raw[i].map(Number);
    const isUp  = c >= o;
    const color = isUp ? '#16a34a' : '#dc2626';
    const bodyTop = py(Math.max(o, c));
    const bodyBot = py(Math.min(o, c));
    const bodyH   = Math.max(1, bodyBot - bodyTop);
    const x       = cx(i);
    candleSVG += `<line x1="${x}" y1="${py(h)}" x2="${x}" y2="${py(l)}" stroke="${color}" stroke-width="1" opacity="0.8"/>`;
    candleSVG += `<rect x="${(x - candleW/2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" rx="0.5"/>`;
  }

  // EMA lines
  let ema50Line = '', ema200Line = '';
  if (closes && closes.length >= 50) {
    const ema50Vals = [], ema200Vals = [];
    for (let i = 0; i < N; i++) {
      const slice = closes.slice(0, closes.length - (N - 1 - i));
      ema50Vals.push( slice.length >= 50  ? calcEMA(slice, 50)  : null);
      ema200Vals.push(slice.length >= 200 ? calcEMA(slice, 200) : null);
    }
    const linePoints = (vals, color, dasharray = '') => {
      const pts = vals.map((v, i) => v != null ? `${cx(i).toFixed(1)},${py(v).toFixed(1)}` : null).filter(Boolean);
      if (pts.length < 2) return '';
      return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.2" opacity="0.75" ${dasharray ? `stroke-dasharray="${dasharray}"` : ''} stroke-linejoin="round"/>`;
    };
    ema50Line  = linePoints(ema50Vals,  '#2563eb');
    ema200Line = linePoints(ema200Vals, '#9333ea', '3,2');
  }

  // Horizontal price lines
  const hLine = (price, color, label, dashed = false) => {
    if (!price || price <= 0) return '';
    const y = py(price);
    if (y < PAD.top || y > H - PAD.bottom + 2) return '';
    return `
      <line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W - PAD.right}" y2="${y.toFixed(1)}"
        stroke="${color}" stroke-width="${dashed ? '1' : '1.5'}" opacity="0.9"
        ${dashed ? 'stroke-dasharray="4,3"' : ''} />
      <text x="${W - PAD.right - 2}" y="${(y - 2).toFixed(1)}" text-anchor="end"
        font-size="7" font-weight="700" fill="${color}" font-family="system-ui,sans-serif">${label}</text>`;
  };

  // Date labels
  const dateLabel = (c, xPos, anchor) => {
    if (!c || !c[0]) return '';
    const d = new Date(c[0]);
    const label = isNaN(d) ? '' : `${d.getDate()}/${d.getMonth() + 1}`;
    return `<text x="${xPos}" y="${H - 1}" text-anchor="${anchor}" font-size="7" fill="#94a3b8" font-family="system-ui,sans-serif">${label}</text>`;
  };

  const ema50Val  = closes && closes.length >= 50  ? calcEMA(closes, 50)  : null;
  const ema200Val = closes && closes.length >= 200 ? calcEMA(closes, 200) : null;

  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg"
    style="display:block;border-radius:6px;background:#f8fafc;border:1px solid #e2e8f0;margin:8px 0 4px">
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${W - PAD.right}" y2="${PAD.top}" stroke="#e2e8f0" stroke-width="0.5"/>
    <line x1="${PAD.left}" y1="${(PAD.top + chartH/2).toFixed(1)}" x2="${W - PAD.right}" y2="${(PAD.top + chartH/2).toFixed(1)}" stroke="#e2e8f0" stroke-width="0.5" stroke-dasharray="2,2"/>
    <line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${W - PAD.right}" y2="${PAD.top + chartH}" stroke="#e2e8f0" stroke-width="0.5"/>
    ${ema200Line}
    ${ema50Line}
    ${candleSVG}
    ${hLine(opts.target, '#16a34a', 'Tgt')}
    ${hLine(opts.entry,  '#1d4ed8', 'Entry', true)}
    ${hLine(opts.sl,     '#dc2626', 'SL')}
    ${dateLabel(raw[0],   PAD.left + 2, 'start')}
    ${dateLabel(raw[N-1], W - PAD.right - 2, 'end')}
    <line x1="${PAD.left + 2}" y1="${H - 8}" x2="${PAD.left + 14}" y2="${H - 8}" stroke="#2563eb" stroke-width="1.2"/>
    <text x="${PAD.left + 16}" y="${H - 5}" font-size="6.5" fill="#64748b" font-family="system-ui,sans-serif">EMA50</text>
    <line x1="${PAD.left + 46}" y1="${H - 8}" x2="${PAD.left + 58}" y2="${H - 8}" stroke="#9333ea" stroke-width="1.2" stroke-dasharray="3,2"/>
    <text x="${PAD.left + 60}" y="${H - 5}" font-size="6.5" fill="#64748b" font-family="system-ui,sans-serif">EMA200</text>
  </svg>`;

  return { svg, ema50Val, ema200Val };
}

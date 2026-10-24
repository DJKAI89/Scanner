// Collects picks that the gate REJECTED during a scan, so they can be logged as
// "shadow" signals and tracked to an outcome. Without this the models only ever
// see trades that already passed the filters (selection bias) and you can't tell
// whether a threshold helps or hurts.
const _buf = [];
const MAX_BUF = 200;

export function pushShadow(pick, reason, type) {
  if (!pick) return;
  if (type === 'OPTION' && pick.action === 'WATCH') return;
  if (type === 'STOCK' && (pick.rec === 'WATCH' || pick.rec === 'AVOID')) return;
  if (_buf.length >= MAX_BUF) _buf.shift();
  _buf.push({ p: pick, reason: reason || 'unknown', type });
}

export function drainShadow() {
  return _buf.splice(0, _buf.length);
}

import React, { useEffect, useRef, useState } from 'react';

// ── Scan progress card ──────────────────────────────────────────────────────
// Replaces the plain spinner / fixed-60% pulsing bar on the Stocks and F&O Options pages.
// It needs no changes to the scans: it reads the progress message they already send
// ("Step 3/4: KOTAKBANK options (14/50)...") and works out
//   • which step we are on (and the step chips),
//   • how far through that step (the "(14/50)" counter),
//   • an overall percentage, weighted by how long each step usually takes.
// The percentage is an ESTIMATE from step position + counter, never a measured total, and
// only ever moves forward. Elapsed time and a rough time-left are shown once there is
// enough progress to extrapolate from.

const STEP_RE = /Step\s+(\d+)\s*(?:\/\s*(\d+))?\s*:?\s*/i;

// Progress inside a step: "(14/50)", "REST quotes 50/210", "Candles 4–6/20" (uses the upper bound)
function parseSub(message) {
  const body = message.replace(STEP_RE, '');
  const range = body.match(/(\d+)\s*[–-]\s*(\d+)\s*\/\s*(\d+)/);
  if (range) return { cur: +range[2], total: +range[3] };
  const m = body.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { cur: +m[1], total: +m[2] } : null;
}

// Colour tints are computed here rather than with CSS colour-mixing so older mobile browsers render them.
const rgb = (hex) => { const h = hex.replace('#', ''); const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
const mix = (hex, base, pct) => { const a = rgb(hex), b = rgb(base); return '#' + a.map((v, i) => Math.round(v * pct + b[i] * (1 - pct)).toString(16).padStart(2, '0')).join(''); };
const alpha = (hex, a) => { const [r, g, b] = rgb(hex); return `rgba(${r},${g},${b},${a})`; };

const pick = (v, n) => (Array.isArray(v) ? v : v && v[n]) || null;

function fmtClock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function ScanProgress({ title = 'Scanning', message = '', accent = '#2563eb', accentDark, steps, weights, phases, subRules, hint }) {
  const [sec, setSec] = useState(0);
  const maxPct = useRef(0);
  const dark = accentDark || accent;

  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Which step are we on?
  let total = 0, idx = 0;
  const sm = message.match(STEP_RE);
  if (sm) {
    idx = Math.max(0, +sm[1] - 1);
    total = sm[2] ? +sm[2] : (Array.isArray(steps) ? steps.length : 0);
  } else if (phases) {
    const i = phases.findIndex((p) => p.re.test(message));
    if (i >= 0) { idx = i; total = phases.length; }
  }
  const labels = total ? (phases ? phases.map((p) => p.label) : pick(steps, total)) : null;
  const w = total ? (pick(weights, total) || Array(total).fill(1 / total)) : null;

  // A step can contain differently-meaning counters (e.g. "Ranking … (2/5 batches)" and then
  // "RELIANCE options (14/50)" are both Step 3). subRules gives each its own slice of the step
  // so the bar doesn't stall then jump: first matching { re, from, to } maps the counter into
  // [from, to] of the step; { re, ignore: true } drops a counter that isn't progress through the step.
  const rule = subRules ? subRules.find((r) => r.re.test(message)) : null;
  const sub = rule?.ignore ? null : parseSub(message);
  const raw = sub && sub.total > 0 ? Math.min(1, sub.cur / sub.total) : 0;
  const subFrac = rule && !rule.ignore ? (rule.from ?? 0) + ((rule.to ?? 1) - (rule.from ?? 0)) * raw : raw;

  // No step info and no counter (e.g. before the first message, or a one-shot load): don't
  // invent a percentage — show a sliding indeterminate bar instead.
  const indeterminate = !total && !sub;
  let pct = 0;
  if (total && w) {
    const before = w.slice(0, idx).reduce((a, b) => a + b, 0);
    pct = Math.min(99, (before + (w[idx] ?? 1 / total) * subFrac) * 100);
  } else if (sub) {
    pct = Math.min(99, subFrac * 100);
  }
  if (!indeterminate) maxPct.current = Math.max(maxPct.current, pct); // never go backwards
  const shown = Math.round(maxPct.current);

  const left = shown >= 12 && sec >= 6 ? Math.max(1, Math.round((sec * (100 - shown)) / shown)) : null;
  const activity = message.replace(STEP_RE, '').trim() || 'Starting…';
  const chips = hint ? hint.split('·').map((t) => t.trim()).filter(Boolean) : [];

  return (
    <div className="sp-card" role="status" aria-live="polite" style={{
      '--sp': accent, '--spd': dark,
      '--sp-border': mix(accent, '#e2e8f0', 0.28), '--sp-ring': mix(accent, '#ffffff', 0.18),
      '--sp-l': mix(accent, '#ffffff', 0.62), '--sp-l2': mix(accent, '#ffffff', 0.35),
      '--sp-a12': alpha(accent, 0.12), '--sp-a14': alpha(accent, 0.14), '--sp-a18': alpha(accent, 0.18), '--sp-a24': alpha(accent, 0.24),
    }}>
      <style>{CSS}</style>
      <div className="sp-top" />
      <div className="sp-head">
        <div className="sp-ring"><div className="sp-dot" /></div>
        <div className="sp-titles">
          <div className="sp-title">{title}</div>
          <div className="sp-act" title={activity}>{activity}</div>
        </div>
        {indeterminate ? <div className="sp-pct sp-wait">···</div> : <div className="sp-pct">{shown}<span>%</span></div>}
      </div>

      <div className={'sp-bar' + (indeterminate ? ' ind' : '')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : shown} aria-busy={indeterminate || undefined}>
        <div className="sp-fill" style={indeterminate ? undefined : { width: shown + '%' }} />
      </div>

      <div className="sp-meta">
        <span>⏱ {fmtClock(sec)}{left != null ? ` · ~${left >= 90 ? Math.round(left / 60) + ' min' : left + 's'} left` : ''}</span>
        {sub && sub.total > 1 && <span className="sp-count"><b>{sub.cur}</b> / {sub.total}</span>}
      </div>

      {total > 1 && (
        <div className="sp-steps">
          {Array.from({ length: total }).map((_, i) => {
            const state = i < idx ? 'done' : i === idx ? 'on' : 'todo';
            return (
              <React.Fragment key={i}>
                {i > 0 && <div className={'sp-link' + (i <= idx ? ' lit' : '')} />}
                <div className={'sp-step ' + state}>
                  <div className="sp-bub">{state === 'done' ? '✓' : i + 1}</div>
                  <div className="sp-lbl">{labels?.[i] || `Step ${i + 1}`}</div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {chips.length > 0 && (
        <div className="sp-chips">
          {chips.map((c) => <span key={c}>{c}</span>)}
        </div>
      )}
    </div>
  );
}

const CSS = `
.sp-card{position:relative;overflow:hidden;background:#fff;border:1px solid var(--sp-border);border-radius:14px;padding:14px 14px 12px;margin:0 0 12px;box-shadow:0 1px 3px rgba(15,23,42,.06),0 6px 18px rgba(15,23,42,.05)}
.sp-top{position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--sp),var(--sp-l2))}
.sp-head{display:flex;align-items:center;gap:11px}
.sp-ring{position:relative;flex:0 0 auto;width:34px;height:34px;border-radius:50%;border:3px solid var(--sp-ring);border-top-color:var(--sp);animation:sp-spin .9s linear infinite}
.sp-dot{position:absolute;inset:7px;border-radius:50%;background:var(--sp);opacity:.9;animation:sp-pulse 1.2s ease-in-out infinite}
.sp-titles{flex:1;min-width:0}
.sp-title{font-size:13px;font-weight:800;color:#0f172a;letter-spacing:-.1px}
.sp-act{font-size:11px;font-weight:600;color:#64748b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-pct{font-size:26px;font-weight:900;color:var(--spd);letter-spacing:-1px;line-height:1;font-variant-numeric:tabular-nums}
.sp-pct span{font-size:13px;font-weight:800;margin-left:1px;opacity:.7}
.sp-bar{height:10px;border-radius:6px;background:#eef2f7;margin-top:12px;overflow:hidden}
.sp-fill{position:relative;height:100%;border-radius:6px;transition:width .7s cubic-bezier(.22,.8,.3,1);min-width:6px;
  background:linear-gradient(90deg,var(--sp),var(--sp-l))}
.sp-fill::after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.55) 50%,transparent 70%);background-size:200% 100%;animation:sp-shine 1.4s linear infinite}
.sp-meta{display:flex;justify-content:space-between;align-items:center;margin-top:7px;font-size:10px;font-weight:700;color:#94a3b8;font-variant-numeric:tabular-nums}
.sp-count{background:var(--sp-a12);color:var(--spd);border-radius:20px;padding:2px 9px;font-weight:700}
.sp-count b{font-weight:900}
.sp-steps{display:flex;align-items:flex-start;margin-top:12px}
.sp-step{display:flex;flex-direction:column;align-items:center;gap:4px;flex:0 0 auto;min-width:46px}
.sp-bub{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;border:2px solid #dbe3ee;color:#94a3b8;background:#fff;box-sizing:border-box}
.sp-step.done .sp-bub{background:var(--sp);border-color:var(--sp);color:#fff}
.sp-step.on .sp-bub{border-color:var(--sp);color:var(--spd);box-shadow:0 0 0 4px var(--sp-a18);animation:sp-glow 1.4s ease-in-out infinite}
.sp-lbl{font-size:8.5px;font-weight:700;color:#94a3b8;text-align:center;line-height:1.15;max-width:56px}
.sp-step.done .sp-lbl{color:#64748b}
.sp-step.on .sp-lbl{color:var(--spd);font-weight:800}
.sp-link{flex:1;height:2px;margin-top:10px;background:#e5eaf2;border-radius:2px;min-width:8px}
.sp-link.lit{background:var(--sp)}
.sp-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:12px}
.sp-chips span{font-size:9px;font-weight:700;color:#64748b;background:#f4f6fa;border:1px solid #e9eef5;border-radius:20px;padding:2px 8px}
.sp-wait{font-size:20px;letter-spacing:2px;opacity:.55}
.sp-bar.ind .sp-fill{width:38%;animation:sp-slide 1.25s ease-in-out infinite}
@keyframes sp-slide{0%{transform:translateX(-105%)}100%{transform:translateX(290%)}}
@keyframes sp-spin{to{transform:rotate(360deg)}}
@keyframes sp-pulse{0%,100%{transform:scale(.55);opacity:.55}50%{transform:scale(1);opacity:1}}
@keyframes sp-shine{from{background-position:200% 0}to{background-position:-200% 0}}
@keyframes sp-glow{0%,100%{box-shadow:0 0 0 3px var(--sp-a14)}50%{box-shadow:0 0 0 6px var(--sp-a24)}}
@media (prefers-reduced-motion:reduce){.sp-ring,.sp-dot,.sp-fill::after,.sp-step.on .sp-bub,.sp-bar.ind .sp-fill{animation:none}.sp-fill{transition:none}}
`;

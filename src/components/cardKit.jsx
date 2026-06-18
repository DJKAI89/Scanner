import React from 'react';

/**
 * cardKit — shared professional card primitives for Stocks / Breakout / Options pages.
 * Design language: white surface, thin neutral border, a single 3px top accent bar
 * carrying the directional color (bull/bear/neutral) instead of full pastel backgrounds.
 * One unified tag system instead of three different badge styles.
 */

// ── tone → color tokens ─────────────────────────────────────────
const TONES = {
  green:  { bg: '#f0fdf4', fg: '#15803d', bd: '#86efac' },
  red:    { bg: '#fef2f2', fg: '#b91c1c', bd: '#fca5a5' },
  blue:   { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe' },
  amber:  { bg: '#fffbeb', fg: '#92400e', bd: '#fde68a' },
  purple: { bg: '#faf5ff', fg: '#7e22ce', bd: '#ddd6fe' },
  slate:  { bg: '#f8fafc', fg: '#64748b', bd: '#e2e8f0' },
};
const DIR_COLOR = { bull: '#16a34a', bear: '#dc2626', neutral: '#94a3b8', info: '#0ea5e9' };

export function toneColor(tone) { return TONES[tone] || TONES.slate; }

// ── Tag — single unified pill used for every badge across all 3 pages ──
export function Tag({ tone = 'slate', children, title }) {
  const t = toneColor(tone);
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 9.5, fontWeight: 700, lineHeight: 1.3,
      background: t.bg, color: t.fg, border: `1px solid ${t.bd}`,
      borderRadius: 6, padding: '3px 7px', whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

// ── AccentCard — card shell: white surface + 3px top accent bar ──
export function AccentCard({ dir = 'neutral', children, style = {} }) {
  const accent = DIR_COLOR[dir] || DIR_COLOR.neutral;
  return (
    <div style={{
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: 13,
      borderTop: `3px solid ${accent}`, boxShadow: '0 1px 3px rgba(0,0,0,.05)',
      padding: 'clamp(11px,3vw,14px)', position: 'relative', overflow: 'hidden',
      minWidth: 0, ...style,
    }}>{children}</div>
  );
}

// ── RankBadge — small numbered circle ──
export function RankBadge({ n }) {
  return (
    <span style={{
      width: 18, height: 18, borderRadius: '50%', background: '#f1f5f9', color: '#64748b',
      fontSize: 8.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>{n}</span>
  );
}

// ── RecPill — solid colored recommendation pill ──
export function RecPill({ label, dir = 'neutral' }) {
  const accent = DIR_COLOR[dir] || DIR_COLOR.neutral;
  return (
    <span style={{
      background: accent, color: '#fff', fontSize: 9.5, fontWeight: 800,
      letterSpacing: '.3px', borderRadius: 20, padding: '3px 9px', whiteSpace: 'nowrap', flexShrink: 0,
    }}>{label}</span>
  );
}

// ── CardHeader — rank + symbol + sector + optional chart tap + LTP/chg on right ──
export function CardHeader({ rank, symbol, sector, name, ltp, chgPct, onPopup, rec, dir, rightExtra }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
      <div
        style={{ display: 'flex', alignItems: 'flex-start', gap: 7, cursor: onPopup ? 'pointer' : 'default', minWidth: 0, flex: 1 }}
        onClick={onPopup}
      >
        {rank != null && <RankBadge n={rank} />}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', lineHeight: 1.15 }}>{symbol}</span>
            {sector && <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 500 }}>{sector}</span>}
            {onPopup && (
              <span style={{ fontSize: 8.5, color: '#1d4ed8', fontWeight: 700, background: '#eff6ff', padding: '1px 6px', borderRadius: 7, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                📊 Chart
              </span>
            )}
          </div>
          {name && <div style={{ fontSize: 10, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{name}</div>}
        </div>
      </div>

      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        {rec && <div style={{ marginBottom: 4 }}><RecPill label={rec} dir={dir} /></div>}
        {ltp != null && (
          <>
            <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', lineHeight: 1.1 }}>₹{ltp}</div>
            {chgPct != null && (
              <div style={{ fontSize: 11, fontWeight: 700, color: chgPct >= 0 ? '#16a34a' : '#dc2626' }}>
                {chgPct >= 0 ? '▲' : '▼'}{Math.abs(chgPct).toFixed(2)}%
              </div>
            )}
          </>
        )}
        {rightExtra}
      </div>
    </div>
  );
}

// ── VerdictRow — single-line strip: signal strength · R:R · win% · confidence ──
export function VerdictRow({ items }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0, flexWrap: 'wrap',
      background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 9,
      padding: '7px 10px', marginBottom: 9, rowGap: 4,
    }}>
      {items.filter(Boolean).map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: '#cbd5e1', margin: '0 7px', fontSize: 10 }}>·</span>}
          <span style={{ fontSize: 10.5, fontWeight: 700, color: it.color || '#374151', whiteSpace: 'nowrap' }}>
            {it.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ── LevelsStrip — Entry / SL / Target, 3-col, with optional status tag ──
export function LevelsStrip({ entry, sl, target, slSub, tgtSub, entrySub, status }) {
  const cols = [
    { l: 'ENTRY',     v: entry,  c: '#1d4ed8', bg: '#eff6ff', sub: entrySub },
    { l: 'STOP LOSS', v: sl,     c: '#dc2626', bg: '#fef2f2', sub: slSub },
    { l: 'TARGET',    v: target, c: '#16a34a', bg: '#f0fdf4', sub: tgtSub },
  ];
  return (
    <div style={{ marginBottom: 9 }}>
      {status && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          {status}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 1, background: '#e2e8f0', borderRadius: 9, overflow: 'hidden' }}>
        {cols.map(x => (
          <div key={x.l} style={{ background: x.bg, padding: '8px 7px', textAlign: 'center', minWidth: 0 }}>
            <div style={{ fontSize: 7.5, color: '#64748b', letterSpacing: '.3px', marginBottom: 2 }}>{x.l}</div>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: x.c, overflow: 'hidden', textOverflow: 'ellipsis' }}>₹{x.v}</div>
            {x.sub && <div style={{ fontSize: 8.5, color: x.c, marginTop: 1, opacity: .85 }}>{x.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── StatusTag — small WAITING / TRIGGERED style tag ──
export function StatusTag({ triggered }) {
  return triggered
    ? <Tag tone="green">✅ TRIGGERED</Tag>
    : <Tag tone="slate">⏳ WAITING</Tag>;
}

// ── MetricMini — compact stat tile (label / value / sub) ──
export function MetricMini({ label, value, color = '#0f172a', sub }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 7, padding: '6px 8px', minWidth: 0 }}>
      <div style={{ fontSize: 7.5, color: '#94a3b8', letterSpacing: '.3px', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
      {sub && <div style={{ fontSize: 8.5, color: '#64748b', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ── MetricGrid — wraps MetricMini tiles in an even grid ──
export function MetricGrid({ cols = 4, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: 5, marginBottom: 9 }}>
      {children}
    </div>
  );
}

// ── ProgressStat — single row: label, bar, value (replaces duplicated box+bar) ──
export function ProgressStat({ label, pct, color, valueLabel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
      <span style={{ fontSize: 9.5, color: '#64748b', width: 72, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 5, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: color, borderRadius: 3, transition: 'width .5s' }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, color, width: 38, textAlign: 'right', flexShrink: 0 }}>{valueLabel}</span>
    </div>
  );
}

// ── TargetTiers — Conservative / Moderate / Aggressive compact row ──
export function TargetTiers({ cons, mod, agg }) {
  const items = [
    { l: 'Conservative', v: cons, c: '#16a34a', bg: '#f0fdf4', bd: '#bbf7d0' },
    { l: 'Moderate',     v: mod,  c: '#1d4ed8', bg: '#eff6ff', bd: '#bfdbfe' },
    { l: 'Aggressive',   v: agg,  c: '#7c3aed', bg: '#faf5ff', bd: '#ddd6fe' },
  ];
  return (
    <div style={{ display: 'flex', gap: 5, marginBottom: 9 }}>
      {items.map(t => (
        <div key={t.l} style={{ flex: 1, background: t.bg, border: `1px solid ${t.bd}`, borderRadius: 7, padding: '5px 4px', textAlign: 'center', minWidth: 0 }}>
          <div style={{ fontSize: 7, color: '#94a3b8' }}>{t.l}</div>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: t.c }}>₹{t.v}</div>
        </div>
      ))}
    </div>
  );
}

// ── SignalTags — unified row showing only ACTIVE signals + a count summary ──
export function SignalTags({ tags, totalCount, activeCount }) {
  if (!tags?.length) return null;
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {tags.map((t, i) => <Tag key={i} tone={t.tone}>{t.label}</Tag>)}
      </div>
      {totalCount != null && (
        <div style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 4 }}>{activeCount}/{totalCount} indicators confirmed</div>
      )}
    </div>
  );
}

// ── Banner — alert-style callout (reversal, warning, expiry, etc.) ──
export function Banner({ tone = 'slate', icon, title, detail }) {
  const t = toneColor(tone);
  return (
    <div style={{ background: t.bg, border: `1px solid ${t.bd}`, borderRadius: 8, padding: '7px 10px', marginBottom: 9 }}>
      <div style={{ fontWeight: 800, fontSize: 10.5, color: t.fg, marginBottom: detail ? 2 : 0 }}>{icon} {title}</div>
      {detail && <div style={{ fontSize: 9.5, color: t.fg, opacity: .85 }}>{detail}</div>}
    </div>
  );
}

// ── WhyBox — boxed multi-line signal analysis (used by breakout / popups) ──
export function WhyBox({ title = 'SIGNAL ANALYSIS', lines }) {
  if (!lines?.length) return null;
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 9, padding: '9px 10px', marginBottom: 9 }}>
      <div style={{ fontSize: 8.5, fontWeight: 800, color: '#64748b', letterSpacing: '.4px', marginBottom: 5 }}>{title}</div>
      {lines.map((w, i) => (
        <div key={i} style={{ fontSize: 10, color: '#475569', lineHeight: 1.65 }}>→ {w}</div>
      ))}
    </div>
  );
}

// ── FooterNote — small closing summary line ──
export function FooterNote({ children }) {
  return (
    <div style={{ fontSize: 10, color: '#64748b', lineHeight: 1.6, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
      {children}
    </div>
  );
}

import React, { useState } from 'react';
import { fmt } from '../utils/formatters';
import { buildConfidenceRows } from './ConfidenceBreakdown';

// ── Presentational pieces of the Options Analysis page ───────────────────────
// Pure display: everything arrives as props (the chain, the live-merged rows, and
// the chain-level read from optionAnalysisService.summarizeChain). Kept out of the
// pane so the page's data/WebSocket logic and its look can change independently.

const GREEN = '#16a34a', RED = '#dc2626', AMBER = '#d97706', SLATE = '#64748b';

function chgColor(pct) {
  if (pct == null || pct === 0) return SLATE;
  return pct > 0 ? GREEN : RED;
}
function confColor(c) {
  if (c == null) return '#94a3b8';
  return c >= 70 ? GREEN : c >= 50 ? AMBER : RED;
}
function confBg(c) {
  if (c == null) return 'transparent';
  return c >= 70 ? '#f0fdf4' : c >= 50 ? '#fffbeb' : '#fef2f2';
}
function fmtMargin(v) {
  if (!v) return '—';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + 'L';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K';
  return '₹' + fmt(v, 0);
}
// Open interest in contract-quantity, shown the way Indian chains do (lakh / crore)
export function fmtOI(v) {
  if (!v) return '—';
  if (v >= 1e7) return (v / 1e7).toFixed(2) + 'Cr';
  if (v >= 1e5) return (v / 1e5).toFixed(1) + 'L';
  if (v >= 1e3) return Math.round(v / 1e3) + 'K';
  return String(Math.round(v));
}
const signed = (n, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d);

// "Favourable" = the build-up direction helps this option's holder (matches the scan's OI_BONUS)
const BUILD_TAG = {
  LONG_BUILD:  { t: 'Long build',  c: GREEN, bg: '#f0fdf4' },
  SHORT_COVER: { t: 'Short cover', c: GREEN, bg: '#f0fdf4' },
  SHORT_BUILD: { t: 'Short build', c: RED,   bg: '#fef2f2' },
  LONG_UNWIND: { t: 'Long unwind', c: RED,   bg: '#fef2f2' },
};

// ── Expiry pill label: "20 Mar · 3d" ────────────────────────────────────────
export function expiryLabel(e) {
  const d = new Date(e + 'T00:00:00');
  const today = new Date(new Date().toDateString());
  return {
    date: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    dte: Math.max(0, Math.round((d.getTime() - today.getTime()) / 86400000)),
  };
}

// ── Snapshot ────────────────────────────────────────────────────────────────
function Tile({ label, value, sub, color }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #eef2f7', borderRadius: 10, padding: '8px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 8, fontWeight: 800, color: '#94a3b8', letterSpacing: 1, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 900, color: color || '#0f172a', marginTop: 2, letterSpacing: -0.3 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: SLATE, fontWeight: 600, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// Where price sits relative to the walls, max pain and the straddle-implied range
function RangeBar({ s, spot, accent }) {
  const pts = [spot, s.putWall, s.callWall, s.maxPain, s.rangeLow, s.rangeHigh].filter((v) => v > 0);
  if (pts.length < 2) return null;
  const lo0 = Math.min(...pts), hi0 = Math.max(...pts);
  const pad = (hi0 - lo0) * 0.06 || spot * 0.005;
  const lo = lo0 - pad, hi = hi0 + pad;
  const pos = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ position: 'relative', height: 38, margin: '0 6px' }}>
        <div style={{ position: 'absolute', top: 20, left: 0, right: 0, height: 6, borderRadius: 3, background: '#e2e8f0' }} />
        {s.rangeLow > 0 && (
          <div style={{ position: 'absolute', top: 20, height: 6, borderRadius: 3, background: accent + '40',
            left: pos(s.rangeLow) + '%', width: pos(s.rangeHigh) - pos(s.rangeLow) + '%' }} />
        )}
        {s.putWall > 0 && <div style={{ position: 'absolute', top: 14, width: 3, height: 18, borderRadius: 2, background: GREEN, left: pos(s.putWall) + '%', transform: 'translateX(-50%)' }} />}
        {s.callWall > 0 && <div style={{ position: 'absolute', top: 14, width: 3, height: 18, borderRadius: 2, background: RED, left: pos(s.callWall) + '%', transform: 'translateX(-50%)' }} />}
        {s.maxPain > 0 && <div style={{ position: 'absolute', top: 19, width: 8, height: 8, background: '#7c3aed', left: pos(s.maxPain) + '%', transform: 'translateX(-50%) rotate(45deg)' }} />}
        <div style={{ position: 'absolute', top: 0, left: pos(spot) + '%', transform: 'translateX(-50%)', fontSize: 9, fontWeight: 800, color: '#0f172a', whiteSpace: 'nowrap' }}>
          {fmt(spot, 0)}
        </div>
        <div style={{ position: 'absolute', top: 18, width: 10, height: 10, borderRadius: '50%', background: '#0f172a', border: '2px solid #fff', boxShadow: '0 0 0 1px #0f172a', left: pos(spot) + '%', transform: 'translateX(-50%)' }} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 12px', marginTop: 2, fontSize: 9, fontWeight: 700, color: SLATE }}>
        {s.putWall > 0 && <span><span style={{ color: GREEN }}>●</span> Support {fmt(s.putWall, 0)}</span>}
        {s.maxPain > 0 && <span><span style={{ color: '#7c3aed' }}>◆</span> Max Pain {fmt(s.maxPain, 0)}</span>}
        {s.callWall > 0 && <span><span style={{ color: RED }}>●</span> Resistance {fmt(s.callWall, 0)}</span>}
        {s.rangeLow > 0 && <span><span style={{ color: accent }}>▬</span> Straddle range</span>}
      </div>
    </div>
  );
}

// Where new open interest is being added: calls (resistance) vs puts (support)
function OiFlow({ s }) {
  const ca = Math.max(0, s.ceChg), pa = Math.max(0, s.peChg);
  const tot = ca + pa;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 8, fontWeight: 800, color: '#94a3b8', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>OI added today</div>
      {tot > 0 ? (
        <>
          <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: '#e2e8f0' }}>
            <div style={{ width: (ca / tot) * 100 + '%', background: RED, opacity: 0.8 }} />
            <div style={{ width: (pa / tot) * 100 + '%', background: GREEN, opacity: 0.8 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, fontWeight: 800, marginTop: 3 }}>
            <span style={{ color: RED }}>Calls +{fmtOI(ca)}</span>
            <span style={{ color: GREEN }}>Puts +{fmtOI(pa)}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function SnapshotCard({ s, filter, accent, spot, spotPts, spotChg, vix, vixTxt, wsMode, feedCount }) {
  if (!s) return null;
  const pcrColor = s.pcrLabel === 'Bullish' ? GREEN : s.pcrLabel === 'Bearish' ? RED : SLATE;
  const skewColor = s.skewLabel === 'Put skew' ? RED : s.skewLabel === 'Call skew' ? GREEN : SLATE;
  return (
    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 14, marginBottom: 12, boxShadow: 'var(--shadow-raised)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 800, color: accent, letterSpacing: 1.2 }}>{filter}</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: '#0f172a', letterSpacing: -0.8, lineHeight: 1.1 }}>₹{fmt(spot, 2)}</div>
          <div style={{ fontSize: 11, fontWeight: 800, color: chgColor(spotChg) }}>
            {signed(spotPts, 2)} pts · {signed(spotChg ?? 0, 2)}%
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
          <span style={{ fontSize: 10, fontWeight: 800, padding: '3px 9px', borderRadius: 20, background: vix < 16 ? '#f0fdf4' : vix > 22 ? '#fef2f2' : '#fffbeb', color: vix < 16 ? GREEN : vix > 22 ? RED : AMBER }}>
            VIX {vix.toFixed(2)} · {vixTxt}
          </span>
          <span style={{ fontSize: 9, fontWeight: 800, color: wsMode === 'ws' ? GREEN : AMBER }}>
            ● {wsMode === 'ws' ? 'LIVE' : wsMode === 'poll' ? 'POLLING' : '...'} · {feedCount} strikes
          </span>
          {s.dte != null && <span style={{ fontSize: 9, fontWeight: 700, color: SLATE }}>{s.dte === 0 ? 'Expires today' : `${s.dte}d to expiry`}</span>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7, marginTop: 12 }}>
        <Tile label="PCR" value={s.pcr.toFixed(2)} sub={s.pcrLabel} color={pcrColor} />
        <Tile label="Max Pain" value={fmt(s.maxPain, 0)} sub={`${signed(s.maxPainDistPct, 2)}% vs spot`} color="#7c3aed" />
        <Tile label="ATM IV" value={s.atmIv ? s.atmIv + '%' : '—'} sub={s.skewLabel + (s.skew != null ? ` ${signed(s.skew)}` : '')} color={skewColor} />
        <Tile label="Resistance" value={fmt(s.callWall, 0)} sub={`${signed(s.callWallDistPct, 2)}% · ${fmtOI(s.callWallOI)}`} color={RED} />
        <Tile label="Support" value={fmt(s.putWall, 0)} sub={`${signed(s.putWallDistPct, 2)}% · ${fmtOI(s.putWallOI)}`} color={GREEN} />
        <Tile label="ATM Straddle" value={s.straddle ? '₹' + fmt(s.straddle, 0) : '—'} sub={s.straddle ? `±${s.impliedMovePct}% implied` : ''} color="#0f172a" />
      </div>

      <RangeBar s={s} spot={spot} accent={accent} />
      <OiFlow s={s} />

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f1f5f9' }}>
        {s.facts.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, fontSize: 10.5, color: '#334155', lineHeight: 1.5, marginBottom: 2 }}>
            <span style={{ color: accent, fontWeight: 900 }}>›</span><span>{f}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Chain grid ──────────────────────────────────────────────────────────────
// One side (CE or PE) of a strike: LTP/change, an OI heat bar with change and build-up,
// IV · delta, the confidence chip (expandable to its raw components) and margin.
function SideCell({ cell, align, maxOi, itm }) {
  const [open, setOpen] = useState(false);
  const isLeft = align === 'left';
  if (!cell) return <div style={{ flex: 1, padding: '8px 6px' }} />;
  const ltpColor = chgColor(cell.ltpChgPct);
  const rows = open ? buildConfidenceRows(cell, 'option') : [];
  const oiPct = maxOi > 0 ? Math.min(100, ((cell.oi || 0) / maxOi) * 100) : 0;
  const oiChg = cell.prevOI > 0 ? ((cell.oi - cell.prevOI) / cell.prevOI) * 100 : 0;
  const tag = BUILD_TAG[cell.oiBuildType];
  const justify = isLeft ? 'flex-start' : 'flex-end';
  return (
    <div style={{ flex: 1, position: 'relative', padding: '8px 9px', textAlign: align, background: itm ? 'rgba(245,158,11,.07)' : 'transparent', minWidth: 0 }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, [isLeft ? 'right' : 'left']: 0, width: oiPct + '%',
        background: isLeft ? 'rgba(220,38,38,.10)' : 'rgba(22,163,74,.10)', pointerEvents: 'none' }} />
      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: ltpColor, display: 'flex', alignItems: 'baseline', gap: 4, justifyContent: justify }}>
          {fmt(cell.ltp)}{cell.isLive && <span style={{ fontSize: 6, color: GREEN }}>⚡</span>}
          <span style={{ fontSize: 9.5, fontWeight: 700 }}>{cell.ltpChgPct >= 0 ? '+' : ''}{cell.ltpChgPct}%</span>
        </div>
        <div style={{ fontSize: 9.5, fontWeight: 700, color: '#334155', marginTop: 3 }}>
          OI {fmtOI(cell.oi)}{' '}
          <span style={{ color: oiChg >= 0 ? '#2563eb' : '#ea580c' }}>{oiChg >= 0 ? '▲' : '▼'}{Math.abs(oiChg).toFixed(1)}%</span>
        </div>
        <div style={{ fontSize: 9, color: SLATE, fontWeight: 600, marginTop: 1 }}>
          IV {cell.iv || '—'} · Δ {cell.delta != null ? Math.abs(cell.delta).toFixed(2) : '—'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, justifyContent: justify, alignItems: 'center' }}>
          <button onClick={() => setOpen((v) => !v)} style={{ border: 'none', cursor: 'pointer', background: confBg(cell.confidence), borderRadius: 5, padding: '1.5px 5px' }}>
            <span style={{ fontSize: 9.5, fontWeight: 800, color: confColor(cell.confidence) }}>{cell.confidence}% {open ? '▾' : '▸'}</span>
          </button>
          {tag && <span style={{ fontSize: 8, fontWeight: 800, color: tag.c, background: tag.bg, borderRadius: 4, padding: '1.5px 4px' }}>{tag.t}</span>}
        </div>
        <div style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 3 }}>{fmtMargin(cell.marginEst)} margin</div>
        {open && rows.length > 0 && (
          <div style={{ marginTop: 5, background: '#fafbfc', border: '1px solid #f1f5f9', borderRadius: 6, padding: '5px 7px', textAlign: 'left' }}>
            <div style={{ fontSize: 7.5, fontWeight: 800, color: '#94a3b8', marginBottom: 2 }}>RAW SIGNAL — grid shows base score only, not the full ranked pipeline</div>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9 }}>
                <span style={{ color: SLATE }}>{r.label}</span>
                <span style={{ fontWeight: 700, color: r.dir > 0 ? GREEN : r.dir < 0 ? RED : SLATE }}>{r.val}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ children, bg }) {
  return <span style={{ fontSize: 7.5, fontWeight: 900, color: '#fff', background: bg, borderRadius: 3, padding: '1px 4px', letterSpacing: 0.3 }}>{children}</span>;
}

function StrikeRow({ row, accentColor, walls, maxOi, spot }) {
  const pcr = row.CE?.oi > 0 ? +(row.PE?.oi / row.CE.oi).toFixed(2) : (row.PE?.oi > 0 ? 99.99 : 0);
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid #f1f5f9', background: row.atm ? accentColor + '10' : '#fff' }}>
      <SideCell cell={row.CE} align="left" maxOi={maxOi} itm={spot > 0 && row.strike < spot} />
      <div style={{
        width: 80, flexShrink: 0, textAlign: 'center', fontSize: 13, fontWeight: 800,
        color: row.atm ? accentColor : '#334155',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
        borderLeft: '1px solid #f1f5f9', borderRight: '1px solid #f1f5f9', background: row.atm ? accentColor + '14' : '#fafbfc',
      }}>
        <div>{fmt(row.strike, 0)}</div>
        <div style={{ fontSize: 8.5, color: '#94a3b8', fontWeight: 700 }}>PCR {pcr}</div>
        <div style={{ display: 'flex', gap: 2, minHeight: 11 }}>
          {row.atm && <Badge bg={accentColor}>ATM</Badge>}
          {walls?.callWall === row.strike && <Badge bg={RED}>R</Badge>}
          {walls?.putWall === row.strike && <Badge bg={GREEN}>S</Badge>}
          {walls?.maxPain === row.strike && <Badge bg="#7c3aed">MP</Badge>}
        </div>
      </div>
      <SideCell cell={row.PE} align="right" maxOi={maxOi} itm={spot > 0 && row.strike > spot} />
    </div>
  );
}

// Spot-price pill inserted between the strike rows just below spot, like a broker chain
function SpotDivider({ spot, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '6px 0' }}>
      <div style={{ flex: 1, height: 1, background: color }} />
      <div style={{ background: color, color: '#fff', fontSize: 12, fontWeight: 800, padding: '5px 16px', borderRadius: 20, margin: '0 8px' }}>{fmt(spot, 2)}</div>
      <div style={{ flex: 1, height: 1, background: color }} />
    </div>
  );
}

export function ChainSection({ chain, shownRows, totalStrikes, spot, accentColor, walls, maxOi, onLoadMore }) {
  const hasMore = totalStrikes > shownRows.length;
  let spotInserted = false;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '9px 12px', borderRadius: '10px 10px 0 0',
        background: `linear-gradient(90deg, ${accentColor}15, ${accentColor}05)`,
        border: `1px solid ${accentColor}30`, borderBottom: 'none',
      }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: accentColor }}>📅 {chain?.expiry}</span>
        <span style={{ fontSize: 9.5, color: SLATE, fontWeight: 600 }}>{shownRows.length}/{totalStrikes} strikes</span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', padding: '7px 9px', background: '#f1f5f9',
        border: `1px solid ${accentColor}30`, borderTop: 'none', fontSize: 9, fontWeight: 800, color: SLATE, letterSpacing: 0.3,
      }}>
        <div style={{ flex: 1, textAlign: 'left' }}>← CALLS</div>
        <div style={{ width: 80, textAlign: 'center' }}>STRIKE</div>
        <div style={{ flex: 1, textAlign: 'right' }}>PUTS →</div>
      </div>
      <div style={{ border: `1px solid ${accentColor}30`, borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden', boxShadow: 'var(--shadow-raised)' }}>
        {shownRows.length === 0
          ? <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: '#94a3b8' }}>No strikes in range</div>
          : shownRows.map((row, i) => {
              const showDivider = !spotInserted && spot && row.strike >= spot && (i === 0 || shownRows[i - 1].strike < spot);
              if (showDivider) spotInserted = true;
              return (
                <React.Fragment key={row.strike}>
                  {showDivider && <SpotDivider spot={spot} color={accentColor} />}
                  <StrikeRow row={row} accentColor={accentColor} walls={walls} maxOi={maxOi} spot={spot} />
                </React.Fragment>
              );
            })}
        {hasMore && (
          <button onClick={onLoadMore} style={{ width: '100%', padding: '10px 0', border: 'none', borderTop: '1px solid #f1f5f9', background: '#fafbfc', color: accentColor, fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
            ↓ Load 20 More Strikes
          </button>
        )}
      </div>
      <div style={{ fontSize: 8.5, color: '#94a3b8', marginTop: 6, lineHeight: 1.5 }}>
        Shading behind each side = open interest relative to the largest wall (red calls, green puts). Amber tint = in the money.
        R / S / MP mark the call wall, put wall and max pain strikes. ▲▼ = OI change vs previous close.
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { fmt } from '../utils/formatters';

/** True on desktop-width screens; used to pick table vs card layout. */
export function useIsDesktop(min = 1024) {
  const q = `(min-width:${min}px)`;
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const h = e => setMatch(e.matches);
    mq.addEventListener('change', h);
    setMatch(mq.matches);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return match;
}

const num = (v, d = 2) => (v == null || !isFinite(+v) || +v === 0 ? '—' : fmt(+v, d));
const signCls = v => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'dn');
const onKey = fn => e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };

function recTone(rec) {
  const r = String(rec || '').toUpperCase();
  if (r.includes('SELL') || r === 'AVOID') return 'dn';
  if (r.includes('BUY') || r === 'MODERATE') return 'up';
  return 'nt';
}

function ConfBar({ v }) {
  const c = v >= 70 ? '#15803d' : v >= 55 ? '#b45309' : '#b91c1c';
  return (
    <span className="dt-conf">
      <span className="dt-bar"><i style={{ width: Math.min(100, Math.max(0, v || 0)) + '%', background: c }} /></span>
      <b>{v != null ? Math.round(v) + '%' : '—'}</b>
    </span>
  );
}

/** Stocks: one row per pick. Clicking a row opens the side panel. */
export function PicksTable({ picks, onSelect, selectedKey }) {
  return (
    <div className="dt-wrap">
      <table className="dt">
        <thead>
          <tr>
            <th>Symbol</th><th className="r">LTP</th><th className="r">Chg</th><th>Confidence</th>
            <th className="r">R:R</th><th className="r">Entry</th><th className="r">Stop</th><th className="r">Target</th><th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {picks.map((p, i) => {
            const k = p.key || p.s;
            const rec = p.rec || p.signal || 'WATCH';
            const chg = p.chgPct;
            return (
              <tr key={`${k}-${i}`} className={'dt-row' + (selectedKey === k ? ' sel' : '')}
                  tabIndex={0} onClick={() => onSelect(p)} onKeyDown={onKey(() => onSelect(p))}>
                <td><b>{p.s}</b><div className="dt-sub">{p.sec || p.sector || ''}</div></td>
                <td className="r">{num(p.ltp)}</td>
                <td className={'r b ' + signCls(chg)}>{chg != null ? (chg > 0 ? '+' : '') + (+chg).toFixed(2) + '%' : '—'}</td>
                <td><ConfBar v={p.conf} /></td>
                <td className="r">{p.pot?.rr ? p.pot.rr + ':1' : '—'}</td>
                <td className="r">{num(p.entry || p.ltp)}</td>
                <td className="r dn">{num(p.sl)}</td>
                <td className="r up">{num(p.target)}</td>
                <td><span className={'dt-pill ' + recTone(rec)}>{rec}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** F&O: one row per contract; the row expands to the full detail card. */
export function OptionsTable({ picks, renderCard, keyOf }) {
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(null);
  const count = f => picks.filter(p => f === 'all' ? true : f === 'with' ? p.trendAligned : p.type === f).length;
  const shown = picks.filter(p => filter === 'all' ? true : filter === 'with' ? p.trendAligned : p.type === filter);
  return (
    <div>
      <div className="chip-row">
        {[['all', 'All'], ['CE', 'CE'], ['PE', 'PE'], ['with', 'With trend']].map(([id, l]) => (
          <button key={id} className={'chip' + (filter === id ? ' on' : '')} onClick={() => setFilter(id)}>{l} ({count(id)})</button>
        ))}
      </div>
      <div className="dt-wrap">
        <table className="dt">
          <thead>
            <tr>
              <th>Contract</th><th>Type</th><th>Trend</th><th className="r">Conf</th><th className="r">AI win</th>
              <th className="r">R:R</th><th className="r">Entry</th><th className="r">Stop</th><th className="r">Target</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => {
              const k = keyOf(p, i);
              const isOpen = open === k;
              const toggle = () => setOpen(isOpen ? null : k);
              return (
                <React.Fragment key={k}>
                  <tr className={'dt-row' + (isOpen ? ' sel' : '')} tabIndex={0} onClick={toggle} onKeyDown={onKey(toggle)}>
                    <td><b>{p.und} {p.strike}</b><div className="dt-sub">Exp {p.expiry || '—'}{p.lot ? ' · Lot ' + p.lot : ''}</div></td>
                    <td><span className={'dt-pill ' + (p.type === 'PE' ? 'dn' : 'up')}>{p.type}</span></td>
                    <td className="m">{p.trendAligned ? 'With trend' : 'Counter'}</td>
                    <td className="r b">{p.confidence != null ? p.confidence + '%' : '—'}</td>
                    <td className={'r b ' + (typeof p.mlProbability === 'number' && p.mlProbability >= 60 ? 'up' : '')}>{typeof p.mlProbability === 'number' ? p.mlProbability + '%' : '—'}</td>
                    <td className="r">{p.rr ? p.rr + ':1' : '—'}</td>
                    <td className="r">{num(p.entry)}</td>
                    <td className="r dn">{num(p.sl)}</td>
                    <td className="r up">{num(p.tgt)}</td>
                    <td className="r m">{isOpen ? '▾' : '▸'}</td>
                  </tr>
                  {isOpen && <tr className="dt-exp"><td colSpan={10}><div className="dt-exp-in">{renderCard(p)}</div></td></tr>}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const OUT = { OPEN: ['Open', 'bl'], TARGET_HIT: ['Target hit', 'up'], SL_HIT: ['Stop hit', 'dn'], EXPIRED: ['Expired', 'nt'] };

/** Signal Log: one row per signal with an outcome badge; row expands to the full signal card. */
export function LogTable({ signals, renderRow, pnlOf }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="dt-wrap">
      <table className="dt">
        <thead>
          <tr>
            <th>Date</th><th>Symbol</th><th>Type</th><th className="r">Entry</th><th className="r">Stop</th>
            <th className="r">Target</th><th className="r">Conf</th><th>Outcome</th><th className="r">P&amp;L</th><th />
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => {
            const k = s.id || `${s.date}-${s.name || s.stock}-${i}`;
            const isOpen = open === k;
            const toggle = () => setOpen(isOpen ? null : k);
            const [lbl, tone] = OUT[s.status] || OUT.OPEN;
            const pnl = pnlOf(s);
            return (
              <React.Fragment key={k}>
                <tr className={'dt-row' + (isOpen ? ' sel' : '')} tabIndex={0} onClick={toggle} onKeyDown={onKey(toggle)}>
                  <td>{s.date || '—'}<div className="dt-sub">{s.time || ''}</div></td>
                  <td><b>{s.stock || s.name || '—'}</b><div className="dt-sub">{s.signal || s.action || ''}</div></td>
                  <td>{s.type === 'OPTION' ? `${s.strike || ''} ${s.optType || ''}`.trim() : 'Stock'}</td>
                  <td className="r">{num(s.entry)}</td>
                  <td className="r dn">{num(s.sl)}</td>
                  <td className="r up">{num(s.target)}</td>
                  <td className="r">{s.confidence != null ? s.confidence + '%' : '—'}</td>
                  <td><span className={'dt-pill ' + tone}>{lbl}</span></td>
                  <td className={'r b ' + signCls(pnl)}>{pnl != null ? (pnl > 0 ? '+' : '') + pnl.toFixed(2) + '%' : '—'}</td>
                  <td className="r m">{isOpen ? '▾' : '▸'}</td>
                </tr>
                {isOpen && <tr className="dt-exp"><td colSpan={10}><div className="dt-exp-in">{renderRow(s)}</div></td></tr>}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

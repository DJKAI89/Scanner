import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { ghReadMultipleDays } from '../services/github';

// Warns (never blocks) when today's stop-outs or the number of open signals reach the limits set in
// Settings -> Trade management -> Risk limits.
export default function RiskBanner() {
  const { gh, cfg } = useApp();
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (!gh?.token) return undefined;
    let off = false;
    const load = async () => {
      try {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const signals = await ghReadMultipleDays(gh, 5);   // open signals can be a few days old
        if (off) return;
        const stops = signals.filter((s) => s.status === 'SL_HIT' && (s.exitDate || s.date) === today).length;
        const open = signals.filter((s) => s.status === 'OPEN').length;
        setStats({ stops, open });
      } catch (_) { /* banner is best-effort */ }
    };
    load();
    const id = setInterval(load, 120000);
    return () => { off = true; clearInterval(id); };
  }, [gh?.token]); // eslint-disable-line

  if (!stats) return null;
  const maxStops = +cfg?.maxStopsPerDay || 3;
  const maxOpen = +cfg?.maxOpenSignals || 10;
  const msgs = [];
  if (stats.stops >= maxStops) msgs.push(`${stats.stops} stop-outs today (limit ${maxStops})`);
  if (stats.open >= maxOpen) msgs.push(`${stats.open} signals open (limit ${maxOpen})`);
  if (!msgs.length) return null;
  return (
    <div role="alert" style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#78350f', fontWeight: 700 }}>
      🚧 Risk limit reached: {msgs.join(' · ')}. Consider pausing new entries.
    </div>
  );
}

// ── Log service — signal log read/write + outcome resolution ─────
// Extracted from LogPane.jsx so the pane only handles UI/state wiring.
// All calculation and GitHub/API-call logic for the Signal Log tab lives here.

import { ghReadMultipleDays, ghWriteDay, ghUpdateIndex, ghReadDay, ghReadIndex } from './github';
import { fetchQ } from './api';
import { getISTDate } from '../utils/marketTime';
import { evaluateSignalExit } from './tradeManagement';

export function computeDayStats(sigs) {
  const closed  = sigs.filter(s => s.status==='TARGET_HIT'||s.status==='SL_HIT');
  const hits    = sigs.filter(s => s.status==='TARGET_HIT').length;
  const winRate = closed.length ? Math.round(hits/closed.length*100) : null;
  return { total:sigs.length, hits, sls:closed.length-hits, open:sigs.filter(s=>s.status==='OPEN').length, winRate };
}

export function getSignalFeedKey(sig) {
  return sig?.instrKey || sig?.key || '';
}

// ctx: { gh, days, lg, updateBadge }
export async function loadSignalLog(ctx) {
  const { gh, days, lg, updateBadge } = ctx;
  if (!gh.token || !gh.user || !gh.repo) throw new Error('GitHub not configured — go to ⚙ Settings to set it up.');

  const { dates } = await ghReadIndex(gh);
  const sorted = [...dates].sort();
  let calDates;
  if (days === 1) {
    const todayStr = getISTDate();
    calDates = sorted.includes(todayStr) ? [todayStr] : sorted.slice(-1);
  } else {
    calDates = sorted.slice(-days).reverse();
  }

  const all = [];
  const shaMap = {};
  // Read each calendar date in batches of 5
  for (let i = 0; i < calDates.length; i += 5) {
    const batch = calDates.slice(i, i + 5);
    const res = await Promise.allSettled(batch.map(d => ghReadDay(gh, d)));
    res.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value?.signals?.length) {
        all.push(...r.value.signals);
        if (r.value.sha) shaMap[batch[idx]] = r.value.sha;
      }
    });
  }
  all.sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
  updateBadge('log', String(all.length));
  if (days === 1 && calDates[0] && calDates[0] !== getISTDate()) {
    lg(`Signal log: no entry for today yet — showing ${calDates[0]} (${all.length} signals)`, 'w');
  } else {
    lg(`Signal log: ${all.length} signals (${days === 1 ? 'Today' : `${days}d`})`, 'o');
  }
  return { signals: all, shaMap, calDates };
}

// Real-time WS-driven SL/Target resolution — direction-aware (BUY vs SELL).
// Returns the updated signals array and a list of newly-resolved signal ids.
export function resolveSignalsAgainstLivePrices(signals, lastPrices, resolvedIds, istDate, istTime, cfg) {
  let changed = false;
  const newlyResolved = [];
  const touchedIds = []; // resolved OR partial-exit/trailing-stop updated — both need persisting
  const updated = signals.map(sig => {
    const feedKey = getSignalFeedKey(sig);
    if (sig.status !== 'OPEN' || !feedKey) return sig;
    if (resolvedIds.has(sig.id)) return sig;

    const live = lastPrices[feedKey];
    const isExpiryCandidate = sig.type === 'OPTION' && sig.expiry && istDate > sig.expiry;
    // Expiry checks fire even with no live tick (expired contracts often stop ticking);
    // everything else needs a real price.
    if (!live?.ltp && !isExpiryCandidate) {
      return sig.status !== 'OPEN' ? (({ livePrice: _, livePnlPct: __, ...clean }) => clean)(sig) : { ...sig };
    }

    const result = evaluateSignalExit(sig, live?.ltp ?? sig.entry, istDate, istTime, cfg);
    if (!result) return sig;

    if (result.status) {
      changed = true;
      newlyResolved.push(sig.id);
      touchedIds.push(sig.id);
      return { ...sig, ...result };
    }
    if (result.partials || result.trailSL != null || result.beActive) {
      changed = true;
      touchedIds.push(sig.id);
    }
    return { ...sig, ...result };
  });
  return { updated, changed, newlyResolved, touchedIds };
}

// Persists touched signals (fully resolved OR partial-exit/trailing-stop updated)
// back to GitHub, grouped by date, with SHA-conflict-safe merge.
export async function persistResolvedSignals(gh, updated, touchedIds, lg, onShaUpdate) {
  const byDate = {};
  updated.forEach(s => {
    if (!['OPEN', 'TARGET_HIT', 'SL_HIT', 'EXPIRED'].includes(s.status)) return;
    (byDate[s.date] = byDate[s.date] || []).push(s);
  });
  for (const [date, dateSigs] of Object.entries(byDate)) {
    if (!dateSigs.some(s => touchedIds.has(s.id))) continue;
    try {
      // Always read latest SHA from GitHub — prevents conflicts when logSignals
      // created the file but the local SHA cache doesn't know about it yet
      const { signals: latestSigs, sha: latestSha } = await ghReadDay(gh, date);
      // Merge: apply our updated trade-management state on top of the latest GitHub state
      const merged = latestSigs.length > 0
        ? latestSigs.map(s => {
            const touched = dateSigs.find(u => u.id === s.id && touchedIds.has(u.id));
            if (!touched) return s;
            return {
              ...s,
              status: touched.status, exitPrice: touched.exitPrice, exitTime: touched.exitTime,
              exitDate: touched.exitDate, pnlPct: touched.pnlPct, exitReason: touched.exitReason ?? s.exitReason,
              partials: touched.partials ?? s.partials, remainingPct: touched.remainingPct ?? s.remainingPct,
              beActive: touched.beActive ?? s.beActive, trailSL: touched.trailSL ?? s.trailSL,
              maxFavPrice: touched.maxFavPrice ?? s.maxFavPrice,
            };
          })
        : dateSigs.map(s => { const { livePrice:_, livePnlPct:__, ...clean } = s; return clean; }); // strip live fields
      const newSha = await ghWriteDay(gh, merged, latestSha, date);
      if (newSha) onShaUpdate(date, newSha);
      await ghUpdateIndex(gh, date, computeDayStats(merged));
      lg(`⚡ WS update — written to GitHub (${date}) SHA:${newSha?.slice(0,7)})`, 'o');
    } catch(e) { lg('WS write: ' + e.message, 'w'); }
  }
}

// Polls live REST quotes for all OPEN signals across all day-files and resolves
// SL/Target hits — direction-aware (BUY vs SELL), unlike a naive single-direction check.
// ctx: { gh, token, onTokenExpired, lg }
export async function checkAllOutcomes(ctx) {
  const { gh, token, cfg, onTokenExpired, lg } = ctx;
  if (!gh.token || !gh.user || !gh.repo) throw new Error('GitHub not configured.');
  if (!token) throw new Error('No Upstox token — log in first.');

  const { dates, dailyStats } = await ghReadIndex(gh);
  const datesWithOpen = dates.filter(d => dailyStats[d]?.open > 0);
  if (!datesWithOpen.length) { lg('No open signals found.', 'w'); return { updated: 0 }; }
  lg(`checkAllOutcomes: checking ${datesWithOpen.length} day file(s)`, 'o');

  const dayMap = {};
  const reads = await Promise.allSettled(datesWithOpen.map(d => ghReadDay(gh, d)));
  reads.forEach((res, i) => { if (res.status==='fulfilled'&&res.value?.signals) dayMap[datesWithOpen[i]] = { signals:res.value.signals, sha:res.value.sha }; });

  let updated = 0;
  for (const [date, { signals: daySigs, sha }] of Object.entries(dayMap)) {
    const openSigs = daySigs.filter(s => s.status === 'OPEN');
    if (!openSigs.length) continue;
    const keys = [...new Set(openSigs.map(s => s.instrKey || s.key).filter(Boolean))].join(',');
    let quotes = {};
    try { if (keys) quotes = await fetchQ(keys, token, onTokenExpired); } catch(_) {}
    let changed = false;
    const newSigs = daySigs.map(s => {
      if (s.status !== 'OPEN') return s;
      const instrK = s.instrKey || s.key; if (!instrK) return s;
      const exitTime = new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour12:false});
      const istToday = getISTDate();
      const ltp = quotes[instrK]?.last_price ?? null;
      // Expiry/time-stop checks inside the evaluator fire even without a live quote
      // (expired contracts often stop returning one) — everything else needs a real ltp.
      if (!ltp && !(s.type === 'OPTION' && s.expiry && istToday > s.expiry)) return s;

      const result = evaluateSignalExit(s, ltp ?? s.entry, istToday, exitTime, cfg);
      if (!result) return s;

      if (result.status) {
        const isWin = result.status === 'TARGET_HIT';
        const label = result.exitReason === 'EXPIRY' ? 'EXPIRED' : result.exitReason === 'TIME_STOP' ? 'TIME STOP' : result.exitReason === 'TRAIL_STOP' ? 'TRAIL STOP' : isWin ? 'TARGET HIT' : 'SL HIT';
        lg(`${isWin?'✅':'❌'} ${label}: ${s.sym || s.stock}${result.exitPrice!=null?` @ ₹${result.exitPrice}`:''} (blended ${result.pnlPct ?? 0}%)`, isWin ? 'o' : 'w');
        changed = true; updated++;
        return { ...s, ...result };
      }
      if (result.partials || result.trailSL != null || result.beActive) { changed = true; updated++; }
      return { ...s, ...result };
    });
    if (changed) await ghWriteDay(gh, newSigs, sha, date);
  }
  lg(`✅ checkAllOutcomes: ${updated} signal(s) updated`, 'o');
  return { updated };
}

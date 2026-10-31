// ── Today's Plan service: I/O + orchestration around planEngine (pure) ───────
// Refresh tiers (set by the pane to protect the Upstox rate limit):
//   daily candles  → once per day (cached here)
//   quotes + 5-min candles → every refresh (60 s)
//   option chain   → at most every 5 min (cached here)
import { fetchQ, fetchCandles, fetchIntraday, fetchOptionContracts } from './api';
import { classifyExpiries, loadChainForExpiry, summarizeChain } from './optionAnalysisService';
import { computeCtxFromCandles } from './technical';
import { INDEX_OPTS } from '../constants/config';
import { ghReadDay, ghReadMultipleDays, buildOptionSignal, logPlanSignals } from './github';
import { marketView, intradayState, buildDayPlan, setupScorecard, PLAN_DEFAULTS } from './planEngine';

const PLAN_INDICES = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
const VIX_KEY = 'NSE_INDEX|India VIX';
const CHAIN_TTL_MS = 5 * 60 * 1000;

const _daily = {};   // { [indexKey]: { date, candles } }
const _chain = {};   // { [indexKey]: { at, expiry, chain } }

export function istNow() {
  const parts = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' }).split(':');
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return { date, min: (parseInt(parts[0], 10) % 24) * 60 + parseInt(parts[1], 10) };
}

function ymd(d) { return d.toISOString().slice(0, 10); }

export function planLimitsFromCfg(cfg) {
  const l = {};
  if (Number.isFinite(+cfg?.planMaxTrades) && +cfg.planMaxTrades > 0) l.maxTrades = +cfg.planMaxTrades;
  if (Number.isFinite(+cfg?.planDailyLossR) && +cfg.planDailyLossR > 0) l.dailyLossR = +cfg.planDailyLossR;
  return l;
}

// Fetch everything the engine needs. Throws only if spot/VIX can't be read at all.
export async function loadPlanInputs({ token, cfg, onTokenExpired, lg = () => {}, setProgress = () => {} }) {
  const { date, min } = istNow();
  const idx = INDEX_OPTS.filter((i) => PLAN_INDICES.includes(i.name));
  setProgress('Fetching spot and VIX...');
  const q = await fetchQ([...idx.map((i) => i.key), VIX_KEY].join(','), token, onTokenExpired);
  const vix = q[VIX_KEY]?.last_price;
  if (!vix) throw new Error('Could not read India VIX');

  const perIndex = [];
  for (const i of idx) {
    try {
      const sq = q[i.key];
      const spot = sq?.last_price;
      if (!spot) { lg(`Plan: no spot for ${i.name}`, 'w'); continue; }
      const prev = sq.ohlc?.close || 0;
      const netChg = sq.net_change ?? (prev ? spot - prev : 0);
      const dayChg = spot > 0 ? +(netChg / spot * 100).toFixed(2) : 0;

      setProgress(`${i.name}: candles...`);
      if (_daily[i.key]?.date !== date) {
        const to = ymd(new Date()), from = ymd(new Date(Date.now() - 200 * 86400000));
        const candles = await fetchCandles(i.key, from, to, 'day', token, onTokenExpired).catch(() => []);
        _daily[i.key] = { date, candles };
      }
      const intraday = await fetchIntraday(i.key, '5minute', token, onTokenExpired).catch(() => []);

      setProgress(`${i.name}: option chain...`);
      let cached = _chain[i.key];
      if (!cached || Date.now() - cached.at > CHAIN_TTL_MS) {
        const contracts = await fetchOptionContracts(i.key, token, onTokenExpired);
        const { list } = classifyExpiries(contracts.map((c) => c.expiry).filter(Boolean));
        const expiry = list.find((e) => (new Date(e + 'T15:30:00+05:30') - Date.now()) / 86400000 >= PLAN_DEFAULTS.minDte - 0.5) || list[0];
        if (!expiry) throw new Error('no expiry');
        const marketCtx = computeCtxFromCandles(intraday, spot, dayChg, vix, null);
        const chain = await loadChainForExpiry(
          { token, indexKey: i.key, step: i.step, lot: i.lot, cfg, onTokenExpired },
          expiry, { spot, vixVal: vix, niftyBullish: dayChg > -0.3, marketCtx });
        cached = _chain[i.key] = { at: Date.now(), expiry, chain };
      }
      const summary = summarizeChain(cached.chain, spot);
      const dte = Math.max(0, Math.round((new Date(cached.expiry + 'T15:30:00+05:30') - Date.now()) / 86400000));
      perIndex.push({
        name: i.name, key: i.key, lot: i.lot, date, spot, dayChg,
        daily: _daily[i.key].candles, intradayRaw: intraday,
        rows: cached.chain.rows, expiry: cached.expiry, dte, summary,
      });
    } catch (e) { lg(`Plan: ${i.name} failed: ${e.message}`, 'w'); }
  }
  if (!perIndex.length) throw new Error('No index data could be loaded');
  return { date, min, vix, perIndex };
}

// Pure assembly from loaded inputs (+ today's already-logged plan trades).
export function assemblePlan(inputs, cfg, tradedToday = []) {
  const { vix, min } = inputs;
  const limits = planLimitsFromCfg(cfg);
  const perIndex = inputs.perIndex.map((ix) => {
    const intra = intradayState(ix.intradayRaw, min, { ...PLAN_DEFAULTS, ...limits });
    const view = marketView({ daily: ix.daily, intra, summary: ix.summary, vix, dayChgPct: ix.dayChg, nowMin: min, cfg: { ...PLAN_DEFAULTS, ...limits } });
    return { ...ix, intra, view };
  });
  const plan = buildDayPlan({ perIndex, cfg, limits, tradedToday });
  return { perIndex, plan, headline: perIndex[0]?.view, vix, min };
}

// Convert a TRIGGERED plan into a normal signal (paper, tagged planned:true).
export function planToSignal(p, vix) {
  const c = p.contract;
  const pick = {
    und: p.und, type: p.side, strike: c.strike, expiry: c.expiry, action: 'BUY',
    entry: c.ltp, sl: c.stop, tgt: c.t2, t1: c.t1, t2: c.t2, t3: c.t2,
    rr: c.rr, lot: c.lot, iv: c.iv, delta: c.delta, theta: c.theta, oi: c.oi, _dte: c.dte,
    amtRequired: c.sizing.totalCapitalAllocated, instrKey: c.instrKey,
    confidence: 0, slTgtMethod: 'PLAN_INDEX_LEVELS', trendAligned: true,
  };
  const s = buildOptionSignal(pick, vix);
  return {
    ...s,
    id: p.id,
    holdDays: 1,
    intradayOnly: true,                           // enforced in evaluateSignalExit
    exitByTime: '14:30',
    planned: true,
    setup: p.setup,
    planTrigger: p.triggerText,
    planInvalidation: p.invalidation,             // index level; shown, not enforced by the monitor
    planRiskPct: +((c.ltp - c.stop) / c.ltp * 100).toFixed(2),
    planRiskRupees: c.sizing.maxLossRupees,
    planLots: c.sizing.lots,
    note: `${p.setupLabel} · ${p.triggerText}`,
  };
}

export async function logTriggered(gh, plan, vix, lg) {
  const fresh = plan.trades.filter((t) => t.state === 'TRIGGERED').map((t) => planToSignal(t, vix));
  if (!fresh.length) return 0;
  return logPlanSignals(gh, fresh, lg);
}

// Plan trades already logged today (for the risk meter + de-dup) and the 30-day scorecard.
export async function loadPlanHistory(gh) {
  const { date } = istNow();
  const [{ signals: today }, month] = await Promise.all([
    ghReadDay(gh, date).catch(() => ({ signals: [] })),
    ghReadMultipleDays(gh, 30).catch(() => []),
  ]);
  const planToday = (today || []).filter((s) => s.planned);
  return { planToday, scorecard: setupScorecard((month || []).filter((s) => s.planned)) };
}

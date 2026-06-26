// ── Lookup service — single-stock/instrument lookup ───────────────
// Extracted from LookupPane.jsx so the pane only handles UI/state wiring.
// All calculation, scoring, and API-call logic for the Lookup tab lives here.

import { fetchQ, fetchCandles, fetchIntraday, fetchOptions, fetchOptionContracts } from './api';
import {
  calcRSI, calcEMACrossover, calcATR, calcBBSqueeze, calcSR, calcVWAP, calcVWAPBands,
  detectPatterns, calcRisk, calcPotential, calcConfidence, countIndicatorsEx,
  getRec, autoSLTarget, calcEntryTrigger, detectReversal, calcMACD,
  isNearSupport, calcRSIDivergence, getSignalStrength,
  calcMaxPain, calcOIWalls, computeCtxFromCandles, scanChain,
  applyFIIBias, applyAdaptWeights, applyCalibration, calcVolumeSurge, calcEMA, calcADX,
} from './technical';
import { applyMlRanking } from './mlRanking';
import { getIST, getISTDate, sleep } from '../utils/marketTime';
import { interpVIXSc, interpPCR, getDeliveryPct } from './stockScan';

export function getChgPct(q) {
  if (!q) return 0;
  const ltp = q.last_price || 0;
  const prev = q.ohlc?.close || ltp;
  return prev > 0 ? (ltp - prev) / prev * 100 : 0;
}

// ctx: { symbol, token, stocks, cfg, fiiData, adaptWeights, mlModels, onTokenExpired, lg }
// callbacks: { setProgress }
export async function lookupInstrument(ctx, callbacks) {
  const { symbol, token, stocks, cfg, fiiData, adaptWeights, mlModels, confCalibration, onTokenExpired, lg } = ctx;
  const { setProgress } = callbacks;
  const s = (symbol || '').trim().toUpperCase();
  if (!s) return null;

  setProgress('Searching for ' + s + '...');
  let inst = (stocks || []).find((i) => i.s === s);
  let q = null;

  if (inst) {
    const d = await fetchQ(inst.key, token, onTokenExpired);
    q = d[inst.key] || Object.values(d)[0];
  }

  if (!q?.last_price) {
    for (const tk of ['NSE_EQ|' + s, 'BSE_EQ|' + s]) {
      try {
        const d = await fetchQ(tk, token, onTokenExpired);
        const v = Object.values(d)[0];
        if (v?.last_price) {
          q = v;
          inst = inst || { key: tk, s, n: s, sec: 'NSE', fo: false, lot: 0 };
          break;
        }
      } catch (e) {}
    }
  }

  if (!q?.last_price) throw new Error(s + ' not found. Verify symbol or refresh token in settings.');

  // Market-wide context — same macro inputs StocksPane/OptionsPane factor into confidence.
  // Without this, calcConfidence below silently falls back to a neutral 50 score for
  // vixSc/pcrSc regardless of actual market regime, causing Lookup's rec to diverge
  // from Stocks/Options on days where real VIX/PCR meaningfully shift the picture.
  let vixSc = 50, marketPcr = null;
  try {
    const vQ = await fetchQ('NSE_INDEX|India VIX', token, onTokenExpired);
    const vixVal = vQ['NSE_INDEX|India VIX']?.last_price || 0;
    if (vixVal > 0) vixSc = interpVIXSc(vixVal).sc;
  } catch (e) {}
  try {
    const expRes = await fetch(
      `https://api.upstox.com/v2/option/contract?instrument_key=${encodeURIComponent('NSE_INDEX|Nifty 50')}`,
      { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }
    ).then(r => r.json());
    const exps = (expRes?.data?.map(e => e.expiry) || []).sort();
    if (exps.length) {
      const niftyChain = await fetchOptions('NSE_INDEX|Nifty 50', exps[0], token, onTokenExpired);
      const ceOI = niftyChain.reduce((sum, x) => sum + (x.call_options?.market_data?.oi || 0), 0);
      const peOI = niftyChain.reduce((sum, x) => sum + (x.put_options?.market_data?.oi || 0), 0);
      marketPcr = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1;
    }
  } catch (e) {}
  const pcrSc = marketPcr != null ? interpPCR(marketPcr).sc : 50;

  const ltp = q.last_price;
  const chgPct = getChgPct(q);
  const chgPts = q.net_change != null ? +q.net_change : ltp - (q.ohlc?.close || ltp);
  const today = getISTDate();
  const from90 = new Date(Date.now() - 95 * 86400000).toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });
  const from7 = new Date(Date.now() - 10 * 86400000).toLocaleDateString('en-CA', { timeZone:'Asia/Kolkata' });

  setProgress('Loading 90-day candles...');
  let tech = {};
  try {
    const candles = await fetchCandles(inst.key, from90, today, 'day', token, onTokenExpired);
    if (candles.length >= 5) {
      const closes = candles.map((c) => +c[4]).reverse();
      const volObj = calcVolumeSurge(candles);
      const rsi = calcRSI(closes);
      const ema = calcEMACrossover(closes);
      const macd = calcMACD(closes);
      const bb = calcBBSqueeze(closes);
      const atr = calcATR(candles);
      const adx = candles.length >= 16 ? calcADX(candles) : null;
      const sr = calcSR(candles);
      const pats = detectPatterns(candles);
      const rsiDiv = calcRSIDivergence(closes);
      const vwapBands = calcVWAPBands(candles);
      const delivPct = getDeliveryPct(q);
      const a50 = closes.length >= 50 ? ltp > (ema?.e50 || 0) : null;
      const a200 = closes.length >= 200 ? ltp > (ema?.e200 || 0) : null;
      const volOk = (q.volume || 0) > (volObj?.avgVol || 1) * cfg.vol;
      const nearS = isNearSupport(ltp, sr, candles[candles.length - 1]?.[3]);
      const { sl, target, targets } = autoSLTarget(ltp, q.ohlc?.high || ltp, q.ohlc?.low || ltp, atr, sr, 0, rsi);
      const preRR  = (sl>0&&ltp>sl) ? (target-ltp)/(ltp-sl) : 2;
      const preRec = preRR>=2.0?'BUY':preRR>=1.5?'MODERATE':'WATCH';
      const numInds = countIndicatorsEx(rsi, macd.bull, a50, a200, volOk, nearS, pats, preRec, macd, bb, adx, rsiDiv);
      const rec = numInds >= 4 ? 'BUY' : numInds >= 3 ? 'MODERATE' : numInds >= 2 ? 'WATCH' : 'AVOID';
      let conf = calcConfidence(null, vixSc, pcrSc, chgPct > 0, 0, q.volume || 0, volObj?.avgVol || 1, pats, preRec, numInds);
      // Enhancements (parity with stockScan.js — same indicators, same weights)
      if(macd?.bullCross)                      conf=Math.min(99,conf+6);
      if(macd?.histRising&&macd?.bullish)       conf=Math.min(99,conf+3);
      if(macd?.bearCross)                       conf=Math.max(1, conf-8);
      if(bb?.squeeze)                           conf=Math.min(99,conf+5);
      if(bb?.nearLowerBand)                     conf=Math.min(99,conf+4);
      if(bb?.percentB>1.0)                      conf=Math.max(1, conf-5);
      if(adx?.bullTrend)                        conf=Math.min(99,conf+5);
      if(adx?.bearTrend)                        conf=Math.max(1, conf-6);
      if(adx&&!adx.trending&&!adx.weakTrend)    conf=Math.max(1,conf-3);
      if(rsiDiv?.bullish)         conf=Math.min(99,conf+7+Math.min(5,rsiDiv.strength||0));
      if(rsiDiv?.hidden_bullish)  conf=Math.min(99,conf+4);
      if(rsiDiv?.bearish)         conf=Math.max(1, conf-8);
      if(rsiDiv?.hidden_bearish)  conf=Math.max(1, conf-4);
      if(vwapBands?.nearLowerBand)              conf=Math.min(99,conf+3);
      if(vwapBands?.position==='FAR_ABOVE'||vwapBands?.position==='ABOVE_1SD') conf=Math.max(1,conf-4);
      const delivBoost = delivPct!=null?(delivPct>=60?1:delivPct<=25?-1:0):0;
      conf=Math.min(100,Math.max(0,conf+delivBoost*5));
      conf=applyFIIBias(conf, preRec==='BUY'||preRec==='STRONG BUY', null);
      conf=applyCalibration(conf, confCalibration||null);
      const risk = calcRisk(ltp, sl, target, atr, 0);
      const pot = calcPotential(ltp, target, sl, numInds, rec);
      const reversal = detectReversal(ltp, rsi, pats, sr, 0, 1.0, chgPct > 0, chgPct, atr, q.ohlc?.high || ltp, q.ohlc?.low || ltp);
      const vwap = calcVWAP(candles);
      const aboveVWAP = vwap > 0 ? ltp >= vwap : null;
      const _indSnap = {
        macdBull: macd.bull===true, macdBullCross: macd?.bullCross===true, macdBearCross: macd?.bearCross===true,
        bbSqueeze: bb?.squeeze===true, bbNearLower: bb?.nearLowerBand===true, adxBull: adx?.bullTrend===true,
        adxBear: adx?.bearTrend===true, rsiDiv: rsiDiv?.bullish===true, rsiDivHidden: rsiDiv?.hidden_bullish===true,
        rsiBearDiv: rsiDiv?.bearish===true, a50: a50===true, a200: a200===true, nearSupp: !!nearS,
        aboveVWAP: aboveVWAP===true, vwapNearLower: vwapBands?.nearLowerBand===true, engulfing: pats?.bullishEngulfing===true, hammer: pats?.hammer===true,
        morningStar: pats?.morningStar===true, reversalFired: (reversal?.type || 'NONE') !== 'NONE',
        delivHigh: (delivPct??0)>=60, delivLow: (delivPct??100)<=25,
      };
      conf = applyAdaptWeights(conf, adaptWeights?.stock || null, _indSnap);
      const mlRank = applyMlRanking(conf, mlModels || null, { type:'STOCK', confidence: conf, numInds, risk, pot, rec: preRec, reversal, _indSnap });
      conf = mlRank.confidence;
      const finalRec = getRec(conf, pot.base, risk, pot.rr);
      const strength = getSignalStrength(numInds, conf, reversal);
      const entry = calcEntryTrigger(ltp, q.ohlc?.high || ltp, sr, atr, finalRec, vwap, chgPct);
      tech = { rsi, ema, macd, bb, atr, adx, sr, pats, rsiDiv, a50, a200, volOk, nearS, numInds, rec: finalRec, conf, sl, target, targets, pot, risk, strength, vwap, entry, reversal, avgVol: volObj?.avgVol || 0, volRatio: volObj?.ratio || 1, mlProbability: mlRank.mlProbability, mlAdj: mlRank.mlAdj };
    }
  } catch (e) {
    lg('Daily candles: ' + e.message, 'w');
  }

  setProgress('Loading 30-min candles...');
  let tf30 = {};
  try {
    const c30 = await fetchCandles(inst.key, from7, today, '30minute', token, onTokenExpired);
    if (c30.length >= 4) {
      const cl30 = c30.map((c) => +c[4]).reverse();
      tf30 = { rsi: calcRSI(cl30), trend: cl30.at(-1) > cl30[0] ? 'UP' : 'DOWN', vwap: calcVWAP(c30) };
    }
  } catch (e) {}

  let tf5 = {};
  let marketCtx = null;
  let intraData = null;
  setProgress('Loading intraday candles...');
  try {
    // Always try intraday — if market closed, fetchIntraday returns [] safely
    const c5 = await fetchIntraday(inst.key, '5minute', token, onTokenExpired);
    if (c5.length >= 3) {
      const c5chron = [...c5].reverse();
      const cl5     = c5chron.map(c => +c[4]);

      // EMA momentum — calcEMA returns a single scalar, not a series
      const ema5v   = calcEMA(cl5, 5);
      const ema13v  = calcEMA(cl5, 13);
      const emaBull = ema5v != null && ema13v != null ? ema5v > ema13v : null;
      const ema5vPrev = cl5.length > 1 ? calcEMA(cl5.slice(0, -1), 5) : null;
      const accel   = ema5v != null && ema5vPrev != null && ema5v > ema5vPrev;

      // Volume
      const curVol  = +(c5chron[c5chron.length-1]?.[5] || 0);
      const avgVol  = c5chron.length > 5
        ? c5chron.slice(0,-1).reduce((s,c)=>s+(+c[5]||0),0) / (c5chron.length-1) : 0;
      const volRatio = avgVol > 0 ? +(curVol/avgVol).toFixed(2) : null;

      // VWAP
      const vwap5   = calcVWAP(c5);
      const aboveVWAP = vwap5 ? ltp >= vwap5 : null;

      // Intraday high/low vs PDH/PDL
      const intraHi  = Math.max(...c5chron.map(c => +c[2]));
      const intraLo  = Math.min(...c5chron.map(c => +c[3]));

      tf5 = { rsi:calcRSI(cl5), vwap:vwap5, trend:cl5[cl5.length-1]>cl5[0]?'UP':'DOWN',
        volRatio, emaBull, accelerating:accel };
      intraData = { volRatio, emaBull, accelerating:accel, aboveVWAP, vwap:vwap5,
        intraHi, intraLo, curVol, avgVol };
      marketCtx = computeCtxFromCandles(c5, ltp, chgPct, 0, null);
    }
  } catch (e) { lg('Intraday fetch: ' + e.message, 'w'); }

  setProgress('Checking option contracts...');
  let foData = { unsupported: true, picks: [] };
  try {
    const contracts = await fetchOptionContracts(inst.key, token, onTokenExpired);
    const expiries = [...new Set(contracts.map((c) => c.expiry).filter(Boolean))].sort();
    if (expiries.length) {
      const lotFromApi = contracts.find((c) => c.lot_size)?.lot_size || contracts[0]?.lot_size || inst.lot || 1;
      inst = { ...inst, fo: true, lot: lotFromApi };
      const expiry = expiries[0];
      const nextExp = expiries[1] || '';
      setProgress('Loading options chain...');
      await sleep(400);
      const chain = await fetchOptions(inst.key, expiry, token, onTokenExpired);

      if (!chain.length) {
        foData = { empty: true, expiry, picks: [] };
      } else {
        const maxPain = calcMaxPain(chain);
        const oiWalls = calcOIWalls(chain);
        const ceOI = chain.reduce((sum, x) => sum + (x.call_options?.market_data?.oi || 0), 0);
        const peOI = chain.reduce((sum, x) => sum + (x.put_options?.market_data?.oi || 0), 0);
        const pcr = ceOI > 0 ? +(peOI / ceOI).toFixed(2) : 1.0;
        const step = inst.step || (ltp < 200 ? 5 : ltp < 500 ? 10 : ltp < 2000 ? 20 : ltp < 5000 ? 50 : 100);
        const atm = Math.round(ltp / step) * step;
        const ctxForChain = marketCtx || computeCtxFromCandles([], ltp, chgPct, 0, null);
        const picks = scanChain(chain, atm, ltp, s, expiry, inst.lot, chgPct > 0, 0, maxPain, pcr, ctxForChain, cfg);
        const filteredPicks = picks
          .map((p) => {
            const _indSnap = {
              trendAligned: p.trendAligned||false, emaBull: p.emaTrendBull===true, emaBearish: p.emaTrendBull===false,
              freshCross: p.emaCross==='bullish_cross'||p.emaCross==='bearish_cross', momentumFresh: p.momentumFresh||false,
              volSpike: (p.volRatio??0)>=1.5, lowVol: (p.volRatio??1)<0.7, nearPDH: p.priceZone==='PDH_BREAK'||p.priceZone==='NEAR_PDH',
              nearPDL: p.priceZone==='PDL_BREAK'||p.priceZone==='NEAR_PDL', oiBuildUp: p.oiBuildType==='CE_BUILD'||p.oiBuildType==='PE_BUILD',
              compositeHigh: Math.abs(p.compositeScore??0)>=2, compositeMed: Math.abs(p.compositeScore??0)>=1, atm: p.atm||false,
            };
            let c = applyFIIBias(p.confidence, p.action === 'BUY', fiiData);
            c = applyCalibration(c, confCalibration || null);
            c = applyAdaptWeights(c, adaptWeights?.option || null, _indSnap);
            const mlRank = applyMlRanking(c, mlModels || null, { ...p, confidence: c, _indSnap });
            return { ...p, confidence: mlRank.confidence, mlProbability: mlRank.mlProbability, mlAdj: mlRank.mlAdj };
          })
          .filter((p) => p.confidence >= cfg.minOptConf);

        let multiExpiry = null;
        if (nextExp) {
          try {
            await sleep(400);
            const nextChain = await fetchOptions(inst.key, nextExp, token, onTokenExpired);
            if (nextChain.length) {
              const findATM = (ch, side) => {
                const row = ch.find((r) => r.strike_price === atm) || ch.reduce((a, b) => Math.abs(b.strike_price - atm) < Math.abs(a.strike_price - atm) ? b : a, ch[0]);
                const opt = side === 'CE' ? row?.call_options : row?.put_options;
                return { ltp: opt?.market_data?.ltp || 0, iv: opt?.option_greeks?.iv || 0, delta: opt?.option_greeks?.delta || 0, theta: opt?.option_greeks?.theta || 0 };
              };
              const dteCur = Math.max(0, Math.round((new Date(expiry) - new Date()) / 86400000));
              const dteNxt = Math.max(0, Math.round((new Date(nextExp) - new Date()) / 86400000));
              multiExpiry = {
                expiry,
                nextExp,
                dteCur,
                dteNxt,
                atm,
                ce: { cur: findATM(chain, 'CE'), nxt: findATM(nextChain, 'CE') },
                pe: { cur: findATM(chain, 'PE'), nxt: findATM(nextChain, 'PE') },
              };
            }
          } catch (e) {
            lg('Multi-expiry: ' + e.message, 'w');
          }
        }

        foData = { chain, picks: filteredPicks, maxPain, oiWalls, pcr, expiry, nextExp, atm, multiExpiry };
      }
    }
  } catch (e) {
    lg(s + ' F&O: ' + e.message, 'e');
    foData = { error: e.message, picks: [] };
  }

  return { inst, q, ltp, chgPct, chgPts, tech, tf30, tf5, marketCtx, foData, intraData, time: getIST() };
}

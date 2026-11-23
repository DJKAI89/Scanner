import React from 'react';
import { fmt, fmtVol } from '../utils/formatters';
import { getSignalStrength } from '../services/technical';
import { calculatePositionSize } from '../services/tradeManagement';
import {
  AccentCard, CardHeader, VerdictRow, LevelsStrip, StatusTag,
  MetricGrid, MetricMini, ProgressStat, TargetTiers, SignalTags, Banner, FooterNote,
  contextTags, KpiStrip, riskFlags,
} from './cardKit';
import { ConfidenceBreakdown } from './ConfidenceBreakdown';

function dirOf(rec) {
  if (!rec) return 'neutral';
  const r = rec.toLowerCase();
  if (r.includes('strong') || r === 'buy' || r === 'moderate') return 'bull';
  if (r === 'sell' || r === 'avoid') return 'bear';
  return 'neutral';
}

export default function StockCard({ pick: p, rank, cfg = {}, onPopup }) {
  const rec     = p.rec || p.signal || 'WATCH';
  const dir     = dirOf(rec);
  const ltp     = p.ltp || p.entry || 0;
  const minConf = cfg.minStockConf || 50;
  const isBuy   = rec === 'BUY' || rec === 'STRONG BUY' || rec === 'MODERATE';

  const str = getSignalStrength(p.numInds || 0, p.conf || 0, p.reversal);
  const et  = p.entryTrigger;
  const triggered = et?.alreadyTriggered;
  const slPct  = p.sl && ltp ? ((p.sl - ltp) / ltp * 100).toFixed(2)     : null;
  const tgtPct = p.target && ltp ? ((p.target - ltp) / ltp * 100).toFixed(2) : null;
  const slMethod  = p.slTargets?.consMethod || 'ATR+VIX';
  const tgtMethod = p.slTargets?.modMethod  || '2:1 R:R';

  const volRatio = p.avgVol20 > 0 ? +(p.vol / p.avgVol20).toFixed(1) : null;

  // ── Build the unified active-signal tag list (replaces 3 separate badge systems) ──
  const di = [
    p.rsi != null && p.rsi >= (cfg.rsiOS||35) && p.rsi <= (cfg.rsiOB||65),
    !!(p.macd?.bullCross||p.macdBull===true) && isBuy,
    p.a50===true && isBuy,
    p.a200===true && isBuy,
    !!(p.numInds>=5),
    !!(p.nearSupp && isBuy),
    !!(p.patterns?.bullishEngulfing||p.patterns?.hammer||p.patterns?.morningStar),
    !!(p.bb?.nearLowerBand && isBuy),
    !!(p.adx?.bullTrend && isBuy),
    !!(p.rsiDiv?.bullish && isBuy),
  ];
  const indLbls = ['RSI OK','MACD↑','50MA↑','200MA↑','Vol↑','Near Supp','Pattern','BB↓','ADX↑','RSI Div'];
  const activeCount = di.filter(Boolean).length;

  const tags = [];
  indLbls.forEach((l, j) => { if (di[j]) tags.push({ label: l, tone: 'green' }); });
  Object.entries(p.patterns||{}).filter(([,v])=>v).forEach(([k]) =>
    tags.push({ label: '📊 ' + k.replace(/([A-Z])/g,' $1').trim(), tone: 'green' })
  );
  if (p.macd?.bullCross) tags.push({ label: 'MACD✕↑', tone: 'green' });
  if (p.macd?.bearCross) tags.push({ label: 'MACD✕↓', tone: 'red' });
  if (p.bb?.squeeze) tags.push({ label: 'BB Squeeze', tone: 'blue' });
  if (p.adx?.bullTrend) tags.push({ label: `ADX ${p.adx?.adx?.toFixed(0)}↑`, tone: 'purple' });
  if (p.adx && !p.adx.trending && !p.adx.weakTrend) tags.push({ label: 'Choppy', tone: 'slate' });
  if (p.rsiDiv?.bullish) tags.push({ label: `RSI Div↑ +${Math.min(12,p.rsiDiv.strength||0)}pts`, tone: 'amber' });
  if (p.aboveVWAP===true && p.vwap>0) tags.push({ label: `▲ VWAP ₹${fmt(p.vwap,0)}`, tone: 'green' });
  if (p.aboveVWAP===false && p.vwap>0) tags.push({ label: `▼ VWAP ₹${fmt(p.vwap,0)}`, tone: 'red' });
  if (p.vwapBands?.nearLowerBand) tags.push({ label: '📊 VWAP Zone', tone: 'amber' });
  if (p.mtf) tags.push({ label: `MTF ${p.mtf.grade} · ${p.mtf.dirs}${p.mtf.roomATR != null ? ` · ${p.mtf.roomATR} ATR room` : ''}`, tone: p.mtf.grade === 'A' ? 'green' : p.mtf.grade === 'B' ? 'blue' : 'amber' });
  else if (p.mtfUnavailable) tags.push({ label: 'MTF n/a', tone: 'slate' });
  else if (p.mtfBoost>0) tags.push({ label: `⚡ MTF +${p.mtfBoost}pts`, tone: 'blue' });
  // intraday enrichment
  if (p.stockVWAP) tags.push({ label: `${p.stockVWAP.aboveVWAP?'↑':'↓'} 5m VWAP`, tone: p.stockVWAP.aboveVWAP ? 'green' : 'red' });
  if (p.intraVolRatio >= 2) tags.push({ label: `🔥 Vol ${p.intraVolRatio}× intraday`, tone: 'purple' });
  else if (p.intraVolRatio >= 1.5) tags.push({ label: `📊 Vol ${p.intraVolRatio}× 5m`, tone: 'blue' });
  if (typeof p.intraBull === 'boolean') tags.push({ label: p.intraBull ? '⚡ 5m EMA↑' : '⚡ 5m EMA↓', tone: p.intraBull ? 'green' : 'red' });
  if (p.intraAccel) tags.push({ label: '🚀 Accelerating', tone: 'amber' });
  tags.push(...riskFlags(p), ...contextTags(p)); // caution notes first, then regime · confluence · AI win-probability

  return (
    <AccentCard dir={dir}>
      {p._fallback && (
        <Banner tone="amber" icon="⚠" title="Below filter threshold" detail="Showing as fallback — lower ⚙ Settings thresholds for normal picks" />
      )}

      <CardHeader
        rank={rank}
        symbol={p.s}
        sector={p.sec}
        name={p.n}
        ltp={fmt(ltp)}
        chgPct={p.chgPct}
        rec={rec}
        dir={dir}
        onPopup={onPopup}
      />

      <KpiStrip items={[
        { label: 'CONF', value: `${p.conf || 0}%`, color: (p.conf || 0) >= minConf ? '#16a34a' : (p.conf || 0) >= minConf - 15 ? '#d97706' : '#dc2626', sub: `min ${minConf}%` },
        typeof p.mlProbability === 'number'
          ? { label: 'AI WIN', value: `${p.mlProbability}%`, color: p.mlProbability >= 60 ? '#16a34a' : p.mlProbability >= 50 ? '#d97706' : '#dc2626', sub: 'model' }
          : { label: 'EST. WIN', value: `~${p.pot?.wr || 0}%`, sub: 'rule-based' },
        { label: 'R:R', value: `${p.pot?.rr || 0}:1`, color: (p.pot?.rr || 0) >= 2 ? '#16a34a' : (p.pot?.rr || 0) >= 1.5 ? '#d97706' : '#dc2626' },
        { label: 'SIGNAL', value: str.label, color: str.color, sub: `${p.numInds || 0}/7 indicators` },
      ]} />

      {p.reversal && p.reversal.type !== 'NONE' && (
        <Banner
          tone={p.reversal.type==='BULLISH_REVERSAL' ? 'green' : 'red'}
          icon={p.reversal.type==='BULLISH_REVERSAL' ? '🔄📈' : '🔄📉'}
          title={`${p.reversal.strength} ${p.reversal.type==='BULLISH_REVERSAL'?'BULLISH':'BEARISH'} REVERSAL`}
          detail={(p.reversal.signals||[]).slice(0,3).join(' · ')}
        />
      )}

      <LevelsStrip
        entry={fmt(et?.trigger || ltp)}
        sl={fmt(p.sl)}
        target={fmt(p.target)}
        entrySub={et?.method || 'Market'}
        slSub={slPct != null ? `${slPct}% · ${slMethod}` : null}
        tgtSub={tgtPct != null ? `+${tgtPct}% · ${tgtMethod}` : null}
        status={et ? <StatusTag triggered={triggered} /> : null}
      />

      {p.pot && (
        <TargetTiers cons={fmt(p.pot.cons,0)} mod={fmt(p.pot.mod,0)} agg={fmt(p.pot.agg,0)} />
      )}

      <ProgressStat label="Confidence" pct={p.conf||0} color={(p.conf||0)>=minConf?'#16a34a':(p.conf||0)>=(minConf-10)?'#d97706':'#dc2626'} valueLabel={`${p.conf||0}%`} />
      <ConfidenceBreakdown pick={p} kind="stock" />
      <ProgressStat label="Risk"       pct={p.risk||0} color={(p.risk||0)<30?'#16a34a':(p.risk||0)<50?'#d97706':'#dc2626'} valueLabel={`${p.risk||0}%`} />
      <ProgressStat label="Potential"  pct={Math.min(100,(p.pot?.adj||0)*5)} color="#1d4ed8" valueLabel={`${(p.pot?.adj||0).toFixed(1)}%`} />

      <MetricGrid cols={3}>
        <MetricMini label="RSI(14)" value={p.rsi!=null?p.rsi.toFixed(1):'—'}
          color={p.rsi<=(cfg.rsiOS||35)?'#16a34a':p.rsi>=(cfg.rsiOB||65)?'#dc2626':'#d97706'}
          sub={p.rsi?(p.rsi<=(cfg.rsiOS||35)?'Oversold':p.rsi>=(cfg.rsiOB||65)?'Overbought':'Neutral'):''} />
        <MetricMini label="Volume" value={fmtVol(p.vol||0)}
          color={volRatio>=1.5?'#16a34a':volRatio>=0.8?'#d97706':'#dc2626'}
          sub={volRatio!=null?`${volRatio}× avg`:'—'} />
        <MetricMini label="Day High/Low" value={`₹${fmt(p.high,0)} / ${fmt(p.low,0)}`} color="#374151" />
        {p.delivPct!=null && (
          <MetricMini label="Delivery %" value={`${p.delivPct}%`}
            color={p.delivPct>=60?'#16a34a':p.delivPct<=25?'#dc2626':'#d97706'}
            sub={p.delivPct>=60?'High conv':p.delivPct<=25?'Low conv':'Normal'} />
        )}
      </MetricGrid>

      <SignalTags tags={tags} totalCount={indLbls.length} activeCount={activeCount} />

      {isBuy && p.sl > 0 && ltp > p.sl && (() => {
        const portSz = cfg.portSize || 500000, riskPct = cfg.riskPct || 2;
        const pos = calculatePositionSize({ accountCapital: portSz, maxRiskPerTradePct: riskPct, entryPrice: ltp, stopLossPrice: p.sl, type: 'STOCK', maxCapital: portSz });
        const budget = Math.round(portSz * riskPct / 100);
        return (
          <div style={{background: pos.riskTooHigh ? '#fef2f2' : '#eff6ff', border: '1px solid #e2e8f0', borderRadius: 9, padding: '8px 10px', margin: '8px 0'}}>
            <div style={{fontSize: 8, color: '#64748b', fontWeight: 700, marginBottom: 3}}>POSITION SIZING ({'\u20B9'}{(portSz / 100000).toFixed(1)}L, {riskPct}% risk = {'\u20B9'}{fmt(budget, 0)} max)</div>
            {pos.riskTooHigh
              ? <div style={{fontSize: 12, fontWeight: 800, color: '#b91c1c'}}>Skip: stop is {'\u20B9'}{fmt(ltp - p.sl, 2)} away per share</div>
              : <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                  <div><span style={{fontSize: 17, fontWeight: 800, color: '#1d4ed8'}}>{pos.shares} shares</span><span style={{fontSize: 9, color: '#64748b', marginLeft: 6}}>recommended</span></div>
                  <div style={{textAlign: 'right', fontSize: 9, color: '#64748b'}}>Capital: {'\u20B9'}{fmt(pos.totalCapitalAllocated, 0)}<br />Max loss: {'\u20B9'}{fmt(pos.maxLossRupees, 0)}</div>
                </div>}
          </div>
        );
      })()}
      <FooterNote>
        {str.label} signal · {p.numInds||0}/7 indicators · R:R {p.pot?.rr||0}:1 · Win ~{p.pot?.wr||0}%
        {p.reversal?.type!=='NONE' ? ` · ${p.reversal?.type==='BULLISH_REVERSAL'?'🔄 Reversal UP':'🔄 Reversal DOWN'}` : ''}
        {et?.alreadyTriggered ? ' · ✅ Trigger hit' : ` · ⏳ Wait for trigger at ₹${fmt(et?.trigger||ltp)}`}
      </FooterNote>
    </AccentCard>
  );
}
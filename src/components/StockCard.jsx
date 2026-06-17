import React from 'react';
import { fmt, fmtVol } from '../utils/formatters';
import { getSignalStrength, calcEMA } from '../services/technical';
import LiveChart from './LiveChart';


function recCls(rec) {
  if (!rec) return 'watch';
  const r = rec.toLowerCase().replace(/\s+/g, '-');
  if (r.includes('strong')) return 'strong-buy';
  if (r === 'buy')          return 'buy';
  if (r === 'moderate')     return 'moderate';
  if (r === 'sell' || r === 'avoid') return 'sell';
  return 'watch';
}

export default function StockCard({ pick: p, rank, cfg = {} }) {
  const rec = p.rec || p.signal || 'WATCH';
  const cls = recCls(rec);
  const ltp = p.ltp || p.entry || 0;
  const minConf = cfg.minStockConf || 50;
  const isBuy = rec === 'BUY' || rec === 'STRONG BUY' || rec === 'MODERATE';

  // 10 indicator dots — exact HTML port
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

  const str = getSignalStrength(p.numInds || 0, p.conf || 0, p.reversal);
  const et  = p.entryTrigger;
  const triggered = et?.alreadyTriggered;
  const slPct  = p.sl&&ltp ? ((p.sl-ltp)/ltp*100).toFixed(2) : null;
  const tgtPct = p.target&&ltp ? ((p.target-ltp)/ltp*100).toFixed(2) : null;
  const slMethod  = p.slTargets?.consMethod || null;
  const tgtMethod = p.slTargets?.modMethod  || '2:1 R:R';

  const volRatio = p.avgVol20>0 ? +(p.vol/p.avgVol20).toFixed(1) : null;
  const volLabel = volRatio==null?'—':volRatio>=2?`${volRatio}x avg 🔥`:volRatio>=1.5?`${volRatio}x avg ↑`:volRatio>=0.8?`${volRatio}x avg`:`${volRatio}x avg ↓`;
  const volCls   = volRatio==null?'':volRatio>=1.5?'up':volRatio>=0.8?'am':'dn';

  return (
    <div className={`card ${cls}`}>
      {/* Fallback banner */}
      {p._fallback&&(
        <div style={{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:6,padding:'5px 10px',marginBottom:8,fontSize:9,fontWeight:700,color:'#92400e'}}>
          ⚠ Below filter threshold — showing as fallback (lower ⚙ Settings thresholds for normal picks)
        </div>
      )}

      <div className="c-rank">{rank}</div>
      <span className={`c-rec ${cls}`}>{rec}</span>

      {/* Header */}
      <div className="c-head">
        <div className="c-sym">{p.s} <span style={{fontSize:9,color:'#94a3b8',fontWeight:400}}>{p.sec}</span></div>
        <div className="c-name">{p.n}</div>
      </div>

      {/* Signal strength badge */}
      <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8,flexWrap:'wrap'}}>
        <span style={{background:str.bg,color:str.color,border:`1px solid ${str.border}`,borderRadius:12,padding:'3px 10px',fontSize:10,fontWeight:800}}>
          {str.label} SIGNAL
        </span>
        <span style={{fontSize:9,color:'#64748b'}}>{p.numInds||0}/7 indicators</span>
      </div>

      {/* Reversal banner */}
      {p.reversal&&p.reversal.type!=='NONE'&&(()=>{
        const isBR=p.reversal.type==='BULLISH_REVERSAL';
        return (
          <div style={{background:isBR?'#f0fdf4':'#fef2f2',border:`1px solid ${isBR?'#86efac':'#fca5a5'}`,borderRadius:8,padding:'7px 10px',marginBottom:8,fontSize:10,color:isBR?'#15803d':'#dc2626'}}>
            <div style={{fontWeight:800,marginBottom:2}}>{isBR?'🔄📈':'🔄📉'} {p.reversal.strength} {isBR?'BULLISH':'BEARISH'} REVERSAL SIGNAL</div>
            <div style={{fontWeight:500,opacity:.85}}>{(p.reversal.signals||[]).slice(0,3).join(' · ')}</div>
          </div>
        );
      })()}

      {/* LTP LIVE + R:R */}
      <div className="c-metrics cm2" style={{gap:1,marginBottom:6}}>
        <div className="cbox neutral">
          <div className="cb-l">LTP · LIVE</div>
          <div className={`cb-v ltp-live ${p.chgPct>=0?'up':'dn'}`}>₹{fmt(ltp)}</div>
          <div className={`cb-s ${p.chgPct>=0?'up':'dn'}`}>{p.chgPct>=0?'▲':'▼'}{Math.abs(p.chgPct||0).toFixed(2)}%</div>
        </div>
        <div className="cbox neutral">
          <div className="cb-l">R:R | WIN RATE</div>
          <div className="cb-v am">{p.pot?.rr||0}:1</div>
          <div className="cb-s" style={{color:'#64748b'}}>Win ~{p.pot?.wr||0}%</div>
        </div>
      </div>

      {/* Indicator pills */}
      <div style={{display:'flex',flexWrap:'wrap',gap:4,margin:'5px 0 2px'}}>
        {p.macd?.bullCross        &&<span className="ind-pill green-strong">MACD✕↑</span>}
        {p.macd?.bullish&&!p.macd?.bullCross&&<span className="ind-pill green">MACD↑</span>}
        {p.macd?.bearCross        &&<span className="ind-pill red">MACD✕↓</span>}
        {p.macd?.bearish&&!p.macd?.bearCross&&<span className="ind-pill red">MACD↓</span>}
        {p.bb?.squeeze            &&<span className="ind-pill blue">BB Squeeze</span>}
        {p.bb?.nearLowerBand      &&<span className="ind-pill yellow">BB Lower</span>}
        {p.adx?.bullTrend         &&<span className="ind-pill purple">ADX {p.adx?.adx?.toFixed(0)}↑</span>}
        {p.adx&&!p.adx.trending&&!p.adx.weakTrend&&<span className="ind-pill gray">Choppy</span>}
        {p.rsiDiv?.bullish        &&<span className="ind-pill orange">RSI Div↑ +{Math.min(12,p.rsiDiv.strength||0)}pts</span>}
        {p.rsiDiv?.hidden_bullish &&<span className="ind-pill yellow">Hidden Div↑</span>}
        {p.aboveVWAP===true &&p.vwap>0&&<span className="ind-pill green">▲ {p.vwapType==='intraday'?'Session':'Daily'} VWAP ₹{fmt(p.vwap,0)}</span>}
        {p.aboveVWAP===false&&p.vwap>0&&<span className="ind-pill red">▼ {p.vwapType==='intraday'?'Session':'Daily'} VWAP ₹{fmt(p.vwap,0)}</span>}
        {p.vwapBands?.nearLowerBand&&<span className="ind-pill yellow">📊 VWAP Value Zone</span>}
        {p.mtfBoost>0&&<span className="ind-pill blue">⚡ MTF +{p.mtfBoost}pts{p.mtfNote?' · '+p.mtfNote:''}</span>}
      </div>

      {/* Entry Trigger box */}
      {et&&(
        <div style={{background:triggered?'#f0fdf4':'#eff6ff',border:`1px solid ${triggered?'#86efac':'#93c5fd'}`,borderRadius:8,padding:'8px 11px',marginBottom:8}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:3}}>
            <span style={{fontSize:9,fontWeight:700,color:'#64748b',letterSpacing:'.5px'}}>ENTRY TRIGGER</span>
            {triggered
              ?<span style={{background:'#16a34a',color:'#fff',borderRadius:10,padding:'2px 7px',fontSize:9,fontWeight:700}}>✅ TRIGGERED</span>
              :<span style={{background:'#e2e8f0',color:'#64748b',borderRadius:10,padding:'2px 7px',fontSize:9,fontWeight:700}}>⏳ WAITING</span>}
          </div>
          <div style={{fontSize:18,fontWeight:800,color:triggered?'#15803d':'#1d4ed8'}}>₹{fmt(et.trigger)}</div>
          <div style={{fontSize:9,color:'#64748b',marginTop:1}}>{et.method}{et.note?' · '+et.note:''}</div>
        </div>
      )}

      {/* Trade setup */}
      <div className="trade-setup">
        <div className="ts-box"><div className="ts-l">ENTRY TRIGGER</div><div className="ts-v bl">₹{fmt(et?.trigger||ltp)}</div><div className="ts-s" style={{color:'#94a3b8'}}>{et?.method||'Market'}</div></div>
        <div className="ts-box"><div className="ts-l">STOP LOSS</div><div className="ts-v dn">₹{fmt(p.sl)}</div><div className="ts-s dn">{slPct}% · {slMethod||'ATR+VIX'}</div></div>
        <div className="ts-box"><div className="ts-l">TARGET</div><div className="ts-v up">₹{fmt(p.target)}</div><div className="ts-s up">{tgtPct?'+'+tgtPct+'%':''} · {tgtMethod}</div></div>
      </div>

      {/* 3 Targets */}
      {p.pot&&(
        <div className="c-targets">
          <div className="tgt cons"><div className="tgt-l">Conservative</div><div className="tgt-v up">₹{fmt(p.pot.cons,0)}</div></div>
          <div className="tgt mod"><div className="tgt-l">Moderate</div><div className="tgt-v bl">₹{fmt(p.pot.mod,0)}</div></div>
          <div className="tgt agg"><div className="tgt-l">Aggressive</div><div className="tgt-v pu">₹{fmt(p.pot.agg,0)}</div></div>
        </div>
      )}

      {/* Analytics */}
      <div className="c-metrics cm4" style={{gap:1,marginBottom:7}}>
        <div className="cbox neutral"><div className="cb-l">CONFIDENCE</div><div className={`cb-v ${(p.conf||0)>=minConf?'up':(p.conf||0)>=(minConf-10)?'am':'dn'}`}>{p.conf||0}%</div></div>
        <div className="cbox neutral"><div className="cb-l">POTENTIAL</div><div className={`cb-v ${(p.pot?.adj||0)>=12?'up':(p.pot?.adj||0)>=8?'am':'dn'}`}>{(p.pot?.adj||0).toFixed(2)}%</div></div>
        <div className="cbox neutral"><div className="cb-l">RISK</div><div className={`cb-v ${p.risk<30?'up':p.risk<50?'am':'dn'}`}>{p.risk||0}%</div></div>
        <div className="cbox neutral"><div className="cb-l">EXP. VALUE</div><div className={`cb-v ${(p.pot?.ev||0)>=0?'up':'dn'}`}>{(p.pot?.ev||0)>=0?'+':''}{(p.pot?.ev||0).toFixed(2)}%</div></div>
      </div>

      {/* Bars */}
      <div className="c-bars">
        {[
          ['Confidence', p.conf||0, (p.conf||0)>=minConf?'#16a34a':(p.conf||0)>=(minConf-10)?'#d97706':'#dc2626'],
          ['Risk',       p.risk||0, (p.risk||0)<30?'#16a34a':(p.risk||0)<50?'#d97706':'#dc2626'],
          ['Potential',  Math.min(100,(p.pot?.adj||0)*5), '#1d4ed8'],
        ].map(([l,v,c])=>(
          <div key={l} className="bar-row">
            <span className="bar-lbl">{l}</span>
            <div className="bar-track"><div className="bar-fill" style={{width:Math.min(100,v)+'%',background:c}}/></div>
            <span className="bar-val" style={{color:c}}>{Math.round(v)}%</span>
          </div>
        ))}
      </div>

      {/* Technical */}
      <div className="c-metrics cm3" style={{gap:1,marginBottom:7}}>
        <div className="cbox neutral">
          <div className="cb-l">RSI(14)</div>
          <div className={`cb-v ${p.rsi<=(cfg.rsiOS||35)?'up':p.rsi>=(cfg.rsiOB||65)?'dn':'am'}`}>{p.rsi!=null?p.rsi.toFixed(2):'-'}</div>
          <div className="cb-s" style={{color:'#64748b'}}>{p.rsi?p.rsi<=(cfg.rsiOS||35)?'Oversold':p.rsi>=(cfg.rsiOB||65)?'Overbought':'Neutral':''}</div>
        </div>
        <div className="cbox neutral">
          <div className="cb-l">VOLUME</div>
          <div className={`cb-v ${volCls}`}>{fmtVol(p.vol||0)}</div>
          <div className="cb-s" style={{color:'#64748b'}}>{volLabel}</div>
        </div>
        <div className="cbox neutral">
          <div className="cb-l">DAY HIGH/LOW</div>
          <div className="cb-v" style={{color:'#374151',fontSize:11}}>₹{fmt(p.high,0)} / {fmt(p.low,0)}</div>
        </div>
        {p.delivPct!=null&&(
          <div className="cbox neutral">
            <div className="cb-l">DELIVERY %</div>
            <div className={`cb-v ${p.delivPct>=60?'up':p.delivPct<=25?'dn':'am'}`}>{p.delivPct}%</div>
            <div className="cb-s" style={{color:'#64748b'}}>{p.delivPct>=60?'High conv':p.delivPct<=25?'Low conv':'Normal'}</div>
          </div>
        )}
      </div>

      {/* Intraday enrichment badges — shown after background 5m fetch */}
      {(p.stockVWAP || p.intraVolRatio >= 1.5 || p.intraBull != null) && (
        <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:6 }}>
          {p.stockVWAP && (
            <span style={{ fontSize:7, fontWeight:800, borderRadius:5, padding:'2px 6px',
              background: p.stockVWAP.aboveVWAP ? '#f0fdf4' : '#fef2f2',
              color:      p.stockVWAP.aboveVWAP ? '#16a34a' : '#dc2626',
              border: `1px solid ${p.stockVWAP.aboveVWAP ? '#86efac' : '#fca5a5'}`,
            }}>{p.stockVWAP.aboveVWAP ? '↑' : '↓'} VWAP ₹{p.stockVWAP.vwap?.toFixed(1)}</span>
          )}
          {p.intraVolRatio >= 2 && (
            <span style={{ fontSize:7, fontWeight:800, background:'#fdf4ff', color:'#7c3aed', border:'1px solid #ddd6fe', borderRadius:5, padding:'2px 6px' }}>
              🔥 Vol {p.intraVolRatio}×
            </span>
          )}
          {p.intraVolRatio >= 1.5 && p.intraVolRatio < 2 && (
            <span style={{ fontSize:7, fontWeight:700, background:'#eff6ff', color:'#1d4ed8', border:'1px solid #bfdbfe', borderRadius:5, padding:'2px 6px' }}>
              📊 Vol {p.intraVolRatio}×
            </span>
          )}
          {p.intraBull === true && (
            <span style={{ fontSize:7, fontWeight:700, background:'#f0fdf4', color:'#16a34a', border:'1px solid #86efac', borderRadius:5, padding:'2px 6px' }}>⚡ 5m Bull</span>
          )}
          {p.intraAccel && (
            <span style={{ fontSize:7, fontWeight:700, background:'#fff7ed', color:'#c2410c', border:'1px solid #fed7aa', borderRadius:5, padding:'2px 6px' }}>🚀 Accel</span>
          )}
        </div>
      )}

      {/* 10 indicator dots */}
      <div className="c-inds">
        {indLbls.map((l,j)=><span key={l} className={`ind ${di[j]?'ok':di[j]===false&&p.rsi!=null?'no':'na'}`}>{l}</span>)}
        {Object.entries(p.patterns||{}).filter(([,v])=>v).map(([k])=>
          <span key={k} className="ind ok">📊{k.replace(/([A-Z])/g,' $1').trim()}</span>
        )}
      </div>

      {/* Intraday enrichment badges */}
      {(p.stockVWAP || p.intraVolRatio >= 1.5 || p.intraBull !== undefined) && (
        <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:6, marginTop:2 }}>
          {p.stockVWAP && (
            <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:8,
              background: p.stockVWAP.aboveVWAP?'#f0fdf4':'#fef2f2',
              color:      p.stockVWAP.aboveVWAP?'#16a34a':'#ef4444',
              border:`1px solid ${p.stockVWAP.aboveVWAP?'#86efac':'#fca5a5'}`,
            }}>
              {p.stockVWAP.aboveVWAP?'↑':'↓'} VWAP {p.stockVWAP.distPct>0?'+':''}{p.stockVWAP.distPct}%
            </span>
          )}
          {p.intraVolRatio >= 2 && (
            <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:8, background:'#fdf4ff', color:'#7c3aed', border:'1px solid #ddd6fe' }}>
              🔥 Vol {p.intraVolRatio}× intraday
            </span>
          )}
          {p.intraVolRatio >= 1.5 && p.intraVolRatio < 2 && (
            <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:8, background:'#eff6ff', color:'#1d4ed8', border:'1px solid #bfdbfe' }}>
              📊 Vol {p.intraVolRatio}× 5m
            </span>
          )}
          {p.intraBull !== null && (
            <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:8,
              background: p.intraBull?'#f0fdf4':'#fef2f2',
              color:      p.intraBull?'#16a34a':'#ef4444',
              border:`1px solid ${p.intraBull?'#86efac':'#fca5a5'}`,
            }}>
              {p.intraBull?'⚡ 5m EMA↑':'⚡ 5m EMA↓'}
            </span>
          )}
          {p.intraAccel && (
            <span style={{ fontSize:8, fontWeight:700, padding:'2px 6px', borderRadius:8, background:'#fff7ed', color:'#c2410c', border:'1px solid #fed7aa' }}>
              🚀 Accelerating
            </span>
          )}
        </div>
      )}

      {/* Why */}
      <div className={`c-why ${cls}`}>
        {str.label} signal · {p.numInds||0}/7 indicators · R:R {p.pot?.rr||0}:1 · Win ~{p.pot?.wr||0}%
        {p.reversal?.type!=='NONE'?` · ${p.reversal?.type==='BULLISH_REVERSAL'?'🔄 Reversal UP':'🔄 Reversal DOWN'}`:''}
        {et?.alreadyTriggered?' · ✅ Trigger hit':` · ⏳ Wait for trigger at ₹${fmt(et?.trigger||ltp)}`}
      </div>

      {/* Live chart */}
      {p.key && (
        <div style={{ marginTop:10, borderTop:'1px solid #e2e8f0', paddingTop:10 }}>
          <LiveChart
            instrKey={p.key}
            candles={p.recentCandles || []}
            closes={p.closes || []}
            entry={et?.trigger || p.ltp}
            sl={p.sl}
            target={p.target}
            symbol={p.s}
            livePrice={ltp}
            liveChgPct={p.chgPct}
          />
        </div>
      )}
    </div>
  );
}

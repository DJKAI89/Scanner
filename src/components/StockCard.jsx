import React from 'react';
import { fmt, fmtVol } from '../utils/formatters';
import { getSignalStrength, calcEMA } from '../services/technical';
import LiveChart from './LiveChart';

// Inline mini chart (shared logic with StocksPane)
function drawMiniChart(candles, closes, opts = {}) {
  if (!candles || candles.length < 3) return null;
  const W = opts.width || 320, H = opts.height || 92;
  const PAD = { top: 6, right: 4, bottom: 14, left: 2 };
  const chartW = W - PAD.left - PAD.right, chartH = H - PAD.top - PAD.bottom;
  const raw = candles.slice(0, 20).reverse(), N = raw.length;
  if (N < 2) return null;
  let priceHigh = Math.max(...raw.map(c => +c[2]));
  let priceLow  = Math.min(...raw.map(c => +c[3]));
  if (opts.target > 0) priceHigh = Math.max(priceHigh, opts.target);
  if (opts.sl     > 0) priceLow  = Math.min(priceLow,  opts.sl);
  if (opts.entry  > 0) { priceHigh = Math.max(priceHigh, opts.entry); priceLow = Math.min(priceLow, opts.entry); }
  const range = priceHigh - priceLow; if (range <= 0) return null;
  const py = p => PAD.top + chartH * (1 - (p - priceLow) / range);
  const slotW = chartW / N, candleW = Math.max(2, slotW * 0.6);
  const cx = i => PAD.left + (i + 0.5) * slotW;
  let cs = '';
  for (let i = 0; i < N; i++) {
    const [,o,h,l,c] = raw[i].map(Number); const up = c >= o;
    const col = up ? '#16a34a' : '#dc2626';
    const bodyTop = py(Math.max(o,c)), bodyH = Math.max(1, py(Math.min(o,c)) - bodyTop);
    cs += `<line x1="${cx(i)}" y1="${py(h)}" x2="${cx(i)}" y2="${py(l)}" stroke="${col}" stroke-width="1" opacity="0.8"/>`;
    cs += `<rect x="${(cx(i)-candleW/2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${col}" rx="0.5"/>`;
  }
  let ema50L = '', ema200L = '';
  if (closes && closes.length >= 50) {
    const e50 = [], e200 = [];
    for (let i = 0; i < N; i++) {
      const sl2 = closes.slice(0, closes.length - (N - 1 - i));
      e50.push(sl2.length >= 50 ? calcEMA(sl2, 50) : null);
      e200.push(sl2.length >= 200 ? calcEMA(sl2, 200) : null);
    }
    const lp = (vals, col, dash = '') => {
      const pts = vals.map((v, i) => v != null ? `${cx(i).toFixed(1)},${py(v).toFixed(1)}` : null).filter(Boolean);
      return pts.length >= 2 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="1.2" opacity="0.75" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"/>` : '';
    };
    ema50L = lp(e50, '#2563eb'); ema200L = lp(e200, '#9333ea', '3,2');
  }
  const hLine = (price, col, lbl, dash = false) => {
    if (!price || price <= 0) return '';
    const y = py(price);
    if (y < PAD.top || y > H - PAD.bottom + 2) return '';
    return `<line x1="${PAD.left}" y1="${y.toFixed(1)}" x2="${W-PAD.right}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="${dash?'1':'1.5'}" opacity="0.9" ${dash?'stroke-dasharray="4,3"':''}/>` +
      `<text x="${W-PAD.right-2}" y="${(y-2).toFixed(1)}" text-anchor="end" font-size="7" font-weight="700" fill="${col}" font-family="system-ui,sans-serif">${lbl}</text>`;
  };
  const dateL = (c2, xPos, anchor) => {
    if (!c2 || !c2[0]) return '';
    const d = new Date(c2[0]); const l = isNaN(d) ? '' : `${d.getDate()}/${d.getMonth()+1}`;
    return `<text x="${xPos}" y="${H-1}" text-anchor="${anchor}" font-size="7" fill="#94a3b8" font-family="system-ui,sans-serif">${l}</text>`;
  };
  const ema50Val  = closes && closes.length >= 50  ? calcEMA(closes, 50)  : null;
  const ema200Val = closes && closes.length >= 200 ? calcEMA(closes, 200) : null;
  const svgStr = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;border-radius:6px;background:#f8fafc;border:1px solid #e2e8f0;margin:8px 0 4px">
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${W-PAD.right}" y2="${PAD.top}" stroke="#e2e8f0" stroke-width="0.5"/>
    <line x1="${PAD.left}" y1="${(PAD.top+chartH/2).toFixed(1)}" x2="${W-PAD.right}" y2="${(PAD.top+chartH/2).toFixed(1)}" stroke="#e2e8f0" stroke-width="0.5" stroke-dasharray="2,2"/>
    <line x1="${PAD.left}" y1="${PAD.top+chartH}" x2="${W-PAD.right}" y2="${PAD.top+chartH}" stroke="#e2e8f0" stroke-width="0.5"/>
    ${ema200L}${ema50L}${cs}
    ${hLine(opts.target,'#16a34a','Tgt')}${hLine(opts.entry,'#1d4ed8','Entry',true)}${hLine(opts.sl,'#dc2626','SL')}
    ${dateL(raw[0], PAD.left+2, 'start')}${dateL(raw[N-1], W-PAD.right-2, 'end')}
    <line x1="${PAD.left+2}" y1="${H-8}" x2="${PAD.left+14}" y2="${H-8}" stroke="#2563eb" stroke-width="1.2"/>
    <text x="${PAD.left+16}" y="${H-5}" font-size="6.5" fill="#64748b" font-family="system-ui,sans-serif">EMA50</text>
    <line x1="${PAD.left+46}" y1="${H-8}" x2="${PAD.left+58}" y2="${H-8}" stroke="#9333ea" stroke-width="1.2" stroke-dasharray="3,2"/>
    <text x="${PAD.left+60}" y="${H-5}" font-size="6.5" fill="#64748b" font-family="system-ui,sans-serif">EMA200</text>
  </svg>`;
  return { svgStr, ema50Val, ema200Val };
}

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

  // Mini candlestick chart
  const chart = p.recentCandles?.length >= 3
    ? drawMiniChart(p.recentCandles, p.closes||[], {entry:et?.trigger||ltp, target:p.target, sl:p.sl})
    : null;

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

      {/* Mini candlestick chart — before trade setup, same as HTML */}
      {chart&&(
        <div style={{marginBottom:8}}>
          <div style={{fontSize:8,fontWeight:700,color:'#94a3b8',marginBottom:2,letterSpacing:'.5px'}}>
            20-DAY CHART{chart.ema50Val?` · EMA50 ₹${fmt(chart.ema50Val,0)}`:''}{chart.ema200Val?` · EMA200 ₹${fmt(chart.ema200Val,0)}`:''}
          </div>
          <div dangerouslySetInnerHTML={{__html:chart.svgStr}}/>
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

      {/* 10 indicator dots */}
      <div className="c-inds">
        {indLbls.map((l,j)=><span key={l} className={`ind ${di[j]?'ok':di[j]===false&&p.rsi!=null?'no':'na'}`}>{l}</span>)}
        {Object.entries(p.patterns||{}).filter(([,v])=>v).map(([k])=>
          <span key={k} className="ind ok">📊{k.replace(/([A-Z])/g,' $1').trim()}</span>
        )}
      </div>

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
          />
        </div>
      )}
    </div>
  );
}

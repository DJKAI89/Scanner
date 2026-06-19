import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { DEF, CFG_VERSION } from '../constants/config';
import { localIsOpen, getMarketStatusLocal, getIST } from '../utils/marketTime';
import { fetchMarketStatus, fetchUserProfile, normalizeAccessToken } from '../services/api';
import { interpretFIIDII } from '../services/technical';
import { pullSettingsFromGH, pushSettingsToGH, ghReadMultipleDays, ghMigrateIfNeeded, ghReadIndex, ghReadDay, ghWriteDay, pullAiModelFromGH, pushAiModelToGH, appendAiHistoryToGH } from '../services/github';
import { fetchQ, resolveAccessToken } from '../services/api';
import { trainSignalMlModels, buildModelSnapshot } from '../services/mlRanking';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  // ── Token ──
  const [token, setTokenState] = useState(() => localStorage.getItem('friday_token') || '');
  const [tokenExpired, setTokenExpired] = useState(false);
  const [booted, setBooted] = useState(false);

  // ── Config — exact same init logic as HTML ──
  const [cfg, setCfgState] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('friday_cfg') || 'null');
      if (saved && saved._v === CFG_VERSION) return { ...DEF, ...saved };
      // Old/mismatched version — clear and use DEF (same as HTML)
      localStorage.removeItem('friday_cfg');
    } catch (e) {}
    return { ...DEF };
  });

  // ── Market ──
  const [marketStatus, setMarketStatus] = useState(() =>
    localIsOpen() ? { open: true, msg: '' } : getMarketStatusLocal()
  );
  const _mktCacheTs = useRef(0);

  // ── User ──
  const [userName, setUserName] = useState(() => localStorage.getItem('friday_user_name') || '');
  const [userId,   setUserId]   = useState(() => localStorage.getItem('friday_user_id')   || '');

  // ── GitHub ──
  const [gh, setGhState] = useState(() => ({
    token: localStorage.getItem('friday_gh_token') || '',
    user:  localStorage.getItem('friday_gh_user')  || '',
    repo:  localStorage.getItem('friday_gh_repo')  || '',
  }));

  // ── Stocks ──
  const [stocks, setStocks]           = useState([]);
  const [stocksStatus, setStocksStatus] = useState('');

  // ── FII/DII ──
  const [fiiData, setFiiData]     = useState(null);
  const [fiiInterp, setFiiInterp] = useState(null);

  // ── UI state ──
  const [activeTab, setActiveTabState] = useState(() => localStorage.getItem('friday_active_tab') || 'stocks');
  const [scanning, setScanning]   = useState(false);
  const [statusDot, setStatusDot] = useState('live');
  const [statusTxt, setStatusTxt] = useState('Live');
  const [badges, setBadges]       = useState({ stocks: '—', options: '—', log: '—', analysis: '—' });
  const [logOpen, setLogOpen]     = useState(false);
  const [logLines, setLogLines]   = useState([]);
  const [toast, setToast]         = useState(null);
  const [tickerStats, setTickerStats] = useState({ vix:0, pcr:null, sentiment:'—', sentSc:5, topSec:'—' });
  const [confCalibration, setConfCalibration] = useState(null);
  const [adaptWeights,    setAdaptWeights]    = useState(null); // per-indicator win-rate adjustments
  const [mlModels,        setMlModels]        = useState(() => {
    try { return JSON.parse(localStorage.getItem('friday_ml_models') || 'null'); } catch (_) { return null; }
  });
  const [mlSnapshots,     setMlSnapshots]     = useState(() => {
    try { return JSON.parse(localStorage.getItem('friday_ml_snapshots') || '[]'); } catch (_) { return []; }
  });
  const [openSignalCount, setOpenSignalCount] = useState(0);   // live OPEN signal count (global monitor)
  const signalMonitorRef  = useRef(null);  // interval ref for global signal monitor
  const resolvedSigIds    = useRef(new Set()); // in-memory set of already-resolved signal IDs — never re-checked
  const mlRefreshTimerRef = useRef(null);

  // ── Settings-pulled-from-GH callback ref (so SettingsPane can react) ──
  const [ghSettingsPulled, setGhSettingsPulled] = useState(0);

  // ── Helpers ──
  const lg = useCallback((msg, t = '') => {
    setLogLines((prev) => [...prev.slice(-200), { msg, t, ts: getIST() }]);
  }, []);

  const showToast = useCallback((msg, color = '#16a34a', duration = 5000) => {
    setToast({ msg, color });
    setTimeout(() => setToast(null), duration);
  }, []);

  const scheduleMlRefresh = useCallback((ghCfg, delayMs = 12000) => {
    const g = ghCfg || gh;
    if (!g?.token || !g?.user || !g?.repo) return;
    if (mlRefreshTimerRef.current) clearTimeout(mlRefreshTimerRef.current);
    mlRefreshTimerRef.current = setTimeout(() => {
      const run = () => loadConfCalibration(g);
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        window.requestIdleCallback(run, { timeout: 8000 });
      } else {
        setTimeout(run, 0);
      }
    }, delayMs);
  }, [gh]); // eslint-disable-line

  const onTokenExpired = useCallback(() => {
    localStorage.removeItem('friday_token');
    localStorage.removeItem('friday_token_date');
    setTokenState(''); setBooted(false); setTokenExpired(true);
  }, []);

  const saveToken = useCallback((newToken) => {
    const v = normalizeAccessToken(newToken);
    if (!v || v.length < 20) return 'Token too short';
    localStorage.setItem('friday_token', v);
    localStorage.setItem('friday_token_date', new Date().toDateString());
    setTokenState(v); setTokenExpired(false); setBooted(true);
    return null;
  }, []);

  const clearToken = useCallback(() => {
    localStorage.removeItem('friday_token');
    localStorage.removeItem('friday_token_date');
    localStorage.removeItem('friday_user_name');
    localStorage.removeItem('friday_user_id');
    setTokenState(''); setUserName(''); setUserId('');
    setBooted(false); setStocks([]);
  }, []);

  // ── saveCfg — saves to localStorage + state ──
  const saveCfg = useCallback((newCfg) => {
    const merged = { ...newCfg, _v: CFG_VERSION };
    localStorage.setItem('friday_cfg', JSON.stringify(merged));
    setCfgState(merged);
  }, []);

  const resetCfg = useCallback(() => {
    localStorage.removeItem('friday_cfg');
    setCfgState({ ...DEF });
  }, []);

  const saveGh = useCallback((newGh) => {
    localStorage.setItem('friday_gh_token', newGh.token || '');
    localStorage.setItem('friday_gh_user',  newGh.user  || '');
    localStorage.setItem('friday_gh_repo',  newGh.repo  || '');
    setGhState(newGh);
  }, []);

  const setActiveTab = useCallback((tab) => {
    const nextTab = tab || 'stocks';
    localStorage.setItem('friday_active_tab', nextTab);
    setActiveTabState(nextTab);
  }, []);

  const updateBadge = useCallback((tab, text) => {
    setBadges((prev) => ({ ...prev, [tab]: text }));
  }, []);


  // ── refreshMarketStatus ──
  const refreshMarketStatus = useCallback(async () => {
    if (Date.now() - _mktCacheTs.current < 60000) return;
    _mktCacheTs.current = Date.now();
    if (!token) { setMarketStatus(getMarketStatusLocal()); return; }
    try {
      const result = await fetchMarketStatus(token);
      if (result) setMarketStatus({ open: result.open, msg: result.open ? '' : '🔔 NSE Market Closed' });
    } catch (e) { setMarketStatus(getMarketStatusLocal()); }
  }, [token]);

  // ── loadStocks — from GitHub /stocks/stocks.json ──
  const loadStocks = useCallback(async (ghCfg, force = false) => {
    const g = ghCfg || gh;
    if (!g.token || !g.user || !g.repo) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (!force && localStorage.getItem('friday_stocks_loaded_date') === today && stocks.length > 0) {
      lg(`stocks.json: already loaded today (${stocks.length} stocks)`, 'o');
      return;
    }
    setStocksStatus('⏳ Loading stocks.json...');
    try {
      const r = await fetch(
        `https://api.github.com/repos/${g.user}/${g.repo}/contents/stocks/stocks.json`,
        { headers: { Authorization: 'token ' + g.token, Accept: 'application/vnd.github.v3+json' } }
      );
      if (r.status === 404) { setStocksStatus('⚠ stocks/stocks.json not found in repo'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d      = await r.json();
      const parsed = JSON.parse(atob(d.content.replace(/\n/g, '')));
      const rawList = parsed.data || parsed.stocks || (Array.isArray(parsed) ? parsed : null);
      if (!rawList?.length) throw new Error('Empty or invalid stocks.json');
      const list = rawList.map((item) => ({
        key:  item.key  || '',
        s:    item.s    || item.symbol || '',
        n:    item.n    || item.name   || item.s || '',
        sec:  item.sec  || item.sector || 'NSE',
        scan: true,
        fo:   !!(item.fo ?? item.hasOption ?? false),
        lot:  item.lot  || 0,
        step: item.step || 0,
      })).filter((s) => s.key && s.s);
      setStocks(list);
      localStorage.setItem('friday_stocks_loaded_date', today);
      const foCount = list.filter((s) => s.fo && s.lot > 0).length;
      const updDate = parsed.updated_at ? ' · ' + parsed.updated_at.split('T')[0] : '';
      setStocksStatus(`✅ ${list.length} stocks · ${foCount} F&O${updDate}`);
      lg(`stocks.json: ${list.length} stocks · ${foCount} F&O`, 'o');
    } catch (e) {
      setStocksStatus('⚠ Error: ' + e.message);
      lg('loadStocks: ' + e.message, 'w');
    }
  }, [gh, stocks.length, lg]); // eslint-disable-line

  // ── loadFIIDII — from GitHub fii-dii/latest.json ──
  const loadFIIDII = useCallback(async (ghCfg, force = false) => {
    const g = ghCfg || gh;
    if (!g.token || !g.user || !g.repo) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (!force && localStorage.getItem('friday_fiidii_date') === today && fiiData) return;
    try {
      const r = await fetch(
        `https://api.github.com/repos/${g.user}/${g.repo}/contents/fii-dii/latest.json`,
        { headers: { Authorization: 'token ' + g.token, Accept: 'application/vnd.github.v3+json' } }
      );
      if (r.status === 404) { lg('FII/DII: fii-dii/latest.json not found in repo', 'w'); return; }
      if (!r.ok) return;
      const d    = await r.json();
      const data = JSON.parse(atob(d.content.replace(/\n/g, '')));
      setFiiData(data);
      setFiiInterp(interpretFIIDII(data));
      localStorage.setItem('friday_fiidii_date', today);
      const age = data.fetched_at
        ? Math.round((Date.now() - new Date(data.fetched_at)) / 3600000)
        : '?';
      lg(`FII/DII loaded (${age}h old)`, 'o');
      if (age > 20) showToast(`⚠ FII/DII data is ${age}h old — update fii-dii/latest.json in GitHub`, '#d97706', 7000);
    } catch (e) { lg('loadFIIDII: ' + e.message, 'w'); }
  }, [gh, fiiData, lg, showToast]); // eslint-disable-line

  // ── loadConfCalibration + adaptWeights — self-calibrating from GitHub signal history ──
  // Two-layer calibration system:
  //   Layer 1 (confCalibration): bucket-level win-rate correction (existing)
  //   Layer 2 (adaptWeights): per-indicator win-rate adjustment — learns which
  //     indicators actually predict wins vs losses from YOUR signal history
  const loadConfCalibration = useCallback(async (ghCfg) => {
      const g = ghCfg || gh;
      if (!g?.token || !g?.user || !g?.repo) return;
      try {
        const signals = await ghReadMultipleDays(g, 60); // 60 days for better sample size
        if (!signals?.length) { setMlModels(null); localStorage.removeItem('friday_ml_models'); return; }
        const closed = signals.filter(s => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
        if (closed.length < 10) { setMlModels(null); localStorage.removeItem('friday_ml_models'); lg(`Calibration: need 10+ closed signals, have ${closed.length}`, 'w'); return; }
        // Browser-safe mode:
        // Use cached/remote AI model and avoid heavy on-page retraining that can freeze UI.
        let activeModels = null;
        const remoteModel = await pullAiModelFromGH(g).catch(() => null);
        if (remoteModel?.version) {
          activeModels = remoteModel;
          setMlModels(remoteModel);
          localStorage.setItem('friday_ml_models', JSON.stringify(remoteModel));
          lg('ML ranker loaded from GitHub', 'o');
        } else {
          const cachedModel = (() => {
            try { return JSON.parse(localStorage.getItem('friday_ml_models') || 'null'); } catch (_) { return null; }
          })();
          if (cachedModel?.version) {
            activeModels = cachedModel;
            setMlModels(cachedModel);
            lg('ML ranker loaded from local cache', 'o');
          } else if (closed.length <= 25) {
            // Only allow a tiny fallback training pass in-browser for small datasets.
            const trainedModels = trainSignalMlModels(closed.slice(-25));
            if (trainedModels) {
              activeModels = trainedModels;
              setMlModels(trainedModels);
              localStorage.setItem('friday_ml_models', JSON.stringify(trainedModels));
              const snap = buildModelSnapshot(trainedModels);
              if (snap) {
                setMlSnapshots((prev) => {
                  const next = [snap, ...prev].slice(0, 20);
                  localStorage.setItem('friday_ml_snapshots', JSON.stringify(next));
                  return next;
                });
              }
              lg('ML ranker trained locally on small sample fallback', 'o');
            }
          } else {
            lg('ML ranker skipped in browser to keep UI responsive. Use GitHub Action retrainer.', 'w');
          }
        }

      // ── Layer 1: Bucket calibration (existing logic) ──
      const bands = {};
      for (const s of closed) {
        const bucket = Math.floor((s.confidence || 50) / 10) * 10;
        if (!bands[bucket]) bands[bucket] = { hits:0, total:0 };
        bands[bucket].total++;
        if (s.status === 'TARGET_HIT') bands[bucket].hits++;
      }
      const calibration = {};
      for (const [band, data] of Object.entries(bands)) {
        if (data.total < 3) continue;
        const b = parseInt(band);
        const actualWR = data.hits / data.total;
        const expectedWR = b / 100;
        const rawAdj = Math.round((actualWR - expectedWR) * 100);
        calibration[b] = { adj: Math.max(-15, Math.min(15, rawAdj)), hits:data.hits, total:data.total, winRate:Math.round(actualWR*100) };
      }
      setConfCalibration(calibration);
      const summary = Object.entries(calibration).map(([b,d]) => `${b}%→${d.winRate}%WR(n=${d.total})`).join(' ');
      lg('Calibration loaded: ' + summary, 'o');

      // ── Layer 2: Per-indicator adaptWeights ──
      // Only compute when we have enough closed signals with indicator snapshots
      const withInds = closed.filter(s => s.indicators && typeof s.indicators === 'object');
      if (withInds.length < 15) {
        lg(`adaptWeights: need 15+ signals with indicator data, have ${withInds.length} (accumulating...)`, 'w');
        return;
      }

      // Baseline win rate across ALL closed signals
      const baselineWR = closed.filter(s => s.status === 'TARGET_HIT').length / closed.length;

      // Per-type analysis: stocks and options separately
      const stockClosed = withInds.filter(s => s.type === 'STOCK');
      const optClosed   = withInds.filter(s => s.type === 'OPTION');

      // ── Stock indicator analysis ──
      const STOCK_INDICATORS = [
        'macdBull','macdBullCross','macdBearCross','bbSqueeze','bbNearLower',
        'adxBull','adxBear','rsiDiv','rsiDivHidden','rsiBearDiv',
        'a50','a200','nearSupp','aboveVWAP','vwapNearLower',
        'engulfing','hammer','morningStar','reversalFired','delivHigh','delivLow',
      ];
      const OPT_INDICATORS = [
        'trendAligned','emaBull','emaBearish','freshCross','momentumFresh',
        'volSpike','lowVol','nearPDH','nearPDL','oiBuildUp',
        'compositeHigh','compositeMed','atm',
      ];

      const MIN_SAMPLES = 8; // minimum signals per indicator before trusting it
      const MAX_ADJ     = 12; // max pts adjustment in either direction

      function computeIndWeights(signals, indicators, baseWR) {
        if (!signals.length) return {};
        const weights = {};
        for (const ind of indicators) {
          const withInd    = signals.filter(s => s.indicators[ind] === true);
          const withoutInd = signals.filter(s => s.indicators[ind] === false);
          if (withInd.length < MIN_SAMPLES) continue; // not enough data yet

          const wrWith    = withInd.filter(s => s.status === 'TARGET_HIT').length / withInd.length;
          const wrWithout = withoutInd.length >= MIN_SAMPLES
            ? withoutInd.filter(s => s.status === 'TARGET_HIT').length / withoutInd.length
            : baseWR;

          // Lift = how much better/worse this indicator is vs baseline
          const liftVsBaseline = wrWith - baseWR;
          // Differential = how much better/worse with vs without
          const liftVsWithout  = wrWith - wrWithout;
          // Weighted average of both measures (baseline more stable, differential more specific)
          const rawLift = liftVsBaseline * 0.6 + liftVsWithout * 0.4;
          // Convert to confidence pts: 10% lift → ~8 pts (diminishing returns)
          const adjPts  = Math.sign(rawLift) * Math.min(MAX_ADJ, Math.abs(rawLift) * 80);

          weights[ind] = {
            adj:     +adjPts.toFixed(1),
            wrWith:  Math.round(wrWith * 100),
            wrBase:  Math.round(baseWR * 100),
            n:       withInd.length,
            lift:    +(liftVsBaseline * 100).toFixed(1),
          };
        }
        return weights;
      }

      const stockWR  = stockClosed.length
        ? stockClosed.filter(s => s.status === 'TARGET_HIT').length / stockClosed.length
        : baselineWR;
      const optWR    = optClosed.length
        ? optClosed.filter(s => s.status === 'TARGET_HIT').length / optClosed.length
        : baselineWR;

      const stockWeights = computeIndWeights(stockClosed, STOCK_INDICATORS, stockWR);
      const optWeights   = computeIndWeights(optClosed,   OPT_INDICATORS,   optWR);

      const adaptW = {
        stock:        stockWeights,
        option:       optWeights,
        baselineWR:   +baselineWR.toFixed(3),
        stockBaseWR:  +stockWR.toFixed(3),
        optBaseWR:    +optWR.toFixed(3),
        totalSignals: closed.length,
        withIndData:  withInds.length,
        computedAt:   new Date().toISOString(),
      };
      setAdaptWeights(adaptW);

      const topStock = Object.entries(stockWeights)
        .sort((a,b) => Math.abs(b[1].adj) - Math.abs(a[1].adj))
        .slice(0,3)
        .map(([k,v]) => `${k}:${v.adj>0?'+':''}${v.adj}pts(WR${v.wrWith}%,n=${v.n})`)
        .join(' ');
      const topOpt = Object.entries(optWeights)
        .sort((a,b) => Math.abs(b[1].adj) - Math.abs(a[1].adj))
        .slice(0,3)
        .map(([k,v]) => `${k}:${v.adj>0?'+':''}${v.adj}pts(WR${v.wrWith}%,n=${v.n})`)
        .join(' ');
      lg(`adaptWeights(${withInds.length} signals) STOCK: ${topStock || 'accumulating'} OPT: ${topOpt || 'accumulating'}`, 'o');

    } catch(e) { lg('loadConfCalibration: ' + e.message, 'w'); }
  }, [gh, lg]);

  // ── Global Signal Monitor — runs every 60s regardless of active page ──
  // Checks ALL open signals against live prices and resolves TARGET_HIT / SL_HIT
  const runSignalMonitor = useCallback(async (ghCfg) => {
    const g = ghCfg || gh;
    if (!g?.token || !g?.user || !g?.repo) return;
    const accessToken = resolveAccessToken(token);
    if (!accessToken) return;
    try {
      // Read index — only dates that index reports as having open > 0
      const { dates, dailyStats } = await ghReadIndex(g);
      const datesWithOpen = dates.filter(d => (dailyStats[d]?.open || 0) > 0);
      if (!datesWithOpen.length) { setOpenSignalCount(0); return; }

      // Read day files in parallel
      const reads = await Promise.allSettled(datesWithOpen.map(d => ghReadDay(g, d)));
      const dayMap = {};
      reads.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value?.signals?.length)
          dayMap[datesWithOpen[i]] = { signals: res.value.signals, sha: res.value.sha };
      });

      // Seed resolvedSigIds from already-resolved signals on first pass
      // so we never accidentally re-process them even if index is stale
      for (const { signals } of Object.values(dayMap)) {
        for (const s of signals) {
          if (s.status !== 'OPEN') {
            const id = s.id || s.instrKey + '_' + s.date + '_' + s.time;
            resolvedSigIds.current.add(id);
          }
        }
      }

      // Collect ONLY open signals that haven't been resolved yet
      const pendingSigs = [];
      for (const [date, { signals }] of Object.entries(dayMap)) {
        for (const s of signals) {
          if (s.status !== 'OPEN') continue;
          const id = s.id || (s.instrKey || s.key) + '_' + s.date + '_' + s.time;
          if (resolvedSigIds.current.has(id)) continue; // already resolved this session
          pendingSigs.push({ ...s, _date: date, _id: id });
        }
      }

      setOpenSignalCount(pendingSigs.length);
      if (!pendingSigs.length) {
        lg('Signal monitor: no pending open signals to check', 'o');
        return;
      }

      lg(`Signal monitor: checking ${pendingSigs.length} open signal(s)…`, 'o');

      // Fetch live prices only for pending signals
      const keys = [...new Set(pendingSigs.map(s => s.instrKey || s.key).filter(Boolean))];
      const quotes = {};
      const BATCH = 50;
      await Promise.allSettled(
        Array.from({ length: Math.ceil(keys.length / BATCH) }, (_, i) =>
          fetchQ(keys.slice(i * BATCH, (i + 1) * BATCH).join(','), accessToken)
            .then(raw => Object.assign(quotes, raw))
            .catch(() => {})
        )
      );
      if (!Object.keys(quotes).length) return;

      const now = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      let totalResolved = 0;

      // Group pending sigs by date for efficient file writes
      const pendingByDate = {};
      for (const s of pendingSigs) {
        if (!pendingByDate[s._date]) pendingByDate[s._date] = [];
        pendingByDate[s._date].push(s);
      }

      for (const [date, pending] of Object.entries(pendingByDate)) {
        const { signals: daySigs, sha } = dayMap[date];
        let changed = false;

        const updated = daySigs.map(s => {
          // Already closed — skip entirely, no lookup needed
          if (s.status !== 'OPEN') return s;

          const instrK = s.instrKey || s.key;
          const sigId  = s.id || instrK + '_' + s.date + '_' + s.time;

          // Already resolved this session — leave as-is in file (will be written on next full check)
          if (resolvedSigIds.current.has(sigId)) return s;

          const q = quotes[instrK];
          if (!q?.last_price) return s;
          const ltp = q.last_price;

          if (s.target > 0 && ltp >= s.target) {
            const pnlPct = s.entry > 0 ? +((ltp - s.entry) / s.entry * 100).toFixed(2) : null;
            lg(`🎯 TARGET HIT: ${s.stock || s.sym} @ ₹${ltp} (tgt ₹${s.target})`, 'o');
            showToast(`🎯 ${s.stock || s.sym} target hit! ${pnlPct !== null ? '+' + pnlPct + '%' : ''}`, '#16a34a', 8000);
            resolvedSigIds.current.add(sigId); // mark so we never re-check this signal
            changed = true; totalResolved++;
            return { ...s, status: 'TARGET_HIT', exitPrice: ltp, exitTime: now, pnlPct };
          }

          if (s.sl > 0 && ltp <= s.sl) {
            const pnlPct = s.entry > 0 ? +((ltp - s.entry) / s.entry * 100).toFixed(2) : null;
            lg(`❌ SL HIT: ${s.stock || s.sym} @ ₹${ltp} (SL ₹${s.sl})`, 'w');
            showToast(`❌ ${s.stock || s.sym} SL hit ${pnlPct !== null ? pnlPct + '%' : ''}`, '#dc2626', 8000);
            resolvedSigIds.current.add(sigId); // mark so we never re-check this signal
            changed = true; totalResolved++;
            return { ...s, status: 'SL_HIT', exitPrice: ltp, exitTime: now, pnlPct };
          }

          return s; // still open, will be re-checked next cycle
        });

        if (changed) await ghWriteDay(g, updated, sha, date).catch(() => {});
      }

      const remaining = pendingSigs.length - totalResolved;
      if (totalResolved > 0) {
        lg(`Signal monitor: ✅ ${totalResolved} resolved · ${remaining} still tracking`, 'o');
        loadConfCalibration(g);
      } else {
        lg(`Signal monitor: ${remaining} signal(s) still open, none resolved this cycle`, 'o');
      }
      setOpenSignalCount(remaining);

    } catch (e) {
      lg('Signal monitor error: ' + e.message, 'w');
    }
  }, [gh, token, lg, showToast]); // eslint-disable-line

  // ── pullGHSettings — pull settings from GitHub (same as HTML: on boot after profile fetch) ──
  const pullGHSettings = useCallback(async (ghCfg) => {
    const g = ghCfg || gh;
    if (!g.token || !g.user || !g.repo) {
      lg('Settings pull skipped — GitHub not configured yet', 'w');
      return false;
    }
    try {
      const pulled = await pullSettingsFromGH(g);
      if (pulled) {
        // Merge remote settings into cfg (preserve local token — same as HTML)
        const merged = { ...DEF, ...pulled, _v: CFG_VERSION };
        localStorage.setItem('friday_cfg', JSON.stringify(merged));
        setCfgState(merged);
        setGhSettingsPulled((n) => n + 1); // trigger SettingsPane to re-sync local state
        lg('✅ Settings pulled from GitHub', 'o');
        return true;
      }
    } catch (e) { lg('pullGHSettings: ' + e.message, 'w'); }
    return false;
  }, [gh, lg]);

  // ── Boot when token present ──
  useEffect(() => {
    if (token && token.length > 20) setBooted(true);
  }, [token]);

  // ── On boot: fetch user profile → then pull GH settings (2s delay, same as HTML) ──
  useEffect(() => {
    if (!booted || !token) return;
    refreshMarketStatus();

    // 1. Fetch user profile
    fetchUserProfile(token, onTokenExpired).then((user) => {
      if (!user) return;
      const name = user.user_name || user.name || user.email?.split('@')[0] || 'Trader';
      const id   = user.user_id   || user.client_id || '';
      setUserName(name); setUserId(id);
      localStorage.setItem('friday_user_name', name);
      localStorage.setItem('friday_user_id',   id);
      lg('✅ User: ' + name + (id ? ' (' + id + ')' : ''), 'o');

      // 2. Pull GH settings 2s after profile (same timing as HTML)
      setTimeout(async () => {
        const currentGH = {
          token: localStorage.getItem('friday_gh_token') || '',
          user:  localStorage.getItem('friday_gh_user')  || '',
          repo:  localStorage.getItem('friday_gh_repo')  || '',
        };
        if (currentGH.token && currentGH.user && currentGH.repo) {
          const pulled = await pullGHSettings(currentGH);
          if (pulled) showToast('✅ Settings loaded from GitHub', '#16a34a', 4000);
          const remoteModel = await pullAiModelFromGH(currentGH);
          if (remoteModel?.version) {
            setMlModels(remoteModel);
            localStorage.setItem('friday_ml_models', JSON.stringify(remoteModel));
            lg('✅ AI model pulled from GitHub', 'o');
          }
        }
        // 3. Load light data immediately; defer heavy AI calibration until idle
        if (currentGH.token) {
          loadStocks(currentGH);
          loadFIIDII(currentGH);
          ghMigrateIfNeeded(currentGH, lg);
          scheduleMlRefresh(currentGH, mlModels ? 20000 : 12000);
        }
      }, 2000);
    }).catch((e) => {
      lg('User profile: ' + e.message, 'w');
      // Restore from cache
      const cached = localStorage.getItem('friday_user_name');
      if (cached) { setUserName(cached); setUserId(localStorage.getItem('friday_user_id') || ''); }
      // Still load stocks/FII even if profile fails
      setTimeout(() => {
        const g = { token: localStorage.getItem('friday_gh_token') || '', user: localStorage.getItem('friday_gh_user') || '', repo: localStorage.getItem('friday_gh_repo') || '' };
        if (g.token) {
          loadStocks(g); loadFIIDII(g); ghMigrateIfNeeded(g, lg);
          scheduleMlRefresh(g, mlModels ? 20000 : 12000);
          // Start global signal monitor after 10s (give market feed time to settle)
          setTimeout(() => runSignalMonitor(g), 10000);
        }
      }, 2000);
    });
  }, [booted]); // eslint-disable-line

  // ── When GitHub config changes (after Test Connection / Save), reload stocks+FII ──
  useEffect(() => {
    if (!booted || !gh.token || !gh.user || !gh.repo) return;
    loadStocks(gh, true);
    loadFIIDII(gh, true);
  }, [gh.token, gh.user, gh.repo]); // eslint-disable-line

  useEffect(() => () => {
    if (mlRefreshTimerRef.current) clearTimeout(mlRefreshTimerRef.current);
  }, []);

  // ── Market status poll every 60s ──
  useEffect(() => {
    if (!booted) return;
    const id = setInterval(refreshMarketStatus, 60000);
    return () => clearInterval(id);
  }, [booted, refreshMarketStatus]);

  // ── Global signal monitor — runs every 60s during market hours ──
  // Resolves open signals to TARGET_HIT/SL_HIT regardless of which page is active
  useEffect(() => {
    if (!booted || !gh.token || !gh.user || !gh.repo) return;
    // Clear any existing interval
    if (signalMonitorRef.current) clearInterval(signalMonitorRef.current);
    // Run immediately on boot (after short delay for WS to settle)
    const bootTimer = setTimeout(() => runSignalMonitor(gh), 8000);
    // Then every 60s during market hours, every 5min outside
    const interval = marketStatus.open ? 60000 : 300000;
    signalMonitorRef.current = setInterval(() => runSignalMonitor(gh), interval);
    return () => {
      clearTimeout(bootTimer);
      clearInterval(signalMonitorRef.current);
    };
  }, [booted, gh.token, gh.user, gh.repo, marketStatus.open]); // eslint-disable-line

  const value = {
    // auth
    token, booted, tokenExpired,
    saveToken, clearToken, onTokenExpired,
    // config
    cfg, saveCfg, resetCfg,
    ghSettingsPulled,      // SettingsPane watches this to re-sync local state
    // github
    gh, saveGh,
    pullGHSettings,
    // market
    marketStatus,
    // ui
    activeTab, setActiveTab,
    scanning,  setScanning,
    statusDot, setStatusDot,
    statusTxt, setStatusTxt,
    badges,    updateBadge,
    logOpen,   setLogOpen,
    logLines,  setLogLines,
    toast,
    // data
    stocks,   setStocks,   stocksStatus, loadStocks,
    fiiData,  fiiInterp,   loadFIIDII,
      userName, userId, adaptWeights, mlModels, mlSnapshots,
    tickerStats, setTickerStats,
    confCalibration, setConfCalibration, loadConfCalibration,
    openSignalCount, runSignalMonitor,
    // helpers
    lg, showToast, refreshMarketStatus,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}



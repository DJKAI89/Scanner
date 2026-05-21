import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { DEF, CFG_VERSION } from '../constants/config';
import { localIsOpen, getMarketStatusLocal, getIST } from '../utils/marketTime';
import { fetchMarketStatus, fetchUserProfile, normalizeAccessToken } from '../services/api';
import { interpretFIIDII } from '../services/technical';
import { pullSettingsFromGH, pushSettingsToGH } from '../services/github';

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
  const [activeTab, setActiveTab] = useState('stocks');
  const [scanning, setScanning]   = useState(false);
  const [statusDot, setStatusDot] = useState('live');
  const [statusTxt, setStatusTxt] = useState('Live');
  const [badges, setBadges]       = useState({ stocks: '—', options: '—', log: '—', analysis: '—' });
  const [logOpen, setLogOpen]     = useState(false);
  const [logLines, setLogLines]   = useState([]);
  const [toast, setToast]         = useState(null);

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
        }
        // 3. Load stocks + FII/DII
        if (currentGH.token) {
          loadStocks(currentGH);
          loadFIIDII(currentGH);
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
        if (g.token) { loadStocks(g); loadFIIDII(g); }
      }, 2000);
    });
  }, [booted]); // eslint-disable-line

  // ── When GitHub config changes (after Test Connection / Save), reload stocks+FII ──
  useEffect(() => {
    if (!booted || !gh.token || !gh.user || !gh.repo) return;
    loadStocks(gh, true);
    loadFIIDII(gh, true);
  }, [gh.token, gh.user, gh.repo]); // eslint-disable-line

  // ── Market status poll every 60s ──
  useEffect(() => {
    if (!booted) return;
    const id = setInterval(refreshMarketStatus, 60000);
    return () => clearInterval(id);
  }, [booted, refreshMarketStatus]);

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
    userName, userId,
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

// Scheduled server-side scan. Runs the same scanners the app runs (stocks, breakouts, F&O options)
// during market hours, so signals and shadow (rejected-but-tracked) picks keep being logged even
// when nobody has the app open. The scanners log signals themselves; this script only prepares
// their inputs the way the app does (settings, stocks list, ML models, calibration, VIX history).
//
// Bundled before running (see .github/workflows/server-scan.yml):
//   npx esbuild scripts/server-scan.mjs --bundle --platform=node --format=esm \
//     --outfile=.server-scan.mjs --define:import.meta.env='{}'
//
// Env: GH_TOKEN GH_USER GH_REPO UPSTOX_ACCESS_TOKEN  (+ optional SCAN_USER_ID, SCAN_FORCE=1,
//      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)

// ── browser shims (set BEFORE the app modules are evaluated) ──
const _store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => { _store.set(k, String(v)); },
  removeItem: (k) => { _store.delete(k); },
};
globalThis.document = globalThis.document || { hidden: false, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };

const { GH_TOKEN, GH_USER, GH_REPO, UPSTOX_ACCESS_TOKEN, SCAN_USER_ID, SCAN_FORCE } = process.env;
if (!GH_TOKEN || !GH_USER || !GH_REPO || !UPSTOX_ACCESS_TOKEN) {
  console.error('Missing env: need GH_TOKEN, GH_USER, GH_REPO, UPSTOX_ACCESS_TOKEN');
  process.exit(1);
}
const gh = { token: GH_TOKEN, user: GH_USER, repo: GH_REPO };
const GH_HEADERS = { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const UP_HEADERS = { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`, Accept: 'application/json' };

const lg = (m, t) => console.log(`${t === 'e' ? '❌' : t === 'w' ? '⚠️' : '·'} ${m}`);
const onTokenExpired = () => { throw new Error('Upstox token expired — refresh the UPSTOX_ACCESS_TOKEN secret'); };

async function ghGet(path) {
  const r = await fetch(`https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${path}`, { headers: GH_HEADERS });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`);
  return r.json();
}

async function listUserIds() {
  if (SCAN_USER_ID) return [SCAN_USER_ID];
  const folder = await ghGet('signal-logs');
  return Array.isArray(folder) ? folder.filter((i) => i.type === 'dir' && i.name).map((i) => i.name) : [];
}

async function indexQuote(key) {
  const r = await fetch(`https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(key)}`, { headers: UP_HEADERS });
  if (!r.ok) return null;
  const d = await r.json();
  const q = Object.values(d?.data || {})[0];
  if (!q?.last_price) return null;
  const prev = q.last_price - (q.net_change || 0);
  return { ltp: q.last_price, chgPct: prev > 0 ? ((q.net_change || 0) / prev) * 100 : 0 };
}

async function loadStocks() {
  const d = await ghGet('stocks/stocks.json');
  if (!d) throw new Error('stocks/stocks.json not found in repo');
  const parsed = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
  const raw = parsed.data || parsed.stocks || (Array.isArray(parsed) ? parsed : null);
  if (!raw?.length) throw new Error('Empty or invalid stocks.json');
  return raw.map((item) => ({
    key: item.key || '', s: item.s || item.symbol || '', n: item.n || item.name || item.s || '',
    sec: item.sec || item.sector || 'NSE', scan: true,
    fo: !!(item.fo ?? item.isFO ?? item.hasOption ?? false), lot: item.lot || item.lotSize || 0, step: item.step || 0,
  })).filter((s) => s.key && s.s && !s.s.toUpperCase().startsWith('DUMMY'));
}

async function sendTelegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.warn('telegram failed (ignored): ' + e.message); }
}

async function main() {
  const [{ DEF }, gh_, stockScan, optionScan, tech, api, learned, marketTime, mlRanking] = await Promise.all([
    import('../src/constants/config.js'),
    import('../src/services/github.js'),
    import('../src/services/stockScan.js'),
    import('../src/services/optionScan.js'),
    import('../src/services/technical.js'),
    import('../src/services/api.js'),
    import('../src/services/learnedAdjust.js'),
    import('../src/utils/marketTime.js'),
    import('../src/services/mlRanking.js'),
  ]);

  const marketStatus = marketTime.getMarketStatusLocal();
  if (!marketStatus.open && SCAN_FORCE !== '1') {
    console.log(`Market closed (${marketStatus.msg || 'closed'}) — nothing to scan.`);
    return;
  }

  const uids = await listUserIds();
  if (!uids.length) { console.log('No users found under signal-logs/.'); return; }

  for (const uid of uids) {
    console.log(`\n=== Server scan for ${uid} ===`);
    localStorage.setItem('scanner_user_id', uid);

    const saved = await gh_.pullSettingsFromGH(gh);
    const cfg = { ...DEF, ...(saved || {}) };
    const stocks = await loadStocks();

    // Same window as the app (Settings -> AI and ML -> calibration learns from).
    mlRanking.setLivePickSegments(!!cfg.optionSegmentModels);
    const calDays = +cfg.calibrationDays;
    const all = await gh_.ghReadMultipleDays(gh, calDays > 0 ? calDays : 3650).catch(() => []);
    const closed = (all || []).filter((s) => s.status && s.status !== 'OPEN' && s.status !== 'EXPIRED');
    const confCalibration = learned.computeConfCalibration(closed);
    const adaptWeights = learned.computeAdaptWeights(closed);
    const mlModels = await gh_.pullAiModelFromGH(gh).catch(() => null);
    const vixHist = await gh_.pullVixHistoryFromGH(gh).catch(() => null);
    const vixHistorySeries = Array.isArray(vixHist?.closes) ? vixHist.closes.map((c) => c.close) : [];

    let fiiData = null, fiiInterp = null;
    try { fiiData = await api.fetchFIIDIIData(UPSTOX_ACCESS_TOKEN, onTokenExpired); fiiInterp = fiiData ? tech.interpretFIIDII(fiiData) : null; } catch (_) { /* optional input */ }

    const nifty = await indexQuote('NSE_INDEX|Nifty 50');
    const vix = await indexQuote('NSE_INDEX|India VIX');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const before = new Set(((await gh_.ghReadDay(gh, today).catch(() => null))?.signals || []).map((s) => s.id));

    const base = { token: UPSTOX_ACCESS_TOKEN, accessToken: UPSTOX_ACCESS_TOKEN, stocks, cfg, gh, onTokenExpired, lg,
      marketStatus, confCalibration, adaptWeights, mlModels, fiiInterp, fiiData, vixHistorySeries,
      niftyLTP: nifty?.ltp || 0, niftyChgPct: nifty?.chgPct || 0, vixLTP: vix?.ltp || 0 };

    let scanStats = null;
    try {
      const r = await stockScan.runPicksScan(base, { setPickProgress() {}, setPicks() {} });
      scanStats = r?.scanStats || null;
      console.log(`Picks scan done: ${r?.picks?.length ?? 0} picks`);
    } catch (e) { lg('Picks scan failed: ' + e.message, 'e'); }
    try {
      await stockScan.runBreakoutScan({ ...base, scanStats: scanStats || { current: {} } }, { setBoProgress() {}, setBoCards() {} });
      console.log('Breakout scan done');
    } catch (e) { lg('Breakout scan failed: ' + e.message, 'e'); }
    try {
      await optionScan.runOptionsScan(base, { prevAvgIVCache: { current: {} }, prevPCRCache: { current: {} } },
        { setProgress() {}, setMarketCtxMap() {}, setVix() {} });
      console.log('Options scan done');
    } catch (e) { lg('Options scan failed: ' + e.message, 'e'); }

    // Alert on NEW high-confidence signals only.
    try {
      const after = (await gh_.ghReadDay(gh, today))?.signals || [];
      const minConf = +(cfg.alertMinConf ?? 75);
      const fresh = after.filter((s) => !before.has(s.id) && s.status === 'OPEN' && (s.confidence || 0) >= minConf)
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 5);
      for (const s of fresh) {
        const name = s.type === 'OPTION' ? `${s.stock} ${s.strike} ${s.optType}` : s.stock;
        await sendTelegram(`📈 New signal: ${name}  ${s.confidence}% confidence\nEntry ${s.entry} · Stop ${s.sl} · Target ${s.target}`);
      }
      console.log(`New signals: ${after.filter((s) => !before.has(s.id)).length} (alerted ${fresh.length})`);
    } catch (e) { lg('Alert step failed: ' + e.message, 'w'); }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('Server scan failed:', e); process.exit(1); });

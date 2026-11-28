import fs from 'node:fs/promises';

const GH_TOKEN = process.env.AI_GH_TOKEN || process.env.GH_TOKEN || '';
const GH_USER = process.env.GH_USER || '';
const GH_REPO = process.env.GH_REPO || '';
const SCANNER_USER_ID = (process.env.SCANNER_USER_ID || '').replace(/[^a-zA-Z0-9_-]/g, '_');
// AI_LOOKBACK_DAYS: a number of days, or 0 / "all" to train on EVERY logged signal.
// All-data is the default: the log only grows, and a hard 90-day cut-off throws away
// exactly the history the model needs. Walk-forward still tests on the newest slice,
// so if old data stops helping, the walk-forward / drift numbers will show it.
const _lb = String(process.env.AI_LOOKBACK_DAYS ?? 'all').trim().toLowerCase();
const LOOKBACK_DAYS = (_lb === '' || _lb === 'all' || _lb === '0' || !Number.isFinite(Number(_lb))) ? 100000 : Math.max(1, Number(_lb));

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION VALIDATION
// ═══════════════════════════════════════════════════════════════════
const config = {
  GH_TOKEN,
  GH_USER,
  GH_REPO,
  SCANNER_USER_ID,
  LOOKBACK_DAYS,
};

const missingConfig = [];
if (!GH_TOKEN) missingConfig.push('AI_GH_TOKEN (required: GitHub personal access token with repo:contents:read/write)');
if (!GH_USER) missingConfig.push('GH_USER (required: GitHub username)');
if (!GH_REPO) missingConfig.push('GH_REPO (required: Repository name)');

if (missingConfig.length > 0) {
  console.error('❌ CONFIGURATION ERROR');
  console.error('Missing required environment variables:');
  missingConfig.forEach(msg => console.error(`  - ${msg}`));
  console.error('\nSet these variables before running:');
  console.error('  export AI_GH_TOKEN="ghp_..."');
  console.error('  export GH_USER="your-username"');
  console.error('  export GH_REPO="your-repo"');
  console.error('  export SCANNER_USER_ID="user-id" (optional, processes all if not set)');
  process.exit(1);
}

console.log('✅ Configuration OK');
console.log(`  Repository: ${GH_USER}/${GH_REPO}`);
console.log(`  Token length: ${GH_TOKEN.length} chars`);
console.log(`  Lookback: ${LOOKBACK_DAYS >= 100000 ? 'all available data' : LOOKBACK_DAYS + ' days'}`);
if (SCANNER_USER_ID) console.log(`  Target user: ${SCANNER_USER_ID}`);
console.log('');

async function loadBrainModule() {
  const source = await fs.readFile(new URL('../src/services/mlRanking.js', import.meta.url), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(url);
}

async function ghFetch(path, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const r = await fetch(`https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${path}`, {
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        timeout: 10000, // 10 second timeout
      });
      
      if (r.status === 404) return null;
      if (r.status === 401) throw new Error(`GitHub 401 for ${path} — token invalid/expired/revoked. Check secrets.AI_GH_TOKEN.`);
      if (r.status === 403) throw new Error(`GitHub 403 for ${path} — token lacks repo access (fine-grained PAT needs Contents permission) or rate-limited.`);
      if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`);
      
      return r.json();
    } catch (e) {
      const isRetryable = e.message.includes('fetch failed') || e.message.includes('timeout') || e.message.includes('ECONNREFUSED') || e.message.includes('ENOTFOUND');
      
      if (isRetryable && attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000; // exponential backoff: 1s, 2s, 4s
        console.warn(`[ghFetch] Attempt ${attempt + 1}/${retries} failed for ${path}: ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw new Error(`ghFetch failed after ${retries} attempts for ${path}: ${e.message}`);
    }
  }
}

// Create empty .gitkeep file in directory to ensure it exists
async function ensureDirectoryExists(dirPath) {
  const gitkeepPath = `${dirPath}/.gitkeep`;
  const existing = await ghFetch(gitkeepPath);
  
  if (existing) {
    // Directory already exists
    return;
  }
  
  // Create .gitkeep to create the directory
  const body = {
    message: `Create ${dirPath} directory`,
    content: Buffer.from('', 'utf8').toString('base64'),
  };
  
  const r = await fetch(`https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${gitkeepPath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeout: 10000,
  });
  
  if (!r.ok && r.status !== 409) {
    // 409 means file already exists, which is fine
    console.warn(`[ensureDirectoryExists] Warning: Could not ensure ${dirPath} exists (status ${r.status}). Continuing anyway...`);
  } else {
    console.log(`[ensureDirectoryExists] Ensured directory exists: ${dirPath}`);
  }
}

async function ghPut(path, payload, sha, message, retries = 3) {
  // Ensure parent directory exists first
  const dirPath = path.split('/').slice(0, -1).join('/');
  if (dirPath) {
    await ensureDirectoryExists(dirPath);
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const body = {
        message,
        content: Buffer.from(JSON.stringify(payload, null, 2), 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      };
      
      const r = await fetch(`https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeout: 10000,
      });
      
      if (r.status === 403) {
        const responseText = await r.text().catch(() => '');
        console.error(`[ghPut] 403 Forbidden for ${path}. Response: ${responseText}`);
        throw new Error(`GitHub 403 for ${path} — Check token permissions. Ensure fine-grained PAT has 'Contents' read/write permission for this repo.`);
      }

      if (r.status === 409 && attempt < retries - 1) {
        // Stale SHA — another run wrote this file in between our read and
        // write (e.g. overlapping cron + manual dispatch). Refetch the
        // current SHA and retry, instead of throwing and leaving history
        // out of sync with a model that already trained successfully.
        console.warn(`[ghPut] 409 conflict for ${path} — refetching SHA and retrying (attempt ${attempt + 1}/${retries})`);
        const fresh = await ghFetch(path).catch(() => null);
        sha = fresh?.sha || sha;
        continue;
      }

      if (!r.ok) throw new Error(`GitHub PUT ${r.status} for ${path}`);
      return r.json();
    } catch (e) {
      const isRetryable = e.message.includes('fetch failed') || e.message.includes('timeout') || e.message.includes('ECONNREFUSED');
      
      if (isRetryable && attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[ghPut] Attempt ${attempt + 1}/${retries} failed for ${path}: ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      throw new Error(`ghPut failed after ${retries} attempts for ${path}: ${e.message}`);
    }
  }
}

function decodeContent(content) {
  const cleaned = (content || '').replace(/\s/g, '');
  if (!cleaned) return null;
  let text;
  try {
    text = Buffer.from(cleaned, 'base64').toString('utf8');
  } catch (e) {
    throw new Error(`decodeContent: invalid base64 (${e.message})`);
  }
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`decodeContent: invalid JSON — ${e.message}. Raw (first 200 chars): ${text.slice(0, 200)}`);
  }
}

// Every logged signal for one user: the real log, plus the shadow log (picks the gate rejected and
// the monitor later followed to an outcome). Shadow rows teach the model what the filters threw
// away; without them it only ever sees signals that already passed (selection bias). They carry
// `shadow: true`, which mlRanking counts at half weight, and a real signal always wins over a
// shadow copy of the same idea.
//   AI_INCLUDE_SHADOW=0   never include shadow rows
//   (anything else)       include every resolved shadow row (default)
async function readUserSignals(userId) {
  const indexFile = await ghFetch(`signal-logs/${userId}/index.json`);
  if (!indexFile) return { real: [], shadow: [] };
  const index = decodeContent(indexFile.content);
  if (!index) {
    console.log(`⏭️ Skip ${userId}: index.json is empty/unreadable`);
    return { real: [], shadow: [] };
  }
  const dates = (index.dates || []).slice(-LOOKBACK_DAYS);
  const real = [];
  for (const date of dates) {
    const day = await ghFetch(`signal-logs/${userId}/${date}.json`);
    if (!day) continue;
    const payload = decodeContent(day.content);
    if (!payload) continue;
    real.push(...(payload.signals || []));
  }
  const shadow = [];
  if ((process.env.AI_INCLUDE_SHADOW ?? '1') !== '0') {
    const folder = await ghFetch(`signal-logs/${userId}/shadow`);
    if (Array.isArray(folder)) {
      const names = folder.map((i) => i.name).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(-LOOKBACK_DAYS);
      for (const n of names) {
        const f = await ghFetch(`signal-logs/${userId}/shadow/${n}`);
        const p = f && decodeContent(f.content);
        shadow.push(...(p?.signals || []).filter((x) => x.status === 'TARGET_HIT' || x.status === 'SL_HIT').map((x) => ({ ...x, shadow: true })));
      }
    }
  }
  return { real, shadow };
}

async function listUserIds() {
  if (SCANNER_USER_ID) return [SCANNER_USER_ID];
  const folder = await ghFetch('signal-logs');
  if (!Array.isArray(folder)) return [];
  return folder
    .filter((item) => item?.type === 'dir' && item?.name)
    .map((item) => item.name);
}

async function main() {
  const SCRIPT_TIMEOUT_MS = 25 * 60 * 1000; // 25 minute overall timeout
  const startTime = Date.now();
  
  console.log('📋 Starting AI model retraining...');
  
  let brain;
  try {
    brain = await loadBrainModule();
    // Assumptions that decide what counts as a win: override with your real numbers (repo variables).
    const envNum = (k) => (process.env[k] ? Number(process.env[k]) : undefined);
    const cost = brain.setCostModel({
      stockPct: envNum('AI_STOCK_COST_PCT'), optionFlatPct: envNum('AI_OPTION_FLAT_COST_PCT'),
      orderFeeRs: envNum('AI_OPTION_ORDER_FEE_RS'), statPct: envNum('AI_OPTION_STAT_PCT'),
    });
    brain.setIdeaKeyMode({ byStrike: process.env.AI_DEDUPE_BY_STRIKE === '1' });
    console.log(`  Cost model: stock ${cost.STOCK}% · option flat ${cost.OPTION}% · ₹${cost.orderFeeRs}/order + ${cost.statPct}% statutory · de-dupe by strike: ${process.env.AI_DEDUPE_BY_STRIKE === '1'}`);
    console.log('✅ ML brain module loaded');
  } catch (e) {
    console.error('❌ Failed to load ML module:', e.message);
    process.exit(1);
  }

  let userIds;
  try {
    userIds = await listUserIds();
    console.log(`📊 Found ${userIds.length} users with signal history`);
  } catch (e) {
    console.error('❌ Failed to list user IDs:', e.message);
    process.exit(1);
  }

  if (!userIds.length) {
    console.log('⚠️ No user folders found in signal-logs. Nothing to train.');
    return;
  }

  let trained = 0;
  let failed = 0;
  let skipped = 0;

  for (const userId of userIds) {
    // Check overall timeout
    if (Date.now() - startTime > SCRIPT_TIMEOUT_MS) {
      console.warn(`⏱️ TIMEOUT: Script exceeded ${SCRIPT_TIMEOUT_MS / 1000 / 60} minute limit. Exiting gracefully.`);
      break;
    }

    globalThis.SCANNER_USER_ID = userId;
    const userStartTime = Date.now();

    try {
      const { real, shadow } = await readUserSignals(userId);
      const signals = [...real, ...shadow];
      console.log(`  Loaded ${real.length} real + ${shadow.length} resolved shadow signals`);

      const closed = signals.filter((s) => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
      if (closed.length < 10) {
        console.log(`⏭️ Skip ${userId}: only ${closed.length} closed signals (need ≥10)`);
        skipped++;
        continue;
      }

      // Data-quality check — surfaces the kind of silent skew that has
      // corrupted training before (EXPIRED signals miscounted as wins,
      // missing greeks on option signals) instead of baking it in unnoticed.
      {
        const expiredCount = signals.filter((s) => s.status === 'EXPIRED').length;
        const optClosed = closed.filter((s) => s.type === 'OPTION');
        const optMissingGreeks = optClosed.filter((s) => s.delta == null && s.iv == null).length;
        const winRate = (closed.filter((s) => s.status === 'TARGET_HIT').length / closed.length * 100).toFixed(0);
        console.log(`  Data quality: ${closed.length} closed (${winRate}% win rate), ${expiredCount} expired (excluded), ${optClosed.length} option signals (${optMissingGreeks} missing greeks)`);
        if (optClosed.length > 5 && optMissingGreeks / optClosed.length > 0.5) {
          console.log(`  ⚠️ Over half of option signals are missing delta/iv — option model quality will be degraded until logging captures greeks.`);
        }
        if (winRate == 0 || winRate == 100) {
          console.log(`  ⚠️ Win rate is ${winRate}% — suspiciously uniform, check signal resolution logic before trusting this model.`);
        }
      }

      console.log(`  Idea de-dupe: ${JSON.stringify(brain.describeDedupe(signals))}`);
      const models = brain.trainSignalMlModels(closed);
      if (!models) {
        console.log(`⚠️ Skip ${userId}: training returned null (insufficient/unbalanced data)`);
        skipped++;
        continue;
      }

      // Validate trained model
      if (models.stock) {
        console.log(`  Stock model: in-sample accuracy=${(models.stock.accuracy || 0).toFixed(3)}, out-of-fold accuracy=${models.stock.walkForward?.accuracy ?? 'n/a'}, out-of-fold edge=${models.stock.oof?.edge ?? 'n/a'}, calibration=${models.stock.calibrationSource || 'in-sample'}, samples=${models.stock.trainedOn}`);
      }
      if (models.option) {
        console.log(`  Option model: in-sample accuracy=${(models.option.accuracy || 0).toFixed(3)}, out-of-fold accuracy=${models.option.walkForward?.accuracy ?? 'n/a'}, out-of-fold edge=${models.option.oof?.edge ?? 'n/a'}, calibration=${models.option.calibrationSource || 'in-sample'}, samples=${models.option.trainedOn}`);
      }

      const today = new Date().toISOString().slice(0, 10);
      const month = today.slice(0, 7); // YYYY-MM
      // Month-partitioned storage: ai-models/{uid}/{month}/stock.json + option.json.
      // ai-models/{uid}/index.json tracks which month is current so the app knows where to read from.
      const modelIndexPath = `ai-models/${userId}/index.json`;
      const historyIndexPath = `ai-models/${userId}/history/index.json`;
      const historyDayPath = `ai-models/${userId}/history/${today}.json`;
      const savedAt = new Date().toISOString();
      const { stock, option } = brain.splitModelForStorage(models);

      // ── Champion / challenger ──
      // The freshly trained model only replaces the live one if it has not regressed on its honest
      // (out-of-fold) numbers. A rejected candidate leaves the live files untouched.
      const modelIndexExisting = await ghFetch(modelIndexPath);
      const modelIndex = decodeContent(modelIndexExisting?.content) || { months: [] };
      const liveMonth = modelIndex.latestMonth || month;
      const readLive = async (fam) => {
        const f = await ghFetch(`ai-models/${userId}/${liveMonth}/${fam}.json`);
        let data = null;
        try { data = f ? decodeContent(f.content) : null; } catch (_) { data = null; }
        return data;
      };
      const live = { stock: await readLive('stock'), option: await readLive('option') };
      const cand = { stock, option };
      const decisions = {};
      for (const fam of ['stock', 'option']) {
        if (!cand[fam]) continue;
        decisions[fam] = brain.decidePromotion(cand[fam].family, live[fam]?.family, { force: process.env.AI_FORCE_PROMOTE === '1' });
        console.log(`  ${fam}: ${decisions[fam].promote ? '✅ promote' : '⏸️ keep live model'} — ${decisions[fam].reason}`);
      }
      // GitHub's contents API only returns file content inline up to 1 MB. Keep each model file well
      // under that: drop the segment models with the least data first (never the one being served).
      const SIZE_BUDGET = 700 * 1024;
      for (const fam of ['stock', 'option']) {
        if (!cand[fam]) continue;
        const sizeOf = () => Buffer.byteLength(JSON.stringify(cand[fam]));
        const segs = cand[fam].family?.segments || {};
        const dropOrder = Object.keys(segs).filter((k) => k !== cand[fam].family.servingLabel)
          .sort((a, b) => (segs[a].trainedOn || 0) - (segs[b].trainedOn || 0));
        let size = sizeOf();
        while (size > SIZE_BUDGET && dropOrder.length) {
          const k = dropOrder.shift();
          delete segs[k];
          console.warn(`  ⚠️ ${fam} model ${Math.round(size / 1024)} KB over budget — dropped segment ${k}`);
          size = sizeOf();
        }
        console.log(`  ${fam} model file: ${Math.round(size / 1024)} KB${size > 900 * 1024 ? ' ❌ close to the 1 MB GitHub read limit' : ''}`);
      }
      for (const fam of ['stock', 'option']) {
        const path = `ai-models/${userId}/${month}/${fam}.json`;
        const existing = await ghFetch(path);
        if (cand[fam] && decisions[fam]?.promote) {
          // keep the model being replaced, so a bad promotion can be rolled back by hand
          if (live[fam] && liveMonth === month) {
            const prevPath = `ai-models/${userId}/${month}/${fam}.prev.json`;
            const prevExisting = await ghFetch(prevPath);
            await ghPut(prevPath, { ...live[fam], replacedAt: savedAt }, prevExisting?.sha || null, `SCANNER AI previous ${fam} model · ${userId} · ${month}`);
          }
          await ghPut(path, { ...cand[fam], trainedOffline: true, userId, month, savedAt }, existing?.sha || null, `SCANNER AI offline retrain (${fam}) · ${userId} · ${month}`);
        } else if (live[fam] && liveMonth !== month) {
          // new month but the live model was kept: carry it forward so the new month folder is complete
          await ghPut(path, { ...live[fam], carriedForward: true, userId, month }, existing?.sha || null, `SCANNER AI carry forward (${fam}) · ${userId} · ${month}`);
        }
      }
      await ghPut(modelIndexPath, { months: Array.from(new Set([...(modelIndex.months || []), month])).sort(), latestMonth: month, updatedAt: savedAt }, modelIndexExisting?.sha || null, `SCANNER AI model index · ${userId} · ${month}`);

      // history records what is actually LIVE after the decision
      const liveModels = brain.mergeModelFromStorage(
        decisions.stock?.promote ? cand.stock : live.stock,
        decisions.option?.promote ? cand.option : live.option,
      );
      const snapshot = brain.buildModelSnapshot(liveModels || models);

      const historyDayExisting = await ghFetch(historyDayPath);
      await ghPut(historyDayPath, { date: today, snapshot, promotion: decisions, trainedOffline: true, userId }, historyDayExisting?.sha || null, `SCANNER AI history · ${userId} · ${today}`);

      const historyIndexExisting = await ghFetch(historyIndexPath);
      const historyIndex = decodeContent(historyIndexExisting?.content) || { dates: [] };
      const dates = Array.from(new Set([...(historyIndex.dates || []), today])).sort().slice(-LOOKBACK_DAYS);
      await ghPut(historyIndexPath, { dates, updatedAt: new Date().toISOString() }, historyIndexExisting?.sha || null, `SCANNER AI history index · ${userId}`);

      const elapsed = Math.round((Date.now() - userStartTime) / 1000);
      console.log(`✅ Trained ${userId}: ${closed.length} closed signals in ${elapsed}s`);
      if (elapsed > 1200) console.warn(`⚠️ Training took ${Math.round(elapsed / 60)} min — consider trimming data or raising the workflow timeout.`);
      trained++;
    } catch (e) {
      console.error(`❌ Error training ${userId}: ${e.message}`);
      failed++;
    }
  }

  console.log('');
  console.log('═════════════════════════════════════════');
  console.log(`📈 Results: Trained=${trained}, Skipped=${skipped}, Failed=${failed}, Total=${userIds.length}`);
  console.log(`⏱️ Total time: ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.log('═════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('❌ Unrecoverable error:', err.stack || err.message || String(err));
  process.exit(1);
});

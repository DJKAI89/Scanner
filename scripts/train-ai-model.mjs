import fs from 'node:fs/promises';

const GH_TOKEN = process.env.AI_GH_TOKEN || process.env.GH_TOKEN || '';
const GH_USER = process.env.GH_USER || '';
const GH_REPO = process.env.GH_REPO || '';
const FRIDAY_USER_ID = (process.env.FRIDAY_USER_ID || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const LOOKBACK_DAYS = Number(process.env.AI_LOOKBACK_DAYS || 90);

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION VALIDATION
// ═══════════════════════════════════════════════════════════════════
const config = {
  GH_TOKEN,
  GH_USER,
  GH_REPO,
  FRIDAY_USER_ID,
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
  console.error('  export FRIDAY_USER_ID="user-id" (optional, processes all if not set)');
  process.exit(1);
}

console.log('✅ Configuration OK');
console.log(`  Repository: ${GH_USER}/${GH_REPO}`);
console.log(`  Token length: ${GH_TOKEN.length} chars`);
console.log(`  Lookback: ${LOOKBACK_DAYS} days`);
if (FRIDAY_USER_ID) console.log(`  Target user: ${FRIDAY_USER_ID}`);
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

async function readSignalHistory() {
  const indexPath = `signal-logs/${FRIDAY_USER_ID}/index.json`;
  const indexFile = await ghFetch(indexPath);
  if (!indexFile) return [];
  const index = decodeContent(indexFile.content);
  if (!index) return [];
  const dates = (index.dates || []).slice(-LOOKBACK_DAYS);
  const signals = [];
  for (const date of dates) {
    const day = await ghFetch(`signal-logs/${FRIDAY_USER_ID}/${date}.json`);
    if (!day) continue;
    const payload = decodeContent(day.content);
    if (!payload) continue;
    signals.push(...(payload.signals || []));
  }
  return signals;
}

async function listUserIds() {
  if (FRIDAY_USER_ID) return [FRIDAY_USER_ID];
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

    globalThis.FRIDAY_USER_ID = userId;
    const userStartTime = Date.now();

    try {
      const signals = await (async () => {
        const indexPath = `signal-logs/${userId}/index.json`;
        const indexFile = await ghFetch(indexPath);
        if (!indexFile) return [];
        const index = decodeContent(indexFile.content);
        if (!index) {
          console.log(`⏭️ Skip ${userId}: index.json is empty/unreadable`);
          return [];
        }
        const dates = (index.dates || []).slice(-LOOKBACK_DAYS);
        const out = [];
        for (const date of dates) {
          const day = await ghFetch(`signal-logs/${userId}/${date}.json`);
          if (!day) continue;
          const payload = decodeContent(day.content);
          if (!payload) continue;
          out.push(...(payload.signals || []));
        }
        return out;
      })();

      const closed = signals.filter((s) => s.status === 'TARGET_HIT' || s.status === 'SL_HIT');
      if (closed.length < 10) {
        console.log(`⏭️ Skip ${userId}: only ${closed.length} closed signals (need ≥10)`);
        skipped++;
        continue;
      }

      const models = brain.trainSignalMlModels(closed);
      if (!models) {
        console.log(`⚠️ Skip ${userId}: training returned null (insufficient/unbalanced data)`);
        skipped++;
        continue;
      }

      // Validate trained model
      if (models.stock) {
        console.log(`  Stock model: accuracy=${(models.stock.accuracy || 0).toFixed(3)}, edge=${(models.stock.edge || 0).toFixed(4)}, samples=${models.stock.trainedOn}`);
      }
      if (models.option) {
        console.log(`  Option model: accuracy=${(models.option.accuracy || 0).toFixed(3)}, edge=${(models.option.edge || 0).toFixed(4)}, samples=${models.option.trainedOn}`);
      }

      const snapshot = brain.buildModelSnapshot(models);
      const today = new Date().toISOString().slice(0, 10);
      const latestPath = `ai-models/${userId}/latest.json`;
      const historyIndexPath = `ai-models/${userId}/history/index.json`;
      const historyDayPath = `ai-models/${userId}/history/${today}.json`;

      const latestExisting = await ghFetch(latestPath);
      await ghPut(latestPath, { ...models, trainedOffline: true, userId }, latestExisting?.sha || null, `FRIDAY AI offline retrain · ${userId}`);

      const historyDayExisting = await ghFetch(historyDayPath);
      await ghPut(historyDayPath, { date: today, snapshot, trainedOffline: true, userId }, historyDayExisting?.sha || null, `FRIDAY AI history · ${userId} · ${today}`);

      const historyIndexExisting = await ghFetch(historyIndexPath);
      const historyIndex = decodeContent(historyIndexExisting?.content) || { dates: [] };
      const dates = Array.from(new Set([...(historyIndex.dates || []), today])).sort().slice(-LOOKBACK_DAYS);
      await ghPut(historyIndexPath, { dates, updatedAt: new Date().toISOString() }, historyIndexExisting?.sha || null, `FRIDAY AI history index · ${userId}`);

      const elapsed = Math.round((Date.now() - userStartTime) / 1000);
      console.log(`✅ Trained ${userId}: ${closed.length} closed signals in ${elapsed}s`);
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

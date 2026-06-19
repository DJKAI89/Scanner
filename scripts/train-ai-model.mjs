import fs from 'node:fs/promises';

const GH_TOKEN = process.env.AI_GH_TOKEN || process.env.GH_TOKEN || '';
const GH_USER = process.env.GH_USER || '';
const GH_REPO = process.env.GH_REPO || '';
const FRIDAY_USER_ID = (process.env.FRIDAY_USER_ID || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const LOOKBACK_DAYS = Number(process.env.AI_LOOKBACK_DAYS || 90);

if (!GH_TOKEN || !GH_USER || !GH_REPO) {
  console.error('Missing required config:', {
    AI_GH_TOKEN: GH_TOKEN ? 'set' : 'MISSING',
    GH_USER: GH_USER ? 'set' : 'MISSING',
    GH_REPO: GH_REPO ? 'set' : 'MISSING',
  });
  console.error('Check that repo secrets AI_GH_TOKEN, AI_GH_USER, AI_GH_REPO exist and are spelled exactly like this (case-sensitive).');
  process.exit(1);
}
console.log(`Config OK — targeting ${GH_USER}/${GH_REPO}, token length ${GH_TOKEN.length}`);

async function loadBrainModule() {
  const source = await fs.readFile(new URL('../src/services/mlRanking.js', import.meta.url), 'utf8');
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  return import(url);
}

async function ghFetch(path) {
  const r = await fetch(`https://api.github.com/repos/${GH_USER}/${GH_REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (r.status === 404) return null;
  if (r.status === 401) throw new Error(`GitHub 401 for ${path} — token invalid/expired/revoked. Check secrets.AI_GH_TOKEN.`);
  if (r.status === 403) throw new Error(`GitHub 403 for ${path} — token lacks repo access (fine-grained PAT needs Contents permission) or rate-limited.`);
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${path}`);
  return r.json();
}

async function ghPut(path, payload, sha, message) {
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
  });
  if (!r.ok) throw new Error(`GitHub PUT ${r.status} for ${path}`);
  return r.json();
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
  const brain = await loadBrainModule();
  const userIds = await listUserIds();
  if (!userIds.length) {
    console.log('No user folders found in signal-logs');
    return;
  }

  let trained = 0;
  for (const userId of userIds) {
    globalThis.FRIDAY_USER_ID = userId;
    const signals = await (async () => {
      const indexPath = `signal-logs/${userId}/index.json`;
      const indexFile = await ghFetch(indexPath);
      if (!indexFile) return [];
      const index = decodeContent(indexFile.content);
      if (!index) {
        console.log(`Skip ${userId}: index.json is empty/unreadable`);
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
      console.log(`Skip ${userId}: not enough closed signals (${closed.length})`);
      continue;
    }

    const models = brain.trainSignalMlModels(closed);
    if (!models) {
      console.log(`Skip ${userId}: training returned no model`);
      continue;
    }

    const snapshot = brain.buildModelSnapshot(models);
    const latestPath = `ai-models/${userId}/latest.json`;
    const historyPath = `ai-models/${userId}/history.json`;
    const latestExisting = await ghFetch(latestPath);
    const historyExisting = await ghFetch(historyPath);
    await ghPut(latestPath, { ...models, trainedOffline: true, userId }, latestExisting?.sha || null, `FRIDAY AI offline retrain · ${userId}`);
    const historyPayload = historyExisting ? (decodeContent(historyExisting.content) || { items: [] }) : { items: [] };
    const items = [snapshot, ...(historyPayload.items || [])].slice(0, 100);
    await ghPut(historyPath, { items, updatedAt: new Date().toISOString(), trainedOffline: true, userId }, historyExisting?.sha || null, `FRIDAY AI history offline retrain · ${userId}`);
    console.log(`AI retrain complete for ${userId}. Closed signals: ${closed.length}`);
    trained++;
  }

  console.log(`Finished. Trained users: ${trained}/${userIds.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});

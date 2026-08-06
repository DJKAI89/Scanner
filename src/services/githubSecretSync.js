// Auto-syncs the Upstox access token to a GitHub Actions secret so the
// server-side monitor (scripts/monitorSignals.mjs) can run headlessly —
// called right after login (saveToken), no manual GitHub step needed.
// gh: { token: <PAT with repo + actions:write scope>, user, repo }
import sealedbox from 'tweetnacl-sealedbox-js';

const GH_API = 'https://api.github.com';
const SECRET_NAME = 'UPSTOX_ACCESS_TOKEN';
const WORKFLOW_FILE = 'monitor-signals.yml';

function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
function bytesToB64(bytes) { return btoa(String.fromCharCode(...bytes)); }

async function ghFetch(gh, path, opts = {}) {
  const r = await fetch(`${GH_API}/repos/${gh.user}/${gh.repo}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${gh.token}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
  return r;
}

export async function syncUpstoxTokenToGithub(gh, upstoxToken, lg = () => {}, showToast = () => {}) {
  if (!gh?.token || !gh?.user || !gh?.repo || !upstoxToken) return false;
  try {
    // 1. Get the repo's secret-encryption public key
    const keyRes = await ghFetch(gh, '/actions/secrets/public-key');
    if (!keyRes.ok) {
      const reason = keyRes.status === 404
        ? 'repo not found or PAT lacks access'
        : keyRes.status === 403 || keyRes.status === 401
        ? 'PAT missing "Secrets: write" permission — add it manually instead (see Settings)'
        : `HTTP ${keyRes.status}`;
      lg('GH secret sync: could not fetch public key — ' + reason, 'w');
      showToast(`⚠ Could not auto-sync Upstox token to GitHub: ${reason}`, '#d97706', 8000);
      return false;
    }
    const { key, key_id } = await keyRes.json();

    // 2. Encrypt the token with libsodium sealed box (GitHub's required format)
    const encrypted = sealedbox.seal(new TextEncoder().encode(upstoxToken), b64ToBytes(key));
    const encryptedB64 = bytesToB64(encrypted);

    // 3. Upsert the secret
    const putRes = await ghFetch(gh, `/actions/secrets/${SECRET_NAME}`, {
      method: 'PUT',
      body: JSON.stringify({ encrypted_value: encryptedB64, key_id }),
    });
    if (!putRes.ok) {
      lg('GH secret sync: PUT failed (' + putRes.status + ')', 'w');
      showToast(`⚠ Could not save UPSTOX_ACCESS_TOKEN secret (HTTP ${putRes.status}) — add it manually in Settings`, '#d97706', 8000);
      return false;
    }

    // 4. Trigger the monitor workflow immediately (instead of waiting for the next cron tick)
    await ghFetch(gh, `/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main' }),
    }).catch(() => {}); // non-fatal — cron will still pick it up within 3 min

    lg('✅ Server-side monitor synced with new token', 'o');
    showToast('✅ Server-side monitor synced with your new token', '#16a34a', 4000);
    return true;
  } catch (e) {
    lg('GH secret sync error: ' + e.message, 'w');
    showToast('⚠ Auto-sync to GitHub failed: ' + e.message, '#d97706', 8000);
    return false;
  }
}

// ── Settings service — GitHub config parsing + connection test ───
// Extracted from SettingsPane.jsx so the pane only handles UI/state wiring.
// All calculation and API-call logic for the Settings tab lives here.

import { pullSettingsFromGH, pushSettingsToGH } from './github';

// Fire-and-forget push of local settings to GitHub after a local save.
// Resolves to true/false; never throws (errors are swallowed, matching prior behavior).
export function pushLocalSettingsToGH(cleaned, cfgToSave) {
  if (!cleaned.token || !cleaned.user || !cleaned.repo) return Promise.resolve(false);
  return pushSettingsToGH(cleaned, cfgToSave).catch(() => false);
}

// Parses a raw {token,user,repo} GitHub config, tolerating full repo/Pages URLs
// pasted into the repo field, and normalises user/repo into clean values.
export function sanitiseGH(raw) {
  let { token: tok, user, repo } = raw;
  repo = (repo || '').trim(); user = (user || '').trim().toLowerCase();
  const ghMatch = repo.match(/https?:\/\/github\.com\/([^/]+)\/([^/\s#?]+)/);
  if (ghMatch) { if (!user) user = ghMatch[1].toLowerCase(); repo = ghMatch[2].replace(/\.git$/, ''); }
  const pagesMatch = repo.match(/https?:\/\/([^.]+)\.github\.io(?:\/([^/\s#?]+))?/);
  if (pagesMatch) { if (!user) user = pagesMatch[1]; repo = pagesMatch[2] || pagesMatch[1] + '.github.io'; }
  repo = repo.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+|\/+$/g, '');
  return { token: tok, user, repo };
}

// Tests a GitHub connection against the repos endpoint and, on success,
// pulls any remote settings already saved there.
// Returns { ok, status, message, pulledCfg? }
export async function testGitHubConnection(cleaned) {
  if (!cleaned.token) return { ok: false, message: '❌ GitHub token required' };
  if (!cleaned.user)  return { ok: false, message: '❌ GitHub username required' };
  if (!cleaned.repo)  return { ok: false, message: '❌ Repository name required' };

  try {
    const r = await fetch(`https://api.github.com/repos/${cleaned.user}/${cleaned.repo}`, {
      headers: { Authorization: 'Bearer ' + cleaned.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (r.ok) {
      const pulledCfg = await pullSettingsFromGH(cleaned);
      return { ok: true, message: `✅ Connected! ${cleaned.user}/${cleaned.repo}`, pulledCfg };
    }
    if (r.status === 401) return { ok: false, status: 401, message: '❌ Token invalid — regenerate with repo scope (or Contents permission for fine-grained tokens)' };
    if (r.status === 403) return { ok: false, status: 403, message: '❌ Forbidden — fine-grained token missing repo access/Contents permission, or rate-limited' };
    if (r.status === 404) return { ok: false, status: 404, message: `❌ Repo '${cleaned.user}/${cleaned.repo}' not found (check spelling/case, or token can't see it)` };
    return { ok: false, status: r.status, message: '❌ GitHub error: HTTP ' + r.status };
  } catch (e) {
    return { ok: false, message: '❌ Network error: ' + e.message };
  }
}

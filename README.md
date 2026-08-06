# Scanner — NSE Stock & Option Scanner (React)

React + Vite app for NSE stock and F&O option scanning via the **Upstox v3 API**, with a GitHub-repo-backed signal log, an ML-based confidence ranker, and a server-side signal monitor.

---

## 🚀 Quick Start

```bash
npm install
npm run dev       # http://localhost:3000
npm run build     # → dist/
npm run preview
```

Requires Node ≥ 18.

---

## 📁 Project Structure

```
Scanner-AI_Feature/
├── .github/workflows/
│   ├── ci.yml                  ← build + deploy to GitHub Pages (on push)
│   ├── monitor-signals.yml     ← cron: server-side signal monitor
│   └── AI_Retrain.yml          ← scheduled ML model retrain
├── scripts/
│   ├── monitorSignals.mjs      ← headless signal monitor (no browser needed)
│   └── train-ai-model.mjs      ← offline model retrainer
├── src/
│   ├── App.jsx / main.jsx / index.css
│   ├── context/AppContext.jsx  ← global state: token, cfg, GitHub cfg, ML models, market status
│   ├── constants/config.js     ← default cfg, index list, tabs
│   ├── hooks/
│   │   ├── useMarketFeed.js    ← Upstox WebSocket feed + REST poll fallback
│   │   └── useIndexFeed.js     ← REST-polled index/VIX ticker feed
│   ├── utils/
│   │   ├── formatters.js, marketTime.js, miniChart.js
│   ├── services/
│   │   ├── api.js                  ← Upstox REST (quotes, option chain, greeks, contracts)
│   │   ├── github.js               ← signal log read/write, settings sync (GitHub Contents API)
│   │   ├── githubSecretSync.js     ← pushes Upstox token to Actions secret + triggers monitor run
│   │   ├── technical.js            ← indicators, scanChain (option picks), scanChainAnalysis (chain grid)
│   │   ├── optionScan.js           ← options signal pipeline: scan → FII/regime/ML score → filter
│   │   ├── optionAnalysisService.js← option chain grid data (expiry list, live merge, confidence)
│   │   ├── stockScan.js            ← stock signal pipeline
│   │   ├── tradeManagement.js      ← T1/T2/T3 partials, break-even, trailing SL, time-stop, EXPIRY
│   │   ├── mlRanking.js            ← walk-forward validated model, calibration, adaptive thresholds
│   │   ├── logService.js           ← signal log loading + live resolution
│   │   ├── analysisService.js      ← signal performance analytics (AnalysisPane)
│   │   ├── heatmapService.js       ← sector/stock heatmap data (HeatmapPane)
│   │   ├── lookupService.js        ← on-demand single-symbol analysis (LookupPane)
│   │   ├── portfolioService.js     ← live portfolio P&L (PortfolioPane)
│   │   └── settingsService.js      ← config + stock universe + FII-DII load/save
│   ├── components/
│   │   ├── Header.jsx, NavDrawer.jsx, Ticker.jsx, TokenGate.jsx
│   │   ├── StockCard.jsx           ← used by StocksPane (canonical — see note below)
│   │   ├── LiveChart.jsx, cardKit.jsx, common.jsx
│   └── panes/
│       ├── StocksPane.tsx / OptionsPane.tsx   ← ranked trade signals (stocks / options)
│       ├── OptionAnalysisPane.tsx             ← full option chain grid, live confidence/margin
│       ├── LogPane.tsx                        ← open/closed signal log, live P&L, partial exits
│       ├── LookupPane.tsx, PortfolioPane.jsx, HeatmapPane.jsx, AnalysisPane.jsx
│       ├── SettingsPane.tsx                   ← config, GitHub cfg, ML Ranker stats, stock universe
│       └── StockCard.tsx                      ← ⚠ unused duplicate, safe to delete
├── index.html / package.json / vite.config.js
```

> **Note:** `src/panes/StockCard.tsx` is a leftover unused duplicate of `src/components/StockCard.jsx`. `StocksPane.tsx` explicitly imports the `.jsx` one, so it's dead code, not a routing bug — safe to delete during cleanup.

---

## 🔑 Upstox Token

1. [developer.upstox.com](https://developer.upstox.com) → your app → **Get Token**
2. Paste the access token into the app

Tokens expire ~3:30am IST daily — paste a fresh one each morning. Pasting it also auto-syncs it to the `UPSTOX_ACCESS_TOKEN` GitHub Actions secret, so the server-side monitor keeps working without a manual GitHub step.

---

## ⚙️ GitHub Actions

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | push | build + deploy to GitHub Pages |
| `monitor-signals.yml` | cron (3 min, Mon–Fri market hours) + token push | resolves OPEN signals server-side, app can be closed |
| `AI_Retrain.yml` | cron | retrains the ML ranker from logged signal history |

**Enable Pages:** repo → Settings → Pages → Source: **GitHub Actions**.

**Enable server-side monitoring:** add repo secrets `GH_TOKEN` (PAT, repo + Actions-secrets write), `SCANNER_USER_ID` (your `scanner_user_id` value). `UPSTOX_ACCESS_TOKEN` is set automatically once you paste a token in the app.

---

## 📋 Signal Log (GitHub-backed)

```
signal-logs/{scanner_user_id}/{date}.json   ← signals + stats for that day
signal-logs/{scanner_user_id}/index.json    ← date index + daily open/hit/sl counts
settings/{scanner_user_id}.json             ← saved config
ai-models/{scanner_user_id}/...             ← trained ML ranker snapshots
```

Configure in **Settings → Signal Log (GitHub)**: token (`repo` scope), username, repo name.

---

## 🧠 Confidence & ML Ranking

- Raw per-strike confidence (delta/IV/OI-buildup/zone/direction-flip) is identical between the Options signal page and the Option Analysis grid.
- The signal page additionally layers FII bias, market-regime adjustment, confluence, and an ML probability nudge — the grid shows the raw score by design.
- **ML Ranker** (Settings): walk-forward validated — trust **Walk-Forward** % over the in-sample **Accuracy** % (optimistic).
- Delta/IV gate thresholds and confidence/capital cutoffs are learned from logged signal outcomes once enough history exists, not hardcoded.

---

## ⚠️ Disclaimer

Not SEBI-registered investment advice. Analysis tool only — always DYODD.

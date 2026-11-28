# Scanner operations guide

## Scheduled jobs

| Workflow | When (IST) | What it does |
|---|---|---|
| `server-scan.yml` | every 30 min, 09:30–15:29, Mon–Fri | Runs the stock, breakout and F&O scanners with the same inputs as the app; logs signals and shadow picks; sends Telegram alerts for new high-confidence signals. Exits at once when the market is closed. |
| `monitor-signals.yml` | every 15 min in market hours | Resolves open signals (candle replay + live price), sends Telegram alerts for target / stop / expiry. |
| `AI_Retrain.yml` | 17:00, Mon–Fri | Resolves open signals first, then retrains the stock and option models. |
| `ci.yml` | every push | Existing: builds and deploys the site to GitHub Pages. |
| `tests.yml` | every push / pull request | Build + automated tests (about 3 minutes). |

Manual run: Actions tab → pick the workflow → **Run workflow**.
After deploying a new trainer, run `AI Retrain` once with **force_promote** ticked so the new model replaces the old one even if the safety checks would keep the live one.

## Secrets and variables

Repository secrets:

- `AI_GH_TOKEN` — a **fine-grained** personal access token limited to this one repository, permission **Contents: read and write** only. Nothing else.
- `AI_GH_USER`, `AI_GH_REPO` — repository owner and name.
- `UPSTOX_ACCESS_TOKEN` — expires daily; refresh it every morning (or the scans and the monitor fail with "token expired").
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — optional, for phone alerts. Create a bot with @BotFather, send it a message, then read your chat id from `https://api.telegram.org/bot<token>/getUpdates`.

Never commit a token to the repository. If one was ever committed or pasted somewhere public, revoke it and make a new one.

Optional repository variables (Settings → Secrets and variables → Actions → Variables):

- `AI_STOCK_COST_PCT`, `AI_OPTION_FLAT_COST_PCT`, `AI_OPTION_ORDER_FEE_RS`, `AI_OPTION_STAT_PCT` — your real cost assumptions. They decide what counts as a win. Defaults: stock 0.28%, option flat 0.45%, ₹20 per order, 0.12% statutory.
- `AI_DEDUPE_BY_STRIKE=1` — keep different strikes of the same idea as separate training rows.
- `AI_INCLUDE_SHADOW=0` — leave rejected-but-tracked picks out of training.
- `AI_LOOKBACK_DAYS` — default `all`.

## Reading the training log

- `promote — …` the new model replaced the live one; `keep live model — …` it did not, and the reason is printed.
- `Idea de-dupe: {closed, kept, dropped}` shows how many closed signals were merged into one idea.
- `… model file: N KB` — must stay well under 1 MB (the GitHub read limit). Over 700 KB the smallest segment models are dropped automatically.
- A warning appears if training takes more than 20 minutes.

## Rolling back a model

Each promotion saves the previous model next to the new one: `ai-models/<user>/<month>/stock.prev.json` and `option.prev.json`.
To roll back, copy the contents of the `.prev.json` file over `stock.json` / `option.json` and commit.

## Learning options (Settings → AI and ML → Learning options)

Both are off / at the old value by default, so nothing changes until you choose:

- **Confidence calibration learns from** — last 60 days (default), 180, 365 or every logged day. Applies to the bucket calibration and the indicator weights; effective at the next app load. The scheduled scan uses the same setting. Model training itself always uses all history.
- **Use index / stock option models for live picks** — off keeps the single blended option model for live picks. On, live picks use the model and thresholds trained for index options or stock options, like logged signals do. Turn it on only after the AI Reliability panel shows a positive unseen edge; it can move option confidences.

## Rules-only mode

Settings → AI and ML → **Rules-only mode** turns the ML model off for scoring (calibration and learned indicator weights still apply). Use it if the Performance → AI Reliability panel shows no edge on unseen signals.

## When to trust the model

Look at Performance → AI and model:

- unseen accuracy and unseen edge are positive for two weeks in a row, with at least 300 closed signals per family;
- the final untouched check agrees;
- the reliability table's predicted and actual win rates are within about 10 points;
- no "recent results worse" drift warning.

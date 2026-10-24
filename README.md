# Scanner

Scanner is a market dashboard and signal engine for NSE stocks and options. It brings together live market data, technical scanning, option-chain analysis, and a lightweight ML-inspired ranking layer to help users monitor opportunities and review trade outcomes in one place.

## High-level idea

This repository is built for traders who want a practical workflow for:

- tracking live NSE market activity
- scanning stocks and options for potential setups
- evaluating trade quality using technical and market context
- reviewing signal performance over time
- keeping settings and signal logs organized in a GitHub-backed system
- automating background monitoring without needing the app open constantly

In short, Scanner is not just a chart app or scanner script — it is a full trading-focused workspace that combines data, analysis, signal scoring, and automation.

## What the project does

- Connects to Upstox APIs for live market quotes, option chain data, and greeks
- Monitors index and stock market activity in real time
- Scans stocks and option trades using rule-based and context-aware logic
- Ranks signals using confidence and model-based scoring
- Tracks open and closed signals with a GitHub-backed log
- Stores user settings, market configs, and model artifacts in repo-managed data
- Runs scheduled background tasks through GitHub Actions for signal monitoring and model retraining

## Core capabilities

- Live dashboard for stock and index monitoring
- Stocks and options signal scanning
- Option chain analysis with confidence and risk context
- Trade log and performance analytics
- Portfolio and P&L tracking
- Heatmap and market overview sections
- User configuration management
- Cloud-style automation using GitHub Actions

## Technology overview

- Frontend: React + Vite
- Market data: Upstox API
- App logic: JavaScript/JSX with some TypeScript-based panes
- Automation: Node.js scripts and GitHub Actions workflows
- Storage: GitHub repository as a lightweight backend for logs, settings, and model snapshots
- Intelligence: ML-style ranking and confidence scoring from historical signal outcomes

## Typical workflow

1. User adds their Upstox token and configures the app.
2. The dashboard loads market data and signal feeds.
3. Scanner evaluates stocks and option opportunities using technical and market conditions.
4. Signals are scored and prioritized based on confidence and trade context.
5. Open signals are tracked and resolved through GitHub-backed monitoring.
6. Historical results are used to improve ranking and decision quality over time.

## Quick start

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
npm run preview
```

## Repository layout

```text
Scanner/
├── src/                  # App screens, market logic, and UI components
├── scripts/              # Background monitoring and ML retraining scripts
├── .github/workflows/    # GitHub automation for build, monitoring, and training
├── public/               # Static assets
├── package.json          # Scripts and dependencies
├── vite.config.js        # Vite setup
├── index.html            # App entry point
├── README.md             # Project overview
```

## Important note

This project is designed to support trading research and signal analysis. It is a tool for market monitoring and decision support, not a guarantee of profitable trades. Use it responsibly with proper risk management and independent validation.

## Disclaimer

This project is for educational and analytical use only. It is not SEBI-regulated investment advice and should not be treated as financial advice. Always do your own research and manage risk before making trading decisions.

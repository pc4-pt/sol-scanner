# SOL Scanner v3 — Setup Guide

## File Structure

```
sol-scanner/
├── package.json          ← dependencies (already includes all Solana libs)
├── vite.config.js        ← dev proxy for DexScreener API (no CORS issues)
├── index.html
└── src/
    ├── main.jsx          ← wallet provider setup (Phantom + Solflare)
    ├── App.jsx           ← scanner UI + layout
    ├── TradingPanel.jsx  ← wallet, queue, positions, history, settings
    ├── tradingEngine.js  ← Jupiter swap logic + price monitor
    └── useTrading.js     ← trading state hook (queue, positions, PnL)
```

## Install & Run Locally

```bash
# 1. Create the project
npm create vite@latest sol-scanner -- --template react
cd sol-scanner

# 2. Replace all files in src/ and root with the provided files

# 3. Install dependencies
npm install

# 4. Run dev server (with DexScreener proxy — no CORS errors)
npm run dev
# Opens at http://localhost:5173
```

## Deploy to Vercel (recommended)

```bash
# After testing locally:
npm install -g vercel
vercel

# Or push to GitHub and connect to vercel.com for auto-deploy
```

## Deploy to Netlify

```bash
npm run build
# Drag the dist/ folder to netlify.com/drop
```

---

## Trading Setup

### 1. Connect a wallet
- Click **CONNECT WALLET** in the trading panel
- Supports **Phantom** and **Solflare**
- Use a **dedicated trading wallet** — never your main wallet

### 2. Configure settings (SETTINGS tab)
| Setting | Default | Notes |
|---|---|---|
| Stake per trade | 0.1 SOL | Amount spent per buy |
| Take profit | +50% | Auto-sells at this gain |
| Stop loss | -20% | Auto-sells at this loss |
| Slippage | 200 bps (2%) | Increase for low-liq tokens |
| Min score | 70 | Minimum scanner score to queue |
| Min confidence | 60% | Minimum momentum signal confidence |
| Max positions | 5 | Concurrent open trades |
| Cooldown | 30 min | Prevents re-entering same token |
| Require momentum | ON | Only EARLY MOMENTUM + UPTREND |
| Auto-execute | OFF | Must enable manually — use with caution |

### 3. How the queue works
1. Run a **scan** — tokens meeting your criteria are added to the queue automatically
2. Review each token in the **QUEUE tab**
3. Edit stake/TP/SL per trade if needed
4. Click **▶ BUY** to approve
5. Phantom/Solflare will prompt you to sign the transaction
6. Position moves to **POSITIONS tab** and is monitored every 15s

### 4. Auto-execute mode
When enabled, tokens meeting all criteria are bought **without manual approval**.
- ⚠ Only enable with a dedicated wallet
- ⚠ Cap the balance to your maximum acceptable loss
- The price monitor fires stop-loss and take-profit automatically

---

## How trades execute

1. **Jupiter v6 API** finds the best swap route across all Solana DEXes
2. Price impact is checked — trades with >5% impact are blocked automatically
3. Transaction is signed by your wallet (never stored by the app)
4. Position is recorded with entry price, TP target, SL level
5. Price monitor polls DexScreener every 15 seconds
6. When TP or SL is hit, a sell is automatically submitted

---

## Security notes

- Private keys are **never stored** — all signing goes through Phantom/Solflare
- Positions and trade history are saved to **localStorage** (browser only)
- The app has no backend — all logic runs in your browser
- For fully automated trading (no browser required), a server-side keypair setup is needed — this is a future enhancement

---

## Risk warning

Newly launched Solana tokens are extremely high-risk assets. The scanner's scoring system reduces but does not eliminate risk. Never trade with funds you cannot afford to lose. This tool is for informational purposes.

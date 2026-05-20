// ─── tradingEngine.js ─────────────────────────────────────────────────────────
// Jupiter v6 swap integration + position lifecycle management
// All monetary values in SOL (lamports converted at call site)

import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

// ── Constants ─────────────────────────────────────────────────────────────────
export const SOL_MINT   = "So11111111111111111111111111111111111111112";
export const USDC_MINT  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const JUPITER_API = import.meta.env?.VITE_JUPITER_API || (import.meta.env?.DEV ? "/jup/v6" : "/api/jup/v6");
export const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";
export const JUPITER_RETRY_COUNT = 3;
export const JUPITER_RETRY_DELAY_MS = 900;
export const JUPITER_RETRY_STATUS = [429, 502, 503, 504];

// Price monitor poll interval (ms) — checks open positions
export const PRICE_POLL_MS = 15000;

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, retries = JUPITER_RETRY_COUNT) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (attempt < retries && JUPITER_RETRY_STATUS.includes(res.status)) {
        const backoff = JUPITER_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
        await delay(backoff);
        attempt += 1;
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const message = err?.message || "network error";
      const retryable = attempt < retries && (
        message.includes("Failed to fetch") ||
        message.includes("network") ||
        JUPITER_RETRY_STATUS.some(code => message.includes(String(code)))
      );
      if (retryable) {
        const backoff = JUPITER_RETRY_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
        await delay(backoff);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

// ── Connection ────────────────────────────────────────────────────────────────
export function getConnection() {
  return new Connection(RPC_ENDPOINT, "confirmed");
}

// ── Jupiter: get quote ────────────────────────────────────────────────────────
// inputMint:  what you're spending (SOL_MINT to buy a token)
// outputMint: what you're buying   (token mint address)
// amountLamports: amount in lamports (1 SOL = 1_000_000_000)
// slippageBps: slippage tolerance in basis points (100 = 1%)
export async function getJupiterQuote({ inputMint, outputMint, amountLamports, slippageBps = 150 }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountLamports),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: "false",
  });
  const url = `${JUPITER_API}/quote?${params.toString()}`;
  let res;
  try {
    res = await fetchWithRetry(url, { mode: "cors", credentials: "omit" });
  } catch (err) {
    throw new Error(`Jupiter quote failed: ${err?.message || "network error"}`);
  }
  const payload = await res.json();
  if (!payload || typeof payload !== "object") throw new Error("Invalid Jupiter quote response");
  return payload;
}

// ── Jupiter: get swap transaction ─────────────────────────────────────────────
export async function getJupiterSwapTx({ quoteResponse, userPublicKey, wrapUnwrapSOL = true }) {
  let res;
  try {
    res = await fetchWithRetry(`${JUPITER_API}/swap`, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: userPublicKey.toString(),
        wrapAndUnwrapSol: wrapUnwrapSOL,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });
  } catch (err) {
    throw new Error(`Jupiter swap failed: ${err?.message || "network error"}`);
  }
  const json = await res.json();
  if (!json?.swapTransaction) throw new Error("Invalid Jupiter swap response");
  return json.swapTransaction; // base64-encoded VersionedTransaction
}

// ── Execute swap via connected wallet ────────────────────────────────────────
// signTransaction: from useWallet() wallet adapter
export async function executeSwap({ swapTransactionBase64, signTransaction, connection }) {
  const txBuf = Buffer.from(swapTransactionBase64, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  const signed = await signTransaction(tx);
  const rawTx = signed.serialize();
  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  // Wait for confirmation
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latestBlockhash }, "confirmed");
  return sig;
}

// ── Fetch current token price via DexScreener ────────────────────────────────
export async function fetchCurrentPrice(tokenAddress) {
  try {
    const res = await fetchWithRetry(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`, {
      mode: "cors",
      credentials: "omit",
    }, 2);
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    // Use highest-liquidity pair
    const best = pairs.sort((a, b) =>
      parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0)
    )[0];
    return parseFloat(best.priceUsd || 0);
  } catch {
    return null;
  }
}

// ── Position status helpers ───────────────────────────────────────────────────
export function calcPnl(position, currentPrice) {
  if (!position.entryPrice || !currentPrice) return null;
  const pct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const solPnl = (position.solSpent || 0) * (pct / 100);
  return { pct: parseFloat(pct.toFixed(2)), solPnl: parseFloat(solPnl.toFixed(6)) };
}

export function shouldTriggerExit(position, currentPrice) {
  if (!currentPrice || !position.entryPrice) return null;
  const pct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  if (pct <= -Math.abs(position.stopLossPct))  return { reason: "STOP_LOSS",   pct };
  if (pct >=  Math.abs(position.takeProfitPct)) return { reason: "TAKE_PROFIT", pct };
  return null;
}

// ── Default trade settings ────────────────────────────────────────────────────
export const DEFAULT_TRADE_SETTINGS = {
  stakeSOL:        0.1,    // SOL per trade
  takeProfitPct:   50,     // +50% exit
  stopLossPct:     20,     // -20% exit
  slippageBps:     200,    // 2% slippage tolerance
  maxPositions:    5,      // concurrent open positions
  minScore:        70,     // minimum scanner score to queue
  minConfidence:   60,     // minimum momentum confidence %
  requireMomentum: true,   // must have EARLY MOMENTUM or UPTREND signal
  cooldownMinutes: 30,     // don't re-enter same token within X min
  autoExecute:     false,  // manual approval required by default
};

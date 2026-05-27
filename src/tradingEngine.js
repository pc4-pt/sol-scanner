// ─── tradingEngine.js ─────────────────────────────────────────────────────────
// Jupiter Swap API v1  (api.jup.ag/swap/v1)
// Routed through /api/jupiter/quote and /api/jupiter/swap (Vercel serverless)
// so the API key never touches the browser.

import { VersionedTransaction } from "@solana/web3.js";

export const SOL_MINT      = "So11111111111111111111111111111111111111112";
export const PRICE_POLL_MS = 15000;

// ── Step 1: GET /api/jupiter/quote ────────────────────────────────────────────
export async function getQuote({ inputMint, outputMint, amountLamports, slippageBps = 200 }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount:      String(amountLamports),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: "false",
  });

  const res = await fetch(`/api/jupiter/quote?${params.toString()}`);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Jupiter quote failed (${res.status}): ${data?.error || JSON.stringify(data)}`);
  }
  if (data.error) {
    throw new Error(`Jupiter quote error: ${data.error}`);
  }
  return data; // quoteResponse
}

// ── Step 2: POST /api/jupiter/swap ────────────────────────────────────────────
// Returns a base64-encoded serialized VersionedTransaction ready to sign.
export async function getSwapTransaction({ quoteResponse, userPublicKey }) {
  const res = await fetch("/api/jupiter/swap", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey:              userPublicKey.toString(),
      wrapAndUnwrapSol:           true,
      dynamicComputeUnitLimit:    true,
      prioritizationFeeLamports:  "auto",
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Jupiter swap failed (${res.status}): ${data?.error || JSON.stringify(data)}`);
  }
  if (!data.swapTransaction) {
    throw new Error(`Jupiter returned no swapTransaction: ${JSON.stringify(data)}`);
  }
  return data.swapTransaction; // base64 string
}

// ── Step 3: Deserialise, sign and send ───────────────────────────────────────
export async function signAndSend({ swapTransactionBase64, signTransaction, connection }) {
  // browser-safe base64 decode (no Buffer needed)
  const binary = atob(swapTransactionBase64);
  const bytes  = Uint8Array.from(binary, c => c.charCodeAt(0));
  const tx     = VersionedTransaction.deserialize(bytes);

  // Triggers Phantom / Solflare popup
  const signed = await signTransaction(tx);
  const rawTx  = signed.serialize();

  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight:       false,
    maxRetries:          3,
    preflightCommitment: "confirmed",
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const result = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (result.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
  }
  return sig;
}

// ── Full buy flow ─────────────────────────────────────────────────────────────
export async function executeBuySwap({
  inputMint, outputMint, amountLamports,
  slippageBps, publicKey, signTransaction, connection,
}) {
  // 1. Quote
  const quote = await getQuote({ inputMint, outputMint, amountLamports, slippageBps });

  // Guard: price impact
  const priceImpact = parseFloat(quote.priceImpactPct || 0);
  if (priceImpact > 5) {
    throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}% (limit 5%)`);
  }

  // 2. Build transaction
  const swapTxBase64 = await getSwapTransaction({ quoteResponse: quote, userPublicKey: publicKey });

  // 3. Sign + send
  const sig = await signAndSend({ swapTransactionBase64: swapTxBase64, signTransaction, connection });

  return {
    sig,
    outAmount:   parseInt(quote.outAmount || 0),
    priceImpact,
    inAmountSol: amountLamports / 1_000_000_000,
  };
}

// ── Full sell flow ────────────────────────────────────────────────────────────
export async function executeSellSwap({
  tokenMint, tokenAmount, slippageBps,
  publicKey, signTransaction, connection,
}) {
  const quote = await getQuote({
    inputMint:      tokenMint,
    outputMint:     SOL_MINT,
    amountLamports: tokenAmount,
    slippageBps,
  });

  const swapTxBase64 = await getSwapTransaction({ quoteResponse: quote, userPublicKey: publicKey });
  const sig = await signAndSend({ swapTransactionBase64: swapTxBase64, signTransaction, connection });

  return {
    sig,
    solReceived: parseInt(quote.outAmount || 0) / 1_000_000_000,
  };
}

// ── Fetch current price from DexScreener ─────────────────────────────────────
export async function fetchCurrentPrice(tokenAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`);
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs) || !pairs.length) return null;
    const best = pairs.sort(
      (a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0)
    )[0];
    return parseFloat(best.priceUsd || 0) || null;
  } catch { return null; }
}

// ── PnL helpers ───────────────────────────────────────────────────────────────
export function calcPnl(position, currentPrice) {
  if (!position.entryPrice || !currentPrice) return null;
  const pct    = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const solPnl = (position.solSpent || 0) * (pct / 100);
  return { pct: parseFloat(pct.toFixed(2)), solPnl: parseFloat(solPnl.toFixed(6)) };
}

export function shouldTriggerExit(position, currentPrice) {
  if (!currentPrice || !position.entryPrice) return null;
  const pct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  if (pct <= -Math.abs(position.stopLossPct))   return { reason: "STOP_LOSS",   pct };
  if (pct >=  Math.abs(position.takeProfitPct)) return { reason: "TAKE_PROFIT", pct };
  return null;
}

export const DEFAULT_TRADE_SETTINGS = {
  stakeSOL:        0.1,
  takeProfitPct:   50,
  stopLossPct:     20,
  slippageBps:     200,
  maxPositions:    5,
  minScore:        70,
  minConfidence:   60,
  requireMomentum: true,
  cooldownMinutes: 30,
  autoExecute:     false,
};

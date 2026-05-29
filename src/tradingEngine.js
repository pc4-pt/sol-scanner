// ─── tradingEngine.js ─────────────────────────────────────────────────────────
// Jupiter Swap API v1  (api.jup.ag/swap/v1)
// Routed through /api/quote and /api/swap (Vercel serverless)
// Uses Phantom-recommended signAndSendTransaction flow to minimise warnings.

import { VersionedTransaction } from "@solana/web3.js";

export const SOL_MINT      = "So11111111111111111111111111111111111111112";
export const PRICE_POLL_MS = 15000;

// ── Step 1: GET /api/quote ────────────────────────────────────────────────────
export async function getQuote({ inputMint, outputMint, amountLamports, slippageBps = 200 }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount:           String(amountLamports),
    slippageBps:      String(slippageBps),
    onlyDirectRoutes: "false",
  });

  const res  = await fetch(`/api/quote?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(`Jupiter quote failed (${res.status}): ${data?.error || JSON.stringify(data)}`);
  if (data.error) throw new Error(`Jupiter quote error: ${data.error}`);
  return data;
}

// ── Step 2: POST /api/swap ────────────────────────────────────────────────────
// dynamicSlippage: when true, Jupiter calculates optimal slippage based on the
// current routing and overrides the slippageBps from the quote. This is much
// more reliable for volatile tokens than fixed slippage.
export async function getSwapTransaction({ quoteResponse, userPublicKey, dynamicSlippage = false }) {
  const body = {
    quoteResponse,
    userPublicKey:             userPublicKey.toString(),
    wrapAndUnwrapSol:          true,
    dynamicComputeUnitLimit:   true,
    prioritizationFeeLamports: "auto",
  };
  if (dynamicSlippage) {
    body.dynamicSlippage = { maxBps: 3000 }; // allow Jupiter up to 30% if needed
  }

  const res = await fetch("/api/swap", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Jupiter swap build failed (${res.status}): ${data?.error || JSON.stringify(data)}`);
  if (!data.swapTransaction) throw new Error(`No swapTransaction in response: ${JSON.stringify(data)}`);
  return data.swapTransaction; // base64 string
}

// ── Step 3: Simulate, then sign+send via Phantom ──────────────────────────────
// Uses Phantom's recommended signAndSendTransaction for best simulation support.
// Falls back to manual sendRawTransaction if provider method unavailable.
export async function signAndSend({ swapTransactionBase64, signTransaction, connection }) {
  // Decode base64 → VersionedTransaction (browser-safe, no Buffer)
  const binary = atob(swapTransactionBase64);
  const bytes  = Uint8Array.from(binary, c => c.charCodeAt(0));
  const tx     = VersionedTransaction.deserialize(bytes);

  // ── Pre-flight simulation (sigVerify: false as Phantom docs recommend) ──────
  // This catches failures before Phantom opens, preventing simulation warnings.
  try {
    const sim = await connection.simulateTransaction(tx, { sigVerify: false });
    if (sim.value.err) {
      const logs    = sim.value.logs?.join("\n") || "";
      const errStr  = JSON.stringify(sim.value.err);

      // Jupiter slippage errors come through as Custom error codes, not log messages.
      // 6001 (0x1771), 6024 are both slippage-related from the Jupiter aggregator.
      const isSlippageCustom = /"Custom":(6001|6024|6017)/.test(errStr);
      const isSlippageLog    = logs.includes("SlippageToleranceExceeded") ||
                               logs.includes("Slippage tolerance") ||
                               logs.includes("0x1771");

      if (logs.includes("insufficient funds") || logs.includes("insufficient lamports")) {
        throw new Error("Insufficient SOL balance for this trade (including fees).");
      }
      if (isSlippageCustom || isSlippageLog) {
        throw new Error("SLIPPAGE_EXCEEDED");
      }
      throw new Error(`Transaction simulation failed: ${errStr}\n${logs.slice(0, 200)}`);
    }
  } catch (err) {
    // Re-throw recognised errors so the caller can react
    if (err.message === "SLIPPAGE_EXCEEDED" ||
        err.message.includes("Insufficient") ||
        err.message.includes("simulation failed")) {
      throw err;
    }
    // Simulation infra error (RPC issue etc) — log and proceed anyway
    console.warn("[tradingEngine] simulation skipped:", err.message);
  }

  // ── Sign and send ─────────────────────────────────────────────────────────
  // Try Phantom's preferred signAndSendTransaction first (better UX, fewer warnings)
  const provider = window?.phantom?.solana || window?.solana;

  if (provider?.signAndSendTransaction) {
    try {
      const { signature } = await provider.signAndSendTransaction(tx);
      // Wait for confirmation
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const result = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      if (result.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
      }
      return signature;
    } catch (err) {
      // User rejected — propagate immediately
      if (err.message?.includes("User rejected") || err.code === 4001) {
        throw new Error("Transaction cancelled by user.");
      }
      // Other error — fall through to manual method
      console.warn("[tradingEngine] signAndSendTransaction failed, trying manual:", err.message);
    }
  }

  // ── Fallback: signTransaction + sendRawTransaction ─────────────────────────
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
  const quote = await getQuote({ inputMint, outputMint, amountLamports, slippageBps });

  const priceImpact = parseFloat(quote.priceImpactPct || 0);
  if (priceImpact > 5) {
    throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}% (limit 5%)`);
  }

  const swapTxBase64 = await getSwapTransaction({ quoteResponse: quote, userPublicKey: publicKey });

  let sig;
  try {
    sig = await signAndSend({ swapTransactionBase64: swapTxBase64, signTransaction, connection });
  } catch (err) {
    if (err.message === "SLIPPAGE_EXCEEDED") {
      throw new Error("Slippage tolerance exceeded — price moved too fast. Increase slippage in Settings and try again.");
    }
    throw err;
  }

  return {
    sig,
    outAmount:   parseInt(quote.outAmount || 0),
    priceImpact,
    inAmountSol: amountLamports / 1_000_000_000,
  };
}

// ── Full sell flow ────────────────────────────────────────────────────────────
// Sells often hit slippage on take-profit triggers because we're selling
// tokens that just pumped — price can move 5-30% between quote and execution.
// Strategy: three escalating attempts, each with a fresh quote from current state.
//   1. Configured slippage (e.g. 2%)
//   2. 3x slippage capped at 15%
//   3. Jupiter dynamicSlippage — Jupiter calculates the right amount itself
export async function executeSellSwap({
  tokenMint, tokenAmount, slippageBps,
  publicKey, signTransaction, connection,
}) {
  const attempt = async (bps, useDynamicSlippage = false) => {
    // ALWAYS fetch a fresh quote — using a stale quote causes slippage failures
    // because the on-chain price has moved since the original quote was built.
    const quote = await getQuote({
      inputMint:      tokenMint,
      outputMint:     SOL_MINT,
      amountLamports: tokenAmount,
      slippageBps:    bps,
    });

    const swapTxBase64 = await getSwapTransaction({
      quoteResponse: quote,
      userPublicKey: publicKey,
      dynamicSlippage: useDynamicSlippage,
    });
    const sig = await signAndSend({ swapTransactionBase64: swapTxBase64, signTransaction, connection });

    return {
      sig,
      solReceived: parseInt(quote.outAmount || 0) / 1_000_000_000,
    };
  };

  // ── Attempt 1: user-configured slippage ─────────────────────────────────
  try {
    return await attempt(slippageBps);
  } catch (err) {
    if (err.message !== "SLIPPAGE_EXCEEDED") throw err;
    console.warn(`[tradingEngine] sell #1 failed at ${slippageBps}bps, retrying wider…`);
  }

  // Brief delay between attempts so the next quote reflects a fresh on-chain state
  await new Promise(r => setTimeout(r, 1500));

  // ── Attempt 2: 3x slippage capped at 15% ────────────────────────────────
  const widerBps = Math.min(slippageBps * 3, 1500);
  try {
    return await attempt(widerBps);
  } catch (err) {
    if (err.message !== "SLIPPAGE_EXCEEDED") throw err;
    console.warn(`[tradingEngine] sell #2 failed at ${widerBps}bps, trying Jupiter dynamicSlippage…`);
  }

  await new Promise(r => setTimeout(r, 1500));

  // ── Attempt 3: Jupiter dynamicSlippage (lets Jupiter pick the slippage) ─
  // maxBps 3000 = up to 30%, but Jupiter usually picks something sensible.
  // This is the most reliable mode for volatile tokens.
  try {
    return await attempt(widerBps, true);
  } catch (err) {
    if (err.message === "SLIPPAGE_EXCEEDED") {
      throw new Error(`Price moving too fast — couldn't execute sell even with Jupiter's dynamic slippage. Wait 30s for volatility to ease, then try a manual sell. Token may also have a transfer tax or honeypot mechanic.`);
    }
    throw err;
  }
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
  stakeSOL:           0.1,
  takeProfitPct:      50,
  stopLossPct:        20,
  slippageBps:        200,
  maxPositions:       5,
  minScore:           70,
  minConfidence:      60,
  minVolLiqRatio:     2.0,    // 24h volume / liquidity — filters dead pools
  requireMomentum:    true,
  scaleByConfidence:  true,   // scale stake linearly by signal confidence
  cooldownMinutes:    30,
  autoExecute:        false,
};

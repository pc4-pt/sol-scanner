// ─── tradingEngine.js ─────────────────────────────────────────────────────────
// Jupiter Swap API v1  (api.jup.ag/swap/v1)
// Routed through /api/quote and /api/swap (Vercel serverless)
// Uses Phantom-recommended signAndSendTransaction flow to minimise warnings.

import { VersionedTransaction, PublicKey } from "@solana/web3.js";

export const SOL_MINT      = "So11111111111111111111111111111111111111112";
export const PRICE_POLL_MS = 15000;

// ── Fetch actual on-chain token balance ────────────────────────────────────
// Critical for sells: the buy's quote.outAmount may differ from what actually
// landed in your wallet (transfer taxes, slippage on the buy, rounding).
// Always sell what you actually hold, not what you expected to receive.
export async function getTokenBalance(connection, ownerPubkey, tokenMint) {
  try {
    const owner = typeof ownerPubkey === "string" ? new PublicKey(ownerPubkey) : ownerPubkey;
    const mint  = typeof tokenMint   === "string" ? new PublicKey(tokenMint)   : tokenMint;

    // Find ALL token accounts owned by wallet for this mint (covers both
    // standard SPL and Token-2022 accounts, since they live in different programs)
    const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const token2022    = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

    let accounts = [];
    try {
      const r1 = await connection.getParsedTokenAccountsByOwner(owner, { mint, programId: tokenProgram });
      accounts = r1.value || [];
    } catch {}
    if (!accounts.length) {
      try {
        const r2 = await connection.getParsedTokenAccountsByOwner(owner, { mint, programId: token2022 });
        accounts = r2.value || [];
      } catch {}
    }

    if (!accounts.length) return 0;

    // Sum all account balances (usually just one, but defensive)
    let total = 0;
    for (const acc of accounts) {
      const amt = acc.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (amt) total += parseInt(amt, 10);
    }
    return total;
  } catch (err) {
    console.warn("[tradingEngine] getTokenBalance failed:", err.message);
    return null; // null = could not determine, caller should fall back
  }
}

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

      // Jupiter V6 aggregator error codes (from IDL):
      //   6001 (0x1771) — slippage tolerance exceeded
      //   6017          — exact-in amount not matched
      //   6024          — slippage tolerance exceeded (newer)
      //   6025          — exact-out amount not matched / not enough output
      // All are recoverable by widening slippage or fetching a fresh quote.
      const isSlippageCustom = /"Custom":(6001|6017|6024|6025|6026)/.test(errStr);
      const isSlippageLog    = logs.includes("SlippageToleranceExceeded") ||
                               logs.includes("Slippage tolerance") ||
                               logs.includes("ExactOutAmountNotMatched") ||
                               logs.includes("0x1771") ||
                               logs.includes("0x1779");

      if (logs.includes("insufficient funds") || logs.includes("insufficient lamports")) {
        throw new Error("Insufficient SOL balance for this trade (including fees).");
      }
      // Insufficient token balance — sell amount > what you actually hold
      if (logs.includes("Error: insufficient funds") ||
          logs.includes("0x1") && logs.includes("TokenAccount")) {
        throw new Error("INSUFFICIENT_TOKEN_BALANCE");
      }
      if (isSlippageCustom || isSlippageLog) {
        throw new Error("SLIPPAGE_EXCEEDED");
      }
      throw new Error(`Transaction simulation failed: ${errStr}\n${logs.slice(0, 200)}`);
    }
  } catch (err) {
    // Re-throw recognised errors so the caller can react
    if (err.message === "SLIPPAGE_EXCEEDED" ||
        err.message === "INSUFFICIENT_TOKEN_BALANCE" ||
        err.message.includes("Insufficient") ||
        err.message.includes("simulation failed")) {
      throw err;
    }
    // Simulation infra error (RPC issue etc) — log and proceed anyway
    console.warn("[tradingEngine] simulation skipped:", err.message);
  }

  // ── Sign and send ─────────────────────────────────────────────────────────
  // Phantom's signAndSendTransaction is preferred (better UX, fewer warnings).
  // Critical: if signAndSendTransaction returns a signature, we MUST NOT fall
  // back to manual sending — even if confirmation fails — or the same
  // transaction will be submitted twice and trigger "already processed" errors.
  const provider = window?.phantom?.solana || window?.solana;

  if (provider?.signAndSendTransaction) {
    let signature = null;
    try {
      const result = await provider.signAndSendTransaction(tx);
      signature = result.signature;
    } catch (err) {
      // User rejected — propagate immediately, don't fall through
      if (err.message?.includes("User rejected") ||
          err.message?.includes("rejected") ||
          err.code === 4001) {
        throw new Error("Transaction cancelled by user.");
      }
      // signAndSendTransaction itself failed before submission — safe to fall through
      console.warn("[tradingEngine] signAndSendTransaction failed before send, trying manual:", err.message);
    }

    // If we got a signature, the tx was submitted — do NOT fall through under any circumstances
    if (signature) {
      try {
        const latest = await connection.getLatestBlockhash("confirmed");
        const conf = await connection.confirmTransaction(
          { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          "confirmed"
        );
        if (conf.value.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
        }
      } catch (confErr) {
        // Confirmation step failed but tx was submitted — check chain directly
        // before giving up, since the tx may have actually landed.
        console.warn("[tradingEngine] confirmation step failed, checking on-chain:", confErr.message);
        try {
          const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
          if (status?.value?.confirmationStatus === "confirmed" ||
              status?.value?.confirmationStatus === "finalized") {
            // Transaction did land — success
            return signature;
          }
        } catch {}
        // Genuinely failed — but DON'T re-submit, just report
        throw new Error(`Transaction sent but confirmation timed out (sig: ${signature.slice(0,8)}…). Check Solscan to see if it landed.`);
      }
      return signature;
    }
  }

  // ── Fallback: signTransaction + sendRawTransaction ─────────────────────────
  // Only reached if provider.signAndSendTransaction is unavailable OR it threw
  // before submitting the transaction.
  const signed = await signTransaction(tx);
  const rawTx  = signed.serialize();

  const sig = await connection.sendRawTransaction(rawTx, {
    skipPreflight:       false,
    maxRetries:          3,
    preflightCommitment: "confirmed",
  });

  const latest2 = await connection.getLatestBlockhash("confirmed");
  const result2 = await connection.confirmTransaction(
    { signature: sig, blockhash: latest2.blockhash, lastValidBlockHeight: latest2.lastValidBlockHeight },
    "confirmed"
  );
  if (result2.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(result2.value.err)}`);
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
// Sells fail in two main ways:
//   1. Slippage — price moves between quote and execution
//   2. Amount mismatch — the position record says we have N tokens but actual
//      wallet balance is less (transfer taxes, prior partial sells, etc).
// We solve both by:
//   - Reading the real on-chain balance before each attempt
//   - Selling 99% of that (1% dust buffer for token-2022 rounding)
//   - Escalating slippage across 3 attempts with fresh quotes each time
export async function executeSellSwap({
  tokenMint, tokenAmount, slippageBps,
  publicKey, signTransaction, connection,
}) {
  // Determine the actual amount we can sell from the wallet right now.
  // If we can read the chain, prefer the real balance over the stored amount.
  let sellAmount = tokenAmount;
  try {
    const onChain = await getTokenBalance(connection, publicKey, tokenMint);
    if (onChain && onChain > 0) {
      // Use 99% to leave a tiny dust buffer; some Token-2022 mints round oddly
      // and selling the absolute max can fail with off-by-one errors.
      const safe = Math.floor(onChain * 0.99);
      if (safe > 0) {
        if (Math.abs(safe - tokenAmount) / Math.max(tokenAmount, 1) > 0.05) {
          console.warn(`[tradingEngine] sell amount adjusted: stored=${tokenAmount}, on-chain=${onChain}, selling=${safe}`);
        }
        sellAmount = safe;
      }
    }
  } catch (err) {
    console.warn("[tradingEngine] couldn't verify balance, using stored amount:", err.message);
  }

  if (!sellAmount || sellAmount <= 0) {
    throw new Error("No token balance available to sell. The position may have already been sold or transferred.");
  }

  const attempt = async (bps, useDynamicSlippage = false) => {
    // ALWAYS fetch a fresh quote
    const quote = await getQuote({
      inputMint:      tokenMint,
      outputMint:     SOL_MINT,
      amountLamports: sellAmount,
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

  // Helper: handle balance-mismatch error by reducing sellAmount and retrying
  const reduceAndRetry = async (bps, useDynamic) => {
    // Re-read balance fresh and try with 95% of that
    try {
      const onChain = await getTokenBalance(connection, publicKey, tokenMint);
      if (onChain && onChain > 0) {
        sellAmount = Math.floor(onChain * 0.95);
        console.warn(`[tradingEngine] reduced sell amount to ${sellAmount} after balance mismatch`);
      }
    } catch {}
    return attempt(bps, useDynamic);
  };

  // ── Attempt 1: user-configured slippage ─────────────────────────────────
  try {
    return await attempt(slippageBps);
  } catch (err) {
    if (err.message === "INSUFFICIENT_TOKEN_BALANCE") {
      console.warn("[tradingEngine] sell #1 — token balance mismatch, reducing and retrying");
      try { return await reduceAndRetry(slippageBps, false); }
      catch (err2) {
        if (err2.message !== "SLIPPAGE_EXCEEDED") throw err2;
      }
    } else if (err.message !== "SLIPPAGE_EXCEEDED") {
      throw err;
    }
    console.warn(`[tradingEngine] sell #1 failed at ${slippageBps}bps, retrying wider…`);
  }

  await new Promise(r => setTimeout(r, 1500));

  // ── Attempt 2: 3x slippage capped at 15% ────────────────────────────────
  const widerBps = Math.min(slippageBps * 3, 1500);
  try {
    return await attempt(widerBps);
  } catch (err) {
    if (err.message === "INSUFFICIENT_TOKEN_BALANCE") {
      try { return await reduceAndRetry(widerBps, false); }
      catch (err2) {
        if (err2.message !== "SLIPPAGE_EXCEEDED") throw err2;
      }
    } else if (err.message !== "SLIPPAGE_EXCEEDED") {
      throw err;
    }
    console.warn(`[tradingEngine] sell #2 failed at ${widerBps}bps, trying Jupiter dynamicSlippage…`);
  }

  await new Promise(r => setTimeout(r, 1500));

  // ── Attempt 3: Jupiter dynamicSlippage with fresh balance read ──────────
  try {
    // Final attempt: re-read balance once more in case it changed mid-flow
    try {
      const onChain = await getTokenBalance(connection, publicKey, tokenMint);
      if (onChain && onChain > 0) sellAmount = Math.floor(onChain * 0.95);
    } catch {}
    return await attempt(widerBps, true);
  } catch (err) {
    if (err.message === "SLIPPAGE_EXCEEDED") {
      throw new Error(`Price moving too fast — couldn't execute sell even with Jupiter's dynamic slippage. Wait 30s for volatility to ease, then try a manual sell. Token may also have a transfer tax or honeypot mechanic.`);
    }
    if (err.message === "INSUFFICIENT_TOKEN_BALANCE") {
      throw new Error(`Cannot sell — token balance doesn't match position record. Check your wallet on Solscan to see actual holdings. The token may have a transfer tax or you may have manually moved tokens.`);
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
  minVolLiqRatio:     2.0,
  requireMomentum:    true,
  scaleByConfidence:  true,
  cooldownMinutes:    30,
  autoExecute:        false,
  // ── Token safety (RugCheck) ─────────────────────────────────────────────
  enableSafetyCheck:  true,    // master toggle — calls RugCheck for each candidate
  maxRiskScore:       60,      // RugCheck normalised score 0-100, reject above
  allowUnprofiled:    false,   // if true, allow tokens RugCheck hasn't profiled yet
  blockHardFails:     true,    // reject mint/freeze authority, honeypot, rugged
  blockHighOwnership: true,    // reject top-10 high ownership danger flag
};

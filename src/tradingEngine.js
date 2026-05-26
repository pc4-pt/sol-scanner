// ─── tradingEngine.js ─────────────────────────────────────────────────────────
// Jupiter Swap API v2 — routed through /api/jupiter (Vercel serverless proxy).
// The API key lives in server-side env var JUPITER_API_KEY — never in the browser.

import {
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
} from "@solana/web3.js";

export const SOL_MINT      = "So11111111111111111111111111111111111111112";
export const PRICE_POLL_MS = 15000;

// ── Proxy URL builder ─────────────────────────────────────────────────────────
// In dev (Vite): /api/jupiter is forwarded by vite.config.js proxy to the fn
// In production (Vercel): /api/jupiter is the serverless function in /api/jupiter.js
function jupiterProxyUrl(jupiterPath, params = {}) {
  const url = new URL("/api/jupiter", window.location.origin);
  url.searchParams.set("path", jupiterPath);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  return url.toString();
}

// ── GET /swap/v2/build ────────────────────────────────────────────────────────
// Returns quote + all raw instructions needed to build the swap transaction.
export async function getJupiterBuild({
  inputMint,
  outputMint,
  amountLamports,
  takerPublicKey,
  slippageBps = 200,
}) {
  const url = jupiterProxyUrl("swap/v2/build", {
    inputMint,
    outputMint,
    amount:                     amountLamports,
    taker:                      takerPublicKey.toString(),
    slippageBps,
    computeUnitPricePercentile: "high",
    wrapAndUnwrapSol:           "true",
  });

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => String(res.status));
    // Surface the exact Jupiter error message for easy debugging
    throw new Error(`Jupiter /build failed (${res.status}): ${body}`);
  }

  return res.json();
}

// ── Assemble VersionedTransaction from raw instructions ───────────────────────
// /build returns discrete instruction objects; we compose them into a v0 tx.
export async function assembleTransaction({ build, connection, payerPublicKey }) {
  const {
    computeBudgetInstructions = [],
    setupInstructions         = [],
    swapInstruction,
    cleanupInstruction,
    otherInstructions         = [],
    addressesByLookupTableAddress,
  } = build;

  // Convert Jupiter's instruction format → @solana/web3.js format
  function toWeb3Ix(ix) {
    // Decode base64 instruction data without Buffer (browser-safe)
    const binStr = atob(ix.data);
    const data   = Uint8Array.from(binStr, c => c.charCodeAt(0));
    return {
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map(acc => ({
        pubkey:     new PublicKey(acc.pubkey),
        isSigner:   acc.isSigner,
        isWritable: acc.isWritable,
      })),
      data,
    };
  }

  const allIxs = [
    ...computeBudgetInstructions.map(toWeb3Ix),
    ...setupInstructions.map(toWeb3Ix),
    toWeb3Ix(swapInstruction),
    ...(cleanupInstruction ? [toWeb3Ix(cleanupInstruction)] : []),
    ...otherInstructions.map(toWeb3Ix),
  ];

  // Fresh blockhash
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // Load address lookup tables (needed for v0 transactions)
  let lookupTableAccounts = [];
  if (addressesByLookupTableAddress) {
    const entries = await Promise.all(
      Object.keys(addressesByLookupTableAddress).map(async (addr) => {
        const result = await connection.getAddressLookupTable(new PublicKey(addr));
        return result.value;
      })
    );
    lookupTableAccounts = entries.filter(Boolean);
  }

  const messageV0 = new TransactionMessage({
    payerKey:        payerPublicKey,
    recentBlockhash: blockhash,
    instructions:    allIxs,
  }).compileToV0Message(lookupTableAccounts);

  return new VersionedTransaction(messageV0);
}

// ── Sign and send via wallet adapter ─────────────────────────────────────────
export async function signAndSend({ transaction, signTransaction, connection }) {
  // Triggers Phantom / Solflare approval popup
  const signed = await signTransaction(transaction);
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

// ── Full buy: build → assemble → sign → send ─────────────────────────────────
export async function executeBuySwap({
  inputMint,
  outputMint,
  amountLamports,
  slippageBps,
  publicKey,
  signTransaction,
  connection,
}) {
  const build = await getJupiterBuild({
    inputMint,
    outputMint,
    amountLamports,
    takerPublicKey: publicKey,
    slippageBps,
  });

  const priceImpact = parseFloat(build.priceImpactPct || 0);
  if (priceImpact > 5) {
    throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}% — trade cancelled (limit 5%)`);
  }

  const tx = await assembleTransaction({ build, connection, payerPublicKey: publicKey });
  const sig = await signAndSend({ transaction: tx, signTransaction, connection });

  return {
    sig,
    outAmount:   parseInt(build.outAmount || 0),
    priceImpact,
    inAmountSol: amountLamports / 1_000_000_000,
  };
}

// ── Full sell: build → assemble → sign → send ────────────────────────────────
export async function executeSellSwap({
  tokenMint,
  tokenAmount,
  slippageBps,
  publicKey,
  signTransaction,
  connection,
}) {
  const build = await getJupiterBuild({
    inputMint:      tokenMint,
    outputMint:     SOL_MINT,
    amountLamports: tokenAmount,
    takerPublicKey: publicKey,
    slippageBps,
  });

  const tx = await signAndSend({
    transaction: await assembleTransaction({ build, connection, payerPublicKey: publicKey }),
    signTransaction,
    connection,
  });

  return {
    sig:         tx,
    solReceived: parseInt(build.outAmount || 0) / 1_000_000_000,
  };
}

// ── Fetch current token price from DexScreener ───────────────────────────────
export async function fetchCurrentPrice(tokenAddress) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${tokenAddress}`
    );
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs) || !pairs.length) return null;
    const best = pairs.sort(
      (a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0)
    )[0];
    return parseFloat(best.priceUsd || 0) || null;
  } catch {
    return null;
  }
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

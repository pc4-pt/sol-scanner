// ─── useTrading.js ────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  getJupiterQuote, getJupiterSwapTx, executeSwap,
  fetchCurrentPrice, calcPnl, shouldTriggerExit,
  DEFAULT_TRADE_SETTINGS, SOL_MINT, PRICE_POLL_MS,
} from "./tradingEngine.js";

// ── Storage helpers ───────────────────────────────────────────────────────────
const KEYS = { positions: "solscanner_positions", history: "solscanner_history", settings: "solscanner_settings" };
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useTrading() {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();

  const [settings,  setSettingsState] = useState(() => load(KEYS.settings,  DEFAULT_TRADE_SETTINGS));
  const [queue,     setQueue]         = useState([]);
  const [positions, setPositions]     = useState(() => load(KEYS.positions, []));
  const [history,   setHistory]       = useState(() => load(KEYS.history,   []));
  const [executing, setExecuting]     = useState({});
  const [notifications, setNotifs]   = useState([]);

  const priceMonitorRef = useRef(null);
  const cooldownRef     = useRef({});  // tokenAddress -> timestamp of last trade
  // FIX 1: track queued addresses in a ref so addToQueue always sees fresh state
  // without needing queue in its dependency array (which caused stale-closure dupes)
  const queuedAddrsRef  = useRef(new Set());
  const positionAddrsRef = useRef(new Set(
    positions.filter(p => p.status === "open").map(p => p.tokenAddress)
  ));

  useEffect(() => { save(KEYS.positions, positions); }, [positions]);
  useEffect(() => { save(KEYS.history,   history);   }, [history]);
  useEffect(() => { save(KEYS.settings,  settings);  }, [settings]);

  const updateSettings = useCallback((patch) => {
    setSettingsState(prev => ({ ...prev, ...patch }));
  }, []);

  // ── Notifications ─────────────────────────────────────────────────────────
  const notify = useCallback((msg, type = "info") => {
    const n = { id: Date.now() + Math.random(), msg, type, ts: new Date().toLocaleTimeString() };
    setNotifs(prev => [n, ...prev].slice(0, 20));
  }, []);

  const dismissNotif = useCallback((id) => {
    setNotifs(prev => prev.filter(n => n.id !== id));
  }, []);

  // ── Queue management ──────────────────────────────────────────────────────
  const addToQueue = useCallback((token, signal) => {
    const addr       = token.baseToken?.address;
    const pairAddr   = token.pairAddress;
    if (!addr || !pairAddr) return;

    // Cooldown check
    const lastTrade = cooldownRef.current[addr];
    if (lastTrade && Date.now() - lastTrade < settings.cooldownMinutes * 60000) return;

    // FIX 1: use refs so we always have fresh data, not stale closure values
    if (queuedAddrsRef.current.has(pairAddr))  return;  // already in queue
    if (positionAddrsRef.current.has(addr))    return;  // already have open position

    // Mark as queued immediately in the ref to prevent race-condition duplicates
    queuedAddrsRef.current.add(pairAddr);

    const entry = {
      id:            `q_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      pairAddress:   pairAddr,
      tokenAddress:  addr,
      symbol:        token.baseToken?.symbol || "?",
      name:          token.baseToken?.name   || "",
      priceUsd:      parseFloat(token.priceUsd || 0),
      score:         token._score || 0,
      signal,
      dexUrl:        `https://dexscreener.com/solana/${pairAddr}`,
      queuedAt:      Date.now(),
      stakeSOL:      settings.stakeSOL,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct:   settings.stopLossPct,
    };

    setQueue(prev => {
      // Double-check in state too — belt and braces
      if (prev.some(q => q.pairAddress === pairAddr)) {
        queuedAddrsRef.current.delete(pairAddr); // undo the ref add
        return prev;
      }
      notify(`${entry.symbol} added to queue (score ${entry.score})`, "queue");
      return [entry, ...prev].slice(0, 20);
    });
  }, [settings, notify]);

  const removeFromQueue = useCallback((id) => {
    setQueue(prev => {
      const item = prev.find(q => q.id === id);
      if (item) queuedAddrsRef.current.delete(item.pairAddress);
      return prev.filter(q => q.id !== id);
    });
  }, []);

  const updateQueueItem = useCallback((id, patch) => {
    setQueue(prev => prev.map(q => q.id === id ? { ...q, ...patch } : q));
  }, []);

  // ── Execute buy ───────────────────────────────────────────────────────────
  const executeBuy = useCallback(async (queueItem) => {
    if (!connected || !publicKey || !signTransaction) {
      notify("Wallet not connected — please connect Phantom or Solflare", "error");
      return;
    }

    const openCount = positions.filter(p => p.status === "open").length;
    if (openCount >= settings.maxPositions) {
      notify(`Max positions (${settings.maxPositions}) reached`, "warn");
      return;
    }

    // Prevent double-tap
    let alreadyExecuting = false;
    setExecuting(prev => {
      if (prev[queueItem.id]) {
        alreadyExecuting = true;
        return prev;
      }
      return { ...prev, [queueItem.id]: true };
    });
    if (alreadyExecuting) return;

    notify(`Getting quote for ${queueItem.symbol}…`, "info");

    try {
      const lamports    = Math.round(queueItem.stakeSOL * 1_000_000_000);
      const inAmountSol = lamports / 1_000_000_000;

      // 1. Quote
      const quote = await getJupiterQuote({
        inputMint:      SOL_MINT,
        outputMint:     queueItem.tokenAddress,
        amountLamports: lamports,
        slippageBps:    settings.slippageBps,
      });

      const outAmount   = parseInt(quote.outAmount || 0);
      const priceImpact = parseFloat(quote.priceImpactPct || 0);

      if (priceImpact > 5) {
        notify(`⚠ Price impact too high (${priceImpact.toFixed(1)}%) — trade cancelled`, "warn");
        setExecuting(prev => ({ ...prev, [queueItem.id]: false }));
        return;
      }

      notify(`Signing transaction for ${queueItem.symbol}…`, "info");

      // 2. Build swap tx
      const swapTxBase64 = await getJupiterSwapTx({
        quoteResponse: quote,
        userPublicKey: publicKey,
      });

      // 3. Sign + send (triggers wallet popup)
      const sig = await executeSwap({
        swapTransactionBase64: swapTxBase64,
        signTransaction,
        connection,
      });

      // 4. Record position
      const position = {
        id:             `pos_${Date.now()}`,
        pairAddress:    queueItem.pairAddress,
        tokenAddress:   queueItem.tokenAddress,
        symbol:         queueItem.symbol,
        name:           queueItem.name,
        entryPrice:     queueItem.priceUsd,
        currentPrice:   queueItem.priceUsd,
        solSpent:       inAmountSol,
        tokensReceived: outAmount,
        takeProfitPct:  queueItem.takeProfitPct,
        stopLossPct:    queueItem.stopLossPct,
        status:         "open",
        entryTx:        sig,
        entrySignal:    queueItem.signal,
        score:          queueItem.score,
        dexUrl:         queueItem.dexUrl,
        openedAt:       Date.now(),
        pnlPct:         0,
        pnlSol:         0,
      };

      // Update position tracking ref
      positionAddrsRef.current.add(queueItem.tokenAddress);
      queuedAddrsRef.current.delete(queueItem.pairAddress);

      setPositions(prev => [position, ...prev]);
      setQueue(prev => prev.filter(q => q.id !== queueItem.id));
      cooldownRef.current[queueItem.tokenAddress] = Date.now();

      notify(`✓ Bought ${queueItem.symbol} — ${sig.slice(0,8)}…`, "success");

    } catch (err) {
      const msg = err?.message || String(err);
      const detail = msg.includes("Failed to fetch") ? `${msg} (network/CORS issue?)` : msg;
      notify(`Buy failed: ${detail}`, "error");
      console.error("[executeBuy]", err);
    } finally {
      setExecuting(prev => ({ ...prev, [queueItem.id]: false }));
    }
  }, [connected, publicKey, signTransaction, connection, positions, settings, notify]);

  // ── Execute sell ──────────────────────────────────────────────────────────
  const executeSell = useCallback(async (position, reason = "MANUAL") => {
    if (!connected || !publicKey || !signTransaction) {
      notify("Wallet not connected", "error");
      return;
    }

    setExecuting(prev => ({ ...prev, [position.id]: true }));
    notify(`Selling ${position.symbol} (${reason})…`, "info");

    try {
      const tokenAmount = position.tokensReceived;
      if (!tokenAmount || tokenAmount <= 0) throw new Error("No token amount recorded for this position");

      const quote = await getJupiterQuote({
        inputMint:      position.tokenAddress,
        outputMint:     SOL_MINT,
        amountLamports: tokenAmount,
        slippageBps:    settings.slippageBps,
      });

      const swapTxBase64 = await getJupiterSwapTx({
        quoteResponse: quote,
        userPublicKey: publicKey,
      });

      const sig = await executeSwap({
        swapTransactionBase64: swapTxBase64,
        signTransaction,
        connection,
      });

      const solReceived = parseInt(quote.outAmount || 0) / 1_000_000_000;
      const pnlSol      = solReceived - position.solSpent;
      const pnlPct      = (pnlSol / position.solSpent) * 100;

      const closed = {
        ...position,
        status:     "closed",
        exitReason: reason,
        exitPrice:  position.currentPrice,
        exitTx:     sig,
        closedAt:   Date.now(),
        solReceived,
        pnlSol:     parseFloat(pnlSol.toFixed(6)),
        pnlPct:     parseFloat(pnlPct.toFixed(2)),
      };

      positionAddrsRef.current.delete(position.tokenAddress);
      setPositions(prev => prev.filter(p => p.id !== position.id));
      setHistory(prev => [closed, ...prev].slice(0, 100));

      const sign = pnlSol >= 0 ? "+" : "";
      notify(`${pnlSol >= 0 ? "✓" : "✗"} ${position.symbol} closed (${reason}) — ${sign}${pnlPct.toFixed(1)}% / ${sign}${pnlSol.toFixed(4)} SOL`, pnlSol >= 0 ? "success" : "warn");

    } catch (err) {
      const msg = err?.message || String(err);
      notify(`Sell failed: ${msg}`, "error");
      console.error("[executeSell]", err);
    } finally {
      setExecuting(prev => ({ ...prev, [position.id]: false }));
    }
  }, [connected, publicKey, signTransaction, connection, settings, notify]);

  // ── Price monitor ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (priceMonitorRef.current) clearInterval(priceMonitorRef.current);
    priceMonitorRef.current = setInterval(async () => {
      const open = positions.filter(p => p.status === "open");
      if (open.length === 0) return;
      for (const pos of open) {
        try {
          const price = await fetchCurrentPrice(pos.tokenAddress);
          if (!price) continue;
          const pnl  = calcPnl(pos, price);
          const exit = shouldTriggerExit(pos, price);
          setPositions(prev => prev.map(p =>
            p.id === pos.id
              ? { ...p, currentPrice: price, pnlPct: pnl?.pct ?? p.pnlPct, pnlSol: pnl?.solPnl ?? p.pnlSol }
              : p
          ));
          if (exit && !executing[pos.id]) {
            executeSell({ ...pos, currentPrice: price }, exit.reason);
          }
        } catch {}
      }
    }, PRICE_POLL_MS);
    return () => clearInterval(priceMonitorRef.current);
  }, [positions, executing, executeSell]);

  // ── Auto-queue from scanner results ──────────────────────────────────────
  const checkAndQueue = useCallback((tokens, classifyMomentum) => {
    const openCount = positions.filter(p => p.status === "open").length;
    if (openCount >= settings.maxPositions) return;

    for (const token of tokens) {
      if ((token._score || 0) < settings.minScore) continue;
      const signal = classifyMomentum(token);
      if (!signal) continue;
      if (signal.conf < settings.minConfidence) continue;
      if (settings.requireMomentum && !["EARLY MOMENTUM","UPTREND"].includes(signal.type)) continue;
      addToQueue(token, signal);
    }
  }, [settings, positions, addToQueue]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = {
    openCount:   positions.filter(p => p.status === "open").length,
    totalPnlSol: history.reduce((s, p) => s + (p.pnlSol || 0), 0),
    totalPnlPct: history.length ? history.reduce((s, p) => s + (p.pnlPct || 0), 0) / history.length : 0,
    winRate:     history.length ? (history.filter(p => p.pnlSol > 0).length / history.length) * 100 : 0,
    tradeCount:  history.length,
    queueCount:  queue.length,
  };

  return {
    settings, updateSettings,
    queue, addToQueue, removeFromQueue, updateQueueItem,
    positions, history,
    executing,
    notifications, dismissNotif,
    executeBuy, executeSell,
    checkAndQueue,
    stats,
    connected,
    walletAddress: publicKey?.toString(),
  };
}

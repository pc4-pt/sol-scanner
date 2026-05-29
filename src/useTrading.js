// ─── useTrading.js ────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  executeBuySwap, executeSellSwap,
  fetchCurrentPrice, calcPnl, shouldTriggerExit,
  DEFAULT_TRADE_SETTINGS, SOL_MINT, PRICE_POLL_MS,
} from "./tradingEngine.js";

// ── Storage ───────────────────────────────────────────────────────────────────
const KEYS = {
  positions: "solscanner_positions",
  history:   "solscanner_history",
  settings:  "solscanner_settings",
};
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ── Queue staleness threshold (10 minutes) ────────────────────────────────────
const QUEUE_STALE_MS = 10 * 60 * 1000;

// ── Queue sort ────────────────────────────────────────────────────────────────
const SIGNAL_PRIORITY = {
  "EARLY MOMENTUM": 5,
  "UPTREND":        4,
  "LATE RECOVERY":  3,
  "CONSOLIDATING":  2,
  "TOPPING OUT":    1,
};

export const QUEUE_SORT_OPTIONS = [
  { value: "priority",   label: "Signal Priority" },
  { value: "score",      label: "Score"           },
  { value: "confidence", label: "Confidence"      },
  { value: "newest",     label: "Newest First"    },
  { value: "oldest",     label: "Oldest First"    },
];

export function sortQueue(queue, sortBy) {
  return [...queue].sort((a, b) => {
    const aSig  = SIGNAL_PRIORITY[a.signal?.type] || 0;
    const bSig  = SIGNAL_PRIORITY[b.signal?.type] || 0;
    const aConf = a.signal?.conf || 0;
    const bConf = b.signal?.conf || 0;

    switch (sortBy) {
      case "priority":
        if (bSig !== aSig) return bSig - aSig;
        return (bConf * b.score) - (aConf * a.score);
      case "score":
        return b.score - a.score;
      case "confidence":
        return bConf - aConf;
      case "newest":
        return b.queuedAt - a.queuedAt;
      case "oldest":
        return a.queuedAt - b.queuedAt;
      default:
        return 0;
    }
  });
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useTrading() {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();

  const [settings,      setSettings]  = useState(() => load(KEYS.settings,  DEFAULT_TRADE_SETTINGS));
  const [queue,         setQueue]     = useState([]);
  const [queueSort,     setQueueSort] = useState("priority");
  const [positions,     setPositions] = useState(() => load(KEYS.positions, []));
  const [history,       setHistory]   = useState(() => load(KEYS.history,   []));
  const [executing,     setExecuting] = useState({});
  const [notifications, setNotifs]   = useState([]);

  const priceMonitorRef   = useRef(null);
  const cooldownRef       = useRef({});
  const queuedAddrsRef    = useRef(new Set());
  const positionAddrsRef  = useRef(new Set(
    positions.filter(p => p.status === "open").map(p => p.tokenAddress)
  ));
  // Always-current refs used inside intervals to avoid stale closures
  const positionsRef      = useRef(positions);
  const autoSellFiringRef = useRef(new Set());

  // Keep positionsRef current on every render
  useEffect(() => { positionsRef.current = positions; }, [positions]);

  // Persist to localStorage
  useEffect(() => { save(KEYS.positions, positions); }, [positions]);
  useEffect(() => { save(KEYS.history,   history);   }, [history]);
  useEffect(() => { save(KEYS.settings,  settings);  }, [settings]);

  const updateSettings = useCallback((patch) => {
    setSettings(prev => ({ ...prev, ...patch }));
  }, []);

  // ── Notifications ─────────────────────────────────────────────────────────
  const notify = useCallback((msg, type = "info") => {
    const n = { id: Date.now() + Math.random(), msg, type, ts: new Date().toLocaleTimeString() };
    setNotifs(prev => [n, ...prev].slice(0, 20));
  }, []);

  const dismissNotif = useCallback((id) => {
    setNotifs(prev => prev.filter(n => n.id !== id));
  }, []);

  // ── Queue: add ────────────────────────────────────────────────────────────
  // Compute confidence-scaled stake. Confidence 50 → 75% of base, 100 → 100%.
  // Floor 50%, so even lowest-confidence trades get half stake.
  const scaledStake = useCallback((conf) => {
    if (!settings.scaleByConfidence) return settings.stakeSOL;
    const mult = 0.5 + Math.min(1, (conf || 0) / 100) * 0.5;
    return Math.round(settings.stakeSOL * mult * 1000) / 1000;
  }, [settings.scaleByConfidence, settings.stakeSOL]);

  const addToQueue = useCallback((token, signal) => {
    const addr     = token.baseToken?.address;
    const pairAddr = token.pairAddress;
    if (!addr || !pairAddr) return;

    const last = cooldownRef.current[addr];
    if (last && Date.now() - last < settings.cooldownMinutes * 60000) return;

    if (queuedAddrsRef.current.has(pairAddr)) return;
    if (positionAddrsRef.current.has(addr))   return;

    queuedAddrsRef.current.add(pairAddr);

    const stake = scaledStake(signal?.conf);

    const entry = {
      id:            `q_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      pairAddress:   pairAddr,
      tokenAddress:  addr,
      symbol:        token.baseToken?.symbol || "?",
      name:          token.baseToken?.name   || "",
      priceUsd:      parseFloat(token.priceUsd || 0),
      initPriceUsd:  parseFloat(token.priceUsd || 0), // locked at queue time for delta calc
      score:         token._score || 0,
      signal,
      dexUrl:        `https://dexscreener.com/solana/${pairAddr}`,
      queuedAt:      Date.now(),
      lastUpdated:   Date.now(),
      degradeCount:  0,                                  // tracks consecutive weak/no-momentum scans
      stakeSOL:      stake,
      baseStakeSOL:  settings.stakeSOL,                  // original setting for display
      takeProfitPct: settings.takeProfitPct,
      stopLossPct:   settings.stopLossPct,
    };

    setQueue(prev => {
      if (prev.some(q => q.pairAddress === pairAddr)) {
        queuedAddrsRef.current.delete(pairAddr);
        return prev;
      }
      const stakeNote = settings.scaleByConfidence && stake !== settings.stakeSOL
        ? ` · ${stake} SOL (${signal?.conf || 0}% conf scaled)`
        : "";
      notify(`${entry.symbol} added to queue (score ${entry.score})${stakeNote}`, "queue");
      return [entry, ...prev].slice(0, 20);
    });
  }, [settings, notify, scaledStake]);

  // ── Queue: remove ─────────────────────────────────────────────────────────
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

    setExecuting(prev => {
      if (prev[queueItem.id]) return prev;
      return { ...prev, [queueItem.id]: true };
    });

    notify(`Getting quote for ${queueItem.symbol}…`, "info");

    try {
      const lamports = Math.round(queueItem.stakeSOL * 1_000_000_000);

      const { sig, outAmount, priceImpact, inAmountSol } = await executeBuySwap({
        inputMint:      SOL_MINT,
        outputMint:     queueItem.tokenAddress,
        amountLamports: lamports,
        slippageBps:    settings.slippageBps,
        publicKey,
        signTransaction,
        connection,
      });

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

      positionAddrsRef.current.add(queueItem.tokenAddress);
      queuedAddrsRef.current.delete(queueItem.pairAddress);
      cooldownRef.current[queueItem.tokenAddress] = Date.now();

      setPositions(prev => [position, ...prev]);
      setQueue(prev => prev.filter(q => q.id !== queueItem.id));

      notify(`✓ Bought ${queueItem.symbol} · impact ${priceImpact.toFixed(2)}% · tx ${sig.slice(0,8)}…`, "success");

    } catch (err) {
      const msg = err?.message || String(err);
      notify(`Buy failed: ${msg}`, "error");
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
    if (!position.tokensReceived || position.tokensReceived <= 0) {
      notify(`Cannot sell ${position.symbol}: no token amount recorded`, "error");
      return;
    }

    setExecuting(prev => ({ ...prev, [position.id]: true }));
    notify(`Selling ${position.symbol} (${reason})…`, "info");

    try {
      const { sig, solReceived } = await executeSellSwap({
        tokenMint:      position.tokenAddress,
        tokenAmount:    position.tokensReceived,
        slippageBps:    settings.slippageBps,
        publicKey,
        signTransaction,
        connection,
      });

      const pnlSol = solReceived - position.solSpent;
      const pnlPct = (pnlSol / position.solSpent) * 100;
      const sign   = pnlSol >= 0 ? "+" : "";

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

      notify(
        `${pnlSol >= 0 ? "✓" : "✗"} ${position.symbol} closed (${reason}) — ${sign}${pnlPct.toFixed(1)}% / ${sign}${pnlSol.toFixed(4)} SOL`,
        pnlSol >= 0 ? "success" : "warn"
      );

    } catch (err) {
      const msg = err?.message || String(err);
      notify(`Sell failed: ${msg}`, "error");
      console.error("[executeSell]", err);
    } finally {
      setExecuting(prev => ({ ...prev, [position.id]: false }));
    }
  }, [connected, publicKey, signTransaction, connection, settings, notify]);

  // ── Price monitor (15s interval) ──────────────────────────────────────────
  // Uses positionsRef (not positions state) to avoid stale closures and
  // re-creating the interval on every position update.
  // autoSellFiringRef prevents duplicate auto-sells for the same position.
  useEffect(() => {
    if (priceMonitorRef.current) clearInterval(priceMonitorRef.current);
    priceMonitorRef.current = setInterval(async () => {
      // Read from ref — always the latest positions without closure staleness
      const open = positionsRef.current.filter(p => p.status === "open");
      if (!open.length) return;
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
          if (exit && !autoSellFiringRef.current.has(pos.id)) {
            // Re-read from ref to get the absolute latest tokensReceived
            const freshPos = positionsRef.current.find(p => p.id === pos.id);
            if (!freshPos || freshPos.status !== "open") continue;
            if (!freshPos.tokensReceived || freshPos.tokensReceived <= 0) continue;
            autoSellFiringRef.current.add(pos.id);
            executeSell({ ...freshPos, currentPrice: price }, exit.reason)
              .finally(() => autoSellFiringRef.current.delete(pos.id));
          }
        } catch {}
      }
    }, PRICE_POLL_MS);
    return () => clearInterval(priceMonitorRef.current);
    // Only depends on executeSell — positionsRef and autoSellFiringRef are refs, not state
  }, [executeSell]);

  // ── Auto-queue + refresh + prune from scanner ─────────────────────────────
  // Called on every scan pass from App.jsx with the latest token list.
  // 1. New tokens meeting all criteria (including V/L ratio) → addToQueue
  // 2. Existing queue tokens seen in scan → refresh price/score/signal
  // 3. Tokens that degrade for 2+ consecutive scans → auto-remove
  // 4. Tokens that no longer meet hard criteria → auto-remove
  // 5. Tokens stale >10 min (not seen in scan) → auto-remove
  const checkAndQueue = useCallback((tokens, classifyMomentum) => {
    const openCount = positions.filter(p => p.status === "open").length;

    // Build a lookup map of this scan's tokens by pairAddress for O(1) access
    const scanMap = new Map(tokens.map(t => [t.pairAddress, t]));
    const now     = Date.now();

    // Helper to check V/L ratio quality gate
    const passesVolLiq = (token) => {
      const liq   = parseFloat(token.liquidity?.usd || 0);
      const vol24 = parseFloat(token.volume?.h24    || 0);
      if (liq <= 0) return false;
      return (vol24 / liq) >= (settings.minVolLiqRatio || 0);
    };

    setQueue(prev => {
      let updated = [...prev];
      const toRemove = new Set();

      // ── Refresh / prune existing queue items ────────────────────────────
      updated = updated.map(item => {
        const fresh = scanMap.get(item.pairAddress);

        // Not seen in this scan at all
        if (!fresh) {
          if (now - (item.lastUpdated || item.queuedAt) > QUEUE_STALE_MS) {
            toRemove.add(item.id);
            notify(`${item.symbol} removed from queue (signal gone)`, "warn");
          }
          return item;
        }

        // Token is in the scan — re-evaluate everything
        const signal    = classifyMomentum(fresh);
        const score     = fresh._score || 0;
        const meetsMin  = score >= settings.minScore;
        const meetsConf = signal && signal.conf >= settings.minConfidence;
        const meetsVL   = passesVolLiq(fresh);

        // Hard fails — remove immediately (regardless of degradation count)
        if (!signal || !meetsMin || !meetsConf || !meetsVL) {
          toRemove.add(item.id);
          const reason = !meetsVL ? "low volume" :
                         !meetsMin ? "score dropped" :
                         !signal ? "signal lost" :
                         "low confidence";
          notify(`${item.symbol} removed (${reason})`, "warn");
          return item;
        }

        // Signal degradation tracking — soft removal after 2 consecutive bad scans
        const isStrongSig = ["EARLY MOMENTUM","UPTREND","LATE RECOVERY"].includes(signal.type);
        const newDegrade  = isStrongSig ? 0 : (item.degradeCount || 0) + 1;

        if (settings.requireMomentum && newDegrade >= 2) {
          toRemove.add(item.id);
          notify(`${item.symbol} removed (momentum faded — ${signal.type})`, "warn");
          return item;
        }

        // Still qualifies — refresh
        return {
          ...item,
          priceUsd:     parseFloat(fresh.priceUsd || 0),
          score,
          signal,
          lastUpdated:  now,
          degradeCount: newDegrade,
        };
      });

      if (toRemove.size > 0) {
        updated = updated.filter(item => {
          if (toRemove.has(item.id)) {
            queuedAddrsRef.current.delete(item.pairAddress);
            return false;
          }
          return true;
        });
      }

      return updated;
    });

    // ── Add new qualifying tokens ──────────────────────────────────────────
    if (openCount < settings.maxPositions) {
      for (const token of tokens) {
        if ((token._score || 0) < settings.minScore) continue;
        if (!passesVolLiq(token)) continue;                       // V/L gate
        const signal = classifyMomentum(token);
        if (!signal) continue;
        if (signal.conf < settings.minConfidence) continue;
        if (settings.requireMomentum && !["EARLY MOMENTUM","UPTREND"].includes(signal.type)) continue;
        addToQueue(token, signal);
      }
    }
  }, [settings, positions, addToQueue, notify]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = {
    openCount:   positions.filter(p => p.status === "open").length,
    queueCount:  queue.length,
    totalPnlSol: history.reduce((s, p) => s + (p.pnlSol || 0), 0),
    totalPnlPct: history.length
      ? history.reduce((s, p) => s + (p.pnlPct || 0), 0) / history.length
      : 0,
    winRate:     history.length
      ? (history.filter(p => p.pnlSol > 0).length / history.length) * 100
      : 0,
    tradeCount: history.length,
  };

  return {
    settings, updateSettings,
    queue: sortQueue(queue, queueSort),
    queueSort, setQueueSort,
    addToQueue, removeFromQueue, updateQueueItem,
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

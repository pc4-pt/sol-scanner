// ─── safety.js ────────────────────────────────────────────────────────────────
// Token safety checks via RugCheck public API.
// Goal: filter out high-risk tokens BEFORE they reach the queue, so Phantom's
// "high risk" warnings disappear and you avoid honeypots / rugs proactively.
//
// RugCheck endpoint: GET https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary
// No auth required. Returns { score, score_normalised, risks: [...] }.

const RUGCHECK_URL = "https://api.rugcheck.xyz/v1/tokens";

// In-memory cache so we don't re-check the same token on every scan.
// RugCheck data doesn't change often once a token has been profiled (creator,
// mint authority, LP lock status all stabilise quickly).
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Risk severity classification ────────────────────────────────────────────
// RugCheck returns risks with level "warn" or "danger". We categorise them
// into hard-fails (always reject) and soft-fails (lower the safety score).
const HARD_FAIL_RISKS = new Set([
  "Mint Authority still enabled",   // creator can mint infinite supply
  "Freeze Authority still enabled", // creator can freeze your tokens
  "Honeypot",                       // you can buy but not sell
  "Rugged",                         // already identified as a rug
  "Copycat token",                  // imitating another token
  "Cannot Sell",                    // self-explanatory
]);

const HIGH_RISK_NAMES = new Set([
  "Top 10 holders high ownership",  // whale dump risk
  "Single holder ownership",        // one wallet controls supply
  "Low Liquidity",                  // can't exit
  "LP unlocked",                    // creator can rug
  "High ownership",
  "Transfer Tax",                   // can erode your position
]);

// ── Fetch RugCheck report (cached) ──────────────────────────────────────────
export async function getRugCheckReport(tokenAddress) {
  if (!tokenAddress) return null;

  const cached = cache.get(tokenAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await fetch(`${RUGCHECK_URL}/${tokenAddress}/report/summary`, {
      headers: { "Accept": "application/json" },
    });

    // 404 means RugCheck hasn't profiled this token yet — too new to assess.
    // Cache the null so we don't re-hammer the API; will retry after TTL.
    if (res.status === 404) {
      cache.set(tokenAddress, { ts: Date.now(), data: { unprofiled: true } });
      return { unprofiled: true };
    }
    if (!res.ok) {
      // 429 rate limit etc — don't cache the failure, will retry next scan
      console.warn(`[safety] RugCheck ${res.status} for ${tokenAddress.slice(0,8)}…`);
      return null;
    }

    const data = await res.json();
    const report = {
      score:          data.score ?? 0,
      scoreNorm:      data.score_normalised ?? 0, // 0-100, higher = riskier
      risks:          Array.isArray(data.risks) ? data.risks : [],
      rugged:         !!data.rugged,
      unprofiled:     false,
    };
    cache.set(tokenAddress, { ts: Date.now(), data: report });
    return report;
  } catch (err) {
    console.warn(`[safety] RugCheck fetch failed:`, err.message);
    return null;
  }
}

// ── Evaluate a report against thresholds ────────────────────────────────────
// Returns { safe: bool, reason: string, severity: "hard"|"high"|"medium"|"ok" }
export function evaluateReport(report, opts = {}) {
  const {
    maxRiskScore         = 60,      // 0-100 normalised, reject above this
    allowUnprofiled      = false,   // if true, accept tokens RugCheck doesn't know
    blockHardFails       = true,    // reject mint/freeze auth, honeypot, etc
    blockHighOwnership   = true,    // reject top-10 high ownership warnings
  } = opts;

  if (!report) {
    return { safe: false, reason: "RugCheck API unavailable", severity: "medium" };
  }

  if (report.unprofiled) {
    return allowUnprofiled
      ? { safe: true,  reason: "Not yet profiled by RugCheck", severity: "medium" }
      : { safe: false, reason: "Too new — no RugCheck profile yet", severity: "medium" };
  }

  if (report.rugged) {
    return { safe: false, reason: "Token marked as RUGGED by RugCheck", severity: "hard" };
  }

  // Hard-fail risks override everything
  if (blockHardFails) {
    for (const r of report.risks) {
      if (HARD_FAIL_RISKS.has(r.name)) {
        return { safe: false, reason: r.name, severity: "hard" };
      }
    }
  }

  // High-ownership warning (separate toggle so users can override)
  if (blockHighOwnership) {
    for (const r of report.risks) {
      if (HIGH_RISK_NAMES.has(r.name) && r.level === "danger") {
        return { safe: false, reason: `${r.name} (danger)`, severity: "high" };
      }
    }
  }

  // Numerical risk score gate
  if (report.scoreNorm > maxRiskScore) {
    return { safe: false, reason: `RugCheck risk score ${report.scoreNorm}/100 above limit (${maxRiskScore})`, severity: "high" };
  }

  // Warn-level risks present but acceptable — pass with note
  const warnRisks = report.risks.filter(r => r.level === "warn").map(r => r.name);
  if (warnRisks.length) {
    return { safe: true, reason: `Minor warnings: ${warnRisks.join(", ")}`, severity: "medium" };
  }

  return { safe: true, reason: "Clean RugCheck profile", severity: "ok" };
}

// ── One-call helper: check + evaluate ───────────────────────────────────────
export async function checkTokenSafety(tokenAddress, opts) {
  const report = await getRugCheckReport(tokenAddress);
  const result = evaluateReport(report, opts);
  return { ...result, report };
}

// ── Clear cache (useful for "force refresh" UI button) ──────────────────────
export function clearSafetyCache() {
  cache.clear();
}

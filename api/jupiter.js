// api/jupiter.js — Vercel serverless function (CommonJS)
// Proxies Jupiter Swap API v2 calls, injecting JUPITER_API_KEY server-side.
// Browser calls /api/jupiter?path=swap/v2/build&inputMint=...

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Verify API key is configured
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    console.error("[jupiter proxy] JUPITER_API_KEY env var not set");
    return res.status(500).json({
      error: "Server configuration error: JUPITER_API_KEY not set.",
    });
  }

  // The 'path' param contains the Jupiter endpoint, e.g. 'swap/v2/build'
  const { path: jupiterPath, ...queryParams } = req.query;

  if (!jupiterPath) {
    return res.status(400).json({ error: "Missing required 'path' query parameter." });
  }

  // Build upstream Jupiter URL with all forwarded query params
  const jupiterUrl = new URL(`https://api.jup.ag/${jupiterPath}`);
  Object.entries(queryParams).forEach(([k, v]) => {
    jupiterUrl.searchParams.set(k, Array.isArray(v) ? v[0] : v);
  });

  console.log(`[jupiter proxy] → ${req.method} ${jupiterUrl.toString()}`);

  try {
    const upstreamRes = await fetch(jupiterUrl.toString(), {
      method:  req.method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key":    apiKey,
      },
      body: req.method === "POST" && req.body
        ? JSON.stringify(req.body)
        : undefined,
    });

    const responseText = await upstreamRes.text();

    console.log(`[jupiter proxy] ← ${upstreamRes.status}`);

    return res
      .status(upstreamRes.status)
      .setHeader("Content-Type", "application/json")
      .send(responseText);

  } catch (err) {
    console.error("[jupiter proxy] fetch error:", err);
    return res.status(502).json({
      error: `Upstream Jupiter request failed: ${err.message}`,
    });
  }
};

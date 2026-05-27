// api/jupiter.js — Vercel serverless function (CommonJS)
// Two routes:
//   GET  /api/jupiter/quote  → proxies GET  api.jup.ag/swap/v1/quote
//   POST /api/jupiter/swap   → proxies POST api.jup.ag/swap/v1/swap

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "JUPITER_API_KEY not configured on server." });
  }

  // Determine which Jupiter endpoint to call based on the URL path
  // /api/jupiter/quote  → /swap/v1/quote
  // /api/jupiter/swap   → /swap/v1/swap
  const urlPath = req.url || "";
  let jupiterEndpoint;

  if (urlPath.includes("/quote")) {
    jupiterEndpoint = "https://api.jup.ag/swap/v1/quote";
  } else if (urlPath.includes("/swap")) {
    jupiterEndpoint = "https://api.jup.ag/swap/v1/swap";
  } else {
    return res.status(400).json({ error: "Unknown Jupiter endpoint. Use /api/jupiter/quote or /api/jupiter/swap" });
  }

  try {
    let upstreamRes;

    if (req.method === "GET") {
      // Forward all query params to Jupiter
      const params = new URLSearchParams(req.query || {});
      const url = `${jupiterEndpoint}?${params.toString()}`;
      console.log(`[jupiter] GET ${url}`);
      upstreamRes = await fetch(url, {
        headers: { "x-api-key": apiKey },
      });
    } else {
      // POST — forward JSON body
      console.log(`[jupiter] POST ${jupiterEndpoint}`);
      upstreamRes = await fetch(jupiterEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(req.body || {}),
      });
    }

    const text = await upstreamRes.text();
    console.log(`[jupiter] response ${upstreamRes.status}`);
    return res.status(upstreamRes.status).setHeader("Content-Type", "application/json").send(text);

  } catch (err) {
    console.error("[jupiter] error:", err.message);
    return res.status(502).json({ error: err.message });
  }
};

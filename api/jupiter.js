// api/jupiter.js
// Vercel Edge/Serverless function — proxies all Jupiter Swap API v2 calls.
// The JUPITER_API_KEY env var is server-side only (no VITE_ prefix).
// The browser calls /api/jupiter?path=swap/v2/build&... instead of api.jup.ag directly.

export default async function handler(req, res) {
  // CORS — allow requests from your deployed domain and localhost
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "JUPITER_API_KEY environment variable not set on the server.",
    });
  }

  // Extract the Jupiter path from the query string
  // e.g. ?path=swap/v2/build&inputMint=...&outputMint=...
  const { path, ...queryParams } = req.query;
  if (!path) {
    return res.status(400).json({ error: "Missing 'path' query parameter." });
  }

  // Build the upstream Jupiter URL, forwarding all other query params
  const jupiterUrl = new URL(`https://api.jup.ag/${path}`);
  Object.entries(queryParams).forEach(([k, v]) => {
    jupiterUrl.searchParams.set(k, v);
  });

  try {
    const upstreamRes = await fetch(jupiterUrl.toString(), {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      // Forward POST body if present
      body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
    });

    const text = await upstreamRes.text();

    res.status(upstreamRes.status)
       .setHeader("Content-Type", "application/json")
       .send(text);

  } catch (err) {
    res.status(502).json({ error: `Upstream Jupiter request failed: ${err.message}` });
  }
}

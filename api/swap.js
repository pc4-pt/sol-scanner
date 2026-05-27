// api/swap.js — proxies POST api.jup.ag/swap/v1/swap
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "JUPITER_API_KEY not set" });

  try {
    console.log("[swap] → POST api.jup.ag/swap/v1/swap");
    const upstream = await fetch("https://api.jup.ag/swap/v1/swap", {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key":    apiKey,
        "Accept":       "application/json",
      },
      body: JSON.stringify(req.body || {}),
    });
    const text = await upstream.text();
    console.log("[swap] ←", upstream.status);
    return res.status(upstream.status)
              .setHeader("Content-Type", "application/json")
              .send(text);
  } catch (err) {
    console.error("[swap] error:", err.message);
    return res.status(502).json({ error: err.message });
  }
};

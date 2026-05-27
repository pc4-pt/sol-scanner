// api/quote.js — proxies GET api.jup.ag/swap/v1/quote
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "JUPITER_API_KEY not set" });

  try {
    const params = new URLSearchParams(req.query || {});
    const url = `https://api.jup.ag/swap/v1/quote?${params.toString()}`;
    console.log("[quote] →", url);
    const upstream = await fetch(url, {
      headers: { "x-api-key": apiKey, "Accept": "application/json" },
    });
    const text = await upstream.text();
    console.log("[quote] ←", upstream.status);
    return res.status(upstream.status)
              .setHeader("Content-Type", "application/json")
              .send(text);
  } catch (err) {
    console.error("[quote] error:", err.message);
    return res.status(502).json({ error: err.message });
  }
};

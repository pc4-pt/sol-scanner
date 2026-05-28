export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "JUPITER_API_KEY not set" });
  try {
    const r = await fetch("https://api.jup.ag/swap/v1/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "Accept": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const t = await r.text();
    return res.status(r.status).setHeader("Content-Type", "application/json").send(t);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
// api/test.js - temporary diagnostic endpoint
export default async function handler(req, res) {
  const apiKey = process.env.JUPITER_API_KEY;
  
  // Test Jupiter with the key
  const url = "https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=200";
  
  const r = await fetch(url, {
    headers: { 
      "x-api-key": apiKey,
      "Accept": "application/json"
    }
  });
  
  const text = await r.text();
  
  return res.status(200).json({
    keyPresent: !!apiKey,
    keyLength: apiKey ? apiKey.length : 0,
    keyPreview: apiKey ? apiKey.substring(0, 12) + "..." : "none",
    jupiterStatus: r.status,
    jupiterResponse: text.substring(0, 200)
  });
}

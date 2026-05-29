// api/test.js - test swap endpoint access
export default async function handler(req, res) {
  const apiKey = process.env.JUPITER_API_KEY;

  // First get a quote
  const quoteUrl = "https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=200";
  const quoteRes = await fetch(quoteUrl, { headers: { "x-api-key": apiKey } });
  const quote = await quoteRes.json();

  // Then test the swap endpoint with that quote
  const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "Accept": "application/json"
    },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: "11111111111111111111111111111111",
      wrapAndUnwrapSol: true,
    })
  });

  const swapText = await swapRes.text();

  return res.status(200).json({
    quoteStatus: quoteRes.status,
    swapStatus: swapRes.status,
    swapResponse: swapText.substring(0, 300)
  });
}

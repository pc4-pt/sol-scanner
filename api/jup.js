const TARGET_BASE = "https://quote-api.jup.ag/v6";

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  try {
    const targetPath = req.url.replace(/^\/api\/jup/, "") || "/";
    const targetUrl = `${TARGET_BASE}${targetPath}`;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    delete headers.connection;

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await getRawBody(req);
      if (body.length === 0) body = undefined;
    }

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (["transfer-encoding", "content-encoding", "connection"].includes(key)) return;
      res.setHeader(key, value);
    });

    const data = await response.arrayBuffer();
    res.end(Buffer.from(data));
  } catch (err) {
    res.status(502).json({ error: "Proxy error", details: err?.message || "unknown" });
  }
}

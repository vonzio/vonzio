/**
 * Ollama auth proxy — rewrites x-api-key to Authorization: Bearer.
 * The Anthropic SDK sends x-api-key, but Ollama Cloud expects Bearer auth.
 * Delete this file to remove Ollama support.
 */
const http = require("http");
const https = require("https");

const TARGET = process.env.OLLAMA_TARGET_URL || "https://ollama.com";
const PORT = parseInt(process.env.OLLAMA_PROXY_PORT || "11434", 10);
const { hostname, protocol } = new URL(TARGET);

const server = http.createServer((req, res) => {
  const apiKey = req.headers["x-api-key"] || "";
  const headers = { ...req.headers, authorization: `Bearer ${apiKey}`, host: hostname };
  delete headers["x-api-key"];

  const proxyReq = (protocol === "https:" ? https : http).request(
    `${TARGET}${req.url}`,
    { method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  req.pipe(proxyReq);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") process.exit(0);
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`ollama-proxy listening on 127.0.0.1:${PORT} -> ${TARGET}\n`);
});

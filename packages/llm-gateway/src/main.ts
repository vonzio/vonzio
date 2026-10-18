/** Entry point of the bundled daemon (/app/llm-gateway.cjs). */
import { configFromEnv, createServer } from "./server.js";
import { installProxyFetch } from "./proxy.js";

const config = configFromEnv();
const proxied = installProxyFetch();
const server = createServer(config);
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") process.exit(0); // already running for this container
  throw e;
});
server.listen(config.port, "127.0.0.1", () => {
  process.stdout.write(
    `llm-gateway (${config.mode}) listening on 127.0.0.1:${config.port} -> ${config.target || "chatgpt backend"}${proxied ? " via egress proxy" : ""}\n`,
  );
});

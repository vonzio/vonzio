import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A throwaway OpenAI-compatible LLM endpoint for E2E.
 *
 * The chat path calls the model provider SERVER-SIDE (the agent container, not
 * the browser), so Playwright's request interception can't touch it. The way
 * to make chat deterministic + free is to point a real credential at a fake
 * provider: this server speaks just enough of the OpenAI API for the model
 * picker (`GET /v1/models`) and a single chat turn (`POST /v1/chat/completions`,
 * both streaming and non-streaming) to succeed, returning a canned reply.
 *
 * Usage (see chat.spec.ts):
 *   const mock = await startMockProvider();
 *   // create an openai-compatible credential whose base URL is mock.url
 *   // (reachable from the agent container — see chat.spec.ts for the
 *   //  host.docker.internal / compose-network wiring), then drive the UI.
 *   await mock.close();
 */

export const MOCK_MODEL = "mock-gpt";
export const MOCK_REPLY = "E2E pong — the mock provider is wired up.";

export interface MockProvider {
  /** Base URL to hand the app as the provider endpoint, e.g. http://host:port */
  url: string;
  port: number;
  /** Chat completions seen so far — assert the agent actually called us. */
  readonly requests: ReadonlyArray<unknown>;
  close: () => Promise<void>;
}

export async function startMockProvider(host = "0.0.0.0"): Promise<MockProvider> {
  const requests: unknown[] = [];

  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(json),
      });
      res.end(json);
    };

    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      send(200, {
        object: "list",
        data: [{ id: MOCK_MODEL, object: "model", owned_by: "vonzio-e2e" }],
      });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let parsed: { stream?: boolean } = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          /* keep the canned reply even if the body is unexpected */
        }
        requests.push(parsed);

        if (parsed.stream) {
          // Minimal SSE: one content delta then [DONE].
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const chunk = {
            id: "chatcmpl-e2e",
            object: "chat.completion.chunk",
            model: MOCK_MODEL,
            choices: [{ index: 0, delta: { content: MOCK_REPLY }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        send(200, {
          id: "chatcmpl-e2e",
          object: "chat.completion",
          model: MOCK_MODEL,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: MOCK_REPLY },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });
      return;
    }

    send(404, { error: { message: `mock-provider: unhandled ${req.method} ${req.url}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

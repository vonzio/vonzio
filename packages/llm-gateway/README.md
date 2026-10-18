# llm-gateway

The daemon that lets the Claude Agent SDK, which only speaks the Anthropic
Messages API, run on whichever provider the user connected. It listens on
`127.0.0.1:11434` inside the agent container; the orchestrator points
`ANTHROPIC_BASE_URL` at it and starts it per turn with the env below.

Two kinds of mode:

- **byok modes** (`openai`, `codex`): each `/v1/messages` request is
  translated to a [`@amenophis1er/byok/core`](https://github.com/amenophis1er/byok)
  `chat()` turn and the turn's events are written back as Anthropic SSE as they
  arrive. byok owns the protocols (Chat Completions, Responses, Gemini);
  this package owns the Anthropic wire format on both ends.
- **passthrough modes** (`ollama`, `passthrough`): the request is forwarded
  as Anthropic Messages. Ollama Cloud serves that API natively; `passthrough`
  with `LLM_GATEWAY_PASSTHROUGH_RAW=1` is how a native-Anthropic agent reaches
  the egress proxy, since the SDK ignores proxy env.

| Env | Meaning |
|---|---|
| `LLM_GATEWAY_MODE` | `openai` \| `codex` \| `ollama` \| `passthrough` |
| `LLM_GATEWAY_TARGET_URL` | byok `openai`: the API root (`…/v1`); passthrough: the upstream origin |
| `LLM_GATEWAY_PASSTHROUGH_RAW` | `1` keeps the client's own auth headers (native Anthropic) |
| `LLM_GATEWAY_DEFAULT_MODEL` / `/tmp/llm-gateway.model` | substitute for any `claude-*` id that reaches a non-Anthropic upstream |
| `CODEX_ACCOUNT_ID` | fallback `chatgpt-account-id` when the token carries none |
| `HTTPS_PROXY` / `HTTP_PROXY` | egress proxy; honoured for every upstream call |

The credential arrives per request as `x-api-key` (what the SDK sends for
`ANTHROPIC_API_KEY`).

Built with esbuild into one file, `dist/llm-gateway.cjs`, by a stage in
`docker/Dockerfile.agent.base`. This package is deliberately not a workspace
member: the image build installs it on its own, from its own lockfile.

```
npm ci && npm test && npm run build
LLM_GATEWAY_MODE=openai LLM_GATEWAY_TARGET_URL=https://api.openai.com/v1 node dist/llm-gateway.cjs
```

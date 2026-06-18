# Agent templates

Each `*.md` file here is one **agent template** shown in the dashboard's Agent
Gallery (Agents → Templates). Picking one seeds a new agent's editor — it does
**not** create a live agent until the user saves.

Templates are loaded and served by the server at `GET /v1/agent-templates`, so
**editing a file takes effect on the next server start — no rebuild needed.**
The file name (minus `.md`) is the template `id` unless you set `id:` in the
frontmatter.

## Format

YAML frontmatter (a small subset — scalars and `- ` lists) + a markdown body.
**The body becomes the agent's system prompt.**

> **Parser limits:** the frontmatter reader supports only top-level `key: value`
> scalars and `key:` + `- item` lists. Keys must be `[A-Za-z0-9_]`. Nested
> objects, inline `[a, b]` lists, and escaped quotes inside values are **not**
> supported (anything it can't parse is validated out and the template skipped
> with a warning). Quote a scalar only if it contains a leading/trailing space.

```markdown
---
id: my-agent              # optional; defaults to the filename
slug: my-agent            # optional; @mention slug seeded into the agent — defaults to the filename
name: My agent            # required — shown on the card + seeds the agent name
description: One-liner.    # required — card subtitle
category: Engineering     # required — cards are grouped by this
icon: Code2               # required — a lucide-react icon name (or an emoji)
about: A longer blurb shown on the card.        # optional
requirements:             # optional — a "Needs" checklist on the card
  - An API key
  - A connected git provider (optional)
examples:                 # optional — example prompts
  - Do the thing
egress:                   # optional — network allowlist (least privilege!)
  - github.com
model: claude-opus-4-8    # optional — default model
effort: high              # optional
tools:                    # optional — allowed tool names
  - Bash
setup:                    # optional — container setup commands
  - npm ci
---
You are a careful, concise assistant. (← this whole body is the system prompt)
```

### Fields

| Field | Required | Notes |
|-------|----------|-------|
| `name`, `description`, `category`, `icon` | yes | `icon` is a [lucide](https://lucide.dev/icons) name (e.g. `Code2`, `LifeBuoy`); an unknown value (or emoji) renders as-is |
| `id` | no | defaults to the filename |
| `slug` | no | @mention shortcut seeded into the agent; defaults to the filename |
| `about`, `requirements`, `examples` | no | card presentation |
| `egress` | no | network allowlist baked into the new agent; **keep it least-privilege** — only the hosts it truly needs. `["*"]` = unrestricted (avoid) |
| `model`, `effort`, `tools`, `setup` | no | seed the corresponding agent settings |
| _body_ | no (but recommended) | the system prompt |

## Overriding / adding your own

- **Add a template:** drop a new `.md` file here.
- **Override the built-ins without editing this dir:** set `AGENT_TEMPLATES_DIR`
  to a directory of your own `.md` files. Those are merged on top of the
  built-ins and **win by `id`**.

> **Security:** these files can set `egress` and `setup` commands that run inside
> agent containers. Treat the directory as **operator-trusted** — don't let
> untrusted users write template files.

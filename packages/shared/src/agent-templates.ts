/**
 * Shape of an agent template (Agent Gallery, feature 0025).
 *
 * Templates are authored as markdown-with-frontmatter under
 * `config/agent-templates/*.md` (operator-overridable without a rebuild — same
 * pattern as `config/system-prompt.md`). core-server loads + validates them and
 * serves them at `GET /v1/agent-templates`; the dashboard renders the cards and
 * seeds the new-agent editor via `/agents/new?template=<id>`.
 *
 * This module is the shared *contract* only — the data lives in files, not here.
 */
export interface AgentTemplate {
  /** Stable id (frontmatter `id`, defaults to the filename) — used in `?template=<id>`. */
  id: string;
  /** @mention slug seeded into the new agent (frontmatter `slug`, defaults to the filename/id). */
  slug: string;
  /** Display name; seeds the new agent's name. */
  name: string;
  /** One-line card description. */
  description: string;
  /** Grouping label (e.g. "Engineering", "Knowledge"). */
  category: string;
  /** Card icon — a lucide-react icon name (e.g. "Code2"); the dashboard maps it
   *  to a component and falls back to rendering the raw string (e.g. an emoji). */
  icon: string;
  /** Longer "what it does" blurb. */
  about?: string;
  /** What the user must supply for it to work (shown as a checklist). */
  requirements?: string[];
  /** A couple of example prompts. */
  examplePrompts?: string[];

  // --- profile seed fields (the markdown body becomes claude_md) ---
  claude_md?: string;
  model?: string;
  effort?: string;
  default_tools?: string[];
  default_egress_domains?: string[];
  setup_commands?: string[];
}

/**
 * Loads agent templates (Agent Gallery, feature 0025) from markdown-with-
 * frontmatter files. Operator-overridable without a rebuild — same pattern as
 * `config/system-prompt.md`.
 *
 * Sources, in order (later wins by `id`):
 *   1. built-in defaults: `<repo|/app>/config/agent-templates/*.md`
 *   2. override dir: `$AGENT_TEMPLATES_DIR/*.md` (operator-only — these files
 *      can set egress allowlists + setup commands, so treat the dir as trusted)
 *
 * Frontmatter is a deliberately small subset (scalars + simple `- ` lists) so we
 * need no YAML dependency; anything malformed is validated out (zod) and skipped
 * with a warning rather than crashing the server. The markdown body becomes the
 * agent's system prompt (`claude_md`).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AgentTemplate } from "@vonzio/shared";

const frontmatterSchema = z.object({
  id: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  icon: z.string().min(1),
  about: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
  egress: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  tools: z.array(z.string()).optional(),
  setup: z.array(z.string()).optional(),
});

/** Split a markdown file into its `---` frontmatter block + body. */
function splitFrontmatter(raw: string): { fm: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  return { fm: m[1], body: m[2].trim() };
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Minimal frontmatter parser: `key: scalar` and
 * `key:` followed by indented `- item` lines. Sufficient for our schema; not a
 * general YAML parser. Unknown shapes are ignored and caught by zod downstream.
 */
function parseFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = fm.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const inline = kv[2];
    if (inline.trim()) {
      out[key] = stripQuotes(inline);
      i++;
      continue;
    }
    // No inline value → collect following `- ` list items.
    const items: string[] = [];
    i++;
    while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
      items.push(stripQuotes(lines[i].replace(/^\s*-\s+/, "")));
      i++;
    }
    out[key] = items;
  }
  return out;
}

function toTemplate(fileId: string, fm: Record<string, unknown>, body: string): AgentTemplate | null {
  const parsed = frontmatterSchema.safeParse(fm);
  if (!parsed.success) {
    console.warn(`[agent-templates] skipping "${fileId}": ${parsed.error.issues.map((e) => e.path.join(".") + " " + e.message).join("; ")}`);
    return null;
  }
  const d = parsed.data;
  const id = d.id ?? fileId;
  return {
    id,
    slug: d.slug ?? id, // explicit frontmatter slug, else the filename/id
    name: d.name,
    description: d.description,
    category: d.category,
    icon: d.icon,
    about: d.about,
    requirements: d.requirements,
    examplePrompts: d.examples,
    claude_md: body || undefined,
    model: d.model,
    effort: d.effort,
    default_tools: d.tools,
    default_egress_domains: d.egress,
    setup_commands: d.setup,
  };
}

/** Built-in defaults dir: prefer cwd/config (the /app layout), fall back to a
 *  path relative to this module (covers `npm run dev` from the package dir). */
function builtinDir(): string | null {
  const candidates = [
    join(process.cwd(), "config", "agent-templates"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../config/agent-templates"),
    "/app/config/agent-templates", // baked-image path (mirrors system-prompt resolution)
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function loadDir(dir: string, into: Map<string, AgentTemplate>): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      // Template files only — skip the README and any _/.-prefixed helper files.
      (f) => f.toLowerCase().endsWith(".md") && !/^[_.]/.test(f) && f.toLowerCase() !== "readme.md",
    );
  } catch (err) {
    console.warn(`[agent-templates] could not read dir ${dir}:`, err instanceof Error ? err.message : err);
    return;
  }
  for (const f of files.sort()) {
    try {
      // Strip a leading UTF-8 BOM so the `^---` frontmatter match isn't defeated.
      const raw = readFileSync(join(dir, f), "utf8").replace(/^\uFEFF/, "");
      const split = splitFrontmatter(raw);
      if (!split) { console.warn(`[agent-templates] no frontmatter in ${f} — skipped`); continue; }
      const fm = parseFrontmatter(split.fm);
      const fileId = f.replace(/\.md$/, "");
      const tpl = toTemplate(fileId, fm, split.body);
      if (tpl) into.set(tpl.id, tpl); // later dir / later file wins by id
    } catch (err) {
      console.warn(`[agent-templates] failed to read ${f}:`, err instanceof Error ? err.message : err);
    }
  }
}

let cache: AgentTemplate[] | null = null;

/** Load all templates (built-in defaults ∪ override dir, override wins). Cached. */
export function loadAgentTemplates(): AgentTemplate[] {
  if (cache) return cache;
  const merged = new Map<string, AgentTemplate>();
  const builtin = builtinDir();
  if (builtin) loadDir(builtin, merged);
  const override = process.env.AGENT_TEMPLATES_DIR;
  if (override && existsSync(override)) loadDir(override, merged);
  cache = [...merged.values()];
  return cache;
}

/** Test/hot-reload escape hatch. */
export function clearAgentTemplateCache(): void {
  cache = null;
}

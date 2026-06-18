/**
 * Agent Gallery (feature 0025) — curated, one-click-import agent templates.
 * Cards render from the shared AGENT_TEMPLATES registry; "Use template" seeds
 * the new-agent editor via `/agents/new?template=<id>` (handled in EditAgent).
 */
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Sparkles, Bot,
  Code2, Telescope, LifeBuoy, BarChart3, ServerCog, Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { type AgentTemplate } from "@vonzio/shared";
import { useApi } from "../hooks/useApi.js";
import { fetchAgentTemplates } from "../api/client.js";
import { PageHeader, PageBody, Card, Button } from "../brand/components.js";

// Template `icon` frontmatter names a lucide icon so cards match the rest of
// the UI. Unknown names (or an emoji) fall back to being rendered as raw text,
// so custom/override templates aren't forced onto this set.
const ICON_MAP: Record<string, LucideIcon> = {
  Code2, Telescope, LifeBuoy, BarChart3, ServerCog, Image: ImageIcon, Bot, Sparkles,
};

function TemplateIcon({ name }: { name: string }) {
  const Icon = ICON_MAP[name];
  if (Icon) return <Icon size={20} style={{ color: "var(--vz-sodium)" }} />;
  return <span style={{ fontSize: 20, lineHeight: 1 }}>{name}</span>;
}

export function AgentGallery() {
  const navigate = useNavigate();
  const { data: templates, loading } = useApi<AgentTemplate[]>(() => fetchAgentTemplates());

  // Group templates by category, preserving first-seen order.
  const byCategory: Array<[string, AgentTemplate[]]> = [];
  for (const t of templates ?? []) {
    let bucket = byCategory.find(([c]) => c === t.category);
    if (!bucket) {
      bucket = [t.category, []];
      byCategory.push(bucket);
    }
    bucket[1].push(t);
  }

  return (
    <>
      <PageHeader
        title="Agent templates"
        lede="Start from a ready-made agent and tweak it — instead of a blank editor."
        actions={
          <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => navigate("/agents")}>
            Back to agents
          </Button>
        }
      />
      <PageBody>
        {loading && (
          <div style={{ padding: "48px 0", textAlign: "center", fontFamily: "var(--vz-font-mono)", fontSize: 12, color: "var(--vz-muted)" }}>
            loading…
          </div>
        )}
        {!loading && byCategory.length === 0 && (
          <div style={{ padding: "48px 0", textAlign: "center", fontSize: 13, color: "var(--vz-muted)" }}>
            No templates available. Add markdown files under <code>config/agent-templates/</code> (or start a blank agent).
          </div>
        )}
        {byCategory.map(([category, templates]) => (
          <div key={category} style={{ marginBottom: 28 }}>
            <div
              style={{
                fontFamily: "var(--vz-font-mono)",
                fontSize: 11,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--vz-muted-2)",
                marginBottom: 12,
              }}
            >
              {category}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: 16,
              }}
            >
              {templates.map((t) => (
                <Card key={t.id} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 18 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <TemplateIcon name={t.icon} />
                    <span style={{ fontWeight: 600, fontSize: 15 }}>{t.name}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--vz-muted)" }}>{t.about ?? t.description}</div>

                  {t.requirements && t.requirements.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      <div style={{ fontSize: 11, color: "var(--vz-muted-2)", marginBottom: 4 }}>Needs</div>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--vz-muted)" }}>
                        {t.requirements.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    icon={<Sparkles size={14} />}
                    onClick={() => navigate(`/agents/new?template=${t.id}`)}
                  >
                    Use template
                  </Button>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </PageBody>
    </>
  );
}

import { useState } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, Eye, EyeOff, Server, Wrench, Globe } from "lucide-react";
import { Button } from "./Button.js";
import { Input } from "./Input.js";
import { Badge } from "./Badge.js";
import { cn } from "../lib/utils.js";

export interface McpServerConfig {
  name: string;
  type: "sdk" | "stdio" | "http";
  tools?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface McpServerEditorProps {
  servers: McpServerConfig[];
  onChange: (servers: McpServerConfig[]) => void;
  /** Available SDK tool names (fetched from /admin/tools) */
  availableTools?: string[];
}

const serverTypeInfo = {
  sdk: {
    label: "Custom Tools",
    description: "Wrap your uploaded tool files as an in-process MCP server",
    icon: Wrench,
    badge: "info" as const,
  },
  stdio: {
    label: "Stdio Process",
    description: "Spawn an MCP server as a child process (e.g. npx @modelcontextprotocol/server-github)",
    icon: Server,
    badge: "default" as const,
  },
  http: {
    label: "HTTP Server",
    description: "Connect to a remote MCP server over HTTP",
    icon: Globe,
    badge: "warning" as const,
  },
};

export function McpServerEditor({ servers, onChange, availableTools }: McpServerEditorProps) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const addServer = (type: McpServerConfig["type"]) => {
    const base: McpServerConfig = { name: type === "sdk" ? "custom-tools" : "", type };
    if (type === "sdk") base.tools = [];
    if (type === "stdio") { base.command = ""; base.args = []; base.env = {}; }
    if (type === "http") { base.url = ""; base.headers = {}; }
    onChange([...servers, base]);
    setExpandedIdx(servers.length);
    setShowAddMenu(false);
  };

  const updateServer = (idx: number, patch: Partial<McpServerConfig>) => {
    onChange(servers.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const removeServer = (idx: number) => {
    onChange(servers.filter((_, i) => i !== idx));
    if (expandedIdx === idx) setExpandedIdx(null);
    else if (expandedIdx !== null && expandedIdx > idx) setExpandedIdx(expandedIdx - 1);
  };

  const toggleExpand = (idx: number) => {
    setExpandedIdx(expandedIdx === idx ? null : idx);
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">MCP Servers & Tools</label>

      {servers.length === 0 && !showAddMenu && (
        <p className="text-xs text-gray-400 mb-2">No MCP servers configured. Add one to extend your agent with custom tools or external integrations.</p>
      )}

      {/* Server cards */}
      <div className="space-y-2 mb-3">
        {servers.map((s, idx) => {
          const info = serverTypeInfo[s.type];
          const Icon = info.icon;
          const expanded = expandedIdx === idx;

          return (
            <div key={idx} className="border border-gray-200 rounded-lg overflow-hidden">
              {/* Header (collapsible) */}
              <div
                className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors"
                onClick={() => toggleExpand(idx)}
              >
                {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
                <Icon className="w-3.5 h-3.5 text-gray-500" />
                <Badge variant={info.badge}>{info.label}</Badge>
                <span className="text-sm text-gray-700 font-medium truncate">
                  {s.name || <span className="text-gray-400 italic">unnamed</span>}
                </span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeServer(idx); }}
                  className="p-1 text-gray-400 hover:text-red-500 cursor-pointer transition-colors"
                  title="Remove server"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Body (expanded) */}
              {expanded && (
                <div className="px-4 py-3 space-y-3 bg-white">
                  {s.type !== "sdk" && (
                    <Input
                      label="Server Name"
                      value={s.name}
                      onChange={(e) => updateServer(idx, { name: e.target.value })}
                      placeholder="e.g. github, my-api"
                    />
                  )}

                  {s.type === "sdk" && (
                    <SdkToolSelector
                      selected={s.tools ?? []}
                      available={availableTools ?? []}
                      onChange={(tools) => updateServer(idx, { tools })}
                    />
                  )}

                  {s.type === "stdio" && (
                    <>
                      <Input
                        label="Command"
                        value={s.command ?? ""}
                        onChange={(e) => updateServer(idx, { command: e.target.value })}
                        placeholder="e.g. npx, node, python"
                      />
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Arguments</label>
                        <input
                          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                          placeholder="e.g. -y, @modelcontextprotocol/server-github"
                          value={s.args?.join(", ") ?? ""}
                          onChange={(e) =>
                            updateServer(idx, {
                              args: e.target.value.split(",").map((a) => a.trim()).filter(Boolean),
                            })
                          }
                        />
                        <p className="text-xs text-gray-500 mt-1">Comma-separated list of command arguments</p>
                      </div>
                      <SecretKeyValueEditor
                        label="Environment Variables"
                        hint="Secrets like API tokens. These are encrypted at rest."
                        value={s.env ?? {}}
                        onChange={(env) => updateServer(idx, { env })}
                        keyPlaceholder="e.g. GITHUB_TOKEN"
                        valuePlaceholder="e.g. ghp_xxx..."
                      />
                    </>
                  )}

                  {s.type === "http" && (
                    <>
                      <Input
                        label="Server URL"
                        value={s.url ?? ""}
                        onChange={(e) => updateServer(idx, { url: e.target.value })}
                        placeholder="e.g. https://mcp.example.com/api"
                      />
                      <SecretKeyValueEditor
                        label="Headers"
                        hint="Request headers sent with every call. Secrets are encrypted at rest."
                        value={s.headers ?? {}}
                        onChange={(headers) => updateServer(idx, { headers })}
                        keyPlaceholder="e.g. Authorization"
                        valuePlaceholder="e.g. Bearer xxx..."
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add server */}
      {showAddMenu ? (
        <div className="border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-2">
          <p className="text-xs font-medium text-gray-700 mb-2">Choose server type:</p>
          {(["sdk", "stdio", "http"] as const).map((type) => {
            const info = serverTypeInfo[type];
            const Icon = info.icon;
            return (
              <button
                key={type}
                type="button"
                onClick={() => addServer(type)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left hover:bg-white border border-transparent hover:border-gray-200 transition-colors cursor-pointer"
              >
                <Icon className="w-4 h-4 text-gray-500 shrink-0" />
                <div>
                  <div className="text-sm font-medium text-gray-700">{info.label}</div>
                  <div className="text-xs text-gray-500">{info.description}</div>
                </div>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowAddMenu(false)}
            className="text-xs text-gray-500 hover:text-gray-700 cursor-pointer mt-1"
          >
            Cancel
          </button>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setShowAddMenu(true)}>
          <Plus className="w-3.5 h-3.5" /> Add MCP Server
        </Button>
      )}
    </div>
  );
}

/** SDK tool selector — pick from available tools */
function SdkToolSelector({
  selected,
  available,
  onChange,
}: {
  selected: string[];
  available: string[];
  onChange: (tools: string[]) => void;
}) {
  const [customInput, setCustomInput] = useState("");

  const toggle = (tool: string) => {
    if (selected.includes(tool)) {
      onChange(selected.filter((t) => t !== tool));
    } else {
      onChange([...selected, tool]);
    }
  };

  const addCustom = () => {
    const trimmed = customInput.trim();
    if (trimmed && !selected.includes(trimmed)) {
      onChange([...selected, trimmed]);
    }
    setCustomInput("");
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">Tools</label>
      {available.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {available.map((tool) => (
            <button
              key={tool}
              type="button"
              onClick={() => toggle(tool)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium border transition-colors cursor-pointer",
                selected.includes(tool)
                  ? "bg-accent/10 border-accent text-foreground"
                  : "bg-white border-gray-200 text-gray-500 hover:border-gray-300",
              )}
            >
              {tool}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400 mb-2">No tools uploaded yet. Go to the Tools tab to add some.</p>
      )}
      <div className="flex gap-1.5">
        <input
          className="flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
          placeholder="Or type a tool name..."
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
        />
        {customInput.trim() && (
          <button type="button" onClick={addCustom} className="px-2.5 py-1.5 text-xs font-medium text-accent hover:text-accent/80 cursor-pointer">
            Add
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-1">Select which of your custom tools this server should expose to the agent</p>
    </div>
  );
}

/** Key-value editor with secret visibility toggle */
function SecretKeyValueEditor({
  label,
  hint,
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  hint?: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const entries = Object.entries(value);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());

  const toggleVisibility = (key: string) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const update = (oldKey: string, newKey: string, newVal: string) => {
    const next = { ...value };
    if (oldKey !== newKey) {
      delete next[oldKey];
      // Move visibility
      setVisibleKeys((prev) => {
        const n = new Set(prev);
        if (n.has(oldKey)) { n.delete(oldKey); n.add(newKey); }
        return n;
      });
    }
    next[newKey] = newVal;
    onChange(next);
  };

  const remove = (key: string) => {
    const next = { ...value };
    delete next[key];
    onChange(next);
    setVisibleKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
  };

  const add = () => {
    let key = "";
    while (key in value) key += " ";
    onChange({ ...value, [key]: "" });
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {entries.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {entries.map(([k, v], idx) => (
            <div key={idx} className="flex gap-1.5 items-center">
              <input
                className="flex-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                placeholder={keyPlaceholder ?? "Key"}
                value={k}
                onChange={(e) => update(k, e.target.value, v)}
              />
              <div className="relative flex-1">
                <input
                  className="w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 pr-8 text-xs placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                  placeholder={valuePlaceholder ?? "Value"}
                  type={visibleKeys.has(k) ? "text" : "password"}
                  value={v}
                  onChange={(e) => update(k, k, e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => toggleVisibility(k)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-gray-600 cursor-pointer"
                  title={visibleKeys.has(k) ? "Hide value" : "Show value"}
                >
                  {visibleKeys.has(k) ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => remove(k)}
                className="p-1 text-gray-400 hover:text-red-500 cursor-pointer transition-colors"
                title="Remove"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent/80 cursor-pointer"
      >
        <Plus className="w-3 h-3" /> Add {label.toLowerCase().replace(/s$/, "")}
      </button>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

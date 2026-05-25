import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Send, Loader2, Paperclip, X, FileText, ChevronDown, Sparkles, Code, MessageSquare, Menu, Key, Square } from "lucide-react";
import { useUser } from "../contexts/UserContext.js";
import { useWorkspaces } from "../hooks/useWorkspaces.js";
import { useWorkspaceChat } from "../hooks/useWorkspaceChat.js";
import { useApi } from "../hooks/useApi.js";
import { useIsMobile, useIsNarrow } from "../hooks/use-mobile.js";
import { fetchProfiles, generateWorkspaceTitle, type ProfileSummary } from "../api/client.js";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar.js";
import { WorkspaceHeader } from "../components/WorkspaceHeader.js";
import { ModelPicker } from "../components/ModelPicker.js";
import { AgentPicker } from "../components/AgentPicker.js";
import { RightPanel, type TabId } from "../components/RightPanel.js";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet.js";
import { UserMenu } from "../components/UserMenu.js";
import { MessageList } from "../components/MessageList.js";
import { QuestionPicker } from "../components/ChatCore.js";
import { authClient } from "../lib/auth-client.js";

// ─── Helpers ────────────────────────────────────────────────────────

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type Attachment = {
  type: "image" | "document";
  media_type: string;
  data: string;
  name: string;
  preview?: string;
};

// ─── Component ──────────────────────────────────────────────────────

export function Workspace() {
  const navigate = useNavigate();
  const currentUser = useUser();
  const isAdmin = currentUser.role === "admin";
  const { id: routeId } = useParams<{ id: string }>();
  const { data: profiles } = useApi<ProfileSummary[]>(() => fetchProfiles());

  const { grouped, update, remove, refetch } = useWorkspaces();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(routeId ?? null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  // Pre-workspace model selection. The ModelPicker is now interactive in the
  // empty state — when the user picks a model BEFORE the first send, we
  // stash it here. handleSend applies it via `update(..., { model_override })`
  // right after the workspace is created, so the picked model is honored
  // on turn one. Cleared whenever the profile changes (a model only makes
  // sense relative to a profile's API key / provider).
  const [pendingModelOverride, setPendingModelOverride] = useState<string | null>(null);
  const [input, setInput] = useState(() => {
    if (!routeId) return "";
    try { return localStorage.getItem(`vonzio_draft_${routeId}`) ?? ""; } catch { return ""; }
  });
  const [pendingNew, setPendingNew] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrow();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auto-close right panel when viewport shrinks to narrow
  useEffect(() => {
    if (isNarrow && panelOpen) setPanelOpen(false);
  }, [isNarrow]);

  // Right panel state — restore from localStorage per workspace
  const [panelOpen, setPanelOpen] = useState(() => {
    if (!routeId) return true;
    try {
      const saved = localStorage.getItem(`vonzio_panel_${routeId}`);
      if (saved) return JSON.parse(saved).open ?? true;
    } catch {}
    return true;
  });
  const [panelTab, setPanelTab] = useState<TabId>(() => {
    if (!routeId) return "preview";
    try {
      const saved = localStorage.getItem(`vonzio_panel_${routeId}`);
      if (saved) return JSON.parse(saved).tab ?? "preview";
    } catch {}
    return "preview";
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => {
    if (!routeId) return null;
    try {
      const saved = localStorage.getItem(`vonzio_panel_${routeId}`);
      if (saved) return JSON.parse(saved).previewUrl ?? null;
    } catch {}
    return null;
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [previewRefresh, setPreviewRefresh] = useState(0);

  // Panel resize state
  const PANEL_MIN = 300;
  const PANEL_DEFAULT = 400;
  const [panelWidth, setPanelWidth] = useState(() => {
    if (!routeId) return PANEL_DEFAULT;
    try {
      const saved = localStorage.getItem(`vonzio_panel_${routeId}`);
      if (saved) return JSON.parse(saved).width ?? PANEL_DEFAULT;
    } catch {}
    return PANEL_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const maxWidth = Math.floor(window.innerWidth * 0.5);
      const newWidth = Math.max(PANEL_MIN, Math.min(maxWidth, startWidth + delta));
      setPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [panelWidth]);

  // Persist panel width alongside other panel state
  useEffect(() => {
    const wid = activeWorkspaceId;
    if (!wid) return;
    try {
      const existing = localStorage.getItem(`vonzio_panel_${wid}`);
      const parsed = existing ? JSON.parse(existing) : {};
      parsed.width = panelWidth;
      localStorage.setItem(`vonzio_panel_${wid}`, JSON.stringify(parsed));
    } catch {}
  }, [activeWorkspaceId, panelWidth]);

  // Save input draft to localStorage (called on every keystroke)
  function setInputWithDraft(value: string) {
    setInput(value);
    const wid = activeWorkspaceId;
    if (!wid) return;
    try {
      if (value) localStorage.setItem(`vonzio_draft_${wid}`, value);
      else localStorage.removeItem(`vonzio_draft_${wid}`);
    } catch {}
  }

  function clearDraft(wid: string) {
    try { localStorage.removeItem(`vonzio_draft_${wid}`); } catch {}
  }

  function restoreDraft(wid: string) {
    try {
      setInput(localStorage.getItem(`vonzio_draft_${wid}`) ?? "");
    } catch { setInput(""); }
  }

  // Persist panel state to localStorage
  useEffect(() => {
    const wid = activeWorkspaceId;
    if (!wid) return;
    try {
      localStorage.setItem(`vonzio_panel_${wid}`, JSON.stringify({ open: panelOpen, tab: panelTab, previewUrl }));
    } catch {}
  }, [activeWorkspaceId, panelOpen, panelTab, previewUrl]);

  // Restore panel state on workspace change
  useEffect(() => {
    if (!activeWorkspaceId) return;
    try {
      const saved = localStorage.getItem(`vonzio_panel_${activeWorkspaceId}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.open === "boolean") setPanelOpen(parsed.open);
        if (parsed.tab) setPanelTab(parsed.tab);
        if (typeof parsed.width === "number") setPanelWidth(parsed.width);
        setPreviewUrl(parsed.previewUrl ?? null);
      } else {
        setPreviewUrl(null);
      }
    } catch {
      setPreviewUrl(null);
    }
  }, [activeWorkspaceId]);

  // Auto-scroll state
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Get the active workspace's profile
  const allWorkspaces = [...grouped.starred, ...grouped.active, ...grouped.paused, ...grouped.archived];
  const activeWorkspace = allWorkspaces.find((w) => w.session_id === activeWorkspaceId);
  // Resolve activeProfile in this order: real workspace owner → user's
  // empty-state pick from AgentPicker → first profile. The middle case
  // matters so the ModelPicker (and the rest of the composer chrome) shows
  // models for the profile the user just picked, not whatever happens to
  // sit at profiles[0].
  const activeProfile =
    profiles?.find((p) => p.id === activeWorkspace?.profile_id) ??
    profiles?.find((p) => p.id === selectedProfileId) ??
    profiles?.[0];
  const profileName = activeProfile?.name ?? "Default";
  const defaultProfileId = profiles?.[0]?.id ?? "";
  const hasApiKey = activeProfile?.api_key_id ? true : false;

  // Derive the preview URL pattern from the template the server publishes
  // (e.g. "https://{container_id}-{port}.app.vonz.io" in prod,
  // "http://{container_id}-{port}.vonzio.localhost" in dev). Falls back to the
  // dev pattern if the server hasn't published one yet.
  const previewUrlTemplate = (typeof window !== "undefined"
    ? (window as unknown as { __VONZIO_PREVIEW_URL_TEMPLATE?: string }).__VONZIO_PREVIEW_URL_TEMPLATE
    : undefined) ?? "http://{container_id}-{port}.vonzio.localhost";

  const PREVIEW_URL_REGEX = useMemo(() => {
    // Translate the template into a regex: escape regex metas, then swap the
    // {container_id} and {port} placeholders for capture-friendly groups.
    const escaped = previewUrlTemplate.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped
      .replace("\\{container_id\\}", "[\\w-]+")
      .replace("\\{port\\}", "(\\d{4,5})")
      // Allow optional path/query after the host. The host portion ends at
      // the first slash, ?, ", ', whitespace, or other URL-stop chars.
      + "[^\\s)\"'*<>\\]`]*";
    // Allow http or https at the start so dev (http) and prod (https) both
    // match without per-environment branching.
    return new RegExp(pattern.replace(/^https?/, "https?"));
  }, [previewUrlTemplate]);

  // Build a concrete preview URL from container short-id + port using the template.
  const buildPreviewUrl = useCallback((shortId: string, port: string) => {
    return previewUrlTemplate
      .replace("{container_id}", shortId)
      .replace("{port}", port);
  }, [previewUrlTemplate]);

  // Scan text for a vonzio preview URL and open the Preview panel
  const openPreviewFromText = useCallback((text: string) => {
    const match = text.match(PREVIEW_URL_REGEX);
    if (match) {
      setPreviewUrl(match[0]);
      setPanelTab("preview");
      setPanelOpen(true);
    }
  }, [PREVIEW_URL_REGEX]);

  // Auto-show panel on tool results
  const handleToolResult = useCallback((tool: string, output: string) => {
    // First check for a full vonzio preview URL in the output
    const previewMatch = output.match(PREVIEW_URL_REGEX);
    if (previewMatch) {
      setPreviewUrl(previewMatch[0]);
      setPanelTab("preview");
      setPanelOpen(true);
      return;
    }
    if (tool === "Bash" && (output.includes("localhost:") || output.includes("0.0.0.0:"))) {
      const portMatch = output.match(/(?:localhost|0\.0\.0\.0):(\d{4,5})/);
      if (portMatch && activeWorkspace?.container_id) {
        const shortId = activeWorkspace.container_id.slice(0, 12);
        setPreviewUrl(buildPreviewUrl(shortId, portMatch[1]));
        setPanelTab("preview");
        setPanelOpen(true);
        return;
      }
    }
    if ((tool === "Write" || tool === "Edit") && output.includes("/workspace/")) {
      setPanelTab("files");
      setPanelOpen(true);
      // Auto-refresh preview when files in www are modified
      setPreviewRefresh((n) => n + 1);
    }
  }, [activeWorkspace?.container_id]);

  // Scan assistant text messages for preview URLs
  const handleAssistantMessage = useCallback((text: string) => {
    openPreviewFromText(text);
  }, [openPreviewFromText]);

  // Chat hook
  const chat = useWorkspaceChat({
    sessionId: activeWorkspaceId,
    profileId: activeWorkspace?.profile_id ?? defaultProfileId,
    onContainerIdChange: () => {},
    onToolResult: handleToolResult,
    onAssistantMessage: handleAssistantMessage,
    onTitleUpdate: (sid, name) => {
      refetch();
    },
    onTurnDone: () => {
      // After first turn, ask server to generate a smart title
      const wid = activeWorkspaceId;
      if (!wid) return;
      const ws = allWorkspaces.find((w) => w.session_id === wid);
      const name = ws?.name ?? "";
      const looksAuto = !name || name.endsWith("...") || name.startsWith("Workspace ") || name.startsWith("– ") || name.startsWith("- ") || name.length > 45;
      if (looksAuto) {
        generateWorkspaceTitle(wid).then(({ name: title }) => {
          if (title) refetch();
        }).catch(() => {});
      }
    },
    onLogEntry: (entry) => setLogs((prev) => [...prev, entry]),
  });

  // ─── Auto-focus input on mount ───────────────────────────────────
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 200);
  }, []);

  // ─── Auto-resize textarea ────────────────────────────────────────
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      const maxH = 6 * 24; // ~6 rows
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, maxH) + "px";
    }
  }, [input]);

  // ─── Auto-scroll ─────────────────────────────────────────────────
  function isNearBottom() {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function scrollToBottom(smooth = true) {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
    setUserScrolledUp(false);
    setShowScrollBtn(false);
  }

  useEffect(() => {
    if (!userScrolledUp) {
      scrollToBottom(false);
    }
  }, [chat.messages, userScrolledUp]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const near = isNearBottom();
    setUserScrolledUp(!near);
    setShowScrollBtn(!near);
  }

  // ─── Auto-focus after streaming ends ─────────────────────────────
  const prevStreamingRef = useRef(chat.streaming);
  useEffect(() => {
    if (prevStreamingRef.current && !chat.streaming) {
      inputRef.current?.focus();
    }
    prevStreamingRef.current = chat.streaming;
  }, [chat.streaming]);

  // ─── Attachments ─────────────────────────────────────────────────
  const processFile = useCallback((file: File) => {
    const isImage = file.type.startsWith("image/");
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      setAttachments((prev) => [...prev, {
        type: isImage ? "image" : "document",
        media_type: file.type,
        data: base64,
        name: file.name,
        preview: isImage ? (reader.result as string) : undefined,
      }]);
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) processFile(file);
        break;
      }
    }
  }, [processFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    for (const file of e.dataTransfer.files) {
      processFile(file);
    }
  }, [processFile]);

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // ─── Navigation ──────────────────────────────────────────────────

  /** Reset all workspace-specific state when switching or creating */
  function resetWorkspaceState() {
    setAttachments([]);
    setInput("");
    setPreviewUrl(null);
    setPreviewRefresh(0);
    setLogs([]);
    setUserScrolledUp(false);
    setShowScrollBtn(false);
    setDragOver(false);
  }

  function handleSelect(workspace: typeof allWorkspaces[0]) {
    resetWorkspaceState();
    setActiveWorkspaceId(workspace.session_id);
    setPendingNew(false);

    // Restore draft for the selected workspace
    restoreDraft(workspace.session_id);

    // Restore panel state for the selected workspace
    try {
      const saved = localStorage.getItem(`vonzio_panel_${workspace.session_id}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.open === "boolean") setPanelOpen(parsed.open);
        if (parsed.tab) setPanelTab(parsed.tab);
        if (parsed.previewUrl) setPreviewUrl(parsed.previewUrl);
        if (typeof parsed.width === "number") setPanelWidth(parsed.width);
      }
    } catch {}

    navigate(`/w/${workspace.session_id}`, { replace: true });
  }

  function handleCreate() {
    resetWorkspaceState();
    setActiveWorkspaceId(null);
    setPendingNew(true);
    setPanelOpen(false);
    setPanelTab("preview");
    setSelectedProfileId(defaultProfileId);
    setPendingModelOverride(null);
    navigate("/", { replace: true });
    // Auto-focus the input after render
    setTimeout(() => inputRef.current?.focus(), 100);
  }

  // ─── Send message ────────────────────────────────────────────────
  async function handleSend() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chat.streaming) return;
    const atts = attachments.length > 0
      ? attachments.map(({ type, media_type, data, name }) => ({ type, media_type, data, name }))
      : undefined;
    setInput("");
    if (activeWorkspaceId) clearDraft(activeWorkspaceId);
    setAttachments([]);
    setUserScrolledUp(false);

    if (!activeWorkspaceId) {
      const pid = selectedProfileId || defaultProfileId;
      if (!pid) return;
      const sessionId = await chat.startSession(pid);
      setActiveWorkspaceId(sessionId);
      setPendingNew(false);
      navigate(`/w/${sessionId}`, { replace: true });

      // Auto-name from first message (instant)
      if (text) {
        const autoName = text.length <= 40 ? text : text.slice(0, 40).replace(/\s+\S*$/, "") + "...";
        update(sessionId, { name: autoName });
      }

      // Apply the model the user chose in the empty state (if any). The
      // ModelPicker is editable pre-workspace, but `update()` needs a real
      // session_id; that exists only after startSession() resolves above.
      // Critical: AWAIT the update so the override is persisted before the
      // first turn fires — without await, the first chat.send() races and
      // may dispatch with the profile default instead of the user's pick.
      if (pendingModelOverride !== null) {
        try {
          await update(sessionId, { model_override: pendingModelOverride });
        } catch {
          // Persistence failure is non-fatal — the worst case is the first
          // turn uses the profile default. We still want to send.
        }
        setPendingModelOverride(null);
      }

      setTimeout(() => {
        chat.send(text, atts);
        refetch();
      }, 100);
      return;
    }

    chat.send(text, atts);
  }

  async function handleLogout() {
    await authClient.signOut();
    window.location.href = "/";
  }

  // ─── Agent status label ──────────────────────────────────────────
  const statusLabel = chat.agentStatus.state === "waiting"
    ? "Working..."
    : chat.agentStatus.state === "thinking"
      ? "Thinking..."
      : chat.agentStatus.state === "tool"
        ? `Running ${chat.agentStatus.tool}...`
        : null;

  // ─── Suggestion chips ────────────────────────────────────────────
  const suggestions = [
    { icon: <Code className="w-4 h-4" />, label: "Build a landing page", prompt: "Build me a responsive landing page with a hero section, features grid, and a contact form." },
    { icon: <Sparkles className="w-4 h-4" />, label: "Analyze some data", prompt: "Help me analyze a dataset. I'll share the file with you." },
    { icon: <MessageSquare className="w-4 h-4" />, label: "Write a script", prompt: "Write a Python script that automates a common task. What kind of task should we automate?" },
  ];

  function handleSuggestion(prompt: string) {
    setInputWithDraft(prompt);
    inputRef.current?.focus();
  }

  return (
    <div className={`flex h-full overflow-hidden ${isResizing ? "select-none cursor-col-resize" : ""}`} style={{ background: "var(--vz-page)" }}>
      {/* Sidebar — Sheet on narrow/mobile, inline on wide desktop */}
      {isNarrow ? (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" showCloseButton={false} className="w-64 p-0 gap-0">
            <SheetTitle className="sr-only">Chats</SheetTitle>
            <WorkspaceSidebar
              grouped={grouped}
              activeId={activeWorkspaceId}
              onSelect={(w) => { handleSelect(w); setSidebarOpen(false); }}
              onCreate={() => { handleCreate(); setSidebarOpen(false); }}
              onUpdate={(id, fields) => update(id, fields)}
              onDelete={async (id) => {
                await remove(id);
                if (activeWorkspaceId === id) handleCreate();
              }}
              inSheet
            />
          </SheetContent>
        </Sheet>
      ) : (
        <div className="flex flex-col h-full shrink-0">
          <WorkspaceSidebar
            grouped={grouped}
            activeId={activeWorkspaceId}
            onSelect={handleSelect}
            onCreate={handleCreate}
            onUpdate={(id, fields) => update(id, fields)}
            onDelete={async (id) => {
              await remove(id);
              if (activeWorkspaceId === id) handleCreate();
            }}
          />
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex min-w-0 min-h-0">
        {/* Conversation column (header + thread + composer) */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0" style={{ background: "var(--vz-page)" }}>
          {activeWorkspace ? (
            <WorkspaceHeader
              name={activeWorkspace.name}
              sessionId={activeWorkspace.session_id}
              status={activeWorkspace.status}
              connected={chat.connected}
              streaming={chat.streaming}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen(!panelOpen)}
              onToggleSidebar={isNarrow ? () => setSidebarOpen(true) : undefined}
              onRename={(name) => update(activeWorkspace.session_id, { name })}
              messages={chat.messages}
              workspaceName={activeWorkspace.name ?? "workspace"}
              profileName={profileName}
              modelOverride={activeWorkspace.model_override ?? null}
              profileDefaultModel={activeProfile?.model ?? null}
              profileId={activeProfile?.id}
            />
          ) : isNarrow && (
            // Empty-state header on narrow viewports — without it there'd be
            // no way to open the workspace list Sheet because the chat
            // sidebar is hidden and the WorkspaceHeader (which has the
            // hamburger) only renders for an active workspace.
            <div
              className="flex items-center gap-2"
              style={{
                padding: "0 14px",
                height: 44,
                flexShrink: 0,
                borderBottom: "1px solid var(--vz-border)",
                background: "var(--vz-page)",
              }}
            >
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="vz-action-btn"
                style={{ marginLeft: -4 }}
                aria-label="Open workspace list"
              >
                <Menu className="w-4 h-4" />
              </button>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--vz-ink)" }}>
                Workspaces
              </span>
            </div>
          )}

          <div className="flex-1 flex flex-col min-h-0 relative">
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto relative"
              style={{ paddingBottom: chat.messages.length > 0 ? 180 : 0 }}
              onScroll={handleScroll}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              {/* Drag overlay */}
              {dragOver && (
                <div
                  className="absolute inset-0 z-10 border-2 border-dashed rounded-lg flex items-center justify-center pointer-events-none"
                  style={{ background: "var(--vz-sodium-08)", borderColor: "var(--vz-sodium)" }}
                >
                  <div style={{ color: "var(--vz-sodium)", fontWeight: 500, fontSize: 14 }}>Drop files here</div>
                </div>
              )}

              {chat.messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
                  {!activeWorkspaceId || pendingNew ? (
                    <>
                      {/* Empty state — ready to start */}
                      <svg viewBox="0 0 512 512" className="w-10 h-10">
                        <circle cx="256" cy="256" r="256" fill="var(--vz-brand-tile)"/>
                        <polyline points="165,160 256,290 347,160" fill="none" stroke="var(--vz-brand-on-tile)" strokeWidth="50" strokeLinecap="round" strokeLinejoin="round"/>
                        <rect x="190" y="330" width="132" height="28" rx="14" fill="var(--vz-brand-on-tile)"/>
                      </svg>
                      <div className="text-center">
                        <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--vz-ink)" }}>How can I help?</h2>
                        <p className="text-sm text-muted-foreground">
                          {(profiles?.length ?? 0) > 1 ? "Select a profile and start a conversation" : "Start a conversation"}
                        </p>
                      </div>
                      {(profiles?.length ?? 0) > 1 && (
                        <AgentPicker
                          profiles={profiles!}
                          value={selectedProfileId || defaultProfileId || null}
                          onChange={(id) => {
                            setSelectedProfileId(id);
                            // A model override only makes sense relative to a
                            // profile's API key/provider — switching profile
                            // discards any in-flight model pick.
                            setPendingModelOverride(null);
                          }}
                        />
                      )}
                      {/* Suggestion chips moved out of the hero — they now
                          live in a horizontal strip directly above the
                          composer (see further down). Keeping the hero
                          spacious for the picker + question. */}
                    </>
                  ) : (
                    <>
                      {/* Empty state for existing workspace with no messages */}
                      <svg viewBox="0 0 512 512" className="w-10 h-10">
                        <circle cx="256" cy="256" r="256" fill="var(--vz-brand-tile)"/>
                        <polyline points="165,160 256,290 347,160" fill="none" stroke="var(--vz-brand-on-tile)" strokeWidth="50" strokeLinecap="round" strokeLinejoin="round"/>
                        <rect x="190" y="330" width="132" height="28" rx="14" fill="var(--vz-brand-on-tile)"/>
                      </svg>
                      <div className="text-center">
                        <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--vz-ink)" }}>How can I help?</h2>
                        <p className="text-sm text-muted-foreground">Send a message to get started</p>
                      </div>
                      {/* Suggestions live above the composer — see below. */}
                    </>
                  )}
                </div>
              ) : (
                <div className="max-w-3xl mx-auto py-4 px-4 space-y-1">
                  <MessageList
                    messages={chat.messages}
                    showTools={true}
                    streaming={chat.streaming}
                    containerId={chat.containerId}
                    profileId={activeWorkspace?.profile_id}
                  />
                </div>
              )}
            </div>

            {/* Scroll to bottom button */}
            {showScrollBtn && (
              <div className="relative">
                <button
                  onClick={() => scrollToBottom()}
                  className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs cursor-pointer transition-colors"
                  style={{
                    background: "var(--vz-card)",
                    border: "1px solid var(--vz-border)",
                    boxShadow: "var(--vz-shadow-md)",
                    color: "var(--vz-ink-3)",
                  }}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                  New messages
                </button>
              </div>
            )}

            {/* Floating bottom region — composer + status overlay the scroll
                area so messages flow underneath the composer (template-style). */}
            <div
              className="absolute left-0 right-0 bottom-0 px-4 pb-3 pt-6"
              style={{
                pointerEvents: "none",
                background:
                  chat.messages.length > 0
                    ? "linear-gradient(to bottom, transparent 0%, color-mix(in srgb, var(--vz-page) 92%, transparent) 35%, var(--vz-page) 70%)"
                    : "transparent",
              }}
            >
            {/* Agent status indicator */}
            {statusLabel && !chat.pendingQuestion && (
              <div className="px-0 pb-2" style={{ pointerEvents: "auto" }}>
                <div className="max-w-3xl mx-auto">
                  <div
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm"
                    style={{
                      background: "var(--vz-mute)",
                      border: "1px solid var(--vz-border)",
                      color: "var(--vz-muted)",
                    }}
                  >
                    <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--vz-sodium)" }} />
                    {statusLabel}
                  </div>
                </div>
              </div>
            )}

            {/* Question picker — replaces input area when active */}
            {chat.pendingQuestion ? (
              <div className="pt-2" style={{ pointerEvents: "auto" }}>
                <QuestionPicker
                  question={chat.pendingQuestion.question}
                  options={chat.pendingQuestion.options}
                  onSelect={(answer) => { chat.setPendingQuestion(null); chat.sendQuickReply(answer); }}
                  onSkip={() => { chat.setPendingQuestion(null); chat.sendQuickReply("skip"); }}
                />
              </div>
            ) : (

            /* Input area — floats at bottom */
            <div className="pt-2" style={{ pointerEvents: "auto" }}>
              {/* No API key warning */}
              {!hasApiKey && activeWorkspaceId && !pendingNew && (
                <div className="max-w-3xl mx-auto mb-2">
                  <div
                    className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm"
                    style={{
                      background: "rgba(245, 158, 11, 0.08)",
                      border: "1px solid rgba(245, 158, 11, 0.30)",
                      color: "var(--vz-warn)",
                    }}
                  >
                    <Key className="w-4 h-4 shrink-0" />
                    <span>No API key linked to this profile. <a href="/agents" style={{ textDecoration: "underline", fontWeight: 500 }}>Open Profiles</a> to attach one.</span>
                  </div>
                </div>
              )}
              <div className="max-w-3xl mx-auto">
                {/* Suggestion strip — anchored to the composer, only in
                    the empty state. Single horizontal row that scrolls
                    sideways if the user adds more suggestions later.
                    `vz-strip` hides the scrollbar (the global webkit
                    rule would otherwise paint a 10px bar under a 36px
                    strip). Suggestions grow horizontally, not vertically. */}
                {chat.messages.length === 0 && !chat.pendingQuestion && (
                  <div className="vz-strip mb-2" style={{ paddingBottom: 2 }}>
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => handleSuggestion(s.prompt)}
                        className="vz-chip"
                        style={{
                          fontFamily: "var(--vz-font-sans)",
                          fontSize: 12.5,
                          padding: "5px 12px",
                          gap: 6,
                        }}
                      >
                        {s.icon}
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
                <div
                  className="relative rounded-2xl transition-shadow"
                  style={{
                    background: "var(--vz-card)",
                    border: "1px solid var(--vz-border)",
                    boxShadow: "var(--vz-shadow-md)",
                    padding: 14,
                  }}
                  onDrop={handleDrop}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                >
                  {/* Attachment preview chips */}
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {attachments.map((att, idx) => (
                        <div
                          key={idx}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
                          style={{
                            background: "var(--vz-mute)",
                            border: "1px solid var(--vz-border)",
                            color: "var(--vz-ink-3)",
                          }}
                        >
                          {att.preview ? (
                            <img src={att.preview} alt="" className="w-6 h-6 rounded object-cover" />
                          ) : (
                            <FileText className="w-3.5 h-3.5" style={{ color: "var(--vz-fail)" }} />
                          )}
                          <span className="max-w-[120px] truncate">{att.name}</span>
                          <button
                            type="button"
                            onClick={() => removeAttachment(idx)}
                            className="cursor-pointer transition-colors"
                            style={{ color: "var(--vz-muted-2)" }}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Textarea */}
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInputWithDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
                    }}
                    onPaste={handlePaste}
                    placeholder={!hasApiKey && activeWorkspaceId ? "No API key linked…" : "Message vonzio…"}
                    disabled={chat.streaming || (!chat.connected && !!activeWorkspaceId) || (!hasApiKey && !!activeWorkspaceId && !pendingNew)}
                    rows={1}
                    className="w-full resize-none border-0 bg-transparent text-sm focus:outline-none"
                    style={{
                      color: "var(--vz-ink)",
                      fontFamily: "var(--vz-font-sans)",
                      minHeight: 24,
                      maxHeight: 200,
                      lineHeight: 1.5,
                      padding: 0,
                    }}
                  />

                  {/* Composer footer: tool chips · meta · send */}
                  <div className="flex items-center gap-2 mt-3">
                    {/* Tool chips */}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      title="Attach file"
                      style={{
                        width: 28, height: 28, borderRadius: "var(--vz-radius-sm)",
                        display: "grid", placeItems: "center",
                        background: "var(--vz-mute)",
                        border: "1px solid var(--vz-border)",
                        color: "var(--vz-muted)",
                        cursor: "pointer",
                        transition: "color var(--vz-fast) var(--vz-ease), border-color var(--vz-fast) var(--vz-ease)",
                      }}
                      onMouseEnter={(e) => { const el = e.currentTarget as HTMLElement; el.style.color = "var(--vz-ink)"; el.style.borderColor = "var(--vz-border-strong)"; }}
                      onMouseLeave={(e) => { const el = e.currentTarget as HTMLElement; el.style.color = "var(--vz-muted)"; el.style.borderColor = "var(--vz-border)"; }}
                    >
                      <Paperclip className="w-3.5 h-3.5" />
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="*/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        for (const f of e.target.files ?? []) processFile(f);
                        e.target.value = "";
                      }}
                    />

                    {/* Meta line: model picker · workspace context. Must be a
                        <div> (the ModelPicker renders a block-level wrapper
                        for its dropdown's absolute positioning; a <div>
                        inside a <span> is invalid HTML and breaks layout).
                        Do NOT add `truncate` here — its overflow:hidden
                        clips the upward-opening dropdown. Truncate only
                        the workspace-name span below. */}
                    <div
                      style={{
                        flex: 1,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 0,
                        fontFamily: "var(--vz-font-mono)",
                        fontSize: 11.5,
                        color: "var(--vz-muted)",
                        letterSpacing: "0.02em",
                        marginLeft: 4,
                        minWidth: 0,
                        overflow: "visible",
                      }}
                    >
                      {activeProfile?.id && (
                        <ModelPicker
                          profileId={activeProfile.id}
                          profileDefaultModel={activeProfile.model ?? null}
                          // Pre-workspace: show the pending pick if any (else
                          // the profile default). Post-workspace: persisted
                          // override wins. The picker treats `null` as "use
                          // profile default" in both modes.
                          value={
                            activeWorkspaceId
                              ? activeWorkspace?.model_override ?? null
                              : pendingModelOverride
                          }
                          onChange={(model) => {
                            if (activeWorkspaceId) {
                              update(activeWorkspaceId, { model_override: model });
                            } else {
                              // Stashed; applied in handleSend() right after
                              // the workspace is created so the first turn
                              // honors the user's choice.
                              setPendingModelOverride(model);
                            }
                          }}
                        />
                      )}
                      {activeWorkspace?.name && (
                        <>
                          <span style={{ color: "var(--vz-muted-2)", padding: "0 2px" }}> · </span>
                          <span className="truncate" style={{ minWidth: 0 }}>{activeWorkspace.name}</span>
                        </>
                      )}
                    </div>

                    {/* Send / Stop */}
                    {chat.streaming ? (
                      <button
                        onClick={() => chat.cancel()}
                        title="Stop agent"
                        style={{
                          background: "var(--vz-fail)", color: "#fff",
                          padding: "6px 14px", borderRadius: "var(--vz-radius-sm)",
                          fontFamily: "var(--vz-font-mono)", fontSize: 11.5, fontWeight: 600,
                          letterSpacing: "0.06em", textTransform: "uppercase",
                          display: "inline-flex", alignItems: "center", gap: 6,
                          border: 0, cursor: "pointer",
                        }}
                      >
                        <Square className="w-3 h-3 fill-current" />
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={handleSend}
                        disabled={(!chat.connected && !!activeWorkspaceId) || (!input.trim() && attachments.length === 0)}
                        style={{
                          background: "var(--vz-sodium)", color: "#fff",
                          padding: "6px 14px", borderRadius: "var(--vz-radius-sm)",
                          fontFamily: "var(--vz-font-mono)", fontSize: 11.5, fontWeight: 600,
                          letterSpacing: "0.06em", textTransform: "uppercase",
                          display: "inline-flex", alignItems: "center", gap: 8,
                          border: 0, cursor: "pointer",
                          opacity: (!chat.connected && !!activeWorkspaceId) || (!input.trim() && attachments.length === 0) ? 0.4 : 1,
                          pointerEvents: (!chat.connected && !!activeWorkspaceId) || (!input.trim() && attachments.length === 0) ? "none" : "auto",
                          transition: "background var(--vz-fast) var(--vz-ease)",
                        }}
                      >
                        Send
                        <span
                          className="vz-kbd"
                          style={{ background: "rgba(255,255,255,0.16)", borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.85)" }}
                        >
                          ⏎
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-[10px] text-center mt-1.5 select-none" style={{ color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
                  <kbd>shift + enter</kbd> for a new line
                </p>
              </div>
            </div>
            )}
            </div>
          </div>
        </div>

        {/* Right panel — sibling of conversation column, sits inside the
            main flex-row so its tabs row visually aligns with WorkspaceHeader. */}
        {panelOpen && activeWorkspaceId && (
          isNarrow ? (
            <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
              <SheetContent side="right" showCloseButton={false} className="w-[85vw] sm:max-w-[480px] p-0">
                <SheetTitle className="sr-only">Panel</SheetTitle>
                <RightPanel
                  workspaceId={activeWorkspaceId}
                  containerId={chat.containerId}
                  containerName={chat.containerName}
                  profileName={profileName}
                  workspaceStatus={activeWorkspace?.status ?? "unknown"}
                  persistent={activeWorkspace?.persistent ?? false}
                  createdAt={activeWorkspace?.created_at ?? new Date().toISOString()}
                  expiresAt={activeWorkspace?.expires_at ?? new Date().toISOString()}
                  previewUrl={previewUrl}
                  previewRefresh={previewRefresh}
                  isPublicPreview={activeWorkspace?.public_preview ?? false}
                  onTogglePublicPreview={(pub) => activeWorkspaceId && update(activeWorkspaceId, { public_preview: pub })}
                  logs={logs}
                  activeTab={panelTab}
                  onTabChange={setPanelTab}
                  onClose={() => setPanelOpen(false)}
                />
              </SheetContent>
            </Sheet>
          ) : (
            <>
              {/* Drag handle */}
              <div
                onMouseDown={handleResizeStart}
                className={`w-1 cursor-col-resize transition-colors flex-shrink-0 ${isResizing ? "" : ""}`}
                style={{
                  background: isResizing ? "var(--vz-sodium)" : "transparent",
                }}
                onMouseEnter={(e) => { if (!isResizing) (e.currentTarget as HTMLElement).style.background = "var(--vz-sodium-25)"; }}
                onMouseLeave={(e) => { if (!isResizing) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              />
              <div style={{ width: panelWidth, borderLeft: "1px solid var(--vz-border)" }} className="flex-shrink-0">
                <RightPanel
                  workspaceId={activeWorkspaceId}
                  containerId={chat.containerId}
                  containerName={chat.containerName}
                  profileName={profileName}
                  workspaceStatus={activeWorkspace?.status ?? "unknown"}
                  persistent={activeWorkspace?.persistent ?? false}
                  createdAt={activeWorkspace?.created_at ?? new Date().toISOString()}
                  expiresAt={activeWorkspace?.expires_at ?? new Date().toISOString()}
                  previewUrl={previewUrl}
                  previewRefresh={previewRefresh}
                  isPublicPreview={activeWorkspace?.public_preview ?? false}
                  onTogglePublicPreview={(pub) => activeWorkspaceId && update(activeWorkspaceId, { public_preview: pub })}
                  logs={logs}
                  activeTab={panelTab}
                  onTabChange={setPanelTab}
                  onClose={() => setPanelOpen(false)}
                />
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}

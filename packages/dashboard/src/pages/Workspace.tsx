import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Send, Loader2, Paperclip, X, FileText, ChevronDown, Sparkles, Code, MessageSquare, Menu, Key, Square, Target, Bot, Gamepad2, BarChart3, Search, Rocket, Globe, Plus, PanelLeftOpen, Mic, MicOff } from "lucide-react";
import { useUser } from "../contexts/UserContext.js";
import { useWorkspaces } from "../hooks/useWorkspaces.js";
import { useWorkspaceChat } from "../hooks/useWorkspaceChat.js";
import { useApi } from "../hooks/useApi.js";
import { useIsMobile, useIsNarrow } from "../hooks/use-mobile.js";
import { fetchProfiles, fetchUserAnthropicKeys, updateProfile, fetchPromptSuggestions, fetchWorkspacePorts, setPreviewAccess, type ProfileSummary, type UserAnthropicKey, type PromptSuggestion, type WorkspacePort, type PreviewPortMode } from "../api/client.js";
import { WorkspaceSidebar } from "../components/WorkspaceSidebar.js";
import { WorkspaceHeader } from "../components/WorkspaceHeader.js";
import { ModelPicker } from "../components/ModelPicker.js";
import { getComposerSlots } from "../registry/index.js";
import { useEntitlements } from "@vonzio/dashboard-registry";
import { useVoiceDictation, VOICE_LANGUAGES } from "@vonzio/dictation";
import { RightPanel, type TabId } from "../components/RightPanel.js";
import { extractOfficeDocPath, OPEN_DOCUMENT_EVENT } from "../components/document-utils.js";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet.js";
import { UserMenu } from "../components/UserMenu.js";
import { MessageList } from "../components/MessageList.js";
import { ThreadNavigator } from "../components/ThreadNavigator.js";
import { QuestionPicker } from "../components/ChatCore.js";
import { HOME_DRAFT_KEY, HOME_AGENT_KEY } from "./Home.js";
import { reopenOnboarding } from "../components/OnboardingHost.js";
import { Button, Select } from "../brand/components.js";
import { authClient } from "../lib/auth-client.js";

// Persistent composer history (shell-style ArrowUp recall), shared across all
// workspaces in this browser. Newest entry last; capped to keep it light.
const COMPOSER_HISTORY_KEY = "vonzio_composer_history";
const COMPOSER_HISTORY_MAX = 100;

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

// Extensions that, when loaded in the preview iframe, just dump source or
// trigger a download instead of rendering a page. We never auto-open the
// preview pane at one of these — otherwise an agent merely *mentioning*
// `organize_files.py` hijacks the viewer into rendering raw script source.
const NON_SERVABLE_PREVIEW_EXT = new Set([
  "py", "rb", "sh", "bash", "zsh", "ts", "tsx", "jsx", "mjs", "cjs",
  "go", "rs", "java", "kt", "c", "h", "cpp", "cc", "hpp", "php", "pl",
  "lua", "swift", "scala", "clj", "ex", "exs", "r",
  "md", "txt", "log", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "csv", "tsv", "sql", "env", "lock", "dockerfile", "makefile",
  // Office documents render in the deck's Document tab (#368), never in the
  // preview iframe (which would just trigger a download).
  "docx", "doc", "pptx", "ppt", "odt", "odp", "ods", "rtf", "xlsx", "xls",
]);

// Only auto-open the preview pane for URLs that actually render as a page —
// a server root, a directory, or HTML. A concrete source/script file is a
// reference, not a running server, so we leave the pane where it is.
function isServablePreviewTarget(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Schemeless or otherwise unparseable — strip host heuristically.
    pathname = url.replace(/^[^/]*\/\/[^/]*/, "").split(/[?#]/)[0] || "/";
  }
  if (pathname === "" || pathname === "/" || pathname.endsWith("/")) return true;
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return true; // no extension → treat as a route/page
  const ext = last.slice(dot + 1).toLowerCase();
  return !NON_SERVABLE_PREVIEW_EXT.has(ext);
}

// Minimal built-in starters — only used if config/prompt-suggestions.json is
// missing/unreachable, so the new-chat strip is never empty.
const SUGGESTION_FALLBACK: PromptSuggestion[] = [
  { id: "landing", label: "Build a landing page", icon: "code", prompt: "Build me a responsive landing page with a hero section, features grid, and a contact form." },
  { id: "data", label: "Analyze some data", icon: "chart", prompt: "Help me analyze a dataset. I'll share the file with you." },
  { id: "script", label: "Write a script", icon: "message", prompt: "Write a Python script that automates a common task. What kind of task should we automate?" },
];

// ─── Component ──────────────────────────────────────────────────────

export function Workspace() {
  const navigate = useNavigate();
  const currentUser = useUser();
  const isAdmin = currentUser.role === "admin";
  const { id: routeId } = useParams<{ id: string }>();
  const { data: profiles, refetch: refetchProfiles } = useApi<ProfileSummary[]>(() => fetchProfiles());

  // Drop the no-key gating live when a key/profile is added (e.g. via the
  // welcome modal) — without this, profiles stay stale until a full reload.
  useEffect(() => {
    const onChange = () => { void refetchProfiles(); };
    window.addEventListener("vonzio:profiles:changed", onChange);
    return () => window.removeEventListener("vonzio:profiles:changed", onChange);
  }, [refetchProfiles]);

  const { grouped, update, remove, refetch, loading: workspacesLoading } = useWorkspaces();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(routeId ?? null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  // Pre-workspace model selection. The ModelPicker is now interactive in the
  // empty state — when the user picks a model BEFORE the first send, we
  // stash it here. handleSend applies it via `update(..., { model_override })`
  // right after the workspace is created, so the picked model is honored
  // on turn one. Cleared whenever the profile changes (a model only makes
  // sense relative to a profile's API key / provider).
  const [pendingModelOverride, setPendingModelOverride] = useState<string | null>(null);
  // Paired key override for the pre-workspace pick (cross-key model selection).
  const [pendingKeyOverride, setPendingKeyOverride] = useState<string | null>(null);
  const entitlements = useEntitlements();
  const composerSlots = getComposerSlots().filter(
    (s) => !s.entitlement || entitlements.includes(s.entitlement),
  );
  // Composer slots can register an async hook that runs after a new
  // workspace is created but before its first turn dispatches (see
  // ComposerSlotProps.registerBeforeSend). The registrar is stable per
  // slot id so the slot's effect doesn't re-register every render.
  const composerBeforeSend = useRef<Map<string, (workspaceId: string) => Promise<void>>>(new Map());
  const beforeSendRegistrars = useRef<Map<string, (fn: ((workspaceId: string) => Promise<void>) | null) => void>>(new Map());
  function getBeforeSendRegistrar(id: string) {
    let r = beforeSendRegistrars.current.get(id);
    if (!r) {
      r = (fn) => {
        if (fn) composerBeforeSend.current.set(id, fn);
        else composerBeforeSend.current.delete(id);
      };
      beforeSendRegistrars.current.set(id, r);
    }
    return r;
  }
  const [input, setInput] = useState(() => {
    if (!routeId) return "";
    try { return localStorage.getItem(`vonzio_draft_${routeId}`) ?? ""; } catch { return ""; }
  });
  const [pendingNew, setPendingNew] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Mirror of `attachments` for revoking blob: preview URLs from places that
  // can't read the latest state (workspace switch, unmount).
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const revokePreviews = (atts: Attachment[]) => {
    for (const a of atts) {
      if (a.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview);
    }
  };
  // Composer history: ArrowUp/ArrowDown recall your previous messages (shell
  // style). -1 = not navigating. Index counts back from the most recent.
  const [historyIdx, setHistoryIdx] = useState(-1);
  // Persistent, cross-session command history (newest last), so ArrowUp recalls
  // prior entries even in a brand-new/empty composer. Capped + deduped on push.
  const [persistedHistory, setPersistedHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(COMPOSER_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
    } catch { return []; }
  });
  // Goal-loop composer override. null = follow the profile's auto_continue
  // default; true/false = explicit per-message choice. `goalCriteria` is the
  // optional acceptance-criteria text (one per line).
  const [goalModeOverride, setGoalModeOverride] = useState<boolean | null>(null);
  const [goalCriteria, setGoalCriteria] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrow();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Voice dictation → composer (reviewed before send, never auto-sent).
  const voice = useVoiceDictation({
    getBaseText: () => input,
    onText: (next) => setInputWithDraft(next),
  });

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
  // Office document shown in the Document deck tab (#368). Persisted with the
  // rest of the panel state so reopening a workspace restores its document.
  const [documentFile, setDocumentFile] = useState<string | null>(() => {
    if (!routeId) return null;
    try {
      const saved = localStorage.getItem(`vonzio_panel_${routeId}`);
      if (saved) return JSON.parse(saved).documentFile ?? null;
    } catch {}
    return null;
  });
  const [documentRefresh, setDocumentRefresh] = useState(0);

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
  // Which divider is being dragged, if any. Kept as a discriminator (not two
  // booleans) so each handle only highlights when it's the one in use — a
  // shared `isResizing` flag used to light up both the rail and Deck handles.
  const [resizeTarget, setResizeTarget] = useState<"sidebar" | "panel" | null>(null);
  const isResizing = resizeTarget !== null;

  // Workspace-rail (task list) resize state. Width is global (not per-route)
  // since the rail is the same across workspaces; persisted in localStorage.
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;
  const SIDEBAR_DEFAULT = 240;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem("vonzio_sidebar_width");
      if (saved) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parseInt(saved, 10) || SIDEBAR_DEFAULT));
    } catch { /* ignore */ }
    return SIDEBAR_DEFAULT;
  });

  // Whether the workspace-list rail is collapsed (desktop only). When
  // collapsed the rail (and its resize handle) is removed entirely and the
  // "New task" + expand controls relocate into the workspace header.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("vonzio_sidebar_collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("vonzio_sidebar_collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizeTarget("sidebar");
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + (ev.clientX - startX)));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      setResizeTarget(null);
      try { localStorage.setItem("vonzio_sidebar_width", String(sidebarWidthRef.current)); } catch { /* ignore */ }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);
  // Keep a ref so the mouseup handler persists the latest width without
  // re-subscribing listeners on every drag tick.
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizeTarget("panel");
    const startX = e.clientX;
    const startWidth = panelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const maxWidth = Math.floor(window.innerWidth * 0.5);
      const newWidth = Math.max(PANEL_MIN, Math.min(maxWidth, startWidth + delta));
      setPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      setResizeTarget(null);
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
      localStorage.setItem(`vonzio_panel_${wid}`, JSON.stringify({ open: panelOpen, tab: panelTab, previewUrl, documentFile }));
    } catch {}
  }, [activeWorkspaceId, panelOpen, panelTab, previewUrl, documentFile]);

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
        setDocumentFile(parsed.documentFile ?? null);
      } else {
        setPreviewUrl(null);
        setDocumentFile(null);
      }
    } catch {
      setPreviewUrl(null);
      setDocumentFile(null);
    }
  }, [activeWorkspaceId]);

  // Auto-scroll state
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // What you were typing before stepping into history — stashed when recall
  // begins (idx -1 → 0) and restored when you step back down past the newest.
  const pendingDraftRef = useRef<string>("");
  // Container vanity name, mirrored into a ref so the (earlier-defined) tool-
  // result auto-detect can build preview URLs with the friendly name.
  const containerNameRef = useRef<string | null>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Get the active workspace's profile
  const allWorkspaces = [...grouped.starred, ...grouped.active, ...grouped.paused, ...grouped.archived];
  const activeWorkspace = allWorkspaces.find((w) => w.session_id === activeWorkspaceId);

  // Org-scope guard: a routeId that doesn't resolve to any visible
  // workspace after the list has loaded means the workspace either
  // doesn't exist or belongs to a different org than the active one
  // (server filters /v1/workspaces by request.orgContext.org_id). Send
  // the user to / instead of leaving them on a half-functional page
  // where activeWorkspace is undefined.
  useEffect(() => {
    if (!routeId) return;
    if (workspacesLoading) return;
    if (activeWorkspace) return;
    // A just-created session navigates to /w/<id> BEFORE the workspace list
    // refetches, so it isn't in the list yet — don't bounce it back to /w
    // (which stripped the session id from the URL on every new workspace).
    if (routeId === activeWorkspaceId) return;
    navigate("/w", { replace: true });
  }, [routeId, workspacesLoading, activeWorkspace, activeWorkspaceId, navigate]);
  // Resolve activeProfile in this order: real workspace owner → user's
  // empty-state pick from AgentPicker → the user's default agent → first
  // profile. The middle cases matter so the ModelPicker (and the rest of the
  // composer chrome) shows models for the profile the user picked / defaulted.
  const activeProfile =
    profiles?.find((p) => p.id === activeWorkspace?.profile_id) ??
    profiles?.find((p) => p.id === selectedProfileId) ??
    profiles?.find((p) => p.is_default) ??
    profiles?.[0];
  const profileName = activeProfile?.name ?? "Default";

  // Effective goal-loop ("Run until done") state: explicit composer override
  // wins, else the profile's auto_continue default. Criteria are one per line.
  const effectiveGoalMode = goalModeOverride ?? (activeProfile?.auto_continue ?? false);
  const goalCriteriaList = goalCriteria
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultProfileId = (profiles?.find((p) => p.is_default) ?? profiles?.[0])?.id ?? "";

  // Pick up a draft / chosen agent handed off from the Home launcher (it stashes
  // these then navigates to /w). Apply once on a fresh new-chat mount, then clear.
  useEffect(() => {
    if (routeId) return; // only for new chat (/w)
    try {
      const draft = localStorage.getItem(HOME_DRAFT_KEY);
      if (draft) { setInput(draft); localStorage.removeItem(HOME_DRAFT_KEY); }
      const agent = localStorage.getItem(HOME_AGENT_KEY);
      if (agent) { setSelectedProfileId(agent); localStorage.removeItem(HOME_AGENT_KEY); }
      if (draft || agent) setTimeout(() => inputRef.current?.focus(), 100);
    } catch { /* ignore storage errors */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const hasApiKey = activeProfile?.api_key_id ? true : false;
  // Only treat "no key" as actionable once profiles have actually loaded —
  // `profiles` is undefined mid-fetch, which would otherwise flash the
  // add-key CTA + disable the composer for users who DO have a key.
  const keyMissing = profiles !== undefined && !hasApiKey;

  // Keys the user can actually use (own + shared/admin-granted). When the
  // active agent has no key but the user HAS an accessible one (e.g. an admin
  // shared a key with them), we offer a one-click "use this key" instead of
  // forcing them to add their own — the shared key is already usable.
  const { data: availableApiKeys } = useApi<UserAnthropicKey[]>(() => fetchUserAnthropicKeys());
  const attachableKey: UserAnthropicKey | undefined =
    keyMissing && activeProfile && !activeProfile.team_owned
      ? (availableApiKeys ?? [])[0]
      : undefined;
  // Distinguish a key the user OWNS from one merely shared with them, so the
  // empty-state copy doesn't tell an owner their own key is "shared with you".
  const attachableKeyOwned = !!attachableKey && attachableKey.user_id === currentUser.id;
  const [attaching, setAttaching] = useState(false);
  const attachKey = async () => {
    if (!activeProfile || !attachableKey) return;
    setAttaching(true);
    try {
      // The server attaches the key and auto-picks a provider-appropriate model
      // for a model-less agent (ProfileService.update), so no model needed here.
      await updateProfile(activeProfile.id, { api_key_id: attachableKey.id });
      await refetchProfiles();
    } finally {
      setAttaching(false);
    }
  };

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


  // Open (or refresh) an office document in the Document deck tab (#368).
  // Also the handler for OPEN_DOCUMENT_EVENT, so chat links and file rows
  // deep in the tree can open the tab without prop-drilling.
  const openDocument = useCallback((path: string) => {
    setDocumentFile(path);
    setPanelTab("document");
    setPanelOpen(true);
    // Same file re-announced after an edit → bump so the tab reconverts.
    setDocumentRefresh((n) => n + 1);
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (path) openDocument(path);
    };
    window.addEventListener(OPEN_DOCUMENT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DOCUMENT_EVENT, onOpen);
  }, [openDocument]);

  // The Document tab only exists while a document does — if restored state
  // (or a workspace switch) lands on "document" with none, the active tab
  // would be hidden and the panel blank. Fall back to Preview.
  useEffect(() => {
    if (panelTab === "document" && !documentFile) setPanelTab("preview");
  }, [panelTab, documentFile]);

  // Scan text for a vonzio preview URL and open the Preview panel
  const openPreviewFromText = useCallback((text: string) => {
    const match = text.match(PREVIEW_URL_REGEX);
    if (match && isServablePreviewTarget(match[0])) {
      setPreviewUrl(match[0]);
      setPanelTab("preview");
      setPanelOpen(true);
    }
  }, [PREVIEW_URL_REGEX]);

  // Auto-show panel on tool results
  const handleToolResult = useCallback((tool: string, output: string) => {
    // First check for a full vonzio preview URL in the output
    const previewMatch = output.match(PREVIEW_URL_REGEX);
    if (previewMatch && isServablePreviewTarget(previewMatch[0])) {
      setPreviewUrl(previewMatch[0]);
      setPanelTab("preview");
      setPanelOpen(true);
      return;
    }
    // An office document created/edited/announced by any tool → open it in
    // the deck (#368). Checked BEFORE the port sniffing below — a fileserver
    // download link ("http://localhost:3000/preview/<id>/8765/report.docx")
    // contains a localhost:port match and would otherwise hijack the Preview
    // tab instead of opening the document.
    const docPath = extractOfficeDocPath(output);
    if (docPath) {
      openDocument(docPath);
      return;
    }
    if (tool === "Bash" && (output.includes("localhost:") || output.includes("0.0.0.0:"))) {
      const portMatch = output.match(/(?:localhost|0\.0\.0\.0):(\d{4,5})/);
      if (portMatch && activeWorkspace?.container_id) {
        const host = containerNameRef.current || activeWorkspace.container_id.slice(0, 12);
        setPreviewUrl(buildPreviewUrl(host, portMatch[1]));
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
      // The document being shown may have been edited through a path the
      // regex can't see (e.g. a relative path in tool output) — reconvert.
      if (documentFileRef.current && output.includes(documentFileRef.current.split("/").pop() ?? "")) {
        setDocumentRefresh((n) => n + 1);
      }
    }
  }, [activeWorkspace?.container_id, openDocument]);

  // The tool-result handler needs the current document without re-subscribing
  // the chat hook on every document change.
  const documentFileRef = useRef<string | null>(null);
  documentFileRef.current = documentFile;

  // Scan assistant text messages for preview URLs and announced documents
  const handleAssistantMessage = useCallback((text: string) => {
    const docPath = extractOfficeDocPath(text);
    if (docPath) {
      openDocument(docPath);
      return;
    }
    openPreviewFromText(text);
  }, [openPreviewFromText, openDocument]);

  // Chat hook
  const chat = useWorkspaceChat({
    sessionId: activeWorkspaceId,
    profileId: activeWorkspace?.profile_id ?? defaultProfileId,
    onContainerIdChange: () => {},
    onToolResult: handleToolResult,
    onAssistantMessage: handleAssistantMessage,
    onTitleUpdate: (sid, name) => {
      // Server-side auto-title (ws/handler) emits workspace.title_updated after
      // the turn; just refresh. The previous onTurnDone → generateWorkspaceTitle
      // call was a redundant second title pass (double LLM cost) — removed.
      refetch();
    },
    onLogEntry: (entry) => setLogs((prev) => [...prev, entry]),
  });

  // ─── Auto-focus input on mount ───────────────────────────────────
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 200);
  }, []);

  // Stop dictation once the agent starts streaming — the composer is disabled
  // during a turn, so a live mic would have nowhere to write.
  useEffect(() => {
    if (chat.streaming && voice.listening) voice.stop();
  }, [chat.streaming, voice.listening, voice]);

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

  // ─── Preview port picker ────────────────────────────────────────────
  // Every service the container is listening on, so the user can switch the
  // preview between them and expose any one publicly — not just whichever
  // port the agent happened to print. Probed live while Preview is open.
  const [previewPorts, setPreviewPorts] = useState<WorkspacePort[]>([]);

  const previewContainerId = activeWorkspace?.container_id ?? null;

  const refreshPreviewPorts = useCallback(async () => {
    if (!activeWorkspaceId || !previewContainerId) { setPreviewPorts([]); return; }
    try {
      const res = await fetchWorkspacePorts(activeWorkspaceId);
      setPreviewPorts(res.ports);
    } catch { /* container gone / transient — keep last list */ }
  }, [activeWorkspaceId, previewContainerId]);

  // Poll while the Preview tab is actually visible.
  useEffect(() => {
    if (!panelOpen || panelTab !== "preview" || !previewContainerId) return;
    refreshPreviewPorts();
    const t = setInterval(refreshPreviewPorts, 8000);
    return () => clearInterval(t);
  }, [panelOpen, panelTab, previewContainerId, refreshPreviewPorts]);

  // The port currently shown in the iframe (parsed back out of previewUrl).
  const currentPreviewPort = useMemo(() => {
    if (!previewUrl) return null;
    const m = previewUrl.match(PREVIEW_URL_REGEX);
    return m && m[1] ? Number(m[1]) : null;
  }, [previewUrl, PREVIEW_URL_REGEX]);

  // Prefer the container's vanity name (what the agent prints in vonzio.md's
  // preview URLs) over the raw hex id; the proxy resolves either. Falls back to
  // the short id before the name has been resolved.
  const previewHost = chat.containerName || (previewContainerId ? previewContainerId.slice(0, 12) : null);
  useEffect(() => { containerNameRef.current = chat.containerName; }, [chat.containerName]);

  // After a container restart/recreate the vanity name changes, but the displayed
  // preview URL may have been restored from localStorage or parsed out of older
  // agent text — pointing at the now-dead OLD name. Whenever the probe gives us a
  // live container name, rewrite the preview URL's host to the current one
  // (preserving port + path) so the Deck always targets the running container.
  useEffect(() => {
    if (!previewUrl || !previewHost) return;
    const m = previewUrl.match(PREVIEW_URL_REGEX);
    if (!m || !m[1]) return;
    let canonical: string;
    try {
      const cur = new URL(previewUrl);
      const fresh = new URL(buildPreviewUrl(previewHost, m[1]));
      fresh.pathname = cur.pathname;
      fresh.search = cur.search;
      fresh.hash = cur.hash;
      canonical = fresh.toString();
    } catch {
      return;
    }
    if (canonical !== previewUrl) setPreviewUrl(canonical);
  }, [previewUrl, previewHost, buildPreviewUrl, PREVIEW_URL_REGEX]);

  const handleSelectPreviewPort = useCallback((port: number) => {
    if (!previewHost) return;
    setPreviewUrl(buildPreviewUrl(previewHost, String(port)));
    setPanelTab("preview");
    setPanelOpen(true);
  }, [previewHost, buildPreviewUrl]);

  const handleSetPortAccess = useCallback(async (port: number, mode: PreviewPortMode) => {
    if (!activeWorkspaceId) return;
    const res = await setPreviewAccess(activeWorkspaceId, { port, mode });
    // Optimistically reflect the new mode + any freshly-issued code, then
    // refetch to stay in sync with the server (other ports, decrypted codes).
    setPreviewPorts((prev) => prev.map((p) => (p.port === port ? { ...p, mode, public: mode === "public", code: res.code ?? (mode === "code" ? p.code : null) } : p)));
    refreshPreviewPorts();
  }, [activeWorkspaceId, refreshPreviewPorts]);

  const buildPortPublicUrl = useCallback((port: number) => {
    return previewHost ? buildPreviewUrl(previewHost, String(port)) : "";
  }, [previewHost, buildPreviewUrl]);

  // ─── Attachments ─────────────────────────────────────────────────
  const processFile = useCallback((file: File) => {
    // Shared upload cap (config.MAX_UPLOAD_MB, published in /api/config). Chat
    // attachments ride the WebSocket inline as base64, so an oversized file
    // would blow past the WS frame limit and leave the turn stuck "Working…"
    // looping on reconnect. Reject it up front with a clear message instead.
    const maxMb = (typeof window !== "undefined" && (window as unknown as { __VONZIO_MAX_UPLOAD_MB?: number }).__VONZIO_MAX_UPLOAD_MB) || 100;
    if (file.size > maxMb * 1024 * 1024) {
      setAttachError(`"${file.name}" is too large (max ${maxMb} MB). Use the Files panel for large files.`);
      return;
    }
    setAttachError(null);
    const isImage = file.type.startsWith("image/");
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      setAttachments((prev) => [...prev, {
        type: isImage ? "image" : "document",
        media_type: file.type,
        data: base64,
        name: file.name,
        // Thumbnail uses a lightweight object URL, NOT the full base64 data URL.
        // A multi-MB data URL as an <img src> forces the browser to base64-decode
        // the whole string on the main thread (visible jank while a file is
        // attached); a blob: URL is cheap to render.
        preview: isImage ? URL.createObjectURL(file) : undefined,
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
    const att = attachmentsRef.current[idx];
    if (att) revokePreviews([att]);
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // Revoke any outstanding composer preview URLs when the page unmounts.
  useEffect(() => () => revokePreviews(attachmentsRef.current), []);

  // ─── Navigation ──────────────────────────────────────────────────

  /** Reset all workspace-specific state when switching or creating */
  function resetWorkspaceState() {
    revokePreviews(attachmentsRef.current);
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
    setPendingKeyOverride(null);
    navigate("/w", { replace: true });
    // Auto-focus the input after render
    setTimeout(() => inputRef.current?.focus(), 100);
  }

  // ⌘K / Ctrl+K → new task. (⌘N can't be used — browsers reserve it for "new
  // window" and a page can't preventDefault it.) Ref keeps the handler fresh
  // without re-binding the listener every render.
  const handleCreateRef = useRef(handleCreate);
  handleCreateRef.current = handleCreate;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handleCreateRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Your previously-sent messages, most-recent-last, for ArrowUp recall.
  // Merges the persistent cross-session history with this conversation's user
  // messages (a resumed workspace's messages may predate the local history, or
  // have been sent from another device), deduped keeping the most recent.
  const sentHistory = useMemo(() => {
    const session = chat.messages
      .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => m.content as string);
    const combined = [...persistedHistory, ...session];
    const seen = new Set<string>();
    const out: string[] = [];
    for (let i = combined.length - 1; i >= 0; i--) {
      if (seen.has(combined[i])) continue;
      seen.add(combined[i]);
      out.unshift(combined[i]);
    }
    return out;
  }, [chat.messages, persistedHistory]);

  // User questions for the thread navigator — id (anchor) + a one-line label.
  const navTurns = useMemo(
    () =>
      chat.messages
        .filter((m) => m.role === "user")
        .map((m) => ({
          id: String(m.id),
          label: (typeof m.content === "string" ? m.content : "").trim().replace(/\s+/g, " ").slice(0, 80),
        })),
    [chat.messages],
  );

  // ArrowUp/ArrowDown composer history. Only engages when the caret is at the
  // very start (so multi-line editing/normal cursor movement is unaffected) or
  // when already navigating. Returns true if it handled the key.
  function navigateHistory(dir: "up" | "down", el: HTMLTextAreaElement): boolean {
    if (sentHistory.length === 0) return false;
    if (dir === "up") {
      if (historyIdx === -1 && (el.selectionStart !== 0 || el.selectionEnd !== 0)) return false;
      // Entering history — stash whatever was being typed so Down can restore it.
      if (historyIdx === -1) pendingDraftRef.current = input;
      const next = Math.min(historyIdx + 1, sentHistory.length - 1);
      if (next === historyIdx) return true;
      setHistoryIdx(next);
      setInputWithDraft(sentHistory[sentHistory.length - 1 - next]);
      return true;
    }
    // down
    if (historyIdx === -1) return false;
    const next = historyIdx - 1;
    setHistoryIdx(next);
    setInputWithDraft(next === -1 ? pendingDraftRef.current : sentHistory[sentHistory.length - 1 - next]);
    return true;
  }

  // Append a sent message to the persistent history (newest last). Drops a
  // consecutive duplicate of the most recent entry and caps the list.
  function pushHistory(text: string) {
    if (!text) return;
    setPersistedHistory((prev) => {
      if (prev[prev.length - 1] === text) return prev;
      const next = [...prev, text].slice(-COMPOSER_HISTORY_MAX);
      try { localStorage.setItem(COMPOSER_HISTORY_KEY, JSON.stringify(next)); } catch { /* quota/unavailable */ }
      return next;
    });
  }

  // ─── Send message ────────────────────────────────────────────────
  async function handleSend() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || chat.streaming) return;
    if (text) pushHistory(text);
    const atts = attachments.length > 0
      ? attachments.map(({ type, media_type, data, name }) => ({ type, media_type, data, name }))
      : undefined;
    // Captured so a confirmed dispatch can revoke the composer preview URLs.
    // NOT revoked on the optimistic clear below — restoreComposer may put these
    // same attachments (and their URLs) back if the send never dispatches.
    const sentAttachments = attachments;
    setInput("");
    setHistoryIdx(-1);
    if (activeWorkspaceId) clearDraft(activeWorkspaceId);
    setAttachments([]);
    // Clear the per-message acceptance-criteria field on send (the goal_mode
    // toggle persists; criteria are per message). goalCriteriaList is already
    // captured above for this send, so clearing the state here is safe.
    setGoalCriteria("");
    setUserScrolledUp(false);

    // Restore the composer if the send never dispatches — otherwise the
    // optimistic clear above silently eats the message and the user has to
    // retype it (reported on new-chat sends that lost the session race).
    const restoreComposer = () => {
      setInput(text);
      if (attachments.length > 0) setAttachments(attachments);
    };

    if (!activeWorkspaceId) {
      const pid = selectedProfileId || defaultProfileId;
      if (!pid) { restoreComposer(); return; }
      let sessionId: string;
      try {
        sessionId = await chat.startSession(pid);
      } catch {
        restoreComposer();
        return;
      }
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
      if (pendingModelOverride !== null || pendingKeyOverride !== null) {
        try {
          await update(sessionId, { model_override: pendingModelOverride, api_key_id_override: pendingKeyOverride });
        } catch {
          // Persistence failure is non-fatal — the worst case is the first
          // turn uses the profile default. We still want to send.
        }
        setPendingModelOverride(null);
        setPendingKeyOverride(null);
      }

      // Flush any composer-slot choices stashed while this chat had no
      // workspace yet (e.g. the VPN picker's "none"/pin override). These
      // MUST land before the first turn so the server bakes the right
      // network at container creation — same await-before-dispatch reason
      // as the model override above. Best-effort: a failed flush falls back
      // to the profile default but never blocks the send.
      const beforeSendHooks = Array.from(composerBeforeSend.current.values());
      if (beforeSendHooks.length > 0) {
        await Promise.all(beforeSendHooks.map((fn) => fn(sessionId).catch(() => {})));
      }

      // Send with the id we just got back — no setTimeout guess. send() uses
      // this id directly instead of waiting for currentSessionIdRef to catch
      // up, so the first turn can't be dropped. Restore the composer if it
      // somehow doesn't dispatch.
      const dispatched = chat.send(text, atts, { goal_mode: effectiveGoalMode, acceptance_criteria: goalCriteriaList }, sessionId);
      if (!dispatched) restoreComposer();
      else revokePreviews(sentAttachments);
      refetch();
      return;
    }

    if (!chat.send(text, atts, { goal_mode: effectiveGoalMode, acceptance_criteria: goalCriteriaList })) {
      restoreComposer();
    } else {
      revokePreviews(sentAttachments);
    }
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
        : chat.agentStatus.state === "judging"
          ? "Checking goal..."
          : null;

  // ─── Suggestion chips ────────────────────────────────────────────
  // Curated starters come from config/prompt-suggestions.json (baked into the
  // image, overridable via volume mount). Fall back to a minimal built-in set
  // if the config is missing/unreachable so the strip is never empty.
  const { data: suggestionData } = useApi<{ suggestions: PromptSuggestion[] }>(() => fetchPromptSuggestions());
  const suggestionIcon = (key?: string) => {
    switch (key) {
      case "code": return <Code className="w-4 h-4" />;
      case "message": return <MessageSquare className="w-4 h-4" />;
      case "game": return <Gamepad2 className="w-4 h-4" />;
      case "chart": return <BarChart3 className="w-4 h-4" />;
      case "search": return <Search className="w-4 h-4" />;
      case "rocket": return <Rocket className="w-4 h-4" />;
      case "globe": return <Globe className="w-4 h-4" />;
      default: return <Sparkles className="w-4 h-4" />;
    }
  };
  // Show a rotating subset so the strip feels fresh + hints at the range without
  // clutter. Shuffle once per fetch (not per render) via useMemo keyed on data.
  const suggestions = useMemo(() => {
    const pool = suggestionData?.suggestions?.length ? suggestionData.suggestions : SUGGESTION_FALLBACK;
    return [...pool]
      .sort(() => Math.random() - 0.5)
      .slice(0, 4)
      .map((s) => ({ icon: suggestionIcon(s.icon), label: s.label, prompt: s.prompt }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestionData]);

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
        !sidebarCollapsed && (
        <div className="flex h-full shrink-0">
          <div className="flex flex-col h-full" style={{ width: sidebarWidth }}>
            <WorkspaceSidebar
              grouped={grouped}
              activeId={activeWorkspaceId}
              onSelect={handleSelect}
              onCreate={handleCreate}
              onCollapse={toggleSidebarCollapsed}
              onUpdate={(id, fields) => update(id, fields)}
              onDelete={async (id) => {
                await remove(id);
                if (activeWorkspaceId === id) handleCreate();
              }}
            />
          </div>
          {/* Drag handle on the rail's right edge — same mechanism as the
              right panel. 1px hit area widened by padding via the hover ring. */}
          <div
            onMouseDown={handleSidebarResizeStart}
            className="w-1 cursor-col-resize flex-shrink-0 transition-colors"
            style={{ background: resizeTarget === "sidebar" ? "var(--vz-sodium)" : "transparent" }}
            onMouseEnter={(e) => { if (!isResizing) (e.currentTarget as HTMLElement).style.background = "var(--vz-border)"; }}
            onMouseLeave={(e) => { if (!isResizing) (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            title="Drag to resize"
          />
        </div>
        )
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
              sidebarCollapsed={!isNarrow && sidebarCollapsed}
              onExpandSidebar={toggleSidebarCollapsed}
              onNewTask={handleCreate}
              onRename={(name) => update(activeWorkspace.session_id, { name })}
              messages={chat.messages}
              workspaceName={activeWorkspace.name ?? "workspace"}
              profileName={profileName}
              profileIdForSlot={activeWorkspace.profile_id}
              attachedTunnel={activeWorkspace.attached_tunnel ?? null}
            />
          ) : (isNarrow || sidebarCollapsed) && (
            // Empty-state header — without it there'd be no way to reach the
            // workspace list when there's no active workspace: on narrow the
            // rail is a Sheet (hamburger), on desktop the rail is collapsed
            // (expand chevron). The WorkspaceHeader (with these controls)
            // only renders for an active workspace.
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
                onClick={() => (isNarrow ? setSidebarOpen(true) : toggleSidebarCollapsed())}
                className="vz-action-btn"
                style={{ marginLeft: -4 }}
                aria-label="Open workspace list"
                title="Show workspace list"
              >
                {isNarrow ? <Menu className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
              </button>
              {!isNarrow && sidebarCollapsed && (
                <button
                  type="button"
                  onClick={handleCreate}
                  className="vz-action-btn"
                  aria-label="New task"
                  title="New task"
                  style={{ background: "var(--vz-sodium)", color: "#fff" }}
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--vz-ink)" }}>
                {!isNarrow && sidebarCollapsed ? "New" : "Workspaces"}
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
                        <h2 className="text-lg font-semibold mb-1" style={{ color: "var(--vz-ink)" }}>
                          {!keyMissing ? "How can I help?"
                            : attachableKey ? (attachableKeyOwned ? "Attach a key to get started" : "Use your shared key to get started")
                            : "Add an API key to get started"}
                        </h2>
                        <p className="text-sm text-muted-foreground">
                          {!keyMissing
                            ? ((profiles?.length ?? 0) > 1 ? "Select an agent and start a conversation" : "Start a conversation")
                            : attachableKey
                              ? (attachableKeyOwned
                                  ? `“${attachableKey.name}” isn’t attached to this agent yet — attach it to start chatting.`
                                  : `“${attachableKey.name}” is shared with you — attach it to your agent to start chatting.`)
                              : "You'll need a provider key before you can chat — it takes a few seconds."}
                        </p>
                      </div>
                      {keyMissing && (
                        attachableKey ? (
                          <Button onClick={attachKey} disabled={attaching}>
                            <Key className="w-4 h-4 mr-1.5" />
                            {attaching ? "Setting up…" : `Use ${attachableKey.name}`}
                          </Button>
                        ) : (
                          <Button onClick={() => reopenOnboarding()}>
                            <Key className="w-4 h-4 mr-1.5" />
                            Add API key
                          </Button>
                        )
                      )}
                      {/* Launcher: pick an agent to start with (cards), or start
                          from a template. The composer below stays the fast path
                          — clicking a card just selects + focuses it, it doesn't
                          force a click before you can type. */}
                      {!keyMissing && (
                        <div className="w-full" style={{ maxWidth: 620, display: "flex", flexDirection: "column", gap: 14 }}>
                          {(profiles?.length ?? 0) > 0 && (
                            <div style={{ maxWidth: 360, width: "100%", margin: "0 auto" }}>
                              <div style={{ fontFamily: "var(--vz-font-mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--vz-muted-2)", marginBottom: 8, textAlign: "center" }}>
                                Start with an agent
                              </div>
                              <Select
                                value={selectedProfileId || defaultProfileId}
                                onChange={(id) => {
                                  // Mirror AgentPicker: switching profile discards
                                  // any in-flight model/key pick.
                                  setSelectedProfileId(id);
                                  setPendingModelOverride(null);
                                  setPendingKeyOverride(null);
                                  inputRef.current?.focus();
                                }}
                                options={profiles!.map((p) => ({ value: p.id, label: p.name }))}
                                searchable={(profiles?.length ?? 0) > 6}
                              />
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => navigate("/agents/gallery")}
                            style={{
                              alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 5,
                              background: "none", border: 0, cursor: "pointer", padding: 0,
                              fontFamily: "inherit", fontSize: 12.5, color: "var(--vz-muted)",
                            }}
                          >
                            <Sparkles size={13} />
                            Start from a template
                          </button>
                        </div>
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
                    sessionId={activeWorkspaceId}
                  />
                  {/* Live status flows inline at the end of the transcript so it
                      reads as the agent's next step and moves down as output
                      arrives (rather than floating in a fixed gutter). */}
                  {statusLabel && !chat.pendingQuestion && (
                    <div className="flex pt-1">
                      <div
                        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs"
                        style={{
                          background: "var(--vz-card)",
                          border: "1px solid var(--vz-border)",
                          color: "var(--vz-muted)",
                          boxShadow: "var(--vz-shadow-sm)",
                        }}
                      >
                        <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--vz-sodium)" }} />
                        {statusLabel}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Drag overlay — sibling of the scroll container so `inset-0`
                resolves against the non-scrolling wrapper (the visible
                viewport), not the full scroll-content height. Otherwise the
                dashed border + label drift to the middle/top of the content
                when the thread is scrolled. */}
            {dragOver && (
              <div
                className="absolute inset-0 z-20 border-2 border-dashed rounded-lg flex items-center justify-center pointer-events-none"
                style={{ background: "var(--vz-sodium-08)", borderColor: "var(--vz-sodium)" }}
              >
                <div style={{ color: "var(--vz-sodium)", fontWeight: 500, fontSize: 14 }}>Drop files here</div>
              </div>
            )}

            {/* Thread navigator — jump between questions in long threads.
                Self-hides for short/unscrollable threads. */}
            <ThreadNavigator
              scrollRef={scrollRef}
              turns={navTurns}
              onScrollToBottom={() => scrollToBottom()}
            />

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

            {/* Bottom-area precedence: no-key guidance → pending question →
                composer. The composer is never shown without a key — a
                disabled one just reads as broken. In the empty/new state the
                hero already shows an "Add API key" CTA (so render nothing
                here); in an existing conversation we show a compact CTA banner
                in the composer's place. */}
            {keyMissing ? (
              (!activeWorkspaceId || pendingNew) ? null : (
                <div className="pt-2" style={{ pointerEvents: "auto" }}>
                  <div className="max-w-3xl mx-auto">
                    <div
                      className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm"
                      style={{
                        background: "rgba(245, 158, 11, 0.08)",
                        border: "1px solid rgba(245, 158, 11, 0.30)",
                        color: "var(--vz-warn)",
                      }}
                    >
                      <Key className="w-4 h-4 shrink-0" />
                      <span className="flex-1">
                        {attachableKey
                          ? (attachableKeyOwned
                              ? `“${attachableKey.name}” isn’t attached to this agent — attach it to continue.`
                              : `“${attachableKey.name}” is shared with you — attach it to this agent to continue.`)
                          : "No API key configured — add one to continue this conversation."}
                      </span>
                      <button
                        type="button"
                        onClick={attachableKey ? attachKey : () => reopenOnboarding()}
                        disabled={attaching}
                        style={{
                          background: "var(--vz-sodium)", color: "#fff",
                          padding: "5px 12px", borderRadius: "var(--vz-radius-sm)",
                          fontSize: 12.5, fontWeight: 500, cursor: "pointer", border: "none",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {attachableKey ? (attaching ? "Setting up…" : `Use ${attachableKey.name}`) : "Add API key"}
                      </button>
                    </div>
                  </div>
                </div>
              )
            ) : chat.pendingQuestion ? (
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
                    cursor: "text",
                  }}
                  onMouseDown={(e) => {
                    // Clicking anywhere in the composer card (its padding, the
                    // footer's empty space) should drop the cursor into the
                    // textarea — the whole card reads as the input. Skip when
                    // the click lands on an interactive control or a real text
                    // selection target so buttons/the model picker still work.
                    if ((e.target as HTMLElement).closest("button, a, textarea, input, select, [role='button'], [role='combobox']")) return;
                    e.preventDefault();
                    inputRef.current?.focus();
                  }}
                  onDrop={handleDrop}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                >
                  {/* Attachment preview chips */}
                  {attachError && (
                    <div
                      className="mb-2 px-2.5 py-1.5 rounded-lg text-xs"
                      style={{ background: "var(--vz-mute)", border: "1px solid var(--vz-fail)", color: "var(--vz-fail)" }}
                    >
                      {attachError}
                    </div>
                  )}
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

                  {/* Goal-loop acceptance criteria (shown when "Run until done"
                      is on) — one criterion per line; the judge checks these. */}
                  {effectiveGoalMode && (
                    <textarea
                      value={goalCriteria}
                      onChange={(e) => setGoalCriteria(e.target.value)}
                      placeholder="Acceptance criteria (optional, one per line) — what 'done' means"
                      rows={2}
                      className="w-full resize-none mb-2 text-xs focus:outline-none"
                      style={{
                        color: "var(--vz-ink)",
                        fontFamily: "var(--vz-font-sans)",
                        background: "var(--vz-mute)",
                        border: "1px solid var(--vz-border)",
                        borderRadius: "var(--vz-radius-sm)",
                        padding: "6px 8px",
                        lineHeight: 1.5,
                      }}
                    />
                  )}

                  {/* Textarea */}
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => { setHistoryIdx(-1); setInputWithDraft(e.target.value); }}
                    onKeyDown={(e) => {
                      // Desktop: Enter sends, Shift+Enter is a newline. Mobile keyboards
                      // have no Shift+Enter, so Enter must insert a newline — send via the button.
                      if (e.key === "Enter" && !e.shiftKey && !isMobile) { e.preventDefault(); handleSend(); return; }
                      if (e.key === "ArrowUp" && navigateHistory("up", e.currentTarget)) { e.preventDefault(); return; }
                      if (e.key === "ArrowDown" && navigateHistory("down", e.currentTarget)) { e.preventDefault(); return; }
                    }}
                    onPaste={handlePaste}
                    placeholder="Message vonzio…"
                    disabled={chat.streaming}
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

                    {/* "Run until done" (goal-loop) toggle — the agent keeps
                        working until an independent judge says the goal is met.
                        Defaults to the profile's auto_continue; click to override
                        for this message. */}
                    <button
                      type="button"
                      onClick={() => setGoalModeOverride(!effectiveGoalMode)}
                      title={effectiveGoalMode ? "Run until done: ON — agent loops until the goal is judged complete" : "Run until done: off"}
                      aria-label="Run until done"
                      aria-pressed={effectiveGoalMode}
                      style={{
                        height: 28, width: 28, padding: 0, borderRadius: "var(--vz-radius-sm)",
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        background: effectiveGoalMode ? "var(--vz-sodium)" : "var(--vz-mute)",
                        border: `1px solid ${effectiveGoalMode ? "var(--vz-sodium)" : "var(--vz-border)"}`,
                        color: effectiveGoalMode ? "#fff" : "var(--vz-muted)",
                        cursor: "pointer",
                        transition: "color var(--vz-fast) var(--vz-ease), background var(--vz-fast) var(--vz-ease), border-color var(--vz-fast) var(--vz-ease)",
                      }}
                    >
                      <Target className="w-3.5 h-3.5" />
                    </button>

                    {/* Voice dictation — Web Speech API. Only rendered where it
                        can actually work (SpeechRecognition + secure context);
                        the transcript lands in the composer for review, never
                        auto-sent. The language <select> is native so mobile gets
                        the OS picker; default is the browser's top language,
                        last-used choice is remembered. */}
                    {voice.supported && (
                      <>
                        <button
                          type="button"
                          onClick={voice.toggle}
                          disabled={chat.streaming}
                          title={voice.listening ? "Stop dictation" : "Dictate a message"}
                          aria-label={voice.listening ? "Stop dictation" : "Dictate a message"}
                          aria-pressed={voice.listening}
                          style={{
                            width: 28, height: 28, borderRadius: "var(--vz-radius-sm)",
                            display: "grid", placeItems: "center",
                            background: voice.listening ? "var(--vz-fail)" : "var(--vz-mute)",
                            border: `1px solid ${voice.listening ? "var(--vz-fail)" : "var(--vz-border)"}`,
                            color: voice.listening ? "#fff" : "var(--vz-muted)",
                            cursor: chat.streaming ? "not-allowed" : "pointer",
                            opacity: chat.streaming ? 0.4 : 1,
                            animation: voice.listening ? "vz-pulse 1.4s ease-in-out infinite" : undefined,
                            transition: "color var(--vz-fast) var(--vz-ease), background var(--vz-fast) var(--vz-ease), border-color var(--vz-fast) var(--vz-ease)",
                          }}
                          onMouseEnter={(e) => { if (voice.listening || chat.streaming) return; const el = e.currentTarget as HTMLElement; el.style.color = "var(--vz-ink)"; el.style.borderColor = "var(--vz-border-strong)"; }}
                          onMouseLeave={(e) => { if (voice.listening || chat.streaming) return; const el = e.currentTarget as HTMLElement; el.style.color = "var(--vz-muted)"; el.style.borderColor = "var(--vz-border)"; }}
                        >
                          {voice.listening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                        </button>
                        {/* Dictation language — collapsed to a tiny code chip
                            (e.g. "EN") so a rarely-touched control doesn't crowd
                            the composer. The real <select> is transparent on top,
                            so a tap still opens the native OS language picker. */}
                        <div style={{ position: "relative", height: 28, display: "inline-flex", alignItems: "center" }}>
                          <span
                            aria-hidden
                            style={{
                              pointerEvents: "none",
                              display: "inline-flex", alignItems: "center", gap: 3,
                              height: 28, padding: "0 7px", borderRadius: "var(--vz-radius-sm)",
                              background: "var(--vz-mute)", border: "1px solid var(--vz-border)",
                              color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)",
                              fontSize: 10.5, letterSpacing: "0.04em",
                            }}
                          >
                            <Globe className="w-3 h-3" />
                            {voice.lang.split("-")[0].toUpperCase()}
                          </span>
                          <select
                            value={voice.lang}
                            onChange={(e) => voice.setLang(e.target.value)}
                            title="Dictation language"
                            aria-label="Dictation language"
                            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer" }}
                          >
                            {VOICE_LANGUAGES.map((l) => (
                              <option key={l.code} value={l.code}>{l.label}</option>
                            ))}
                          </select>
                        </div>
                      </>
                    )}

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
                          profileApiKeyId={activeProfile.api_key_id ?? null}
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
                          apiKeyIdOverride={
                            activeWorkspaceId
                              ? activeWorkspace?.api_key_id_override ?? null
                              : pendingKeyOverride
                          }
                          onChange={(model, apiKeyId) => {
                            if (activeWorkspaceId) {
                              update(activeWorkspaceId, { model_override: model, api_key_id_override: apiKeyId });
                            } else {
                              // Stashed; applied in handleSend() right after
                              // the workspace is created so the first turn
                              // honors the user's choice.
                              setPendingModelOverride(model);
                              setPendingKeyOverride(apiKeyId);
                            }
                          }}
                        />
                      )}
                      {composerSlots.map((slot) => {
                        const SlotComp = slot.component;
                        return (
                          <SlotComp
                            key={slot.id}
                            workspaceId={activeWorkspaceId ?? null}
                            profileId={activeProfile?.id ?? null}
                            attachedTunnel={activeWorkspace?.attached_tunnel ?? null}
                            registerBeforeSend={getBeforeSendRegistrar(slot.id)}
                          />
                        );
                      })}
                      {/* Workspace title intentionally NOT repeated here — it
                          already lives in the header; duplicating it in the
                          composer meta line just crowds the footer. */}
                    </div>

                    {/* Send / Stop. Stop must track "agent busy", not just
                        token streaming — during a long tool run (e.g. a
                        5-minute Bash command) no tokens stream, but the turn
                        is very much cancellable. */}
                    {(chat.streaming || chat.agentStatus.state !== "idle") ? (
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
                        {isMobile ? (
                          // Icon-only on mobile: saves footer width, and the ⏎
                          // hint is wrong there (mobile Enter inserts a newline).
                          <Send className="w-4 h-4" />
                        ) : (
                          <>
                            Send
                            <span
                              className="vz-kbd"
                              style={{ background: "rgba(255,255,255,0.16)", borderColor: "rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.85)" }}
                            >
                              ⏎
                            </span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-[10px] text-center mt-1.5 select-none" style={{ color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
                  <kbd>shift + enter</kbd> for a new line
                  {sentHistory.length > 0 && <> · <kbd>↑</kbd> recall history</>}
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
                <SheetTitle className="sr-only">Deck</SheetTitle>
                <RightPanel
                  workspaceId={activeWorkspaceId}
                  containerId={chat.containerId}
                  containerName={chat.containerName}
                  profileName={profileName}
                  profileId={activeWorkspace?.profile_id ?? activeProfile?.id ?? null}
                  workspaceStatus={activeWorkspace?.status ?? "unknown"}
                  persistent={activeWorkspace?.persistent ?? false}
                  createdAt={activeWorkspace?.created_at ?? new Date().toISOString()}
                  expiresAt={activeWorkspace?.expires_at ?? new Date().toISOString()}
                  previewUrl={previewUrl}
                  previewRefresh={previewRefresh}
                  documentFile={documentFile}
                  documentRefresh={documentRefresh}
                  ports={previewPorts}
                  currentPort={currentPreviewPort}
                  publicPreview={activeWorkspace?.public_preview ?? false}
                  onSelectPort={handleSelectPreviewPort}
                  onSetPortAccess={handleSetPortAccess}
                  buildPortUrl={buildPortPublicUrl}
                  onRescanPorts={refreshPreviewPorts}
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
                className="w-1 cursor-col-resize transition-colors flex-shrink-0"
                style={{
                  background: resizeTarget === "panel" ? "var(--vz-sodium)" : "transparent",
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
                  profileId={activeWorkspace?.profile_id ?? activeProfile?.id ?? null}
                  workspaceStatus={activeWorkspace?.status ?? "unknown"}
                  persistent={activeWorkspace?.persistent ?? false}
                  createdAt={activeWorkspace?.created_at ?? new Date().toISOString()}
                  expiresAt={activeWorkspace?.expires_at ?? new Date().toISOString()}
                  previewUrl={previewUrl}
                  previewRefresh={previewRefresh}
                  documentFile={documentFile}
                  documentRefresh={documentRefresh}
                  ports={previewPorts}
                  currentPort={currentPreviewPort}
                  publicPreview={activeWorkspace?.public_preview ?? false}
                  onSelectPort={handleSelectPreviewPort}
                  onSetPortAccess={handleSetPortAccess}
                  buildPortUrl={buildPortPublicUrl}
                  onRescanPorts={refreshPreviewPorts}
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

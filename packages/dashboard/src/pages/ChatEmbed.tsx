/**
 * ChatEmbed — Embeddable chat page for external callers.
 * Accessed at /chat?key=rc_...&profile=prof_...
 * Used both as a standalone page and inside the widget's iframe.
 */
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Send, RotateCcw, Loader2, Paperclip, X, FileText, Image, Download } from "lucide-react";
import { type ChatMessage, nextId, ToolBlock, MarkdownContent, QuestionPicker, parseAskUserInput } from "../components/ChatCore.js";
import { MessageList } from "../components/MessageList.js";

// ─── URL params ──────────────────────────────────────────────────────

function getParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? "";
}

// ─── localStorage persistence ────────────────────────────────────────

function storagePrefix(key: string): string {
  return `vonzio_${key.slice(0, 12)}`;
}

function saveSession(key: string, sessionId: string, messages: ChatMessage[]) {
  const prefix = storagePrefix(key);
  try {
    localStorage.setItem(`${prefix}_session`, sessionId);
    // Only save serializable fields
    const serializable = messages.map(({ id, role, content, tool, toolInput, images, files }) => ({
      id, role, content, tool, toolInput, images, files, timestamp: new Date().toISOString(),
    }));
    localStorage.setItem(`${prefix}_messages`, JSON.stringify(serializable));
  } catch { /* quota exceeded or private browsing */ }
}

function loadSession(key: string): { sessionId: string | null; messages: ChatMessage[] } {
  const prefix = storagePrefix(key);
  try {
    const sessionId = localStorage.getItem(`${prefix}_session`);
    const raw = localStorage.getItem(`${prefix}_messages`);
    if (!sessionId || !raw) return { sessionId: null, messages: [] };
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    const messages: ChatMessage[] = parsed.map((m) => ({
      id: m.id as string,
      role: m.role as ChatMessage["role"],
      content: m.content as string,
      tool: m.tool as string | undefined,
      toolInput: m.toolInput as Record<string, unknown> | undefined,
      images: m.images as string[] | undefined,
      files: m.files as Array<{ name: string; type: "image" | "document" }> | undefined,
      timestamp: new Date(m.timestamp as string),
    }));
    return { sessionId, messages };
  } catch {
    return { sessionId: null, messages: [] };
  }
}

function clearSession(key: string) {
  const prefix = storagePrefix(key);
  localStorage.removeItem(`${prefix}_session`);
  localStorage.removeItem(`${prefix}_messages`);
}

// ─── Transcript export ───────────────────────────────────────────────

function messagesToMarkdown(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`**You:** ${msg.content}`);
    } else if (msg.role === "assistant") {
      lines.push(`**Assistant:** ${msg.content}`);
    } else if (msg.role === "system") {
      lines.push(`*${msg.content}*`);
    }
    // skip tool_use / tool_result — internal noise
  }
  return lines.join("\n\n");
}

function downloadTranscript(messages: ChatMessage[]) {
  const md = messagesToMarkdown(messages);
  const blob = new Blob([md], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `chat-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Component ───────────────────────────────────────────────────────

export function ChatEmbed() {
  const callerKey = getParam("key");
  const profileId = getParam("profile");
  const embedded = getParam("embedded") === "true";
  const title = getParam("title") || "Chat";

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Theme detection for the embed. The dashboard's useTheme defaults to
  // "carbon" (dark) when no data-surface is set on <html>; the embed has
  // no dashboard session and inherits that default, which renders dark-
  // mode prose-invert text on the embed's white card → near-invisible
  // text. Use prefers-color-scheme so the embed matches the host site's
  // theme. Done as a state initializer so it applies BEFORE first render
  // (avoids a flash of the wrong palette).
  useState(() => {
    if (typeof window === "undefined") return null;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    document.documentElement.dataset.surface = mq.matches ? "carbon" : "paper";
    return null;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.surface = mq.matches ? "carbon" : "paper";
    };
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  const streamBufferRef = useRef("");
  const suppressNextAssistantRef = useRef(false);
  const [pendingQuestion, setPendingQuestion] = useState<{ question: string; options: string[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Array<{ type: "image" | "document"; media_type: string; data: string; name: string; preview?: string }>>([]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  // Persist messages to localStorage whenever they change
  useEffect(() => {
    if (callerKey && sessionId && messages.length > 0) {
      saveSession(callerKey, sessionId, messages);
    }
  }, [callerKey, sessionId, messages]);

  // Notify parent (for iframe embed)
  const notifyParent = useCallback((type: string, data?: Record<string, unknown>) => {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({ type: `vonzio:${type}`, ...data }, "*");
    }
  }, [embedded]);

  // Listen for postMessage commands from parent (widget panel)
  const newChatRef = useRef<() => void>(() => {});
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "vonzio:newChat") {
        newChatRef.current();
      } else if (event.data?.type === "vonzio:downloadTranscript") {
        const md = messagesToMarkdown(messagesRef.current);
        window.parent.postMessage({ type: "vonzio:transcript", markdown: md }, "*");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

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
        preview: isImage ? reader.result as string : undefined,
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
    for (const file of e.dataTransfer.files) {
      processFile(file);
    }
  }, [processFile]);

  // Connect WebSocket. The cleanup below uses a deferred-close pattern
  // so the React 19 StrictMode double-effect doesn't produce the
  // "WebSocket is closed before the connection is established" browser
  // warning — that lives in useEffect's cleanup, not here. Don't add
  // a "already connecting" guard here: in StrictMode the second mount
  // would skip creating its WS because the first (about-to-be-closed)
  // one is still CONNECTING, leaving the page with no live socket.
  const connect = useCallback(() => {
    if (!callerKey) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/v1/stream?token=${encodeURIComponent(callerKey)}`);

    ws.onopen = () => {
      setConnected(true);

      // Try to resume existing session. Dedup by id at the boundary —
      // historical localStorage state from broken connect-retry loops
      // could contain the same msg_N twice, which trips React's
      // "Encountered two children with the same key" warning when
      // MessageList renders.
      const saved = loadSession(callerKey);
      if (saved.sessionId) {
        const seen = new Set<string>();
        const deduped = saved.messages.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        setMessages(deduped);
        ws.send(JSON.stringify({ type: "session.resume", session_id: saved.sessionId }));
      }

      notifyParent("ready");
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      handleServerMessage(msg);
    };
    ws.onclose = () => {
      setConnected(false);
      setStreaming(false);
    };
    ws.onerror = () => {};
    wsRef.current = ws;
  }, [callerKey]);

  useEffect(() => {
    connect();
    return () => {
      // Defer the close until the WS is actually OPEN. Closing a WS
      // that's still CONNECTING is what produces the "WebSocket is
      // closed before the connection is established" browser warning.
      // React 19 StrictMode triggers this in dev (mount → cleanup →
      // mount runs twice); production is unaffected.
      const ws = wsRef.current;
      if (!ws) return;
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener("open", () => ws.close(), { once: true });
      } else {
        ws.close();
      }
    };
  }, [connect]);

  function handleServerMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "started":
        if (msg.container_id) setContainerId(msg.container_id as string);
        break;
      case "tool_use": {
        streamBufferRef.current = "";
        setStreaming(false);
        const toolName = msg.tool as string;
        const toolInput = msg.input as Record<string, unknown>;
        const hasInput = toolInput && Object.keys(toolInput).length > 0;

        if (toolName === "AskUserQuestion" && hasInput) {
          suppressNextAssistantRef.current = true;
          const parsed = parseAskUserInput(toolInput);
          if (parsed.length > 0) setPendingQuestion(parsed[0]);
        }

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "tool_use" && last.tool === toolName && !last.toolInput?._ && hasInput) {
            return [...prev.slice(0, -1), { ...last, toolInput }];
          }
          return [...prev, {
            id: nextId(), role: "tool_use" as const, content: "",
            tool: toolName, toolInput: hasInput ? toolInput : undefined, timestamp: new Date(),
          }];
        });
        break;
      }
      case "tool_result":
        streamBufferRef.current = "";
        setStreaming(false);
        setMessages((prev) => [...prev, {
          id: nextId(), role: "tool_result", content: (msg.output as string) ?? "",
          tool: msg.tool as string, timestamp: new Date(),
        }]);
        break;
      case "token":
        if (suppressNextAssistantRef.current) break;
        streamBufferRef.current += msg.text as string;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && streamBufferRef.current.length > (msg.text as string).length) {
            return [...prev.slice(0, -1), { ...last, content: streamBufferRef.current }];
          }
          return [...prev, { id: nextId(), role: "assistant", content: streamBufferRef.current, timestamp: new Date() }];
        });
        setStreaming(true);
        notifyParent("message", { role: "assistant" });
        break;
      case "done":
      case "turn.done": {
        if (suppressNextAssistantRef.current) {
          suppressNextAssistantRef.current = false;
          setStreaming(false);
          streamBufferRef.current = "";
          break;
        }
        const resultText = msg.result_text as string | undefined;
        if (resultText && !streamBufferRef.current) {
          setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: resultText, timestamp: new Date() }]);
        }
        setStreaming(false);
        streamBufferRef.current = "";
        break;
      }
      case "session.ready":
        setSessionId(msg.session_id as string);
        if (msg.container_id && msg.container_id !== "pending") {
          setContainerId(msg.container_id as string);
        }
        // If this was a resume and container_id is "pending", the old container is gone
        if (msg.resumed && (!msg.container_id || msg.container_id === "pending")) {
          setSessionExpired(true);
        }
        break;
      case "session.closed":
        setSessionId(null);
        break;
      case "error":
        if (msg.code === "SESSION_NOT_FOUND") {
          // Session expired on server — clear stored session, start fresh
          if (callerKey) clearSession(callerKey);
          setSessionId(null);
          setMessages([]);
        } else {
          setMessages((prev) => [...prev, { id: nextId(), role: "system", content: `Error: ${msg.message}`, timestamp: new Date() }]);
        }
        setStreaming(false);
        streamBufferRef.current = "";
        break;
      case "ask_user":
        streamBufferRef.current = "";
        suppressNextAssistantRef.current = true;
        setStreaming(false);
        setMessages((prev) => [...prev, {
          id: nextId(), role: "tool_use" as const, content: "",
          tool: "AskUserQuestion", toolInput: msg.input as Record<string, unknown>,
          timestamp: new Date(),
        }]);
        break;
    }
  }

  function sendQuickReply(text: string) {
    if (!wsRef.current || streaming) return;
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: text, timestamp: new Date() }]);
    if (sessionId) {
      wsRef.current.send(JSON.stringify({ type: "session.turn", session_id: sessionId, message: text }));
    }
    notifyParent("message", { role: "user" });
  }

  function send() {
    if (!input.trim() || !wsRef.current || streaming) return;
    const text = input.trim();
    setInput("");
    setAttachments([]);
    setSessionExpired(false);
    const imagePreviews = attachments.filter((a) => a.preview).map((a) => a.preview!);
    const fileMeta = attachments.map((a) => ({ name: a.name, type: a.type }));
    setMessages((prev) => [...prev, {
      id: nextId(), role: "user", content: text, timestamp: new Date(),
      images: imagePreviews.length > 0 ? imagePreviews : undefined,
      files: fileMeta.length > 0 ? fileMeta : undefined,
    }]);

    if (sessionId) {
      wsRef.current.send(JSON.stringify({
        type: "session.turn", session_id: sessionId, message: text,
        ...(attachments.length > 0 && { attachments: attachments.map(({ type, media_type, data, name }) => ({ type, media_type, data, name })) }),
      }));
    } else {
      // Auto-start session
      const atts = attachments.map(({ type, media_type, data, name }) => ({ type, media_type, data, name }));
      wsRef.current.send(JSON.stringify({ type: "session.start", profile_id: profileId || undefined }));
      const handler = (event: MessageEvent) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "session.ready") {
          wsRef.current?.removeEventListener("message", handler);
          wsRef.current?.send(JSON.stringify({
            type: "session.turn", session_id: msg.session_id, message: text,
            ...(atts.length > 0 && { attachments: atts }),
          }));
        }
      };
      wsRef.current?.addEventListener("message", handler);
    }

    notifyParent("message", { role: "user" });
  }

  function newConversation() {
    if (sessionId && wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: "session.end", session_id: sessionId }));
    }
    if (callerKey) clearSession(callerKey);
    setMessages([]);
    setSessionId(null);
    setContainerId(null);
    setStreaming(false);
    setSessionExpired(false);
    streamBufferRef.current = "";
  }
  newChatRef.current = newConversation;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (!callerKey) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--vz-mute)]">
        <div className="text-center">
          <h2 className="text-lg font-medium text-[color:var(--vz-ink)] mb-2">Missing API Key</h2>
          <p className="text-sm text-[color:var(--vz-muted)]">Add <code className="bg-[var(--vz-mute)] px-1 rounded">?key=rc_...</code> to the URL.</p>
        </div>
      </div>
    );
  }

  const hasMessages = messages.some((m) => m.role !== "system");

  // Dedup by id at the render boundary. Belt-and-suspenders fix for
  // any place upstream that might append a duplicate (server replay on
  // session.resume, stale localStorage from older sessions, etc.).
  // Keeps the FIRST occurrence — the React-key warning fires when the
  // SAME key shows up twice in the same array, so we just need to
  // collapse rather than choose.
  const dedupedMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [messages]);

  return (
    <div className="flex flex-col h-screen bg-[var(--vz-card)]">
      {/* Header (hidden when embedded in iframe) */}
      {!embedded && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[color:var(--vz-border)]">
          <div className="flex items-center gap-3">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{ background: "var(--vz-carbon, #0F2B46)" }}
            >
              <svg width="14" height="14" viewBox="0 0 64 64" aria-hidden="true">
                <path d="M18 22 L32 44 L46 22" fill="none" stroke="var(--vz-sodium, #FF6B35)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="22" y="49" width="20" height="3.5" rx="1.75" fill="var(--vz-sodium, #FF6B35)" />
              </svg>
            </div>
            <span className="text-sm font-medium text-[color:var(--vz-ink)]">{title}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] ${connected ? "text-green-600" : "text-[color:var(--vz-muted-2)]"}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-500" : "bg-gray-400"}`} />
              {connected ? "Connected" : "Connecting..."}
            </span>
          </div>
          <div className="flex items-center gap-2">
          <button
            onClick={() => downloadTranscript(messages)}
            disabled={!hasMessages}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-[color:var(--vz-muted)] hover:text-[color:var(--vz-ink)] border border-[color:var(--vz-border)] rounded-md hover:bg-[var(--vz-mute)] disabled:opacity-30 cursor-pointer transition-colors"
            title="Download chat"
          >
            <Download className="w-3 h-3" />
          </button>
          <button
            onClick={newConversation}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-[color:var(--vz-muted)] hover:text-[color:var(--vz-ink)] border border-[color:var(--vz-border)] rounded-md hover:bg-[var(--vz-mute)] cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            New Chat
          </button>
          </div>
        </div>
      )}

      {/* Session expired notice */}
      {sessionExpired && (
        <div className="px-4 py-1.5 bg-amber-50 border-b border-amber-100 text-center">
          <span className="text-[11px] text-amber-600">Session context was reset. The agent may not remember earlier messages.</span>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4">
        {!hasMessages && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
              style={{ background: "var(--vz-carbon, #0F2B46)" }}
            >
              <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
                <path d="M18 22 L32 44 L46 22" fill="none" stroke="var(--vz-sodium, #FF6B35)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
                <rect x="22" y="49" width="20" height="3.5" rx="1.75" fill="var(--vz-sodium, #FF6B35)" />
              </svg>
            </div>
            <p className="text-sm text-[color:var(--vz-muted)]">How can I help you?</p>
          </div>
        )}

        <div className="max-w-3xl mx-auto py-4 space-y-1">
          <MessageList messages={dedupedMessages} showTools={showTools} streaming={streaming} containerId={containerId} />
        </div>
      </div>

      {/* Input — swapped with QuestionPicker when agent asks */}
      {pendingQuestion ? (
        <QuestionPicker
          question={pendingQuestion.question}
          options={pendingQuestion.options}
          onSelect={(answer) => { setPendingQuestion(null); sendQuickReply(answer); }}
          onSkip={() => { setPendingQuestion(null); sendQuickReply("[No preference]"); }}
        />
      ) : (
      <div className="px-4 pb-3 pt-2 border-t border-[color:var(--vz-border)]">
        <div className="max-w-3xl mx-auto">
          <div
            className="relative border border-[color:var(--vz-border)] rounded-xl bg-[var(--vz-card)] shadow-sm focus-within:ring-2 focus-within:border-transparent"
            style={{ ["--tw-ring-color" as string]: "var(--vz-teal, #00BFA5)" }}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                {attachments.map((att, idx) => (
                  <div key={idx} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--vz-mute)] text-xs text-[color:var(--vz-ink-3)]">
                    {att.preview ? (
                      <img src={att.preview} alt="" className="w-6 h-6 rounded object-cover" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-red-500" />
                    )}
                    <span className="max-w-[120px] truncate">{att.name}</span>
                    <button type="button" onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))} className="text-[color:var(--vz-muted-2)] hover:text-[color:var(--vz-ink-2)] cursor-pointer">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2 ml-1.5 mb-1 text-[color:var(--vz-muted-2)] hover:text-[color:var(--vz-ink-2)] cursor-pointer"
                title="Attach file"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="*/*"
                multiple
                className="hidden"
                onChange={(e) => { for (const f of e.target.files ?? []) processFile(f); e.target.value = ""; }}
              />
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={getParam("placeholder") || "Type a message..."}
                disabled={streaming || !connected}
                rows={1}
                className="flex-1 resize-none border-0 bg-transparent px-2 py-3 text-sm placeholder:text-[color:var(--vz-muted-2)] focus:outline-none disabled:text-[color:var(--vz-muted-2)] max-h-[120px]"
              />
              <button
                onClick={send}
                disabled={streaming || !connected || (!input.trim() && attachments.length === 0)}
                className="m-1.5 p-2 rounded-lg text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                style={{ background: "var(--vz-teal, #00BFA5)" }}
              >
                {streaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-[color:var(--vz-muted-2)] text-center mt-2 flex items-center justify-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 64 64" aria-hidden="true">
              <path d="M18 22 L32 44 L46 22" fill="none" stroke="var(--vz-sodium, #FF6B35)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="22" y="49" width="20" height="4" rx="2" fill="var(--vz-sodium, #FF6B35)" />
            </svg>
            <span>Powered by <strong style={{ color: "var(--vz-ink)" }}>vonzio</strong></span>
          </p>
        </div>
      </div>
      )}
    </div>
  );
}

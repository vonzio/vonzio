import { useState, useRef, useEffect, useCallback } from "react";
import { type ChatMessage, nextId, parseAskUserInput } from "../components/ChatCore.js";

export type AgentStatus =
  | { state: "idle" }
  | { state: "waiting" }
  | { state: "thinking" }
  | { state: "tool"; tool: string };

export interface UseWorkspaceChatOptions {
  sessionId: string | null;
  profileId: string;
  onContainerIdChange?: (containerId: string) => void;
  onToolResult?: (tool: string, output: string) => void;
  onTitleUpdate?: (sessionId: string, name: string) => void;
  onAssistantMessage?: (text: string) => void;
  onTurnDone?: () => void;
  onLogEntry?: (entry: string) => void;
}

export function useWorkspaceChat({ sessionId, profileId, onContainerIdChange, onToolResult, onTitleUpdate, onAssistantMessage, onTurnDone, onLogEntry }: UseWorkspaceChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [containerName, setContainerName] = useState<string | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<{ question: string; options: string[] } | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ state: "idle" });

  const wsRef = useRef<WebSocket | null>(null);
  const streamBufferRef = useRef("");
  // Tracks the id of the assistant bubble that's currently receiving streamed
  // tokens. On turn.done we look up THIS message specifically and replace its
  // content with the server's signed result_text — rather than blindly
  // replacing "the last assistant message" which fails when a user_message
  // or system entry arrives between the last token and turn.done.
  const streamingMsgIdRef = useRef<string | null>(null);
  const suppressNextAssistantRef = useRef(false);
  const replayingRef = useRef(false);
  // Tracks the most recent AskUserQuestion seen during the current replay.
  // Cleared when a subsequent user_message arrives in replay (= the user
  // already answered). What's left here when replay_done fires is the
  // still-pending question we should restore as a clickable card.
  const replayPendingQuestionRef = useRef<{ question: string; options: string[] } | null>(null);
  const sessionReadyResolveRef = useRef<((id: string) => void) | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

  const onContainerIdChangeRef = useRef(onContainerIdChange);
  onContainerIdChangeRef.current = onContainerIdChange;
  const onToolResultRef = useRef(onToolResult);
  onToolResultRef.current = onToolResult;
  const onTitleUpdateRef = useRef(onTitleUpdate);
  onTitleUpdateRef.current = onTitleUpdate;
  const onAssistantMessageRef = useRef(onAssistantMessage);
  onAssistantMessageRef.current = onAssistantMessage;
  const onTurnDoneRef = useRef(onTurnDone);
  onTurnDoneRef.current = onTurnDone;
  const onLogEntryRef = useRef(onLogEntry);
  onLogEntryRef.current = onLogEntry;

  const addSystem = useCallback((content: string) => {
    setMessages((prev) => [...prev, { id: nextId(), role: "system", content, timestamp: new Date() }]);
  }, []);

  const handleServerMessage = useCallback((msg: Record<string, unknown>) => {
    const isReplay = !!msg._replay;
    const eventTime = () => new Date((msg._ts as number) ?? Date.now());
    const log = (entry: string) => { if (!isReplay) onLogEntryRef.current?.(entry); };
    const ts = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    switch (msg.type) {
      case "session.replay_start":
        replayingRef.current = true;
        setMessages([]);
        streamBufferRef.current = "";
        streamingMsgIdRef.current = null;
        // Reset the "did we see an unanswered ask?" tracker for this
        // replay batch — it's repopulated as we walk the events.
        replayPendingQuestionRef.current = null;
        // Also clear any pending question carried over from a prior
        // session render. The replay walk authoritatively decides
        // whether one is outstanding.
        setPendingQuestion(null);
        break;
      case "session.replay_done":
        replayingRef.current = false;
        // Restore the still-unanswered ask we found mid-replay (if any).
        // setPendingQuestion is React-state-only so calling it after
        // the message array is settled is the right ordering.
        if (replayPendingQuestionRef.current) {
          setPendingQuestion(replayPendingQuestionRef.current);
          replayPendingQuestionRef.current = null;
        }
        log(`[${ts()}] Session resumed — replayed ${msg.last_seq ?? 0} events`);
        break;
      case "user_message":
        // During replay, a user_message arriving AFTER an AskUserQuestion
        // means the user already answered — clear the tracker so we don't
        // restore a stale question card at replay_done. Live messages just
        // append to the timeline.
        if (isReplay) replayPendingQuestionRef.current = null;
        // The user_message event can carry attachments when it originates
        // from a non-dashboard surface (Telegram, Slack, future bots).
        // The dashboard's own send() optimistically renders locally so
        // these fields are only populated for inbound third-party events.
        setMessages((prev) => [...prev, {
          id: nextId(), role: "user", content: (msg.text as string) ?? "",
          timestamp: new Date(msg.ts as number ?? Date.now()),
          images: msg.images as string[] | undefined,
          files: msg.files as Array<{ name: string; type: "image" | "document" }> | undefined,
        }]);
        break;
      case "text": {
        const textContent = (msg.text as string) ?? "";
        setMessages((prev) => [...prev, {
          id: nextId(), role: "assistant", content: textContent,
          timestamp: new Date(msg.ts as number ?? Date.now()),
        }]);
        if (textContent) onAssistantMessageRef.current?.(textContent);
        break;
      }
      case "queued":
        setAgentStatus((prev) => prev.state === "idle" ? { state: "waiting" } : prev);
        log(`[${ts()}] Task queued`);
        break;
      case "started":
        setAgentStatus((prev) => prev.state === "idle" || prev.state === "waiting" ? { state: "waiting" } : prev);
        if (msg.container_id) {
          const cid = msg.container_id as string;
          setContainerId(cid);
          if (msg.container_name) setContainerName(msg.container_name as string);
          onContainerIdChangeRef.current?.(cid);
          log(`[${ts()}] Container started: ${(msg.container_name as string) ?? cid.slice(0, 12)}`);
        }
        break;
      case "tool_use": {
        streamBufferRef.current = "";
        setStreaming(false);
        setAgentStatus({ state: "tool", tool: (msg.tool as string) ?? "" });
        const toolName = msg.tool as string;
        const toolInput = msg.input as Record<string, unknown>;
        const hasInput = toolInput && Object.keys(toolInput).length > 0;

        if (toolName === "AskUserQuestion" && hasInput) {
          const parsed = parseAskUserInput(toolInput);
          if (isReplay) {
            // Remember the latest AskUserQuestion seen during this
            // replay. If the user already answered it (a subsequent
            // user_message will arrive in the same replay batch), the
            // user_message handler clears this ref. What survives to
            // session.replay_done is the still-unanswered question
            // and we restore it as the active pending question card.
            if (parsed.length > 0) replayPendingQuestionRef.current = parsed[0];
          } else {
            suppressNextAssistantRef.current = true;
            if (parsed.length > 0) setPendingQuestion(parsed[0]);
          }
        }

        // Log tool use with brief input summary
        if (hasInput) {
          const inputSummary = Object.entries(toolInput)
            .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60)}`)
            .join(", ");
          log(`[${ts()}] ▶ ${toolName}(${inputSummary.slice(0, 120)})`);
        } else {
          log(`[${ts()}] ▶ ${toolName}`);
        }

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "tool_use" && last.tool === toolName && !last.toolInput?._ && hasInput) {
            return [...prev.slice(0, -1), { ...last, toolInput }];
          }
          return [...prev, {
            id: nextId(), role: "tool_use" as const, content: "",
            tool: toolName, toolInput: hasInput ? toolInput : undefined, timestamp: eventTime(),
          }];
        });
        break;
      }
      case "tool_result": {
        streamBufferRef.current = "";
        setStreaming(false);
        const toolOutput = (msg.output as string) ?? "";
        const resultTool = msg.tool as string;
        setMessages((prev) => [...prev, {
          id: nextId(), role: "tool_result", content: toolOutput,
          tool: resultTool, timestamp: eventTime(),
        }]);
        onToolResultRef.current?.(resultTool, toolOutput);
        const preview = toolOutput.replace(/\s+/g, " ").trim().slice(0, 120);
        log(`[${ts()}] ✓ ${resultTool}${preview ? `: ${preview}${toolOutput.length > 120 ? "…" : ""}` : ""}`);
        break;
      }
      case "token":
        if (isReplay) break;
        if (suppressNextAssistantRef.current) break;
        setAgentStatus({ state: "thinking" });
        streamBufferRef.current += msg.text as string;
        setMessages((prev) => {
          // Resume into the same bubble for the rest of this turn — but only
          // if the bubble we created is still present (sanity guard against
          // it being cleared by session.replay_start).
          const targetId = streamingMsgIdRef.current;
          if (targetId) {
            const idx = prev.findIndex((m) => m.id === targetId);
            if (idx !== -1) {
              const copy = prev.slice();
              copy[idx] = { ...copy[idx], content: streamBufferRef.current };
              return copy;
            }
          }
          // First token of this turn — create the bubble and remember its id
          // so turn.done can target it precisely.
          const newId = nextId();
          streamingMsgIdRef.current = newId;
          return [...prev, { id: newId, role: "assistant", content: streamBufferRef.current, timestamp: new Date() }];
        });
        setStreaming(true);
        break;
      case "turn.continuing": {
        const continuation = msg.continuation as number;
        const maxCont = msg.max_continuations as number;
        log(`[${ts()}] Auto-continuing (${continuation}/${maxCont})`);
        // Flush current stream and add a system marker
        if (streamBufferRef.current) {
          onAssistantMessageRef.current?.(streamBufferRef.current);
        }
        streamBufferRef.current = "";
        // Each continuation gets its own bubble.
        streamingMsgIdRef.current = null;
        setMessages((prev) => [...prev, { id: nextId(), role: "system", content: `Auto-continuing (${continuation}/${maxCont})...`, timestamp: new Date() }]);
        setAgentStatus({ state: "thinking" });
        break;
      }
      case "done":
      case "turn.done": {
        if (suppressNextAssistantRef.current) {
          suppressNextAssistantRef.current = false;
          setStreaming(false);
          setAgentStatus({ state: "idle" });
          streamBufferRef.current = "";
          streamingMsgIdRef.current = null;
          break;
        }
        const resultText = msg.result_text as string | undefined;
        if (resultText && !streamBufferRef.current) {
          // No streaming bubble — fresh assistant message (e.g. replay path).
          setMessages((prev) => [...prev, { id: nextId(), role: "assistant", content: resultText, timestamp: new Date() }]);
          onAssistantMessageRef.current?.(resultText);
        } else if (streamBufferRef.current) {
          // Replace the streamed bubble's content with the server's polished
          // result_text. The streamed version has raw image URLs the browser
          // can't fetch; result_text has signed _pvt tokens injected so
          // inline images actually render. We target the streaming bubble by
          // its id — that survives intervening user/system messages, unlike
          // a "replace the last assistant" heuristic.
          const finalText = resultText ?? streamBufferRef.current;
          const targetId = streamingMsgIdRef.current;
          setMessages((prev) => {
            if (targetId) {
              const idx = prev.findIndex((m) => m.id === targetId);
              if (idx !== -1) {
                const copy = prev.slice();
                copy[idx] = { ...copy[idx], content: finalText };
                return copy;
              }
            }
            // Fallback: streaming bubble disappeared (clear/replay). Append.
            return [...prev, { id: nextId(), role: "assistant", content: finalText, timestamp: new Date() }];
          });
          onAssistantMessageRef.current?.(finalText);
        }
        setStreaming(false);
        setAgentStatus({ state: "idle" });
        streamBufferRef.current = "";
        streamingMsgIdRef.current = null;
        if (!isReplay) onTurnDoneRef.current?.();
        log(`[${ts()}] Turn complete`);
        break;
      }
      case "session.ready": {
        const sid = msg.session_id as string;
        if (msg.container_id && msg.container_id !== "pending") {
          const cid = msg.container_id as string;
          setContainerId(cid);
          if (msg.container_name) setContainerName(msg.container_name as string);
          onContainerIdChangeRef.current?.(cid);
        }
        if (sessionReadyResolveRef.current) {
          sessionReadyResolveRef.current(sid);
          sessionReadyResolveRef.current = null;
        }
        log(`[${ts()}] Session ready`);
        break;
      }
      case "session.closed":
        addSystem("Session ended");
        log(`[${ts()}] Session closed`);
        break;
      case "workspace.title_updated":
        onTitleUpdateRef.current?.(msg.session_id as string, msg.name as string);
        break;
      case "ask_user": {
        const input = msg.input as Record<string, unknown>;
        if (isReplay) {
          // Mirror the AskUserQuestion tool_use path: remember the
          // latest ask during replay; clear on a subsequent user_message
          // turn (= already answered). What's left at replay_done is
          // the pending question.
          const parsed = parseAskUserInput(input);
          if (parsed.length > 0) replayPendingQuestionRef.current = parsed[0];
          break;
        }
        streamBufferRef.current = "";
        suppressNextAssistantRef.current = true;
        setStreaming(false);
        setMessages((prev) => [...prev, {
          id: nextId(), role: "tool_use" as const, content: "",
          tool: "AskUserQuestion", toolInput: input,
          timestamp: eventTime(),
        }]);
        break;
      }
      case "cancelled":
        setStreaming(false);
        setAgentStatus({ state: "idle" });
        streamBufferRef.current = "";
        setMessages((prev) => [...prev, {
          id: nextId(), role: "system" as const, content: "Stopped by user.",
          timestamp: new Date(),
        }]);
        log(`[${ts()}] Stopped by user`);
        break;
      case "error":
        if (msg.code === "SESSION_NOT_FOUND") {
          setMessages([]);
          addSystem("Previous session expired. Start a new conversation.");
        } else {
          addSystem(`Error: ${msg.message}`);
        }
        setStreaming(false);
        setAgentStatus({ state: "idle" });
        streamBufferRef.current = "";
        log(`[${ts()}] ✗ Error: ${msg.message ?? msg.code ?? "unknown"}`);
        break;
    }
  }, [addSystem]);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // SaaS only — append the active org id as a query param because
    // browsers can't set custom headers on WebSocket upgrade. The
    // server-side permissive orgContext hook reads this as a
    // fallback to X-Org-Id. OSS leaves the localStorage key unset
    // → no param → no behavior change.
    const orgQuery = (() => {
      if (typeof localStorage === "undefined") return "";
      try {
        const id = localStorage.getItem("vonzio_current_org_id");
        return id ? `?org_id=${encodeURIComponent(id)}` : "";
      } catch {
        return "";
      }
    })();
    const ws = new WebSocket(`${protocol}//${window.location.host}/v1/stream${orgQuery}`);

    ws.onopen = () => {
      setConnected(true);
      if (currentSessionIdRef.current) {
        ws.send(JSON.stringify({
          type: "session.resume",
          session_id: currentSessionIdRef.current,
          last_seq: 0,
        }));
      }
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
  }, [handleServerMessage]);

  useEffect(() => {
    connect();
    return () => {
      const ws = wsRef.current;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          // StrictMode: let the handshake finish, then close silently
          ws.onopen = () => ws.close();
          ws.onmessage = null;
          ws.onclose = null;
        }
        wsRef.current = null;
      }
    };
  }, [connect]);

  // When sessionId changes (user clicked a different workspace), resume the new session
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId === prevSessionIdRef.current) return;
    prevSessionIdRef.current = sessionId;

    // Clear old state
    setMessages([]);
    setStreaming(false);
    setContainerId(null);
    setPendingQuestion(null);
    setAgentStatus({ state: "idle" });
    streamBufferRef.current = "";
    suppressNextAssistantRef.current = false;

    // Resume the new session on the existing WS
    if (sessionId && wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({
        type: "session.resume",
        session_id: sessionId,
        last_seq: 0,
      }));
    }
  }, [sessionId]);

  const send = useCallback((text: string, attachments?: Array<{ type: "image" | "document"; media_type: string; data: string; name: string }>) => {
    const hasContent = text.trim().length > 0 || (attachments && attachments.length > 0);
    if (!hasContent || !wsRef.current || !currentSessionIdRef.current) return;
    setMessages((prev) => [...prev, {
      id: nextId(), role: "user", content: text, timestamp: new Date(),
      images: attachments?.filter((a) => a.type === "image").map((a) => `data:${a.media_type};base64,${a.data}`) || undefined,
      files: attachments?.map((a) => ({ name: a.name, type: a.type })) || undefined,
    }]);
    setAgentStatus({ state: "waiting" });
    setStreaming(true);
    wsRef.current.send(JSON.stringify({
      type: "session.turn",
      session_id: currentSessionIdRef.current,
      message: text,
      ...(attachments && attachments.length > 0 && { attachments }),
    }));
  }, []);

  const sendQuickReply = useCallback((text: string) => {
    if (!wsRef.current || streaming) return;
    setMessages((prev) => [...prev, { id: nextId(), role: "user", content: text, timestamp: new Date() }]);
    setAgentStatus({ state: "waiting" });
    setStreaming(true);
    if (currentSessionIdRef.current) {
      wsRef.current.send(JSON.stringify({ type: "session.turn", session_id: currentSessionIdRef.current, message: text }));
    }
  }, [streaming]);

  const cancel = useCallback(() => {
    if (!wsRef.current || !currentSessionIdRef.current) return;
    wsRef.current.send(JSON.stringify({
      type: "session.turn.cancel",
      session_id: currentSessionIdRef.current,
    }));
  }, []);

  const startSession = useCallback((overrideProfileId?: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current) {
        reject(new Error("WebSocket not connected"));
        return;
      }
      sessionReadyResolveRef.current = resolve;
      wsRef.current.send(JSON.stringify({
        type: "session.start",
        profile_id: overrideProfileId ?? profileId,
      }));
    });
  }, [profileId]);

  return {
    messages,
    streaming,
    connected,
    containerId,
    containerName,
    pendingQuestion,
    setPendingQuestion,
    agentStatus,
    send,
    sendQuickReply,
    cancel,
    startSession,
  };
}

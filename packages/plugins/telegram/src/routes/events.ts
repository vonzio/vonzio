// Telegram inbound webhook + outbound (orchestrator -> chat) relay.
// Moved here from packages/core-server/src/routes/telegram-events.ts in
// Phase 3D.1d.1. The full surface (incoming /message + /callback_query
// routing, the 5 task:* event handlers) is unchanged; the only diffs
// from the in-core version are:
//
//   - imports rewired to plugin-owned modules + @vonzio/plugin-api
//     contracts instead of relative ../services/* paths
//   - schema imports point at the plugin-owned drizzle definitions
//     (see ../db/schema.ts) rather than core's mirrors
//   - the 5 orchestrator event subscriptions go through
//     opts.sessionEvents (the typed facade from Phase 3D.1a/#76)
//     instead of orchestrator.on(...)
//   - sessionRegistry.register call adjusted for the narrower 4-arg
//     PluginSessionLifecycle.register signature
//   - PlatformBotService is the plugin-local class

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { eq, and, desc, gte, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  parseThreadCallback,
  switchedThreadDisclaimer,
  THREAD_CLAIM_WINDOW_MS,
} from "@vonzio/shared";
import type { TaskAttachment, Workspace } from "@vonzio/shared";
import type {
  PluginIntegrationLookup,
  PluginTaskSubmitter,
  PluginProfileLookup,
  PluginProfileResolver,
  PluginSessionLifecycle,
  PluginWorkspaceLookup,
  PluginOrchestrator,
  PluginEventLog,
  PluginConnectionManager,
  PluginImageRewriter,
  PluginModelList,
  SessionEvents,
} from "@vonzio/plugin-api";
import type { TelegramService } from "../services/telegram-service.js";
import { markdownToTelegram, splitTelegramMessage } from "../services/telegram-service.js";
import { PlatformBotService } from "../services/platform-bot-service.js";
import type { TelegramConfig } from "../types.js";
import {
  telegramSessions,
  telegramActiveSessions,
  telegramPlaybookThreads,
} from "../db/schema.js";

/**
 * Inline schema namespace so the original
 * `schema.telegramSessions` / `schema.telegramActiveSessions` /
 * `schema.telegramPlaybookThreads` call sites move verbatim with no
 * destructuring. Keeps the file diff small.
 */
const schema = {
  telegramSessions,
  telegramActiveSessions,
  telegramPlaybookThreads,
};

/**
 * Single source of truth for "which model would the next agent turn
 * use" at picker time (no task in flight). Inlined from core's
 * `lib/model-resolution.ts` -- it was a 3-line ternary not worth a
 * cross-package import.
 */
function resolveWorkspaceModel(
  workspace: Pick<Workspace, "model_override"> | null | undefined,
  profile: { model?: string | null } | null | undefined,
): string | null {
  return workspace?.model_override ?? profile?.model ?? null;
}

/**
 * Drizzle handle the file uses for db.select / db.insert / db.update.
 * Plugin-api types `PluginCore.db` as `unknown`; we cast once at the
 * registration boundary and the rest of the file stays drizzle-typed.
 */
type DrizzleDB = NodePgDatabase<Record<string, never>>;

export interface TelegramEventsRoutesOptions {
  config: { BETTER_AUTH_URL: string };
  db: DrizzleDB;
  integrationService: PluginIntegrationLookup;
  telegramService: TelegramService;
  taskService: PluginTaskSubmitter;
  profileService: PluginProfileLookup & PluginProfileResolver;
  sessionRegistry: PluginSessionLifecycle;
  workspaceService: PluginWorkspaceLookup;
  orchestrator: PluginOrchestrator;
  eventLog: PluginEventLog;
  // Used to push user_message events to any dashboard WS clients
  // watching this session so Telegram chat appears live in the workspace
  // view instead of only after a refresh.
  connectionManager: PluginConnectionManager;
  // Wraps the agent-output-rewriter + container-name cache + token signing.
  // Used to extract inline images for sendPhoto follow-ups.
  imageRewriterService: PluginImageRewriter;
  // Source of truth for the platform bot's token + metadata. Used to
  // resolve runtime bot_token for is_platform_owned rows and to dispatch
  // incoming webhooks to the right user-integration (the platform bot's
  // bot_user_id maps to many rows — one per paired user).
  platformBotService: PlatformBotService;
  // Shared cached provider lookup for the /model picker.
  modelListService: PluginModelList;
  // Typed facade over orchestrator's EventEmitter. Backs the 5
  // task:* subscriptions inside setupTelegramRelay; replaces the
  // direct orchestrator.on(...) calls the file used to do.
  sessionEvents: SessionEvents;
}


interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
  date: number;
  text?: string;
  // Captions live in their own field when the message is a photo/doc rather
  // than plain text. The handler treats caption as the prompt text.
  caption?: string;
  // PhotoSize array sorted ascending by area — pick the last for the
  // best-quality variant Telegram exposes (capped at 1280px by their server).
  photo?: TelegramPhotoSize[];
  // Documents include images sent with "Send as file" mode + PDFs etc.
  document?: TelegramDocument;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

// Telegram caps Bot API getFile downloads at 20 MB. Trying anything bigger
// returns a getFile error rather than a partial body, so we just refuse early.
const TELEGRAM_FILE_SIZE_LIMIT = 20 * 1024 * 1024;
// Media types we'll happily forward to the agent. Photos always come back
// as image/jpeg from Telegram (re-encoded on their CDN). Documents preserve
// the user's mime_type if known.
const SUPPORTED_DOC_MIME_PREFIXES = ["image/", "application/pdf", "text/"];
// Placeholder prompt when a user sends an attachment with no caption so
// the agent sees actionable text rather than an empty string.
const NO_CAPTION_PROMPT = "[User uploaded a file with no caption]";
// Mime → file extension fallback for documents whose original filename
// isn't supplied. Keeps Read-tool guidance accurate (orchestrator picks
// the extension off the filename, not the mime).
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
};

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}

// Per-session token + tool buffers, mirroring the Slack relay model.
const sessionBuffers = new Map<string, { tokens: string[]; toolCalls: string[] }>();

// AskUserQuestion message_id → option labels (to recover label from callback index).
// Process-local — survives only until restart, which is acceptable for an in-flight question.
// Each entry has a TTL via setTimeout to prevent unbounded growth when users ignore questions.
const askMessages = new Map<number, { sessionId: string; options: string[] }>();
const ASK_TTL_MS = 60 * 60 * 1000; // 1 hour
function rememberAskMessage(messageId: number, entry: { sessionId: string; options: string[] }) {
  askMessages.set(messageId, entry);
  setTimeout(() => askMessages.delete(messageId), ASK_TTL_MS).unref?.();
}

// /model picker message_id → { sessionId, modelIds }. Callback data only
// carries the option index (Telegram caps at 64 bytes; some Ollama tags
// blow that out alone). Resolved back to the full id on click. 1h TTL so
// abandoned pickers don't pile up across a long-running server.
const modelPickerMessages = new Map<number, { sessionId: string; modelIds: string[] }>();
const MODEL_PICKER_TTL_MS = 60 * 60 * 1000;
function rememberModelPicker(messageId: number, entry: { sessionId: string; modelIds: string[] }) {
  modelPickerMessages.set(messageId, entry);
  setTimeout(() => modelPickerMessages.delete(messageId), MODEL_PICKER_TTL_MS).unref?.();
}

// Sessions awaiting a button click — same pattern as Slack: swallow the fallback text turn.
const pendingAskSessions = new Set<string>();

// Repeated typing-indicator timers per session. Telegram's typing action
// decays after ~5s, so we re-emit it every 4s while a task is in flight.
// Cleared on task:done / task:failed / task:ask_user.
const typingTimers = new Map<string, NodeJS.Timeout>();
const TYPING_REFRESH_MS = 4000;

// Edit-in-place streaming state per session. On first token we send a
// placeholder message and remember its id; subsequent tokens accumulate
// into `rawText` and trigger a throttled editMessageText so one message
// grows in place rather than a wall of new messages. On task:done the
// placeholder is edited to the final formatted output (or used as a
// teaser if the output is too long — see commit 5 for the document path).
interface StreamingState {
  messageId: number;
  rawText: string;
  lastEditAt: number;
  pendingEdit: NodeJS.Timeout | null;
  botToken: string;
  chatId: number | string;
}
const streamingState = new Map<string, StreamingState>();
// Guards a race where two rapid token events both try to create the
// placeholder message simultaneously and we end up with duplicates.
const streamInitInFlight = new Set<string>();
const EDIT_THROTTLE_MS = 700;
const STREAM_PLACEHOLDER = "…";
// Live-stream window — Telegram caps a single message at 4096 chars. We
// trim from the head when raw text exceeds this so the latest output
// is always visible. The polished final formatted message replaces it.
const STREAM_VISIBLE_TAIL = 3500;
// Threshold above which we ship the body as a .md attachment instead of
// splitting it into walls of MarkdownV2 messages.
const LONG_OUTPUT_THRESHOLD = 8000;
const LONG_OUTPUT_PREVIEW = 1500;

function clearStreamingState(sessionId: string) {
  const state = streamingState.get(sessionId);
  if (state?.pendingEdit) clearTimeout(state.pendingEdit);
  streamingState.delete(sessionId);
}

function startTypingRefresh(
  sessionId: string,
  telegramService: TelegramService,
  botToken: string,
  chatId: number | string,
) {
  stopTypingRefresh(sessionId);
  const handle = setInterval(() => {
    telegramService.sendChatAction(botToken, chatId, "typing").catch(() => {});
  }, TYPING_REFRESH_MS);
  handle.unref?.();
  typingTimers.set(sessionId, handle);
}

function stopTypingRefresh(sessionId: string) {
  const handle = typingTimers.get(sessionId);
  if (handle) {
    clearInterval(handle);
    typingTimers.delete(sessionId);
  }
}

const SLUG_PREFIX_RE = /^@([a-z0-9](?:-?[a-z0-9])*):?(?:\s+|$)/;

function secretsMatch(a: string, b: string | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Escape user-controlled content for Telegram's HTML parse_mode. The Bot
 * API only special-cases `<`, `>`, and `&` — quotes and apostrophes are
 * literal inside tags but we escape them anyway for symmetry. Used when we
 * need to render slugs/names containing characters Telegram's auto-linker
 * would mis-parse (notably `@<slug-with-hyphens>`).
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseAgentSlug(text: string): { slug?: string; prompt: string } {
  const match = text.match(SLUG_PREFIX_RE);
  if (!match) return { prompt: text };
  return { slug: match[1], prompt: text.slice(match[0].length).trim() };
}

export const telegramEventsRoutes = fp(
  async (server: FastifyInstance, opts: TelegramEventsRoutesOptions) => {
    server.register(async (tg) => {
      registerWebhookRoute(tg, opts);
    });
    setupTelegramRelay(opts, server);
  },
  { name: "telegram-events-routes" },
);

function registerWebhookRoute(server: FastifyInstance, opts: TelegramEventsRoutesOptions) {
  const {
    config, db, integrationService, telegramService,
    taskService, profileService, sessionRegistry, workspaceService, orchestrator, eventLog,
    connectionManager, modelListService,
  } = opts;

  // Dashboard URL root. Workspace pages live at `<root>/w/<session_id>`.
  // Trim any trailing slash so we can concat without doubling.
  const dashboardRoot = config.BETTER_AUTH_URL.replace(/\/$/, "");
  const workspaceUrl = (sessionId: string) => `${dashboardRoot}/w/${sessionId}`;

  // Collect any photo/document on the message, resolve to file_path,
  // download bytes, base64-encode for the orchestrator. Refuses files
  // larger than the Bot API's 20 MB getFile limit. Adds explicit entries
  // to `unsupported` for other media types Telegram exposes (video, voice,
  // audio, stickers, animations) so the user gets feedback instead of a
  // silent drop.
  type CollectedAttachments = {
    attachments: TaskAttachment[];
    unsupported: string[];
  };
  async function collectAttachments(cfg: TelegramConfig, msg: TelegramMessage): Promise<CollectedAttachments> {
    const out: CollectedAttachments = { attachments: [], unsupported: [] };

    if (msg.photo?.length) {
      // Largest variant is last; Telegram sorts ascending by area.
      const largest = msg.photo[msg.photo.length - 1];
      if (largest.file_size && largest.file_size > TELEGRAM_FILE_SIZE_LIMIT) {
        out.unsupported.push("photo (too large for Bot API)");
      } else {
        try {
          const file = await telegramService.getFile(cfg.bot_token, largest.file_id);
          // Double-check size against getFile's authoritative value — the
          // inbound message's file_size field is optional and sometimes wrong.
          if (file.file_size && file.file_size > TELEGRAM_FILE_SIZE_LIMIT) {
            out.unsupported.push("photo (too large for Bot API)");
          } else if (file.file_path) {
            const bytes = await telegramService.downloadFile(cfg.bot_token, file.file_path);
            out.attachments.push({
              type: "image",
              media_type: "image/jpeg", // Telegram re-encodes all photos to JPEG
              data: bytes.toString("base64"),
              name: `photo_${file.file_unique_id}.jpg`,
            });
          }
        } catch (err) {
          server.log.warn({ err }, "Telegram photo download failed");
          out.unsupported.push("photo (download failed)");
        }
      }
    }

    if (msg.document) {
      const doc = msg.document;
      const mime = doc.mime_type ?? "application/octet-stream";
      const supported = SUPPORTED_DOC_MIME_PREFIXES.some((p) => mime.startsWith(p));
      if (!supported) {
        out.unsupported.push(`${mime} document`);
      } else if (doc.file_size && doc.file_size > TELEGRAM_FILE_SIZE_LIMIT) {
        out.unsupported.push(`${doc.file_name ?? "document"} (too large)`);
      } else {
        try {
          const file = await telegramService.getFile(cfg.bot_token, doc.file_id);
          if (file.file_size && file.file_size > TELEGRAM_FILE_SIZE_LIMIT) {
            out.unsupported.push(`${doc.file_name ?? "document"} (too large)`);
          } else if (file.file_path) {
            const bytes = await telegramService.downloadFile(cfg.bot_token, file.file_path);
            const ext = MIME_EXTENSIONS[mime] ?? "bin";
            out.attachments.push({
              type: mime.startsWith("image/") ? "image" : "document",
              media_type: mime,
              data: bytes.toString("base64"),
              name: doc.file_name ?? `document_${file.file_unique_id}.${ext}`,
            });
          }
        } catch (err) {
          server.log.warn({ err }, "Telegram document download failed");
          out.unsupported.push(`${doc.file_name ?? "document"} (download failed)`);
        }
      }
    }

    // Other media types Telegram exposes — explicitly call them out so
    // the user knows nothing was attached, rather than silently dropping
    // the message body. Each field's presence is enough; we don't need
    // to inspect file_id since we're not going to download.
    type MaybeMedia = TelegramMessage & {
      video?: unknown; voice?: unknown; audio?: unknown;
      sticker?: unknown; animation?: unknown; video_note?: unknown;
    };
    const m = msg as MaybeMedia;
    if (m.video) out.unsupported.push("video");
    if (m.voice) out.unsupported.push("voice message");
    if (m.audio) out.unsupported.push("audio");
    if (m.sticker) out.unsupported.push("sticker");
    if (m.animation) out.unsupported.push("GIF/animation");
    if (m.video_note) out.unsupported.push("video note");

    return out;
  }

  // Persist user message to the event log AND push it over WS so any
  // dashboard client watching this session sees the Telegram turn appear
  // live. The dashboard's WS handler already maps `type: "user_message"`
  // to a chat bubble (see useWorkspaceChat.ts).
  function publishUserMessage(sessionId: string, text: string, attachments: TaskAttachment[] = []) {
    // Mirror the dashboard's local-render shape (useWorkspaceChat.ts:336):
    // images is an array of data: URLs, files is metadata (name + type).
    // Built from the same attachments[] that goes to the orchestrator.
    const images = attachments
      .filter((a) => a.type === "image")
      .map((a) => `data:${a.media_type};base64,${a.data}`);
    const files = attachments.map((a) => ({ name: a.name ?? "attachment", type: a.type }));

    // Persist *metadata only* to the event log — full base64 (10s of MB)
    // bloats the JSONL and the orchestrator already saved the bytes into
    // the workspace container under /workspace/uploads/. Live WS push
    // still carries the data URLs so the dashboard can render inline.
    eventLog.append(sessionId, "user_message", {
      type: "user_message",
      session_id: sessionId,
      text,
      files: files.length > 0 ? files : undefined,
    });
    // Best-effort: a dead socket inside sendToSession can throw synchronously.
    // We never want a misbehaving WS client to break the Telegram flow.
    try {
      connectionManager.sendToSession(sessionId, {
        type: "user_message",
        session_id: sessionId,
        text,
        ts: Date.now(),
        source: "telegram",
        images: images.length > 0 ? images : undefined,
        files: files.length > 0 ? files : undefined,
      });
    } catch (err) {
      server.log.warn({ err, sessionId }, "Failed to publish user_message to WS subscribers");
    }
  }

  server.post<{ Params: { botId: string } }>(
    "/api/telegram/webhook/:botId",
    async (request, reply) => {
      const { botId } = request.params;
      const headerSecret = request.headers["x-telegram-bot-api-secret-token"];
      const platformMeta = opts.platformBotService.getMetadata();
      const isPlatformBot = !!(platformMeta && platformMeta.botUserId === botId);

      // Two paths for the secret check, both run BEFORE any heavy DB
      // work so a spoofed request can't trigger N decrypts:
      //   - Platform bot: secret is env-wide. Single string compare.
      //   - Per-user bot: secret lives on the (single) integration row.
      //     We have to load the row to know the secret, but the lookup
      //     is an indexed single-row query — cheap.
      let expectedSecret: string | null = null;
      let preResolved: { id: string; user_id: string; config: Record<string, unknown> } | null = null;

      if (isPlatformBot) {
        expectedSecret = opts.platformBotService.getWebhookSecret();
      } else {
        preResolved = await integrationService.findByTypeAndExternalId("telegram", botId);
        if (!preResolved) {
          return reply.code(404).send({ error: "unknown_bot" });
        }
        const preCfg = preResolved.config as unknown as TelegramConfig;
        // Guard against misrouting: if the resolved row is platform-owned
        // but we got here (isPlatformBot=false), PlatformBotService is
        // unavailable (init failed or env cleared post-create). The
        // single-row lookup would happily return any of the N platform
        // rows for this bot_user_id — processing the message as that
        // arbitrary user would silently deliver someone else's message
        // into the wrong account.
        if (preCfg.is_platform_owned) {
          return reply.code(503).send({ error: "platform_bot_unavailable" });
        }
        expectedSecret = preCfg.webhook_secret ?? null;
      }

      if (!expectedSecret || typeof headerSecret !== "string" || !secretsMatch(headerSecret, expectedSecret)) {
        return reply.code(401).send({ error: "invalid_secret" });
      }

      // ACK immediately so Telegram doesn't retry — process async.
      reply.code(200).send();

      const update = request.body as TelegramUpdate | undefined;
      if (!update) return;

      // Resolve the specific user-integration row this update targets.
      // For per-user bots we already have it. For the platform bot we
      // disambiguate by the Telegram from.id (linked) or a pending
      // pair-code claim (unlinked). Extract from.id and text from
      // whichever update type the webhook carries — Telegram updates
      // can be `message`, `callback_query`, `edited_message`, etc.,
      // and each has its own `from` field.
      let integration: { id: string; user_id: string; config: Record<string, unknown> } | null;
      if (isPlatformBot) {
        const fromId =
          (update.message?.from?.id
            ?? update.callback_query?.from?.id
            ?? (update as { edited_message?: { from?: { id: number } } }).edited_message?.from?.id)
          ?? undefined;
        const text = update.message?.text;
        integration = await findIntegrationByBotId(
          db, integrationService, botId,
          fromId !== undefined ? String(fromId) : undefined,
          text,
        );
        // Strangers messaging the platform bot get a silent drop — no
        // reply (we already ACKed) but also no row to act on.
        if (!integration) return;
      } else {
        integration = preResolved!;
      }

      const cfg = integration.config as unknown as TelegramConfig;
      // Platform-owned rows persist an empty bot_token (env is the
      // source of truth). Splice the runtime token into cfg here so
      // every downstream `cfg.bot_token` read in handleMessage /
      // handleCallbackQuery / startNewSession / ... Just Works without
      // 45 call-site changes. We're mutating a per-request DTO; no
      // cache shares this object.
      if (cfg.is_platform_owned) {
        const resolved = opts.platformBotService.getToken();
        if (!resolved) {
          server.log.warn({ botId }, "platform bot token unavailable; dropping webhook");
          return;
        }
        cfg.bot_token = resolved;
      }

      try {
        if (update.message) {
          await handleMessage(integration, cfg, update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(integration, cfg, update.callback_query);
        }
      } catch (err) {
        server.log.error({ err, update }, "Telegram webhook handler failed");
      }
    },
  );

  // ---- Owner gating ----
  // The first /link <code> message binds the bot to a Telegram user_id. After that,
  // only that user can interact. Without binding, only /link is accepted.
  async function ensureAuthorized(
    integration: { id: string; user_id: string; config: Record<string, unknown> },
    cfg: TelegramConfig,
    msg: TelegramMessage,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const fromId = msg.from?.id ? String(msg.from.id) : "";
    if (!fromId) return { ok: false, reason: "no_from" };

    // Accept only private chats for v1.
    if (msg.chat.type !== "private") {
      return { ok: false, reason: "groups_unsupported" };
    }

    if (cfg.owner_tg_user_id) {
      if (cfg.owner_tg_user_id === fromId) return { ok: true };
      return { ok: false, reason: "not_owner" };
    }

    // No owner yet — claim ownership via /link <code> OR /start <code>
    // (Telegram passes the deep-link payload as the first arg to /start
    // when the user follows a t.me/<bot>?start=<code> URL).
    const text = (msg.text ?? "").trim();
    const linkMatch = text.match(/^\/(?:link|start)(?:@\w+)?\s+([A-Za-z0-9]+)/);
    if (linkMatch && cfg.link_code && linkMatch[1] === cfg.link_code) {
      // Race-safe via CAS on updated_at: re-fetch, verify nothing has
      // changed, then atomically update WHERE updated_at = <observed>.
      // If a concurrent webhook already claimed the row, our UPDATE
      // matches zero rows (the other writer bumped updated_at) and we
      // refuse politely. Without CAS, two simultaneous /start <code>
      // taps from different Telegram users would both write and both
      // see "Linked." — the second silently overwriting the first.
      const fresh = await integrationService.get(integration.id, { decrypt: true });
      const freshCfg = fresh?.config as unknown as TelegramConfig | undefined;
      if (!fresh || !freshCfg || freshCfg.owner_tg_user_id) {
        return { ok: false, reason: "not_owner" };
      }
      if (freshCfg.link_code !== linkMatch[1]) {
        return { ok: false, reason: "not_linked" };
      }
      const newCfg: TelegramConfig = { ...freshCfg, owner_tg_user_id: fromId };
      delete newCfg.link_code;
      const updated = await integrationService.update(
        integration.id,
        { config: newCfg as unknown as Record<string, unknown> },
        { expectUpdatedAt: fresh.updated_at },
      );
      if (!updated) {
        // Another webhook beat us to the claim. Refuse without echoing
        // "Linked." so we don't tell the loser they own the bot.
        return { ok: false, reason: "not_owner" };
      }
      // Mutate the cfg the caller is holding so the rest of this turn sees the new owner.
      Object.assign(cfg, newCfg);
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: String(msg.chat.id),
        text: "Linked. Use /new <prompt> to start a session, or /help for commands.",
      });
      return { ok: false, reason: "linked_now" };
    }

    return { ok: false, reason: "not_linked" };
  }

  async function handleMessage(
    integration: { id: string; user_id: string; config: Record<string, unknown> },
    cfg: TelegramConfig,
    msg: TelegramMessage,
  ) {
    // Photos/documents send their text in `caption` rather than `text`.
    // Treat them as equivalent for prompt purposes.
    const text = (msg.text ?? msg.caption ?? "").trim();
    const hasAttachment = !!(msg.photo?.length || msg.document);
    // Nothing actionable: no text, no caption, no photo, no doc.
    if (!text && !hasAttachment) return;

    if (msg.from?.is_bot) return; // never react to other bots

    const auth = await ensureAuthorized(integration, cfg, msg);
    if (!auth.ok) {
      if (auth.reason === "not_linked") {
        if (cfg.link_code) {
          await telegramService.sendMessage(cfg.bot_token, {
            chat_id: String(msg.chat.id),
            text: `This bot is not yet linked. Send: /link ${cfg.link_code}`,
          });
        } else {
          await telegramService.sendMessage(cfg.bot_token, {
            chat_id: String(msg.chat.id),
            text: "This bot is not linked. Generate a link code in your Vonzio dashboard.",
          });
        }
      } else if (auth.reason === "groups_unsupported") {
        await telegramService.sendMessage(cfg.bot_token, {
          chat_id: String(msg.chat.id),
          text: "This bot only works in private chats.",
        });
      } else if (auth.reason === "not_owner") {
        await telegramService.sendMessage(cfg.bot_token, {
          chat_id: String(msg.chat.id),
          text: "Sorry, this bot is reserved for its owner.",
        });
      }
      return;
    }

    // Download any photo/document up-front so both /new and plain-text
    // branches can attach them. Done before command dispatch so a captioned
    // /new starts a session with the image already attached.
    const collected = hasAttachment ? await collectAttachments(cfg, msg) : { attachments: [], unsupported: [] };
    if (collected.unsupported.length > 0) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: String(msg.chat.id),
        text: `Skipped ${collected.unsupported.join(", ")}. Supported: images, PDFs, and text files up to 20 MB.`,
      });
    }

    // ---- Commands ----
    if (text.startsWith("/")) {
      const [rawCmd, ...rest] = text.split(/\s+/);
      const cmd = rawCmd.replace(/@\w+$/, "").toLowerCase(); // strip /cmd@botname
      const args = rest.join(" ").trim();

      switch (cmd) {
        case "/start": {
          // Deep-link payload routes:
          //   /start                  → /help (no payload)
          //   /start <link_code>      → ownership claim (ensureAuthorized
          //                              already handled this above; we
          //                              never reach here for that case)
          //   /start resume_<session> → bring a webUI/Slack-origin session
          //                              into this chat. The user is the
          //                              authorized owner at this point.
          const payload = args.trim();
          if (payload.startsWith("resume_")) {
            const sessionId = payload.slice("resume_".length);
            const tgUserId = String(msg.from?.id ?? msg.chat.id);
            const restored = await resumeSession(integration, cfg, msg.chat.id, tgUserId, sessionId);
            if (restored) {
              await telegramService.sendMessage(cfg.bot_token, {
                chat_id: String(msg.chat.id),
                text: `Resumed session <code>${htmlEscape(sessionId.slice(0, 8))}</code> — send a message to continue.`,
                parse_mode: "HTML",
              });
            } else {
              await telegramService.sendMessage(cfg.bot_token, {
                chat_id: String(msg.chat.id),
                text: "Session not found. It may have been deleted or belong to another account.",
              });
            }
            return;
          }
          await sendHelp(integration, cfg, msg.chat.id);
          return;
        }
        case "/help":
          await sendHelp(integration, cfg, msg.chat.id);
          return;
        case "/new":
        case "/clear": {
          // `/new` (and its `/clear` alias) is the "fresh start" command.
          // Three valid shapes:
          //   /new                 → ends active session, opens a new one,
          //                          shows info card, waits for input
          //   /new <prompt>        → ends + opens + submits prompt immediately
          //   /new @slug [prompt]  → same, with a specific agent (prompt optional)
          //
          // Order matters: resolve the target profile FIRST, before ending
          // the active session. Otherwise `/new @typo` would end the user's
          // active session and then complain about the slug — they'd lose
          // their session for a typo.
          await startNewSession(
            integration,
            cfg,
            msg,
            args,
            collected.attachments,
            { endActiveBeforeStart: true, awaitFirstMessageIfNoPrompt: true },
          );
          return;
        }
        case "/end": {
          const priorTitle = await endActive(integration, cfg, msg.chat.id);
          // priorTitle may contain `<` / `&` from the LLM-generated workspace
          // title. Send as plain text (no parse_mode) and rely on Telegram
          // treating it literally rather than as markup.
          await telegramService.sendMessage(cfg.bot_token, {
            chat_id: String(msg.chat.id),
            text: priorTitle ? `Session ended: ${priorTitle}` : "No active session.",
          });
          return;
        }
        case "/sessions":
          await listSessions(integration, cfg, msg.chat.id);
          return;
        case "/agents":
          await listAgents(integration, cfg, msg.chat.id);
          return;
        case "/model":
        case "/models": {
          await sendModelPicker(integration, cfg, msg.chat.id);
          return;
        }
        case "/web":
        case "/open": {
          // Return a dashboard deep-link to the active session so the user
          // can hop from phone to laptop mid-conversation. No active
          // session = nothing to link to.
          const active = await getActiveSession(integration, cfg, msg);
          if (!active) {
            await telegramService.sendMessage(cfg.bot_token, {
              chat_id: String(msg.chat.id),
              text: "No active session. Start one with /new <prompt>, or send an image with /new in the caption.",
            });
            return;
          }
          await telegramService.sendMessage(cfg.bot_token, {
            chat_id: String(msg.chat.id),
            text: `Open this session in the dashboard:\n${workspaceUrl(active.session_id)}`,
            disable_web_page_preview: true,
          });
          return;
        }
        case "/link":
          // Already authorized at this point — no-op.
          await telegramService.sendMessage(cfg.bot_token, {
            chat_id: String(msg.chat.id),
            text: "Already linked.",
          });
          return;
        default:
          await telegramService.sendMessage(cfg.bot_token, {
            chat_id: String(msg.chat.id),
            text: `Unknown command: ${cmd}. Try /help.`,
          });
          return;
      }
    }

    // ---- Plain message → route to active session ----
    const active = await getActiveSession(integration, cfg, msg);
    if (!active) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: String(msg.chat.id),
        text: "No active session. Start one with /new <prompt>, or send an image with /new in the caption.",
      });
      return;
    }

    // Image with no caption: tell the agent what happened so it knows to
    // inspect the attachment rather than respond to an empty string.
    const promptBody = text || NO_CAPTION_PROMPT;
    // Thread-claim default path (feature #18): when a playbook nudge was
    // auto-claimed by this reply, prefix a one-liner disclaimer so the
    // agent (and the user, when they see the agent's response) know the
    // session switched contexts.
    const promptText = active.autoClaimedLabel
      ? `${switchedThreadDisclaimer(active.autoClaimedLabel)}\n\n${promptBody}`
      : promptBody;
    await continueSession(integration, cfg, msg, active, promptText, collected.attachments);
  }

  async function handleCallbackQuery(
    integration: { id: string; user_id: string; config: Record<string, unknown> },
    cfg: TelegramConfig,
    cq: TelegramCallbackQuery,
  ) {
    const fromId = String(cq.from.id);
    const owner = cfg.owner_tg_user_id;
    if (!owner || owner !== fromId) {
      await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, {
        text: "Not authorized.",
        show_alert: true,
      });
      return;
    }

    const data = cq.data ?? "";
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    if (!chatId || !messageId) {
      await telegramService.answerCallbackQuery(cfg.bot_token, cq.id);
      return;
    }

    // Thread-claim (feature #18): playbook nudge attached
    // [Reply here] / [Keep my chat] buttons. Tap routes future
    // replies back to the playbook session that fired the nudge.
    const tc = parseThreadCallback(data);
    if (tc) {
      const { action, sessionId } = tc;
      const now = new Date().toISOString();
      const cutoff = new Date(Date.now() - THREAD_CLAIM_WINDOW_MS).toISOString();
      const action_at = action === "claim" ? "claimed_at" : "dismissed_at";

      // Race-safe update: only mutate rows that are still un-actioned AND
      // within the TTL window. The row count tells us whether this is the
      // first tap (do the side-effects) or a replay (just ack and bail).
      const updated = await db.update(schema.telegramPlaybookThreads)
        .set({ [action_at]: now })
        .where(and(
          eq(schema.telegramPlaybookThreads.bot_user_id, cfg.bot_user_id),
          eq(schema.telegramPlaybookThreads.chat_id, String(chatId)),
          eq(schema.telegramPlaybookThreads.message_id, String(messageId)),
          eq(schema.telegramPlaybookThreads.session_id, sessionId),
          isNull(schema.telegramPlaybookThreads.claimed_at),
          isNull(schema.telegramPlaybookThreads.dismissed_at),
          gte(schema.telegramPlaybookThreads.sent_at, cutoff),
        ))
        .returning({ session_id: schema.telegramPlaybookThreads.session_id });

      if (updated.length === 0) {
        // Either expired, already claimed/dismissed, or never existed —
        // surface a brief ack and leave the message alone.
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Expired." });
        return;
      }

      if (action === "claim") {
        const tgUserId = String(cq.from.id);
        // Delegate to resumeSession so it can:
        //   - upsert telegram_active_sessions (we did it inline before)
        //   - AND insert the telegram_sessions bridge row that the
        //     orchestrator→Telegram relay (getTelegramContext) queries
        //     when broadcasting task:done events back to the chat.
        // Without the bridge row, the agent's reply runs server-side but
        // never reaches Telegram. Found by tester report: tap claimed,
        // user replied, agent responded — but the response evaporated
        // because the relay had no chat to send it to.
        const restored = await resumeSession(integration, cfg, chatId, tgUserId, sessionId);
        if (!restored) {
          await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Session unavailable." });
          return;
        }
        // Edit message text AND clear the keyboard so the buttons can't be
        // tapped again. Telegram requires reply_markup to be sent with
        // editMessageText to update it — passing inline_keyboard: [] removes
        // it. Skip parse_mode: we replace with plain text (the original's
        // MarkdownV2 markers were rendered before; cq.message.text holds
        // the rendered form already).
        await telegramService.editMessageText(
          cfg.bot_token, chatId, messageId,
          (cq.message?.text ?? "") + "\n\n✓ Threaded — reply when ready.",
          { reply_markup: { inline_keyboard: [] } },
        ).catch(() => {});
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Threaded." });
      } else {
        await telegramService.editMessageText(
          cfg.bot_token, chatId, messageId,
          (cq.message?.text ?? "") + "\n\n✓ FYI noted.",
          { reply_markup: { inline_keyboard: [] } },
        ).catch(() => {});
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Noted." });
      }
      return;
    }

    if (data.startsWith("model:")) {
      // /model picker tap — commit the override to the workspace.
      // Callback data is either `model:<index>` (pick a model) or
      // `model:_reset` (clear the override). The full model_id is
      // recovered from modelPickerMessages.get(messageId).modelIds[idx]
      // because Telegram callback_data is capped at 64 bytes and Ollama
      // tag ids can be much longer than that.
      const slot = modelPickerMessages.get(messageId);
      if (!slot) {
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Picker expired." });
        await telegramService.editMessageText(cfg.bot_token, chatId, messageId, "Model picker expired. Send /model again.")
          .catch(() => {});
        return;
      }

      const arg = data.slice("model:".length);
      let newOverride: string | null;
      let ackLabel: string;
      if (arg === "_reset") {
        newOverride = null;
        ackLabel = "profile default";
      } else {
        const idx = Number(arg);
        const modelId = Number.isFinite(idx) ? slot.modelIds[idx] : undefined;
        if (!modelId) {
          await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Invalid selection." });
          return;
        }
        newOverride = modelId;
        ackLabel = modelId;
      }

      // Ownership defense: a leaked callback payload can't be used to
      // mutate someone else's workspace.
      const workspace = workspaceService.get(slot.sessionId);
      if (!workspace || workspace.user_id !== integration.user_id) {
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Not authorized." });
        return;
      }

      try {
        await workspaceService.update(slot.sessionId, { model_override: newOverride });
      } catch (err) {
        server.log.warn({ err, sessionId: slot.sessionId }, "Telegram /model: workspace update failed");
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Update failed." });
        return;
      }

      modelPickerMessages.delete(messageId);
      await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, {
        text: `Model: ${ackLabel}`,
      });
      // Edit the original picker message in place so the user gets a
      // single source of truth for what they just picked. Keep it tiny —
      // the chat already has plenty of agent output competing for space.
      await telegramService.editMessageText(
        cfg.bot_token, chatId, messageId,
        newOverride
          ? `Model set to ${ackLabel} for this session.`
          : "Reset to profile default.",
      ).catch(() => {});
      return;
    }

    if (data.startsWith("resume:")) {
      const sessionId = data.slice("resume:".length);
      const restored = await resumeSession(integration, cfg, chatId, fromId, sessionId);
      await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, {
        text: restored ? "Session resumed" : "Session not found",
      });
      if (restored) {
        await telegramService.editMessageText(
          cfg.bot_token, chatId, messageId,
          `Resumed session ${sessionId.slice(0, 8)}. Send your next message.`,
        ).catch(() => {});
      }
      return;
    }

    if (data.startsWith("ask:")) {
      // ask:<sessionId>:<idx>
      const rest = data.slice("ask:".length);
      const sep = rest.indexOf(":");
      if (sep === -1) {
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id);
        return;
      }
      const sessionId = rest.slice(0, sep);
      const idxStr = rest.slice(sep + 1);
      const cached = askMessages.get(messageId);
      if (!cached || cached.sessionId !== sessionId) {
        await telegramService.answerCallbackQuery(cfg.bot_token, cq.id, { text: "Question expired." });
        return;
      }

      let answer: string;
      if (idxStr === "skip") {
        answer = "skip";
      } else {
        const idx = Number(idxStr);
        answer = cached.options[idx] ?? "skip";
      }
      askMessages.delete(messageId);
      pendingAskSessions.delete(sessionId);

      // Replace the keyboard with the chosen value.
      await telegramService.editMessageText(
        cfg.bot_token, chatId, messageId,
        `Selected: ${answer}`,
      ).catch(() => {});
      await telegramService.answerCallbackQuery(cfg.bot_token, cq.id);

      // Resolve the session's profile to submit the answer back through.
      // Try the chat-origin path first: a row in telegram_sessions means
      // this session was started from Telegram. Otherwise fall back to
      // the workspace registry — dashboard-origin sessions live there
      // and we need to honor the answer just the same.
      const mappingRows = await db.select().from(schema.telegramSessions)
        .where(and(
          eq(schema.telegramSessions.bot_user_id, cfg.bot_user_id),
          eq(schema.telegramSessions.session_id, sessionId),
        ));
      const mapping = mappingRows[0];
      let profileId: string;
      if (mapping) {
        profileId = mapping.profile_id;
      } else {
        const workspace = workspaceService.get(sessionId);
        if (!workspace) return; // session evaporated; drop answer
        // Ownership defense: the button taps come from the bot's owner
        // (callback_query.from.id already gated above), but make sure
        // this owner is the workspace's user too — a leaked button
        // payload couldn't be used to forge answers into a different
        // user's session.
        if (workspace.user_id !== integration.user_id) return;
        profileId = workspace.profile_id;
      }

      publishUserMessage(sessionId, answer);
      sessionBuffers.set(sessionId, { tokens: [], toolCalls: [] });
      await telegramService.sendChatAction(cfg.bot_token, chatId, "typing");
      startTypingRefresh(sessionId, telegramService, cfg.bot_token, chatId);
      await taskService.submit(
        { mode: "session", prompt: answer, profile_id: profileId, session_id: sessionId },
        [profileId],
      );
      return;
    }

    await telegramService.answerCallbackQuery(cfg.bot_token, cq.id);
  }

  // ---- Helpers ----
  async function sendHelp(
    integration: { user_id: string },
    cfg: TelegramConfig,
    chatId: number,
  ) {
    // If this bot is bound to an agent, surface that prominently — it's
    // the key info: "this bot routes to this agent by default".
    let boundLine = "";
    if (cfg.bound_profile_id) {
      const profiles = await profileService.list(integration.user_id);
      const bound = profiles.find((p) => p.id === cfg.bound_profile_id);
      if (bound) {
        boundLine = `Bound to <code>@${htmlEscape(bound.slug)}</code> (${htmlEscape(bound.name)}). <code>/new</code> targets this agent by default.\n\n`;
      }
    }
    const text =
      "<b>Vonzio agent bot</b>\n\n" +
      boundLine +
      "<code>/new</code>                    start a fresh session (waits for input)\n" +
      "<code>/new &lt;prompt&gt;</code>           start + send the prompt in one shot\n" +
      "<code>/new @slug &lt;prompt&gt;</code>     target a specific agent profile\n" +
      "<code>/clear</code>                  alias for /new\n" +
      "<code>/end</code>                    end the active session\n" +
      "<code>/web</code>                    open the active session in the dashboard\n" +
      "<code>/model</code>                  switch the model for the active session\n" +
      "<code>/sessions</code>               list your recent sessions\n" +
      "<code>/agents</code>                 list your agent profiles\n" +
      "<code>/help</code>                   show this message\n\n" +
      "Plain text continues the active session.";
    await telegramService.sendMessage(cfg.bot_token, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });
  }

  async function listAgents(
    integration: { user_id: string },
    cfg: TelegramConfig,
    chatId: number,
  ) {
    const profiles = await profileService.list(integration.user_id);
    if (profiles.length === 0) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: chatId,
        text: "No agent profiles. Create one in your Vonzio dashboard.",
      });
      return;
    }
    // Wrap @slug in <code> so Telegram doesn't auto-link it as a
    // username (Telegram usernames forbid hyphens, so `@ollama-glm-5-1`
    // gets parsed as @ollama + literal text and only the first segment
    // becomes a link). HTML parse_mode is simpler than MarkdownV2 here
    // because slugs are alphanumeric+hyphen — no MarkdownV2-special
    // chars to escape.
    const lines = profiles.map((p) => `• <code>@${htmlEscape(p.slug)}</code> — ${htmlEscape(p.name)}`);
    await telegramService.sendMessage(cfg.bot_token, {
      chat_id: chatId,
      text: `Available agents:\n${lines.join("\n")}\n\nUse <code>/new @slug &lt;prompt&gt;</code>.`,
      parse_mode: "HTML",
    });
  }

  /**
   * /model handler — shows an inline keyboard of the active session's
   * profile models so the user can flip the per-workspace override
   * mid-conversation. Scoped to the active session's profile (no
   * cross-profile flips yet — that's a separate feature). Selection
   * commits via the `model:` callback handler below.
   */
  async function sendModelPicker(
    integration: { user_id: string },
    cfg: TelegramConfig,
    chatId: number,
  ) {
    // Resolve active session from telegram_active_sessions. Without
    // one there's nothing to apply an override to.
    const tgUserId = String(chatId);
    const rows = await db.select().from(schema.telegramActiveSessions)
      .where(and(
        eq(schema.telegramActiveSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramActiveSessions.chat_id, String(chatId)),
        eq(schema.telegramActiveSessions.tg_user_id, tgUserId),
      ));
    const active = rows[0];
    if (!active) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: chatId,
        text: "No active session. Start one with /new <prompt>, then /model to switch models.",
      });
      return;
    }

    const workspace = workspaceService.get(active.session_id);
    if (!workspace || workspace.user_id !== integration.user_id) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: chatId,
        text: "Session not found.",
      });
      return;
    }

    const result = await modelListService.listForProfile(active.profile_id);
    if (!result.ok) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: chatId,
        text: `Couldn't load models: ${result.error}`,
      });
      return;
    }
    if (result.models.length === 0) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: chatId,
        text: "No models available for this agent's API key. Configure one in the dashboard.",
      });
      return;
    }

    // result.profileDefault is the profile's default model at the
    // time of the lookup — included in the service response so we
    // don't have to follow up with a separate profileService.get
    // just to render the "current" marker.
    const currentOverride = workspace.model_override ?? null;
    const currentEffective = resolveWorkspaceModel(workspace, { model: result.profileDefault });

    // Callback payloads must be ≤ 64 bytes. Model ids can be long
    // (Ollama tag names especially), so encode the index into the
    // list instead of the full id. We persist the resolved id on
    // the click using the same in-memory `modelPickerOptions` map
    // we maintain per message.
    const buttons: Array<Array<{ text: string; callback_data: string }>> = result.models.map((m, i) => {
      const isCurrent = m.id === currentEffective;
      const label = (m.display_name ?? m.id) + (isCurrent ? " ✓" : "");
      return [{ text: label, callback_data: `model:${i}` }];
    });
    if (currentOverride) {
      // Append a reset option only when an override is currently set —
      // matches the dashboard's footer behavior.
      buttons.push([{ text: "Reset to profile default", callback_data: "model:_reset" }]);
    }
    const sent = await telegramService.sendMessage(cfg.bot_token, {
      chat_id: chatId,
      text: "Pick the model for this session:",
      reply_markup: { inline_keyboard: buttons },
    });
    rememberModelPicker(sent.message_id, {
      sessionId: active.session_id,
      modelIds: result.models.map((m) => m.id),
    });
  }

  async function listSessions(
    integration: { user_id: string },
    cfg: TelegramConfig,
    chatId: number,
  ) {
    // Show ALL the user's workspaces, not just ones started via Telegram.
    // The user expects /sessions to mirror the dashboard's workspace list
    // so they can resume any session — web, Slack, or Telegram origin —
    // from their phone. Sorted newest-first, archived hidden, top 8.
    const { workspaces } = await workspaceService.list({
      userId: integration.user_id,
      includeArchived: false,
      limit: 8,
    });

    if (workspaces.length === 0) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: chatId,
        text: "No sessions yet. Start one with /new <prompt>.",
      });
      return;
    }

    const buttons = workspaces.map((w) => [{
      text: w.name ?? w.session_id.slice(0, 8),
      callback_data: `resume:${w.session_id}`,
    }]);

    await telegramService.sendMessage(cfg.bot_token, {
      chat_id: chatId,
      text: "Recent sessions — tap to resume:",
      reply_markup: { inline_keyboard: buttons },
    });
  }

  /**
   * Ends the chat's active session if any. Returns `null` if there was
   * nothing to end, or the prior session's display title (for "Ended
   * '<title>'" messaging in /new and /clear). Caller surfaces it.
   */
  async function endActive(
    integration: { user_id: string },
    cfg: TelegramConfig,
    chatId: number,
  ): Promise<string | null> {
    // We don't know the tg_user_id without a message — for DMs chat_id == user_id.
    const tgUserId = String(chatId);
    const rows = await db.select().from(schema.telegramActiveSessions)
      .where(and(
        eq(schema.telegramActiveSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramActiveSessions.chat_id, String(chatId)),
        eq(schema.telegramActiveSessions.tg_user_id, tgUserId),
      ));
    if (rows.length === 0) return null;

    const sessionId = rows[0].session_id;
    // Grab the title for the user-facing 'Ended <title>' message before
    // we mutate. Fall back to a short session id when the workspace
    // never got named.
    const titleRows = await db.select({ title: schema.telegramSessions.title })
      .from(schema.telegramSessions)
      .where(and(
        eq(schema.telegramSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramSessions.session_id, sessionId),
      ));
    const priorTitle = titleRows[0]?.title ?? sessionId.slice(0, 8);

    await db.delete(schema.telegramActiveSessions)
      .where(and(
        eq(schema.telegramActiveSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramActiveSessions.chat_id, String(chatId)),
        eq(schema.telegramActiveSessions.tg_user_id, tgUserId),
      ));
    await db.update(schema.telegramSessions)
      .set({ ended_at: new Date().toISOString() })
      .where(and(
        eq(schema.telegramSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramSessions.session_id, sessionId),
      ));
    return priorTitle;
  }

  /**
   * Resolve which session a plain text message routes to. Order:
   *   1. Most recent unclaimed + undismissed playbook thread for this
   *      chat within the last 24h (feature #18 default-claim path).
   *      When matched, we claim it server-side and signal to the
   *      caller via `autoClaimedLabel` so the prompt gets a
   *      "[Switched to <label> thread]" disclaimer prefix.
   *   2. Existing telegram_active_sessions row (the long-standing
   *      "whatever you were last talking to" routing).
   */
  async function getActiveSession(
    integration: { user_id: string },
    cfg: TelegramConfig,
    msg: TelegramMessage,
  ): Promise<{ session_id: string; profile_id: string; autoClaimedLabel?: string } | null> {
    const tgUserId = String(msg.from?.id ?? msg.chat.id);
    const chatIdStr = String(msg.chat.id);

    // 1) Look for a fresh playbook nudge whose thread is still up for grabs.
    // Use a single race-safe UPDATE-RETURNING so two concurrent replies
    // can't both claim the same row: the first one wins, the second sees
    // empty rows and falls through to legacy routing.
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - THREAD_CLAIM_WINDOW_MS).toISOString();
    const claimed = await db.update(schema.telegramPlaybookThreads)
      .set({ claimed_at: now })
      .where(and(
        eq(schema.telegramPlaybookThreads.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramPlaybookThreads.chat_id, chatIdStr),
        isNull(schema.telegramPlaybookThreads.claimed_at),
        isNull(schema.telegramPlaybookThreads.dismissed_at),
        gte(schema.telegramPlaybookThreads.sent_at, cutoff),
        // Bind the update to the most recent eligible row via a subquery so
        // we don't accidentally claim multiple at once.
        eq(schema.telegramPlaybookThreads.message_id, db
          .select({ message_id: schema.telegramPlaybookThreads.message_id })
          .from(schema.telegramPlaybookThreads)
          .where(and(
            eq(schema.telegramPlaybookThreads.bot_user_id, cfg.bot_user_id),
            eq(schema.telegramPlaybookThreads.chat_id, chatIdStr),
            isNull(schema.telegramPlaybookThreads.claimed_at),
            isNull(schema.telegramPlaybookThreads.dismissed_at),
            gte(schema.telegramPlaybookThreads.sent_at, cutoff),
          ))
          .orderBy(desc(schema.telegramPlaybookThreads.sent_at))
          .limit(1)),
      ))
      .returning({
        session_id: schema.telegramPlaybookThreads.session_id,
        label: schema.telegramPlaybookThreads.label,
      });
    const thread = claimed[0];

    if (thread) {
      // Delegate to resumeSession so it sets up telegram_active_sessions
      // AND telegram_sessions (the bridge row the relay queries when
      // broadcasting task:done events). Same reason as the explicit-tap
      // path: skipping the bridge row strands the agent's reply server-
      // side.
      const restored = await resumeSession(integration, cfg, Number(chatIdStr), tgUserId, thread.session_id);
      if (restored) {
        // Re-read the just-upserted active row so we can return the
        // resolved profile_id without duplicating resumeSession's
        // resolution logic.
        const fresh = await db.select().from(schema.telegramActiveSessions)
          .where(and(
            eq(schema.telegramActiveSessions.bot_user_id, cfg.bot_user_id),
            eq(schema.telegramActiveSessions.chat_id, chatIdStr),
            eq(schema.telegramActiveSessions.tg_user_id, tgUserId),
          ));
        if (fresh[0]) {
          return {
            session_id: fresh[0].session_id,
            profile_id: fresh[0].profile_id,
            autoClaimedLabel: thread.label ?? "playbook",
          };
        }
      }
    }

    // 2) Existing routing.
    const rows = await db.select().from(schema.telegramActiveSessions)
      .where(and(
        eq(schema.telegramActiveSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramActiveSessions.chat_id, chatIdStr),
        eq(schema.telegramActiveSessions.tg_user_id, tgUserId),
      ));
    return rows[0] ?? null;
  }

  interface StartNewSessionOptions {
    /**
     * When true (set by `/new` / `/clear`), an empty prompt is OK — we
     * create the session, send the info card, and wait for the user's
     * next message. When false (set by the legacy "first message starts
     * a session" path), we still require a prompt to make the call.
     */
    awaitFirstMessageIfNoPrompt?: boolean;
    /**
     * When true, end the chat's active session AFTER we've successfully
     * validated the target agent (so a slug typo doesn't kill the user's
     * active work). The ended session's title is folded into the info
     * card as "Ended: <title>".
     */
    endActiveBeforeStart?: boolean;
  }

  async function startNewSession(
    integration: { id: string; user_id: string },
    cfg: TelegramConfig,
    msg: TelegramMessage,
    rawPrompt: string,
    attachments: TaskAttachment[] = [],
    opts: StartNewSessionOptions = {},
  ) {
    const profiles = await profileService.list(integration.user_id);
    if (profiles.length === 0) {
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: String(msg.chat.id),
        text: "No agent profiles configured. Create one in your Vonzio dashboard.",
      });
      return;
    }

    const { slug, prompt: parsedPrompt } = parseAgentSlug(rawPrompt);
    // Default profile resolution priority:
    //   1. explicit `@slug` in the prompt
    //   2. bot's bound_profile_id (Option A: direct-access agent bots)
    //   3. user's first profile (legacy behavior)
    // Bound profile may reference a deleted profile — silently fall
    // through to (3) in that case so the bot stays usable.
    let profile: typeof profiles[number] | undefined;
    if (slug) {
      profile = profiles.find((p) => p.slug === slug);
    } else if (cfg.bound_profile_id) {
      profile = profiles.find((p) => p.id === cfg.bound_profile_id) ?? profiles[0];
    } else {
      profile = profiles[0];
    }
    if (!profile) {
      // Same anti-auto-link treatment as listAgents — slugs with hyphens
      // would otherwise get half-eaten by Telegram's username matcher.
      const available = profiles.map((p) => `<code>@${htmlEscape(p.slug)}</code>`).join(", ");
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: String(msg.chat.id),
        text: `No agent <code>@${htmlEscape(slug ?? "")}</code>. Available: ${available}`,
        parse_mode: "HTML",
      });
      return;
    }

    // Prompt resolution:
    //   - Caption-less attachment → use NO_CAPTION_PROMPT (agent sees a hint)
    //   - Otherwise the parsed prompt as-is; may be empty for /new
    const prompt = parsedPrompt || (attachments.length > 0 ? NO_CAPTION_PROMPT : "");
    // Legacy callers (the "first message starts a session" path) still need a
    // prompt. /new and /clear opt into the no-prompt info-card flow.
    if (!prompt && !opts.awaitFirstMessageIfNoPrompt) {
      const escapedSlug = htmlEscape(profile.slug);
      await telegramService.sendMessage(cfg.bot_token, {
        chat_id: String(msg.chat.id),
        text: `Usage: <code>/new @${escapedSlug} &lt;prompt&gt;</code> — or send an image with <code>/new @${escapedSlug}</code> in the caption.`,
        parse_mode: "HTML",
      });
      return;
    }

    // Only NOW that the profile is resolved is it safe to end the
    // previous session. A `/new @typo` aborts above; the user keeps
    // their session.
    const priorTitle = opts.endActiveBeforeStart
      ? await endActive(integration, cfg, msg.chat.id)
      : null;

    const sessionId = randomUUID();
    const persistent = profile.persistent_sessions ?? false;
    const tgUserId = String(msg.from?.id ?? msg.chat.id);
    const now = new Date().toISOString();
    // Default title: the prompt's first words. When opening empty, we
    // tag the session with a trailing "..." so the post-task-done auto
    // title generator (ws/handler.ts:160-169) recognizes it as
    // auto-generated and replaces it once we have content.
    const title = prompt
      ? (prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt)
      : "New session...";

    // PluginSessionLifecycle.register drops the legacy containerId
    // param -- chat-initiated sessions never have one at registration
    // time (the container is provisioned later by wakeWorkspaceContainer).
    await sessionRegistry.register(sessionId, integration.user_id, profile.id, { persistent });
    await workspaceService.update(sessionId, { name: title });

    await db.insert(schema.telegramSessions).values({
      bot_user_id: cfg.bot_user_id,
      chat_id: String(msg.chat.id),
      session_id: sessionId,
      tg_user_id: tgUserId,
      user_id: integration.user_id,
      profile_id: profile.id,
      title,
      started_at: now,
    });

    // Upsert active session.
    await db.insert(schema.telegramActiveSessions).values({
      bot_user_id: cfg.bot_user_id,
      chat_id: String(msg.chat.id),
      tg_user_id: tgUserId,
      session_id: sessionId,
      profile_id: profile.id,
      user_id: integration.user_id,
      last_used_at: now,
    }).onConflictDoUpdate({
      target: [
        schema.telegramActiveSessions.bot_user_id,
        schema.telegramActiveSessions.chat_id,
        schema.telegramActiveSessions.tg_user_id,
      ],
      set: { session_id: sessionId, profile_id: profile.id, user_id: integration.user_id, last_used_at: now },
    });

    // Session-info card — shown for every /new and /clear, regardless of
    // whether a prompt was supplied. Folds in the "Ended <prior>" line
    // when there was an active session before this one.
    const infoLines: string[] = [];
    if (priorTitle) {
      infoLines.push(`Ended: <i>${htmlEscape(priorTitle)}</i>`);
      infoLines.push("");
    }
    infoLines.push("<b>New session</b>");
    infoLines.push(`Agent: <code>@${htmlEscape(profile.slug)}</code> — ${htmlEscape(profile.name)}`);
    if (profile.model) infoLines.push(`Model: <code>${htmlEscape(profile.model)}</code>`);
    infoLines.push(`Session: <code>${sessionId.slice(0, 8)}</code>`);
    // Dashboard deep-link — lets the user hop to the laptop mid-conversation.
    // Telegram auto-links bare URLs; no need for an <a> tag.
    infoLines.push(`Dashboard: ${workspaceUrl(sessionId)}`);
    if (!prompt) infoLines.push("\nSend a message to begin.");
    // Fire-and-forget so the card never blocks task submission below.
    // The card is informational; log on failure so silent breakage
    // doesn't strand the user in a "/new" with no visible response.
    void telegramService.sendMessage(cfg.bot_token, {
      chat_id: String(msg.chat.id),
      text: infoLines.join("\n"),
      parse_mode: "HTML",
      // Suppress Telegram's inline link preview — the dashboard URL is
      // auth-gated; the preview fetch from Telegram's servers gets a
      // login page that's noisy below the card.
      disable_web_page_preview: true,
    }).catch((err) => {
      server.log.warn({ err, sessionId, chatId: msg.chat.id }, "telegram info card send failed");
    });

    // No prompt → wait for the user's next message (it'll come through
    // the continueSession path since telegram_active_sessions is set).
    if (!prompt) return;

    publishUserMessage(sessionId, prompt, attachments);
    sessionBuffers.set(sessionId, { tokens: [], toolCalls: [] });

    await telegramService.sendChatAction(cfg.bot_token, msg.chat.id, "typing");
    startTypingRefresh(sessionId, telegramService, cfg.bot_token, msg.chat.id);
    await taskService.submit(
      {
        mode: "session",
        prompt,
        profile_id: profile.id,
        session_id: sessionId,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      [profile.id],
    );
  }

  async function continueSession(
    integration: { user_id: string },
    cfg: TelegramConfig,
    msg: TelegramMessage,
    active: { session_id: string; profile_id: string },
    text: string,
    attachments: TaskAttachment[] = [],
  ) {
    const sessionId = active.session_id;
    const profileId = active.profile_id;

    // Wake the container if it's resumable.
    const session = workspaceService.get(sessionId);
    if (session && session.status === "resumable") {
      sessionRegistry.extendExpiry(sessionId, new Date(Date.now() + 86400 * 1000).toISOString());
      sessionRegistry.setStatus(sessionId, "active");
      const profile = await profileService.getResolved(profileId);
      if (profile) {
        await orchestrator.wakeWorkspaceContainer(sessionId, profile);
      }
    }

    // Bump last_used_at so /sessions shows recency.
    await db.update(schema.telegramActiveSessions)
      .set({ last_used_at: new Date().toISOString() })
      .where(and(
        eq(schema.telegramActiveSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramActiveSessions.chat_id, String(msg.chat.id)),
        eq(schema.telegramActiveSessions.tg_user_id, String(msg.from?.id ?? msg.chat.id)),
      ));

    publishUserMessage(sessionId, text, attachments);
    sessionBuffers.set(sessionId, { tokens: [], toolCalls: [] });

    await telegramService.sendChatAction(cfg.bot_token, msg.chat.id, "typing");
    startTypingRefresh(sessionId, telegramService, cfg.bot_token, msg.chat.id);
    await taskService.submit(
      {
        mode: "session",
        prompt: text,
        profile_id: profileId,
        session_id: sessionId,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      [profileId],
    );
  }

  async function resumeSession(
    integration: { user_id: string },
    cfg: TelegramConfig,
    chatId: number,
    tgUserId: string,
    sessionId: string,
  ): Promise<boolean> {
    // First try the telegram_sessions cache (sessions that have already
    // touched this bot). If absent, fall back to the workspace registry —
    // the user might be resuming a web/Slack-started session for the
    // first time through Telegram.
    // The (bot_user_id, session_id) filter implicitly scopes to the bot's
    // owner — one Vonzio bot is owned by exactly one user, so a leaked
    // session_id can't be claimed by a different user's bot. Don't drop
    // either part of the WHERE without rethinking that invariant.
    const rows = await db.select().from(schema.telegramSessions)
      .where(and(
        eq(schema.telegramSessions.bot_user_id, cfg.bot_user_id),
        eq(schema.telegramSessions.session_id, sessionId),
      ));
    let target = rows[0];
    let profileId: string;
    let title: string | null = null;

    if (target) {
      profileId = target.profile_id;
      title = target.title;
    } else {
      // Cross-source resume: validate ownership against the workspace
      // registry and lazily create a telegram_sessions row so future
      // task:done events know which chat to broadcast to.
      const workspace = workspaceService.get(sessionId);
      if (!workspace || workspace.user_id !== integration.user_id) return false;
      profileId = workspace.profile_id;
      title = workspace.name;
    }

    const now = new Date().toISOString();
    await db.insert(schema.telegramActiveSessions).values({
      bot_user_id: cfg.bot_user_id,
      chat_id: String(chatId),
      tg_user_id: tgUserId,
      session_id: sessionId,
      profile_id: profileId,
      user_id: integration.user_id,
      last_used_at: now,
    }).onConflictDoUpdate({
      target: [
        schema.telegramActiveSessions.bot_user_id,
        schema.telegramActiveSessions.chat_id,
        schema.telegramActiveSessions.tg_user_id,
      ],
      set: { session_id: sessionId, profile_id: profileId, user_id: integration.user_id, last_used_at: now },
    });

    if (!target) {
      // Insert the bridging row so the orchestrator → Telegram relay
      // (getTelegramContext) can find this session on the next task:done.
      await db.insert(schema.telegramSessions).values({
        bot_user_id: cfg.bot_user_id,
        chat_id: String(chatId),
        session_id: sessionId,
        tg_user_id: tgUserId,
        user_id: integration.user_id,
        profile_id: profileId,
        title,
        started_at: now,
      }).onConflictDoNothing();
    } else {
      // Re-point the bridging row at THIS chat. Without this update,
      // getTelegramContext returns the stale chat_id and subsequent
      // task:done broadcasts go to the chat the session was last used
      // from — not the chat that just deep-linked into it.
      const updates: { chat_id?: string; tg_user_id?: string; ended_at?: null } = {};
      const chatIdStr = String(chatId);
      if (target.chat_id !== chatIdStr) updates.chat_id = chatIdStr;
      if (target.tg_user_id !== tgUserId) updates.tg_user_id = tgUserId;
      if (target.ended_at) updates.ended_at = null;
      if (Object.keys(updates).length > 0) {
        await db.update(schema.telegramSessions)
          .set(updates)
          .where(and(
            eq(schema.telegramSessions.bot_user_id, cfg.bot_user_id),
            eq(schema.telegramSessions.session_id, sessionId),
          ));
      }
    }

    return true;
  }
}

// ---- Orchestrator → Telegram relay ----
function setupTelegramRelay(opts: TelegramEventsRoutesOptions, server: FastifyInstance) {
  const { orchestrator, db, integrationService, telegramService, profileService, workspaceService, eventLog, imageRewriterService, platformBotService, sessionEvents } = opts;

  async function getTelegramContext(sessionId: string) {
    const rows = await db.select().from(schema.telegramSessions)
      .where(eq(schema.telegramSessions.session_id, sessionId));
    const mapping = rows[0];
    if (!mapping) return null;

    // Find the *specific* integration that owns this session — keyed by
    // (user_id, bot_user_id), not just user_id. A user with multiple
    // Telegram bots (e.g. one per-user bot + one platform pairing)
    // would otherwise have task:done events misrouted to whichever bot
    // getByUserAndType returned first.
    const candidates = await integrationService.listByTypeAndExternalId("telegram", mapping.bot_user_id);
    const integration = candidates.find((c) => c.user_id === mapping.user_id);
    if (!integration) return null;
    const cfg = integration.config as unknown as TelegramConfig;
    // Platform-owned rows have an empty cfg.bot_token — runtime pulls
    // the actual token from PlatformBotService so rotation is a single
    // env-var change. If the platform bot is misconfigured, drop.
    const botToken = cfg.is_platform_owned ? platformBotService.getToken() : cfg.bot_token;
    if (!botToken) return null;
    return {
      botToken,
      chatId: mapping.chat_id,
      profileId: mapping.profile_id,
      userId: mapping.user_id,
    };
  }

  /**
   * Broader presence resolution used ONLY for `task:ask_user`. Returns
   * a Telegram context for any session whose owner has a linked
   * Telegram bot, even when the session itself wasn't started from
   * Telegram (dashboard-origin sessions had no `telegram_sessions` row
   * and were dropped by `getTelegramContext` above).
   *
   * Why a separate fallback instead of widening getTelegramContext?
   * Streaming tokens and `task:done` text should stay scoped to chat-
   * origin sessions — we don't want every dashboard message to spam
   * the user's Telegram. AskUserQuestion is the special case: it's
   * blocking, urgent, and Telegram's push delivery is exactly the
   * right escalation surface when the dashboard tab is closed.
   *
   * Priority for picking which bot to use:
   *   1. The bot bound to this workspace's profile (`bound_profile_id`)
   *   2. The first linked bot the user owns
   */
  async function findAskUserTelegramContext(sessionId: string) {
    const primary = await getTelegramContext(sessionId);
    if (primary) return primary;

    const workspace = workspaceService.get(sessionId);
    if (!workspace) return null;

    const bots = await integrationService.listByUserAndType(workspace.user_id, "telegram");
    const linked = bots.filter((b) => {
      const cfg = b.config as unknown as TelegramConfig;
      return !!cfg.owner_tg_user_id;
    });
    if (linked.length === 0) return null;

    const matched = linked.find((b) => {
      const cfg = b.config as unknown as TelegramConfig;
      return cfg.bound_profile_id === workspace.profile_id;
    });
    const chosen = matched ?? linked[0];
    const cfg = chosen.config as unknown as TelegramConfig;
    const botToken = cfg.is_platform_owned ? platformBotService.getToken() : cfg.bot_token;
    if (!botToken || !cfg.owner_tg_user_id) return null;
    // In private DMs Telegram's chat_id is the user's tg user_id — we
    // mint the question straight into the owner's DM with the bot.
    return {
      botToken,
      chatId: cfg.owner_tg_user_id,
      profileId: workspace.profile_id,
      userId: workspace.user_id,
    };
  }

  /**
   * Suppression gate for every Telegram relay handler. A session that
   * was started via Telegram gets a `telegram_sessions` row that lives
   * forever — there's no cleanup path. If the same user later opens the
   * session in the dashboard, every task event would broadcast to BOTH
   * surfaces (and the user sees a duplicate Telegram message for every
   * dashboard turn). Skip the Telegram side when a dashboard WS is
   * currently subscribed to this session. When they disconnect, the
   * next task event will flow through to Telegram normally.
   */
  function dashboardIsLive(sessionId: string): boolean {
    return opts.sessionRegistry.getConnectedSessionIds().has(sessionId);
  }

  sessionEvents.on("task:token", (_taskId: string, sessionId: string | undefined, text: string) => {
    if (!sessionId) return;
    if (dashboardIsLive(sessionId)) return; // user is reading on the dashboard, don't echo to Telegram
    const buffer = sessionBuffers.get(sessionId);
    if (!buffer) return;
    buffer.tokens.push(text);
    // Drive edit-in-place streaming. Async, fire-and-forget — handler stays
    // synchronous so the orchestrator's emit isn't blocked.
    pumpStream(sessionId, text).catch((err) => {
      server.log.warn({ err, sessionId }, "Telegram stream pump failed");
    });
  });

  async function pumpStream(sessionId: string, chunk: string) {
    // Don't stream while we're awaiting an inline-keyboard answer — that
    // message is the question and editing it would replace the buttons.
    if (pendingAskSessions.has(sessionId)) return;

    let state = streamingState.get(sessionId);
    if (!state) {
      if (streamInitInFlight.has(sessionId)) return;
      streamInitInFlight.add(sessionId);
      try {
        const ctx = await getTelegramContext(sessionId);
        if (!ctx) return;
        // Re-check after async — another pump may have lost the race.
        if (streamingState.has(sessionId)) {
          streamingState.get(sessionId)!.rawText += chunk;
          scheduleStreamFlush(sessionId);
          return;
        }
        const sent = await telegramService.sendMessage(ctx.botToken, {
          chat_id: ctx.chatId,
          text: STREAM_PLACEHOLDER,
        });
        state = {
          messageId: sent.message_id,
          rawText: chunk,
          lastEditAt: Date.now(),
          pendingEdit: null,
          botToken: ctx.botToken,
          chatId: ctx.chatId,
        };
        streamingState.set(sessionId, state);
        scheduleStreamFlush(sessionId);
      } finally {
        streamInitInFlight.delete(sessionId);
      }
      return;
    }

    state.rawText += chunk;
    scheduleStreamFlush(sessionId);
  }

  function scheduleStreamFlush(sessionId: string) {
    const state = streamingState.get(sessionId);
    if (!state || state.pendingEdit) return;
    const elapsed = Date.now() - state.lastEditAt;
    const delay = Math.max(0, EDIT_THROTTLE_MS - elapsed);
    state.pendingEdit = setTimeout(() => {
      flushStream(sessionId).catch(() => {});
    }, delay);
    state.pendingEdit.unref?.();
  }

  async function flushStream(sessionId: string) {
    const state = streamingState.get(sessionId);
    if (!state) return;
    state.pendingEdit = null;
    state.lastEditAt = Date.now();
    // Trim to the tail so the latest output is always visible.
    const display = state.rawText.length > STREAM_VISIBLE_TAIL
      ? "…" + state.rawText.slice(-STREAM_VISIBLE_TAIL)
      : state.rawText || STREAM_PLACEHOLDER;
    // Plain text only — partial tokens are unsafe to apply MarkdownV2 to.
    await telegramService.editMessageText(
      state.botToken, state.chatId, state.messageId, display,
    ).catch(() => {});
  }

  sessionEvents.on("task:tool_use", (_taskId: string, sessionId: string | undefined, tool: string) => {
    if (!sessionId) return;
    if (dashboardIsLive(sessionId)) return;
    const buffer = sessionBuffers.get(sessionId);
    if (buffer) buffer.toolCalls.push(tool);
  });

  sessionEvents.on("task:ask_user", async (_taskId: string, sessionId: string | undefined, input: unknown) => {
    if (!sessionId) return;
    if (dashboardIsLive(sessionId)) return; // dashboard renders its own QuestionPicker
    // findAskUserTelegramContext widens beyond getTelegramContext: it
    // also catches dashboard-origin sessions whose owner has a linked
    // Telegram bot. The fallback notification (ask-user-fallback.ts)
    // is a plain text "tap on the shoulder"; THIS path delivers the
    // actual interactive inline-keyboard question.
    const ctx = await findAskUserTelegramContext(sessionId);
    if (!ctx) return;
    stopTypingRefresh(sessionId);
    pendingAskSessions.add(sessionId);

    try {
      const inputData = input as Record<string, unknown>;
      const questions = (inputData.questions as Array<Record<string, unknown>>) ?? [];
      const question = questions[0] ?? inputData;
      const questionText = (question.question as string) ?? "The agent needs your input:";
      const options = (question.options as Array<Record<string, unknown>>) ?? [];

      const labels = options.map((opt, i) =>
        (opt.label as string) ?? (opt as unknown as string) ?? `Option ${i + 1}`,
      );

      // One row per option, plus a Skip row. Telegram callback_data is 1-64 bytes;
      // we encode the option index, not its label.
      const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = labels.map((text, i) => [
        { text, callback_data: `ask:${sessionId}:${i}` },
      ]);
      inline_keyboard.push([{ text: "Skip", callback_data: `ask:${sessionId}:skip` }]);

      const sent = await telegramService.sendMessage(ctx.botToken, {
        chat_id: ctx.chatId,
        text: questionText,
        reply_markup: { inline_keyboard },
      });

      rememberAskMessage(sent.message_id, { sessionId, options: labels });
    } catch (err) {
      server.log.error({ err, sessionId }, "Failed to send AskUser to Telegram");
    }
  });

  sessionEvents.on("task:done", async (_taskId: string, sessionId: string | undefined, result?: { text?: string }) => {
    if (!sessionId) return;
    stopTypingRefresh(sessionId);
    if (dashboardIsLive(sessionId)) {
      // Dashboard is reading this session right now. Suppress the
      // Telegram broadcast — the user is already seeing the result
      // in-app. Clean up any in-flight streaming state so the next
      // task (which may fire after they disconnect) starts clean.
      clearStreamingState(sessionId);
      sessionBuffers.delete(sessionId);
      return;
    }
    const ctx = await getTelegramContext(sessionId);
    if (!ctx) {
      clearStreamingState(sessionId);
      return;
    }

    const buffer = sessionBuffers.get(sessionId);
    sessionBuffers.delete(sessionId);

    // Drain any pending stream edit so the polished final output is the
    // last thing the user sees rather than a half-formatted preview.
    const stream = streamingState.get(sessionId);
    if (stream?.pendingEdit) clearTimeout(stream.pendingEdit);
    streamingState.delete(sessionId);

    if (pendingAskSessions.has(sessionId)) {
      pendingAskSessions.delete(sessionId);
      return;
    }

    try {
      let body = result?.text ?? buffer?.tokens.join("") ?? "";
      if (!body.trim()) body = "_Agent completed with no text output._";

      let prefix = "";
      if (buffer?.toolCalls.length) {
        const unique = [...new Set(buffer.toolCalls)];
        prefix = `_Used: ${unique.join(", ")}_\n\n`;
      }

      // Telegram doesn't render inline `![]()` markdown. Strip image refs
      // from the body and queue them up for sendPhoto follow-ups. The
      // sendPhoto API accepts a URL — Telegram's servers fetch it, so a
      // signed _pvt token is enough auth.
      const rewriter = await imageRewriterService.forSession(sessionId, body).catch(() => null);
      const agentImages = rewriter?.images ?? [];
      if (rewriter && agentImages.length > 0) {
        body = rewriter.textWithoutImages || "_(image attached)_";
      }

      // Long-output path: send a short preview + the full text as a .md
      // attachment. Reading 30 KB diffs as eight MarkdownV2 walls is
      // unreadable; one document is a click away.
      if (body.length > LONG_OUTPUT_THRESHOLD) {
        const preview = body.slice(0, LONG_OUTPUT_PREVIEW).replace(/\s+\S*$/, "");
        const formattedPreview = markdownToTelegram(prefix + preview + "\n\n…");
        const filename = `response-${sessionId.slice(0, 8)}.md`;
        if (stream) {
          await telegramService.editMessageText(
            stream.botToken, stream.chatId, stream.messageId, formattedPreview,
            { parse_mode: "MarkdownV2" },
          ).catch(async () => {
            await telegramService.editMessageText(
              stream.botToken, stream.chatId, stream.messageId,
              preview + "\n\n…",
            ).catch(() => {});
          });
        } else {
          await telegramService.sendMessage(ctx.botToken, {
            chat_id: ctx.chatId,
            text: formattedPreview,
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true,
          }).catch(async () => {
            await telegramService.sendMessage(ctx.botToken, {
              chat_id: ctx.chatId,
              text: preview + "\n\n…",
            }).catch(() => {});
          });
        }
        await telegramService.sendDocument(
          ctx.botToken, ctx.chatId, filename, prefix.replace(/[_*]/g, "") + body,
          { caption: "Full response" },
        ).catch((err) => {
          server.log.error({ err, sessionId }, "Failed to upload response document");
        });
        generateWorkspaceTitle(sessionId, result?.text).catch(() => {});
        return;
      }

      const formatted = markdownToTelegram(prefix + body);
      const chunks = splitTelegramMessage(formatted, 4000);

      // If a streaming placeholder exists AND the final message fits in
      // one chunk, edit it in place — the user just sees their growing
      // message finalize. Otherwise edit the placeholder to the first
      // chunk and send the rest as new messages.
      const firstChunk = chunks[0];
      const restChunks = chunks.slice(1);
      let editedInPlace = false;
      if (stream && firstChunk) {
        try {
          await telegramService.editMessageText(
            stream.botToken, stream.chatId, stream.messageId, firstChunk,
            { parse_mode: "MarkdownV2" },
          );
          editedInPlace = true;
        } catch (err) {
          // MarkdownV2 parse error → retry as plain text.
          server.log.warn({ err, sessionId }, "Telegram MarkdownV2 edit failed, retrying as plain text");
          await telegramService.editMessageText(
            stream.botToken, stream.chatId, stream.messageId,
            firstChunk.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1"),
          ).catch(() => { /* placeholder may be gone; fall through to send */ });
          editedInPlace = true;
        }
      }

      const chunksToSend = editedInPlace ? restChunks : chunks;
      for (const chunk of chunksToSend) {
        try {
          await telegramService.sendMessage(ctx.botToken, {
            chat_id: ctx.chatId,
            text: chunk,
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true,
          });
        } catch (err) {
          // Fallback: if MarkdownV2 parse fails (escape miss), send as plain text.
          server.log.warn({ err, sessionId }, "Telegram MarkdownV2 send failed, retrying as plain text");
          await telegramService.sendMessage(ctx.botToken, {
            chat_id: ctx.chatId,
            text: chunk.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1"),
          }).catch(() => {});
        }
      }

      // Inline images the agent referenced in markdown — Telegram doesn't
      // render those, so we sendPhoto with the signed URL. Telegram's
      // servers fetch the URL using the _pvt query param for auth (no
      // cookie sharing needed).
      for (const img of agentImages) {
        try {
          await telegramService.sendPhoto(ctx.botToken, ctx.chatId, img.url, {
            caption: img.alt && img.alt !== "image" ? img.alt : undefined,
          });
        } catch (err) {
          server.log.warn({ err, sessionId, url: img.url }, "Telegram sendPhoto failed");
        }
      }

      generateWorkspaceTitle(sessionId, result?.text).catch(() => {});
    } catch (err) {
      server.log.error({ err, sessionId }, "Failed to send response to Telegram");
    }
  });

  sessionEvents.on("task:failed", async (_taskId: string, sessionId: string | undefined, error?: string) => {
    if (!sessionId) return;
    stopTypingRefresh(sessionId);
    clearStreamingState(sessionId);
    if (dashboardIsLive(sessionId)) {
      sessionBuffers.delete(sessionId);
      return;
    }
    const ctx = await getTelegramContext(sessionId);
    if (!ctx) return;
    sessionBuffers.delete(sessionId);
    try {
      await telegramService.sendMessage(ctx.botToken, {
        chat_id: ctx.chatId,
        text: `⚠️ Error: ${error ?? "Agent task failed"}`,
      });
    } catch (err) {
      server.log.error({ err, sessionId }, "Failed to send error to Telegram");
    }
  });

  async function generateWorkspaceTitle(sessionId: string, responseText?: string) {
    if (!responseText) return;
    const rows = await db.select().from(schema.telegramSessions)
      .where(eq(schema.telegramSessions.session_id, sessionId));
    const mapping = rows[0];
    if (!mapping) return;

    const events = eventLog.read(sessionId);
    const userMsg = events.find((e) => e.type === "user_message");
    if (!userMsg) return;
    const prompt = (userMsg.data.text as string) ?? "";

    const resolved = await profileService.getResolved(mapping.profile_id);
    const apiKey = resolved?.resolved_api_key;
    if (!apiKey) return;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 20,
          messages: [{
            role: "user",
            content: `Generate a very short title (3-6 words, no quotes) for this conversation:\n\nUser: ${prompt.slice(0, 200)}\nAssistant: ${responseText.slice(0, 200)}`,
          }],
        }),
      });
      if (res.ok) {
        const data = await res.json() as { content: Array<{ text: string }> };
        const title = data.content?.[0]?.text?.trim().replace(/^["']|["']$/g, "");
        if (title && title.length > 0 && title.length < 60) {
          await workspaceService.update(sessionId, { name: title });
          await db.update(schema.telegramSessions)
            .set({ title })
            .where(and(
              eq(schema.telegramSessions.bot_user_id, mapping.bot_user_id),
              eq(schema.telegramSessions.session_id, sessionId),
            ));
        }
      }
    } catch { /* best-effort */ }
  }
}

// ---- Module-level helper ----

/**
 * Resolve which user_integrations row this incoming webhook update
 * belongs to. Two cases:
 *
 *  - Per-user bot (`external_id` matches exactly one row): trivial.
 *
 *  - Platform-hosted bot (`external_id` matches many rows, one per
 *    paired user): filter further by the message's Telegram `from.id`
 *    matching `cfg.owner_tg_user_id`. If no row is linked to this
 *    Telegram user yet AND the message is `/start <pair_code>`,
 *    look for an unlinked row whose `link_code` matches — that's
 *    the pending pair flow about to claim ownership. Otherwise null
 *    (we silently drop messages from strangers).
 *
 * The legacy NULL-external_id fallback (rows created before
 * migration 15) is preserved for the single-row case only — multi-
 * row platform integrations have always had external_id set.
 */
async function findIntegrationByBotId(
  _db: DrizzleDB,
  integrationService: PluginIntegrationLookup,
  botId: string,
  fromId: string | undefined,
  messageText: string | undefined,
): Promise<{ id: string; user_id: string; config: Record<string, unknown> } | null> {
  const matches = await integrationService.listByTypeAndExternalId("telegram", botId);

  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    // Platform bot: multi-tenant. Pick the row owned by the Telegram
    // user who sent this update.
    if (fromId) {
      const linked = matches.find((m) => (m.config as unknown as TelegramConfig).owner_tg_user_id === fromId);
      if (linked) return linked;
    }
    // No linked row yet — only `/start <pair_code>` can attempt a claim.
    const pairMatch = (messageText ?? "").match(/^\/start(?:@\w+)?\s+([A-Za-z0-9]+)/);
    if (pairMatch) {
      const code = pairMatch[1];
      const pending = matches.find((m) => {
        const cfg = m.config as unknown as TelegramConfig;
        return !cfg.owner_tg_user_id && cfg.link_code === code;
      });
      if (pending) return pending;
    }
    return null;
  }

  // Slow path: a row created before migration 15 may have a NULL
  // external_id. Walk every telegram integration, match on
  // cfg.bot_user_id, and backfill the column so the next hit takes
  // the fast path. After 3D.1d.1 the plugin can't read
  // user_integrations directly (it's a core-owned table) so we use
  // listByType + filter -- a touch wider than the legacy
  // `WHERE external_id IS NULL` scan, but listByType already does the
  // decrypt pass and the cost amortizes across all future webhooks.
  const all = await integrationService.listByType("telegram", { decrypt: true });
  for (const integration of all) {
    const cfg = integration.config as unknown as TelegramConfig;
    if (cfg.bot_user_id === botId) {
      await integrationService.backfillExternalId(integration.id);
      return integration;
    }
  }
  return null;
}

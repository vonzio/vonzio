import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { eq, and } from "drizzle-orm";
import type { Config } from "../config.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { IntegrationService, SlackConfig } from "../services/integration-service.js";
import type { SlackService } from "../services/slack-service.js";
import type { TaskService } from "../services/task-service.js";
import type { ProfileService } from "../services/profile-service.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { WorkspaceService } from "../services/workspace-service.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { EventLog } from "../events/event-log.js";
import type { ImageRewriterService } from "../services/image-rewriter-service.js";
import type { ModelListService } from "../services/model-list-service.js";
import { resolveWorkspaceModel } from "../lib/model-resolution.js";

export interface SlackEventsRoutesOptions {
  config: Config;
  db: DrizzleDB;
  integrationService: IntegrationService;
  slackService: SlackService;
  taskService: TaskService;
  profileService: ProfileService;
  sessionRegistry: SessionRegistry;
  workspaceService: WorkspaceService;
  orchestrator: Orchestrator;
  eventLog: EventLog;
  // Wraps the agent-output-rewriter + container-name cache + token signing.
  // Used to extract inline images for Slack image_url blocks.
  imageRewriterService: ImageRewriterService;
  // Shared cached provider lookup for the `@vonzio model` picker.
  modelListService: ModelListService;
}

// Track active sessions to buffer tokens and send complete responses
const sessionBuffers = new Map<string, { tokens: string[]; toolCalls: string[] }>();

// /model picker message_ts → { sessionId, modelIds }. Slack option `value`
// caps at 75 bytes; encoding `set:<UUID>:<model_id>` is borderline and blows
// out on long Ollama tags like `hf.co/user/repo:Q4_K_M`. Mirror Telegram's
// approach — store the model ids per-message, encode the index into the
// callback value. 1h TTL prevents abandoned pickers piling up.
const slackModelPickerMessages = new Map<string, { sessionId: string; modelIds: string[] }>();
const SLACK_MODEL_PICKER_TTL_MS = 60 * 60 * 1000;
function rememberSlackModelPicker(messageTs: string, entry: { sessionId: string; modelIds: string[] }) {
  slackModelPickerMessages.set(messageTs, entry);
  setTimeout(() => slackModelPickerMessages.delete(messageTs), SLACK_MODEL_PICKER_TTL_MS).unref?.();
}

const SLUG_PREFIX_RE = /^@([a-z0-9](?:-?[a-z0-9])*):?(?:\s+|$)/;

/** Extract a leading @slug token. Returns { slug, prompt } where prompt is the rest of the text. */
function parseSlackAgentSlug(text: string): { slug?: string; prompt: string } {
  const match = text.match(SLUG_PREFIX_RE);
  if (!match) return { prompt: text };
  return { slug: match[1], prompt: text.slice(match[0].length).trim() };
}

// Sessions with an open AskUserQuestion — the next task:done is the agent's fallback text
// written before any button click arrived, so we swallow it and let the button-click turn reply.
const pendingAskSessions = new Set<string>();

export const slackEventsRoutes = fp(
  async (server: FastifyInstance, opts: SlackEventsRoutesOptions) => {
    const {
      config, db, integrationService, slackService,
      taskService, profileService, sessionRegistry, workspaceService, orchestrator, eventLog,
    } = opts;

    // Register Slack routes in an encapsulated scope so custom content type
    // parsers don't leak to other routes (e.g. Better Auth login)
    server.register(async (slack) => {
      // Raw body parsers for Slack signature verification
      slack.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
        done(null, body);
      });
      slack.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer" }, (_req, body, done) => {
        done(null, body);
      });

      registerSlackRoutes(slack, opts);
    });

    // Set up orchestrator → Slack relay (outside the scope, only needs event listeners)
    setupSlackRelay(opts, server);
  },
  { name: "slack-events-routes" },
);

function registerSlackRoutes(server: FastifyInstance, opts: SlackEventsRoutesOptions) {
    const {
      config, db, integrationService, slackService,
      taskService, profileService, sessionRegistry, workspaceService, orchestrator, eventLog,
      modelListService,
    } = opts;

    // --- Slack Events API endpoint ---
    server.post("/api/slack/events", async (request, reply) => {
      const rawBody = request.body as Buffer;

      // Verify Slack signature
      if (config.SLACK_SIGNING_SECRET && !verifySlackSignature(request, rawBody, config.SLACK_SIGNING_SECRET)) {
        return reply.code(401).send("Invalid signature");
      }

      const body = JSON.parse(rawBody.toString()) as Record<string, unknown>;

      // Handle URL verification challenge
      if (body.type === "url_verification") {
        return { challenge: body.challenge };
      }

      // Handle event callbacks
      if (body.type === "event_callback") {
        const event = body.event as Record<string, unknown>;
        const teamId = body.team_id as string;

        // Acknowledge immediately — process async
        reply.code(200).send();

        // Ignore bot messages to prevent loops
        if (event.bot_id || event.subtype === "bot_message") return;

        // Handle DMs and mentions
        if (event.type === "message" || event.type === "app_mention") {
          handleMessage(teamId, event).catch((err) => {
            server.log.error({ err, event }, "Slack message handler failed");
          });
        }
      }

      if (!reply.sent) return reply.code(200).send();
    });

    // --- Slack Slash Command endpoint ---
    server.post("/api/slack/commands", async (request, reply) => {
      const rawBody = request.body as Buffer;

      if (config.SLACK_SIGNING_SECRET && !verifySlackSignature(request, rawBody, config.SLACK_SIGNING_SECRET)) {
        return reply.code(401).send("Invalid signature");
      }

      const params = new URLSearchParams(rawBody.toString());
      const text = params.get("text")?.trim() ?? "";
      const teamId = params.get("team_id") ?? "";
      const channelId = params.get("channel_id") ?? "";
      const slackUserId = params.get("user_id") ?? "";

      if (!text) {
        return reply.code(200).send({
          response_type: "ephemeral",
          text: "Usage: `/vonzio <prompt>` — e.g. `/vonzio build me a landing page`. Target a specific agent with `/vonzio @slug <prompt>`.",
        });
      }

      // Find the Vonzio user
      const integration = await integrationService.getBySlackTeamAndUser(teamId, slackUserId);
      if (!integration) {
        const baseUrl = config.BETTER_AUTH_URL.replace(/\/$/, "");
        return reply.code(200).send({
          response_type: "ephemeral",
          text: `To use /vonzio, link your Vonzio account first:\n1. <${baseUrl}/signup|Create an account> or <${baseUrl}/login|sign in>\n2. Go to My Agents > Integrations > Connect Slack\n3. Try /vonzio again!`,
        });
      }

      const botToken = (integration.config as unknown as SlackConfig).bot_token;

      // Resolve which profile to target — parse optional @slug prefix
      const { slug, prompt } = parseSlackAgentSlug(text);
      const profiles = await profileService.list(integration.user_id);
      if (profiles.length === 0) {
        return reply.code(200).send({
          response_type: "ephemeral",
          text: "No agent profiles configured. Set up a profile in your Vonzio dashboard.",
        });
      }
      const profile = slug
        ? profiles.find((p) => p.slug === slug)
        : profiles[0];
      if (!profile) {
        const available = profiles.map((p) => `\`@${p.slug}\``).join(", ");
        return reply.code(200).send({
          response_type: "ephemeral",
          text: `No agent \`@${slug}\`. Available agents: ${available}`,
        });
      }
      if (!prompt) {
        return reply.code(200).send({
          response_type: "ephemeral",
          text: `Usage: \`/vonzio @${profile.slug} <prompt>\``,
        });
      }

      // Respond immediately with acknowledgment
      reply.code(200).send({
        response_type: "in_channel",
        text: `_Starting agent..._\n> ${prompt}`,
      });

      // Create workspace async
      (async () => {
        try {
          // Ensure bot is in the channel
          await slackService.joinChannel(botToken, channelId);

          // Post a message to get a thread_ts
          const { ts: threadTs } = await slackService.sendMessage(botToken, {
            channel: channelId,
            text: `> ${prompt}\n_Processing..._`,
          });

          // Add thinking reaction
          await slackService.addReaction(botToken, channelId, threadTs, "eyes");

          // Create session
          const sessionId = randomUUID();
          const persistent = profile.persistent_sessions ?? false;
          await sessionRegistry.register(sessionId, null, integration.user_id, profile.id, persistent);

          // Set workspace name from the prompt
          const wsName = prompt.length > 50 ? prompt.slice(0, 47) + "..." : prompt;
          await workspaceService.update(sessionId, { name: wsName });

          // Store thread mapping
          await db.insert(schema.slackThreadMappings).values({
            slack_team_id: teamId,
            slack_channel_id: channelId,
            slack_thread_ts: threadTs,
            session_id: sessionId,
            user_id: integration.user_id,
            profile_id: profile.id,
            created_at: new Date().toISOString(),
          });

          // Log and submit
          eventLog.append(sessionId, "user_message", { type: "user_message", session_id: sessionId, text: prompt });
          sessionBuffers.set(sessionId, { tokens: [], toolCalls: [] });

          await taskService.submit(
            { mode: "session", prompt, profile_id: profile.id, session_id: sessionId },
            [profile.id],
          );
        } catch (err) {
          server.log.error({ err }, "Slack command handler failed");
        }
      })();
    });

    // --- Slack Interactions endpoint (for AskUserQuestion buttons) ---
    server.post("/api/slack/interactions", async (request, reply) => {
      const rawBody = request.body as Buffer;

      if (config.SLACK_SIGNING_SECRET && !verifySlackSignature(request, rawBody, config.SLACK_SIGNING_SECRET)) {
        return reply.code(401).send("Invalid signature");
      }

      const payload = JSON.parse(
        new URLSearchParams(rawBody.toString()).get("payload") ?? "{}",
      ) as Record<string, unknown>;

      if (payload.type === "block_actions") {
        const actions = payload.actions as Array<Record<string, unknown>>;
        const action = actions?.[0];
        if (!action) return reply.code(200).send();

        const value = action.value as string;
        const actionId = action.action_id as string;

        if (actionId === "model_select") {
          // The picker's option values carry `set:<index>` or `reset`.
          // Recover sessionId + the resolved model_id from the per-
          // message map (keyed by the picker's own ts). Encoding the
          // index avoids Slack's 75-byte option-value cap which long
          // Ollama tag names like `hf.co/user/repo:Q4_K_M` would blow.
          const selectedOption = action.selected_option as { value?: string } | undefined;
          const selectionValue = selectedOption?.value;
          if (!selectionValue) return reply.code(200).send();

          const channel = (payload.channel as Record<string, string>)?.id;
          const msgTs = (payload.message as Record<string, string>)?.ts;
          const teamId = (payload.team as Record<string, string>)?.id;
          const slackUserId = (payload.user as Record<string, string>)?.id;
          if (!channel || !msgTs || !teamId || !slackUserId) {
            return reply.code(200).send();
          }

          // Reuse the same identity-binding the message handler uses so
          // the action runs as the same Vonzio user the thread belongs
          // to. A separate integration row per Slack workspace user means
          // we can't fall back to the bot owner here.
          const integration = await integrationService.getBySlackTeamAndUser(teamId, slackUserId);
          if (!integration) return reply.code(200).send();
          const botToken = (integration.config as unknown as SlackConfig).bot_token;
          if (!botToken) return reply.code(200).send();

          const slot = slackModelPickerMessages.get(msgTs);
          if (!slot) {
            // Picker expired or process restarted. Tell the user to
            // re-open instead of silently dropping.
            await slackService.updateMessage(botToken, channel, msgTs, "Model picker expired. Mention `model` again.", [])
              .catch(() => {});
            return reply.code(200).send();
          }
          const { sessionId } = slot;

          let newOverride: string | null;
          let ackLabel: string;
          if (selectionValue === "reset") {
            newOverride = null;
            ackLabel = "profile default";
          } else if (selectionValue.startsWith("set:")) {
            const idx = Number(selectionValue.slice("set:".length));
            const modelId = Number.isFinite(idx) ? slot.modelIds[idx] : undefined;
            if (!modelId) return reply.code(200).send();
            newOverride = modelId;
            ackLabel = modelId;
          } else {
            return reply.code(200).send();
          }

          // Ownership defense — a tampered msgTs / slot lookup can't
          // be used to mutate another user's workspace.
          const workspace = sessionRegistry.get(sessionId);
          if (!workspace || workspace.user_id !== integration.user_id) {
            return reply.code(200).send();
          }

          try {
            await workspaceService.update(sessionId, { model_override: newOverride });
          } catch (err) {
            server.log.warn({ err, sessionId }, "Slack /model: workspace update failed");
            await slackService.updateMessage(botToken, channel, msgTs, "Model update failed.", []);
            return reply.code(200).send();
          }

          slackModelPickerMessages.delete(msgTs);
          // Replace the picker with a confirmation so the thread doesn't
          // accumulate stale select menus across multiple flips.
          await slackService.updateMessage(
            botToken, channel, msgTs,
            newOverride
              ? `Model set to *${ackLabel}* for this session.`
              : "Reset to profile default.",
            [],
          );
          return reply.code(200).send();
        }

        if (actionId?.startsWith("ask_user_")) {
          const channel = (payload.channel as Record<string, string>)?.id;
          const threadTs = (payload.message as Record<string, string>)?.thread_ts
            ?? (payload.message as Record<string, string>)?.ts;
          const teamId = (payload.team as Record<string, string>)?.id;

          if (channel && threadTs && teamId) {
            // Find the session for this thread
            const mappings = await db.select().from(schema.slackThreadMappings)
              .where(and(
                eq(schema.slackThreadMappings.slack_team_id, teamId),
                eq(schema.slackThreadMappings.slack_channel_id, channel),
                eq(schema.slackThreadMappings.slack_thread_ts, threadTs),
              ));
            const mapping = mappings[0];

            if (mapping) {
              // Get bot token
              const integration = await integrationService.getByUserAndType(mapping.user_id, "slack");
              const botToken = (integration?.config as unknown as SlackConfig)?.bot_token;

              if (botToken) {
                // Update the message to show the selection
                const msgTs = (payload.message as Record<string, string>)?.ts;
                if (msgTs) {
                  await slackService.updateMessage(botToken, channel, msgTs, `Selected: *${value}*`, []);
                }

                // Send as a session turn
                eventLog.append(mapping.session_id, "user_message", {
                  type: "user_message",
                  session_id: mapping.session_id,
                  text: value,
                });

                await taskService.submit(
                  { mode: "session", prompt: value, profile_id: mapping.profile_id, session_id: mapping.session_id },
                  [mapping.profile_id],
                );
              }
            }
          }
        }
      }

      return reply.code(200).send();
    });

    // --- Core message handler ---
    async function handleMessage(teamId: string, event: Record<string, unknown>) {
      const slackUserId = event.user as string;
      const text = (event.text as string)?.replace(/<@[A-Z0-9]+>/g, "").trim(); // Strip bot mentions
      const channel = event.channel as string;
      const threadTs = (event.thread_ts as string) ?? (event.ts as string); // Use thread_ts if in thread, else start new thread
      const messageTs = event.ts as string;

      if (!text || !channel || !slackUserId) return;

      // Find the Vonzio user from Slack identity
      const integration = await integrationService.getBySlackTeamAndUser(teamId, slackUserId);
      if (!integration) {
        const allIntegrations = await findAnyTeamIntegration(teamId);
        if (allIntegrations) {
          const baseUrl = config.BETTER_AUTH_URL.replace(/\/$/, "");
          await slackService.sendMessage((allIntegrations.config as unknown as SlackConfig).bot_token, {
            channel,
            thread_ts: messageTs,
            text: `Hey! To use Vonzio from Slack, you need to link your account:\n\n1. <${baseUrl}/signup|Create a Vonzio account> (or <${baseUrl}/login|sign in> if you have one)\n2. Go to *My Agents > Integrations > Connect Slack*\n3. Come back here and message me again!\n\nThis is a one-time setup.`,
          });
        }
        return;
      }

      const botToken = (integration.config as unknown as SlackConfig).bot_token;
      const userId = integration.user_id;

      // Check for existing thread mapping
      const existingMappings = await db.select().from(schema.slackThreadMappings)
        .where(and(
          eq(schema.slackThreadMappings.slack_team_id, teamId),
          eq(schema.slackThreadMappings.slack_channel_id, channel),
          eq(schema.slackThreadMappings.slack_thread_ts, threadTs),
        ));
      const existingMapping = existingMappings[0];

      // In-thread commands. Telegram uses `/cmd` but Slack mentions
      // already routed us here, so any single-word body that matches a
      // known command is a directive, not a prompt. Today we only have
      // `model` — extensible by adding cases here as more land. The
      // command runs only inside an established thread (an existing
      // mapping): bare commands without context have nothing to act on.
      const trimmed = text.trim().toLowerCase();
      if ((trimmed === "model" || trimmed === "models") && existingMapping) {
        await sendSlackModelPicker(botToken, channel, threadTs, existingMapping.session_id, existingMapping.profile_id, userId);
        return;
      }

      // Add thinking reaction (only for real prompts, not in-thread commands)
      await slackService.addReaction(botToken, channel, messageTs, "eyes");

      let sessionId: string;
      let profileId: string;

      if (existingMapping) {
        // Existing thread → continue the session
        sessionId = existingMapping.session_id;
        profileId = existingMapping.profile_id;

        // Wake the session if needed
        const session = sessionRegistry.get(sessionId);
        if (session && session.status === "resumable") {
          sessionRegistry.extendExpiry(sessionId, new Date(Date.now() + 86400 * 1000).toISOString());
          sessionRegistry.setStatus(sessionId, "active");
          const profile = await profileService.getResolved(profileId);
          if (profile) {
            await orchestrator.wakeWorkspaceContainer(sessionId, profile);
          }
        }
      } else {
        // New thread → parse optional @slug and pick the target profile
        const { slug, prompt: parsedPrompt } = parseSlackAgentSlug(text);
        const profiles = await profileService.list(userId);
        if (profiles.length === 0) {
          await slackService.sendMessage(botToken, {
            channel,
            thread_ts: messageTs,
            text: "No agent profiles configured. Please set up a profile in your Vonzio dashboard first.",
          });
          return;
        }
        const profile = slug
          ? profiles.find((p) => p.slug === slug)
          : profiles[0];
        if (!profile) {
          const available = profiles.map((p) => `\`@${p.slug}\``).join(", ");
          await slackService.sendMessage(botToken, {
            channel,
            thread_ts: messageTs,
            text: `No agent \`@${slug}\`. Available agents: ${available}`,
          });
          return;
        }
        if (!parsedPrompt) {
          await slackService.sendMessage(botToken, {
            channel,
            thread_ts: messageTs,
            text: `Hi! Send me a prompt: \`@${profile.slug} <your question>\``,
          });
          return;
        }

        sessionId = randomUUID();
        profileId = profile.id;

        // Register the session
        const persistent = profile.persistent_sessions ?? false;
        await sessionRegistry.register(sessionId, null, userId, profileId, persistent);

        // Set workspace name from the prompt
        const wsName = parsedPrompt.length > 50 ? parsedPrompt.slice(0, 47) + "..." : parsedPrompt;
        await workspaceService.update(sessionId, { name: wsName });

        // Store thread mapping
        await db.insert(schema.slackThreadMappings).values({
          slack_team_id: teamId,
          slack_channel_id: channel,
          slack_thread_ts: threadTs,
          session_id: sessionId,
          user_id: userId,
          profile_id: profileId,
          created_at: new Date().toISOString(),
        });

        // Strip the slug prefix from the logged/submitted message so the agent sees the real prompt
        eventLog.append(sessionId, "user_message", {
          type: "user_message",
          session_id: sessionId,
          text: parsedPrompt,
        });
        sessionBuffers.set(sessionId, { tokens: [], toolCalls: [] });
        await taskService.submit(
          { mode: "session", prompt: parsedPrompt, profile_id: profileId, session_id: sessionId },
          [profileId],
        );
        return;
      }

      // Existing-thread continuation: profile is already bound via the mapping
      eventLog.append(sessionId, "user_message", {
        type: "user_message",
        session_id: sessionId,
        text,
      });

      // Initialize token buffer for this session
      sessionBuffers.set(sessionId, { tokens: [], toolCalls: [] });

      // Submit the task
      await taskService.submit(
        { mode: "session", prompt: text, profile_id: profileId, session_id: sessionId },
        [profileId],
      );
    }

    // Find any integration for a team (to send error messages)
    /**
     * `@vonzio model` handler. Posts a threaded message containing a
     * static_select block listing the active session's profile models
     * + a "Reset to profile default" footer when an override is set.
     * The selection commits via the `model_select` action_id handler
     * in the block_actions branch above.
     *
     * Scoped to the active session's profile — cross-profile flips are
     * a separate (bigger) feature.
     */
    async function sendSlackModelPicker(
      botToken: string,
      channel: string,
      threadTs: string,
      sessionId: string,
      profileId: string,
      userId: string,
    ) {
      // Ownership defense — the integration row routes the message,
      // but the workspace's user_id is what should govern who can
      // modify model_override. Guard against stale mappings.
      const workspace = sessionRegistry.get(sessionId);
      if (!workspace || workspace.user_id !== userId) {
        await slackService.sendMessage(botToken, {
          channel, thread_ts: threadTs,
          text: "Session not found.",
        });
        return;
      }

      const result = await modelListService.listForProfile(profileId);
      if (!result.ok) {
        await slackService.sendMessage(botToken, {
          channel, thread_ts: threadTs,
          text: `Couldn't load models: ${result.error}`,
        });
        return;
      }
      if (result.models.length === 0) {
        await slackService.sendMessage(botToken, {
          channel, thread_ts: threadTs,
          text: "No models available for this agent's API key. Configure one in the dashboard.",
        });
        return;
      }

      // result.profileDefault folded into the service response so the
      // picker doesn't need a separate profileService.get.
      const currentOverride = workspace.model_override ?? null;
      const currentEffective = resolveWorkspaceModel(workspace, { model: result.profileDefault });

      // Slack option values cap at 75 bytes. Encoding the model_id
      // directly is borderline and breaks on real Ollama tag names
      // (e.g. `hf.co/user/repo:Q4_K_M`). Encode `set:<index>` instead
      // and resolve the model_id from a per-message in-memory map on
      // tap — same pattern Telegram uses for its 64-byte callback_data
      // cap. The 'reset' option is a fixed sentinel.
      const options = result.models.map((m, i) => ({
        text: { type: "plain_text" as const, text: (m.display_name ?? m.id) + (m.id === currentEffective ? " (current)" : "") },
        value: `set:${i}`,
      }));
      if (currentOverride) {
        options.push({
          text: { type: "plain_text" as const, text: "Reset to profile default" },
          value: "reset",
        });
      }

      const sent = await slackService.sendMessage(botToken, {
        channel, thread_ts: threadTs,
        text: "Pick the model for this session:",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "*Pick the model for this session:*" },
            accessory: {
              type: "static_select",
              action_id: "model_select",
              placeholder: { type: "plain_text", text: "Choose a model" },
              options,
            },
          },
        ],
      });
      rememberSlackModelPicker(sent.ts, {
        sessionId,
        modelIds: result.models.map((m) => m.id),
      });
    }

    async function findAnyTeamIntegration(teamId: string) {
      const rows = await db.select().from(schema.userIntegrations)
        .where(eq(schema.userIntegrations.type, "slack"));
      for (const row of rows) {
        const integration = await integrationService.get(row.id, { decrypt: true });
        if (integration && (integration.config as unknown as SlackConfig).team_id === teamId) {
          return integration;
        }
      }
      return null;
    }

}

// --- Orchestrator → Slack relay ---
function setupSlackRelay(
  opts: SlackEventsRoutesOptions,
  server: FastifyInstance,
) {
  const { orchestrator, db, integrationService, slackService, profileService, workspaceService, eventLog, imageRewriterService } = opts;

  // Helper: get Slack context for a session
  async function getSlackContext(sessionId: string) {
    const mappings = await db.select().from(schema.slackThreadMappings)
      .where(eq(schema.slackThreadMappings.session_id, sessionId));
    const mapping = mappings[0];
    if (!mapping) return null;

    const integration = await integrationService.getByUserAndType(mapping.user_id, "slack");
    if (!integration) return null;

    return {
      botToken: (integration.config as unknown as SlackConfig).bot_token,
      channel: mapping.slack_channel_id,
      threadTs: mapping.slack_thread_ts,
      messageTs: mapping.slack_thread_ts,
    };
  }

  // Buffer tokens for complete messages
  orchestrator.on("task:token", (_taskId: string, sessionId: string | undefined, text: string) => {
    if (!sessionId) return;
    const buffer = sessionBuffers.get(sessionId);
    if (buffer) buffer.tokens.push(text);
  });

  // Track tool calls
  orchestrator.on("task:tool_use", (_taskId: string, sessionId: string | undefined, tool: string) => {
    if (!sessionId) return;
    const buffer = sessionBuffers.get(sessionId);
    if (buffer) buffer.toolCalls.push(tool);
  });

  // Send AskUserQuestion as interactive message
  orchestrator.on("task:ask_user", async (_taskId: string, sessionId: string | undefined, input: unknown) => {
    if (!sessionId) return;
    const ctx = await getSlackContext(sessionId);
    if (!ctx) return;
    pendingAskSessions.add(sessionId);

    try {
      const inputData = input as Record<string, unknown>;
      const questions = (inputData.questions as Array<Record<string, unknown>>) ?? [];
      const question = questions[0] ?? inputData;
      const questionText = (question.question as string) ?? "The agent needs your input:";
      const options = (question.options as Array<Record<string, unknown>>) ?? [];

      const blocks: unknown[] = [
        { type: "section", text: { type: "mrkdwn", text: `*${questionText}*` } },
      ];

      if (options.length > 0) {
        const buttons = options.map((opt, i) => ({
          type: "button",
          text: { type: "plain_text", text: (opt.label as string) ?? (opt as unknown as string) ?? `Option ${i + 1}` },
          value: (opt.label as string) ?? (opt as unknown as string) ?? `Option ${i + 1}`,
          action_id: `ask_user_${i}`,
        }));
        // Add skip button
        buttons.push({
          type: "button",
          text: { type: "plain_text", text: "Skip" },
          value: "skip",
          action_id: "ask_user_skip",
        });
        blocks.push({ type: "actions", elements: buttons });
      }

      await slackService.sendMessage(ctx.botToken, {
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: questionText,
        blocks,
      });
    } catch (err) {
      server.log.error({ err, sessionId }, "Failed to send AskUser to Slack");
    }
  });

  // Send complete response when turn finishes
  orchestrator.on("task:done", async (_taskId: string, sessionId: string | undefined, result?: { text: string }) => {
    if (!sessionId) return;
    const ctx = await getSlackContext(sessionId);
    if (!ctx) return;

    const buffer = sessionBuffers.get(sessionId);
    sessionBuffers.delete(sessionId);

    // If this turn emitted an AskUserQuestion, the fallback text isn't useful —
    // the buttons already convey the prompt. Wait for the button-click turn to reply.
    if (pendingAskSessions.has(sessionId)) {
      pendingAskSessions.delete(sessionId);
      await slackService.removeReaction(ctx.botToken, ctx.channel, ctx.messageTs, "eyes").catch(() => {});
      return;
    }

    try {
      // Remove thinking reaction
      await slackService.removeReaction(ctx.botToken, ctx.channel, ctx.messageTs, "eyes").catch(() => {});

      // Strip preview-URL images out of the agent's text so Slack doesn't
      // render them as broken `<url|alt>` links. They'll be reattached as
      // image blocks after the text.
      let rawBody = result?.text ?? buffer?.tokens.join("") ?? "";
      const rewriter = await imageRewriterService.forSession(sessionId, rawBody).catch(() => null);
      const agentImages = rewriter?.images ?? [];
      if (rewriter && agentImages.length > 0) {
        rawBody = rewriter.textWithoutImages;
      }

      // Build response text — convert GitHub markdown to Slack mrkdwn
      let responseText = markdownToSlack(rawBody);
      if (!responseText.trim()) responseText = agentImages.length > 0 ? "_(image attached)_" : "_Agent completed with no text output._";

      // Add tool summary if tools were used
      if (buffer?.toolCalls.length) {
        const unique = [...new Set(buffer.toolCalls)];
        responseText = `_Used: ${unique.join(", ")}_\n\n${responseText}`;
      }

      // Slack has a 4000 char limit per message — split if needed
      const chunks = splitMessage(responseText, 3900);
      for (const chunk of chunks) {
        await slackService.sendMessage(ctx.botToken, {
          channel: ctx.channel,
          thread_ts: ctx.threadTs,
          text: chunk,
        });
      }

      // Inline images the agent referenced — Slack renders image blocks
      // by fetching the URL server-side, so the signed _pvt token works
      // as auth without needing any session cookie. Batch all images into
      // a single chat.postMessage (Slack's 50-block-per-message limit is
      // far above any realistic agent response) to avoid fragmenting the
      // thread and tripping per-channel rate limits.
      if (agentImages.length > 0) {
        const altSummary = agentImages.map((img) => img.alt || "image").join(", ");
        await slackService.sendMessage(ctx.botToken, {
          channel: ctx.channel,
          thread_ts: ctx.threadTs,
          text: altSummary,
          blocks: agentImages.map((img) => ({
            type: "image",
            image_url: img.url,
            alt_text: img.alt || "image",
          })),
        }).catch((err) => {
          server.log.warn({ err, sessionId, count: agentImages.length }, "Slack image blocks send failed");
        });
      }

      // Generate a proper title for the workspace
      generateWorkspaceTitle(sessionId, result?.text).catch(() => {});
    } catch (err) {
      server.log.error({ err, sessionId }, "Failed to send response to Slack");
    }
  });

  async function generateWorkspaceTitle(sessionId: string, responseText?: string) {
    if (!responseText) return;
    const mappings = await db.select().from(schema.slackThreadMappings)
      .where(eq(schema.slackThreadMappings.session_id, sessionId));
    const mapping = mappings[0];
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
        }
      }
    } catch { /* title generation is best-effort */ }
  }

  // Send errors to Slack
  orchestrator.on("task:failed", async (_taskId: string, sessionId: string | undefined, error?: { message: string }) => {
    if (!sessionId) return;
    const ctx = await getSlackContext(sessionId);
    if (!ctx) return;

    sessionBuffers.delete(sessionId);

    try {
      await slackService.removeReaction(ctx.botToken, ctx.channel, ctx.messageTs, "eyes").catch(() => {});
      await slackService.sendMessage(ctx.botToken, {
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: `:warning: Error: ${error?.message ?? "Agent task failed"}`,
      });
    } catch (err) {
      server.log.error({ err, sessionId }, "Failed to send error to Slack");
    }
  });
}

// --- Utilities ---

function verifySlackSignature(request: FastifyRequest, rawBody: Buffer, signingSecret: string): boolean {
  const timestamp = request.headers["x-slack-request-timestamp"] as string;
  const signature = request.headers["x-slack-signature"] as string;
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${rawBody.toString()}`;
  const mySignature = `v0=${createHmac("sha256", signingSecret).update(sigBasestring).digest("hex")}`;

  try {
    return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Convert GitHub-flavored markdown to Slack mrkdwn */
function markdownToSlack(text: string): string {
  // Preserve code blocks from being modified
  const codeBlocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODEBLOCK_${codeBlocks.length - 1}__`;
  });

  // Headers → bold (Slack doesn't have headers)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Bold around URLs: **https://...** → just the URL (Slack auto-links)
  result = result.replace(/\*\*(https?:\/\/\S+)\*\*/g, "$1");

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Images: ![alt](url) → <url|alt>
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Horizontal rules → divider
  result = result.replace(/^[-*_]{3,}$/gm, "───");

  // Restore code blocks
  result = result.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[Number(idx)]);

  return result;
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen / 2) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskQueue } from "@vonzio/shared";
import type { Task, TaskResult } from "@vonzio/shared";
import type { ContainerManager } from "@vonzio/shared";
import type { ConcurrencyLimiter, VpnTunnelProvider } from "@vonzio/shared";
import type { McpServerSpec } from "@vonzio/plugin-api";
import { buildPluginMcpInjection } from "./plugin-mcp.js";
import { decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { buildPresenceSection, type Presence } from "./presence.js";
import type { SessionPresenceRegistry } from "../lib/session-presence.js";
import { resolveTaskModel } from "../lib/model-resolution.js";
import { ContainerPool } from "../container/pool.js";
import { CONTAINER_MODE_LABEL, ContainerMode } from "../container/docker-manager.js";
import { SessionRegistry, VOLUME_PREFIX_WORKSPACE, VOLUME_PREFIX_SDK } from "../container/session-registry.js";
import { WorkspaceProvisioner } from "../container/workspace.js";
import { AgentCommunicator, type AgentMessage, type TaskPayload, type GoalVerdict, type GoalStopReason } from "./agent-comms.js";
import { decideGoalNext } from "./goal-loop.js";
import { modelHostsFromEnv, planEgress, buildProxyEnv, routeModelThroughGateway } from "./egress.js";
import { judgeServerSide } from "./judge-server.js";
import type { EventLog } from "../events/event-log.js";
import { RetryHandler } from "./retry.js";
import type { ProfileService } from "../services/profile-service.js";
import type { ToolFileService } from "../services/tool-file-service.js";
import type { SkillService } from "../services/skill-service.js";
import type { DocumentService } from "../services/document-service.js";
import type { SubagentService } from "../services/subagent-service.js";
import type { GitProviderService } from "../services/git-provider-service.js";
import type { MemoryService } from "../services/memory-service.js";
import type { SecretVaultService } from "../services/secret-vault-service.js";
import type { IntegrationService } from "../services/integration-service.js";
import type { Profile, ResolvedProfile, McpServerConfig } from "@vonzio/shared";
import type { Memory } from "@vonzio/shared";
import { nanoid } from "nanoid";

type TaskUpdate = Partial<typeof schema.tasks.$inferInsert>;

/** Idle window before tearing down a VPN sidecar after its last
 *  agent detaches. Tuned for typical back-to-back task cadence. */
const SIDECAR_TEARDOWN_GRACE_MS = 60_000;

// Appended to the system prompt when the platform-control MCP is wired in, so
// the agent reliably distinguishes Vonzio platform objects from its own runtime.
// Mirrors PLATFORM_MCP_INSTRUCTIONS in mcp/platform-mcp.ts (which goes out via
// the MCP initialize handshake); kept here too because the system prompt is
// guaranteed to reach the model.
const PLATFORM_MCP_PRIMER = `\n\n## The "vonzio" platform tools\nYou have a "vonzio" toolset that controls the Vonzio platform you run on — it acts on the USER'S ACCOUNT, not the machine you're executing in. Don't confuse platform objects with your own runtime:\n- A WORKSPACE is a Vonzio chat session (its own container), NOT your working directory or the container you're in. For "how many workspaces/chats do I have", call workspace_list — never inspect the filesystem or run ls to answer that.\n- An AGENT (profile) is a saved config (model/tools/skills/prompt) → profile_list/profile_*. A SKILL is a reusable playbook (skill_list/create_skill). A SUBAGENT is a delegate template (subagent_*). KNOWLEDGE = docs at /knowledge (knowledge_*). A PLAYBOOK is a scheduled/repeatable automation; a TASK is a single run.\n- SCHEDULING: when the user asks for recurring or time-based work ("every day at 2pm…", "remind me…", "each Monday…", "keep checking…"), CREATE A PLAYBOOK with a cron schedule (playbook_create) — don't just do it once. Put the recurring instructions in the playbook's prompt.\n- NOTIFYING: to alert/message the user (reminders, findings, "ping me on Slack/Telegram"), use the notify_user tool — it routes to the user's configured channel automatically. Don't assume a specific channel.\n- LEARNING SKILLS: when you work out a non-trivial, repeatable procedure, save it as a skill with create_skill (bundle helper scripts via files) so future runs reuse it. skill_list first to avoid duplicates; improve an existing one with skill_update rather than duplicating. This is how you improve over time.\n- PREREQUISITES: reading Gmail or sending to Slack/Telegram needs that integration connected. You can't connect integrations yourself — check with integration_list and, if a channel is missing, ask the user to connect it in Settings before scheduling.\nUse the vonzio tools for questions about the user's account/history/agents/automations; use your normal filesystem tools (Read/Bash/…) for the files in front of you.`;

/** Short, user-safe error string for surfacing a cause in events/logs. */
function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? `${m.slice(0, 200)}…` : m;
}

export interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface OrchestratorDeps {
  queue: TaskQueue;
  containerManager: ContainerManager;
  pool: ContainerPool;
  sessionRegistry: SessionRegistry;
  workspace: WorkspaceProvisioner;
  concurrencyLimiter: ConcurrencyLimiter;
  profileService: ProfileService;
  toolFileService: ToolFileService;
  skillService: SkillService;
  subagentService: SubagentService;
  documentService: DocumentService;
  gitProviderService: GitProviderService;
  memoryService?: MemoryService;
  secretVaultService?: SecretVaultService;
  integrationService?: IntegrationService;
  /**
   * Plugin-contributed MCP servers (ctx.mcpRegistry). Every registered http
   * server is injected into each agent container with a per-task bearer token
   * the plugin resolves via ctx.mcpSessions. Undefined → no plugin MCP servers.
   */
  mcpRegistry?: { list(): McpServerSpec[] };
  /**
   * Registered chat-surface providers (telegram, slack, ...).
   * Iterated by resolvePresence to build the Reachability section
   * without core having to read plugin-owned tables directly.
   */
  sessionPresence: SessionPresenceRegistry;
  eventLog?: EventLog;
  /**
   * Read at request time, not construction time — cp-server mutates
   * coreDeps.vpnTunnelProvider after the orchestrator is built. A
   * getter (rather than a direct reference) lets the orchestrator see
   * the swap.
   */
  vpnTunnelProvider?: () => VpnTunnelProvider | undefined;
  /**
   * Optional SaaS hook (see CoreDeps.resolveOrgIdForTask) — called
   * before launching a new workspace for a task. Returns the org_id
   * the workspace row should be tagged with. OSS deployments leave
   * this undefined.
   */
  resolveOrgIdForTask?: (taskId: string) => Promise<string | null>;
  db: DrizzleDB;
  log?: Logger;
  config: {
    taskTimeoutSeconds: number;
    maxTurns: number;
    agentImage: string;
    containerCpuBatch: number;
    containerCpuSession: number;
    containerMemoryBatch: string;
    containerMemorySession: string;
    previewUrlTemplate: string;
    internalServerUrl?: string;
    /** Used to decrypt VPN tunnel configs before passing to the sidecar. */
    encryptionKey?: string;
    /** Egress enforcement (feature 0005). When true, non-VPN agents run on an
     *  internal network and reach the internet only through the egress proxy. */
    egressEnforcement?: boolean;
    egressProxyNetwork?: string;
    egressProxySecret?: string;
  };
}

interface ActiveTask {
  containerId: string;
  profileId: string;
  sessionId?: string;
}

const noopLogger: Logger = {
  info() {}, warn() {}, error() {},
  child() { return noopLogger; },
};

export class Orchestrator extends EventEmitter {
  private agentComms: AgentCommunicator;
  private retry: RetryHandler;
  private running = false;
  private processing = false;
  private activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeTasks = new Map<string, ActiveTask>();
  // Tracks per-agent attachment to a shared VPN sidecar so
  // safeRemoveContainer can decrement the tunnel's refcount. Empty
  // for OSS (no tunnels).
  private sidecarsByAgent = new Map<string, { sidecarId: string; tunnelId: string }>();
  // One sidecar per active VPN tunnel — all agents that attach to a
  // given tunnel share the same network namespace via
  // network_mode: container:<sidecarId>. Avoids duplicate-cert
  // connections that CHW-style OpenVPN servers reject.
  // `version` is the tunnel row's updated_at; on reuse we compare with
  // the current tunnel's version to detect config changes (e.g.
  // egress_lockdown toggled) and rebuild the sidecar.
  private sidecarsByTunnel = new Map<string, {
    sidecarId: string;
    networkMode: string;
    refCount: number;
    version: string;
    /** Human-readable tunnel name, surfaced to the dashboard's
     *  workspace UI as "VPN: <name>" pill. */
    name: string;
    dns?: string[];
    searchDomains?: string[];
  }>();
  // Serializes concurrent ensureVpnSidecar calls for the same
  // tunnel so two simultaneous agent dispatches don't both create
  // a sidecar.
  private sidecarInFlight = new Map<string, Promise<{
    sidecarId: string;
    tunnelId: string;
    networkMode: string;
    dns?: string[];
    searchDomains?: string[];
  } | null>>();
  // Pending teardown timers per tunnel. When refCount drops to 0 we
  // wait this long before actually removing the sidecar — back-to-back
  // tasks reuse the same tunnel without re-handshaking.
  private sidecarTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Egress enforcement (feature 0005). The proxy is a long-lived compose
  // service (profile: egress) — the orchestrator only verifies it and points
  // agents at it; it never creates/owns the container.
  private readonly EGRESS_PROXY_PORT = 8080;
  private readonly EGRESS_PROXY_ALIAS = "egress-proxy";
  // Token lifetime — generous (tasks can run long); bounds replay if a token
  // leaks from a container env.
  private readonly EGRESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
  private memoryTokens = new Map<string, { userId: string; profileId: string; orgId: string | null }>();
  private notifyTokens = new Map<string, { userId: string; sessionId: string }>();
  private gmailTokens = new Map<string, { userId: string }>();
  private platformTokens = new Map<string, { userId: string; profileId: string; orgId: string | null; sessionId: string; capabilities: string[] }>();
  // Per-task tokens for plugin-contributed MCP servers (ctx.mcpRegistry).
  private pluginMcpTokens = new Map<string, { userId: string; profileId: string; orgId: string | null }>();
  private log: Logger;

  constructor(private deps: OrchestratorDeps) {
    super();
    this.agentComms = new AgentCommunicator(deps.containerManager);
    this.retry = new RetryHandler();
    this.log = deps.log?.child({ component: "orchestrator" }) ?? noopLogger;
  }

  resolveMemoryToken(token: string): { userId: string; profileId: string; orgId: string | null } | undefined {
    return this.memoryTokens.get(token);
  }

  clearMemoryToken(token: string): void {
    this.memoryTokens.delete(token);
  }

  resolveNotifyToken(token: string): { userId: string; sessionId: string } | undefined {
    return this.notifyTokens.get(token);
  }

  clearNotifyToken(token: string): void {
    this.notifyTokens.delete(token);
  }

  resolveGmailToken(token: string): { userId: string } | undefined {
    return this.gmailTokens.get(token);
  }

  clearGmailToken(token: string): void {
    this.gmailTokens.delete(token);
  }

  resolvePlatformToken(token: string): { userId: string; profileId: string; orgId: string | null; sessionId: string; capabilities: string[] } | undefined {
    return this.platformTokens.get(token);
  }

  clearPlatformToken(token: string): void {
    this.platformTokens.delete(token);
  }

  /** Resolve a per-task plugin-MCP token to its session identity (used by the
   *  ctx.mcpSessions surface a plugin's MCP route calls). */
  resolvePluginMcpToken(token: string): { userId: string; profileId: string; orgId: string | null } | null {
    return this.pluginMcpTokens.get(token) ?? null;
  }

  clearPluginMcpToken(token: string): void {
    this.pluginMcpTokens.delete(token);
  }

  /** Returns the VPN tunnel currently routing the given agent container,
   *  or null. Used by the workspace endpoint to render the "VPN: <name>"
   *  pill in the dashboard chat header. */
  getActiveTunnelByAgentContainer(containerId: string): { id: string; name: string } | null {
    const pair = this.sidecarsByAgent.get(containerId);
    if (!pair) return null;
    const entry = this.sidecarsByTunnel.get(pair.tunnelId);
    if (!entry) return null;
    return { id: pair.tunnelId, name: entry.name };
  }

  /**
   * Tear down a workspace's container so the NEXT message recreates a fresh one.
   * Used to apply config that's baked at container-creation time (egress
   * allowlist, network, env) to a running session without losing the chat — the
   * SDK session id persists, so the conversation resumes on the new container
   * (workspace files survive too for persistent sessions, via the volume).
   * No-op-safe if the session has no live container.
   */
  async restartWorkspaceContainer(sessionId: string): Promise<void> {
    const session = this.deps.sessionRegistry.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    // Refuse while a turn is running on this session — removing the container
    // mid-exec would kill the live turn, and racing a concurrent dispatch could
    // tear down a container another task just reused. Caller maps this to 409.
    for (const t of this.activeTasks.values()) {
      if (t.sessionId === sessionId) {
        throw Object.assign(new Error("Workspace has an in-flight task; try again when it finishes"), { code: "WORKSPACE_BUSY" });
      }
    }
    if (!session.container_id) return; // nothing running
    // Remove the container but DO NOT clear container_id — leaving it set makes
    // the next message take dispatchSession's dead-container RECOVERY path
    // (reuse the persistent volume + resume the SDK session, isResume=true, so
    // the conversation continues) and re-run applyEgress. Clearing it would
    // route to the create-from-scratch path (needsInit=true → fresh SDK session
    // → lost context). This mirrors a natural container crash, which already
    // recovers via the same path. (Non-persistent sessions have no volume, so
    // they necessarily start fresh — the SDK state lived only in the container.)
    await this.safeRemoveContainer(session.container_id);
    this.log.info({ sessionId, containerId: session.container_id }, "Workspace container removed for restart (recreates + resumes on next message)");
  }

  /**
   * Bring up the VPN sidecar for (userId, profileId, workspaceId) eagerly,
   * before any agent dispatch. Used by the composer's tunnel picker so
   * the first message doesn't pay the cold-start handshake.
   *
   * The sidecar is created with refCount=1 (same as a real attach), then
   * we immediately release the hold — that schedules the standard
   * SIDECAR_TEARDOWN_GRACE_MS teardown. So the sidecar stays warm for
   * ~60s; if the user sends within that window the existing reuse path
   * cancels the teardown timer and attaches the agent. If they abandon,
   * the sidecar disappears on its own.
   */
  async warmupTunnel(
    userId: string,
    profileId: string,
    workspaceId?: string,
  ): Promise<{ tunnelId: string; alreadyWarm: boolean } | null> {
    const provider = this.deps.vpnTunnelProvider?.();
    const encryptionKey = this.deps.config.encryptionKey;
    if (!provider || !encryptionKey) return null;
    const tunnel = await provider.resolveActiveTunnel(userId, profileId, workspaceId);
    if (!tunnel) return null;
    // Fast path: sidecar already up for this tunnel. The cache check
    // mirrors ensureVpnSidecar's reuse logic without bumping refCount,
    // so we don't leave a hold to be released. The user's eventual
    // agent dispatch will hit the same cache.
    const cached = this.sidecarsByTunnel.get(tunnel.id);
    if (cached && cached.version === tunnel.version) {
      return { tunnelId: tunnel.id, alreadyWarm: true };
    }
    // Slow path: drive ensureVpnSidecar to create (or evict + recreate
    // on version mismatch), then immediately release the refCount hold
    // so the teardown timer protects us against abandonment.
    const fakeProfile = { user_id: userId, id: profileId } as Profile;
    const vpn = await this.ensureVpnSidecar(fakeProfile, workspaceId);
    if (!vpn) return null;
    this.releaseSidecarHold(vpn.tunnelId, vpn.sidecarId);
    return { tunnelId: vpn.tunnelId, alreadyWarm: false };
  }

  /**
   * Removes a workspace session's current container so the next agent
   * dispatch creates a fresh one. Used to apply a tunnel override
   * mid-session: Docker can't change a running container's
   * `network_mode`, so the only way to swap tunnels for an existing
   * workspace is to drop the container and let the resurrection path
   * rebuild it. Session events / SDK volume survive — only in-flight
   * bash/pty state is lost.
   *
   * Returns false when the session isn't found or doesn't belong to
   * this user; true on success even if the container was already gone
   * (idempotent).
   */
  async detachSessionContainer(sessionId: string, userId: string): Promise<boolean> {
    const session = this.deps.sessionRegistry.get(sessionId);
    if (!session || session.user_id !== userId) return false;
    const containerId = session.container_id;
    if (!containerId) return true;
    // safeRemoveContainer decrements the sidecar refCount and schedules
    // the standard grace-teardown timer — so a follow-up dispatch within
    // 60s reuses the warm sidecar even though the agent is fresh.
    await this.safeRemoveContainer(containerId);
    // Null out the registry's container pointer so the next dispatch
    // hits the resurrection path (creates fresh with the new tunnel).
    await this.deps.sessionRegistry.clearContainer(sessionId);
    return true;
  }

  /** Decrement the refCount for a tunnel by one and schedule the
   *  standard grace teardown if it hits zero. Extracted from
   *  safeRemoveContainer so warmupTunnel can release its hold without
   *  pretending to be an agent container. */
  private releaseSidecarHold(tunnelId: string, sidecarId: string): void {
    const entry = this.sidecarsByTunnel.get(tunnelId);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;
    const existing = this.sidecarTeardownTimers.get(tunnelId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      this.sidecarTeardownTimers.delete(tunnelId);
      const current = this.sidecarsByTunnel.get(tunnelId);
      if (!current || current.refCount > 0) return;
      this.sidecarsByTunnel.delete(tunnelId);
      try {
        await this.deps.containerManager.removeContainer(sidecarId, true);
      } catch {
        // already gone
      }
      try {
        await this.deps.vpnTunnelProvider?.()?.recordEvent?.(tunnelId, "sidecar_down", { sidecarId });
      } catch (err) {
        this.log.warn({ err, tunnelId }, "recordEvent(sidecar_down) failed");
      }
      this.log.info({ tunnelId, sidecarId }, "VPN sidecar torn down after warmup grace");
    }, SIDECAR_TEARDOWN_GRACE_MS);
    this.sidecarTeardownTimers.set(tunnelId, timer);
  }

  start(): void {
    // Reap VPN sidecars left behind by a previous server run before
    // the queue starts dispatching. At this point sidecarsByTunnel
    // is empty (in-process state, fresh on boot), so any
    // vonzio-mode=vpn-sidecar container is an orphan by definition.
    void this.cleanupOrphanedVpnSidecars();
    this.running = true;
    this.deps.queue.onReady(() => this.scheduleProcessing());
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    for (const timer of this.sidecarTeardownTimers.values()) {
      clearTimeout(timer);
    }
    this.sidecarTeardownTimers.clear();
  }

  private async cleanupOrphanedVpnSidecars(): Promise<void> {
    try {
      const all = await this.deps.containerManager.listManagedContainers();
      const orphans = all.filter((c) => c.labels[CONTAINER_MODE_LABEL] === ContainerMode.VpnSidecar);
      if (orphans.length === 0) return;
      for (const o of orphans) {
        try {
          await this.deps.containerManager.removeContainer(o.id, true);
        } catch {
          // Container may already be gone
        }
      }
      this.log.info({ count: orphans.length }, "Removed orphaned VPN sidecars from previous run");
    } catch (err) {
      this.log.warn({ err }, "Orphaned VPN sidecar cleanup failed (non-fatal)");
    }
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const cancelled = await this.deps.queue.cancel(taskId);
    if (cancelled) {
      await this.updateTask(taskId, {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      });
      this.emit("task:cancelled", taskId);
      return true;
    }

    const active = this.activeTasks.get(taskId);
    if (active) {
      // Session tasks: keep the container alive (just abort the exec process)
      // Batch tasks: stop the whole container
      await this.agentComms.abort(active.containerId, !!active.sessionId);
      await this.updateTask(taskId, {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      });
      this.clearTaskTimeout(taskId);
      this.activeTasks.delete(taskId);
      this.deps.concurrencyLimiter.release(active.profileId);
      this.emit("task:cancelled", taskId);
      return true;
    }

    return false;
  }

  async cancelBySession(sessionId: string): Promise<boolean> {
    // Check running tasks
    for (const [taskId, active] of this.activeTasks) {
      if (active.sessionId === sessionId) {
        return this.cancelTask(taskId);
      }
    }
    // Check queued tasks
    const queuedTaskId = await this.deps.queue.cancelBySession(sessionId);
    if (queuedTaskId) {
      await this.updateTask(queuedTaskId, {
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      });
      this.emit("task:cancelled", queuedTaskId);
      return true;
    }
    return false;
  }

  private scheduleProcessing(): void {
    if (this.processing || !this.running) return;
    this.processing = true;
    setImmediate(() => this.processLoop());
  }

  private async processLoop(): Promise<void> {
    try {
      while (this.running) {
        const task = await this.deps.queue.dequeue();
        if (!task) break;

        if (!this.deps.concurrencyLimiter.acquire(task.profile_id)) {
          // Re-enqueue without triggering onReady to avoid hot loop
          task.status = "queued";
          await this.deps.queue.enqueue(task);
          // Back off before trying next task
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        this.dispatchTask(task).catch((err) => {
          this.emit("task:error", task.id, err);
        });
      }
    } finally {
      this.processing = false;
    }
  }

  private async dispatchTask(task: Task): Promise<void> {
    const taskLog = this.log.child({ taskId: task.id, mode: task.mode, profileId: task.profile_id, sessionId: task.session_id });
    taskLog.info({}, "Task dispatching");
    await this.updateTask(task.id, {
      status: "running",
      started_at: new Date().toISOString(),
    });
    this.emit("task:started", task.id);

    const timeout = (task.timeout_seconds ?? this.deps.config.taskTimeoutSeconds) * 1000;
    this.startTaskTimeout(task.id, timeout);

    try {
      switch (task.mode) {
        case "batch":
          await this.dispatchBatch(task);
          break;
        case "pooled":
          await this.dispatchPooled(task);
          break;
        case "session":
          await this.dispatchSession(task);
          break;
      }
    } catch (err) {
      await this.handleFailure(task, err);
    } finally {
      this.clearTaskTimeout(task.id);
      this.deps.concurrencyLimiter.release(task.profile_id);
      this.activeTasks.delete(task.id);
    }
  }

  private async dispatchBatch(task: Task, prefetchedProfile?: ResolvedProfile): Promise<void> {
    let containerId: string | undefined;
    let workspacePath: string | undefined;

    try {
      const binds: string[] = [];
      if (task.workspace) {
        workspacePath = await this.deps.workspace.provision(task.workspace);
        binds.push(`${workspacePath}:/workspace`);
      }

      const profile = prefetchedProfile ?? await this.fetchProfile(task);
      const env = await this.buildEnvFromProfile(profile);
      const vpn = await this.ensureVpnSidecar(profile);
      const egress = await this.applyEgress(task.egress_domains, env, !!vpn, { tokenTtlSeconds: this.EGRESS_TOKEN_TTL_SECONDS });

      containerId = await this.deps.containerManager.createContainer({
        image: profile.container_image,
        registryAuth: this.buildRegistryAuth(profile),
        env,
        binds,
        cpus: this.deps.config.containerCpuBatch,
        memory: this.deps.config.containerMemoryBatch,
        networkMode: egress?.networkMode ?? vpn?.networkMode,
        labels: {
          [CONTAINER_MODE_LABEL]: ContainerMode.Batch,
          "vonzio-task-id": task.id,
        },
      });
      if (vpn) {
        this.sidecarsByAgent.set(containerId, { sidecarId: vpn.sidecarId, tunnelId: vpn.tunnelId });
        try {
          await this.deps.vpnTunnelProvider?.()?.recordEvent?.(vpn.tunnelId, "agent_attached", { agentId: containerId, sidecarId: vpn.sidecarId });
        } catch (err) {
          this.log.warn({ err, tunnelId: vpn.tunnelId }, "recordEvent(agent_attached) failed");
        }
      }
      await this.deps.containerManager.startContainer(containerId);
      if (vpn?.dns?.length) {
        await this.applyTunnelDns(containerId, vpn.dns, vpn.searchDomains);
      }
      this.activeTasks.set(task.id, { containerId, profileId: task.profile_id, sessionId: task.session_id });
      this.emit("task:container", task.id, containerId);

      if (task.claude_md) {
        await this.writeClaudeMd(containerId, task.claude_md);
      }
      if (profile.setup_commands?.length) {
        await this.runSetupCommands(containerId, profile.setup_commands, env);
      }

      const result = await this.runAgent(task, containerId, profile, env);
      await this.completeTask(task, result);
    } finally {
      if (containerId) {
        await this.safeRemoveContainer(containerId);
      }
      if (workspacePath) {
        await this.deps.workspace.cleanup(workspacePath);
      }
    }
  }

  private async dispatchPooled(task: Task): Promise<void> {
    const profile = await this.fetchProfile(task);

    // Custom image, setup commands, or an active VPN tunnel — none of
    // these can ride a pre-warmed pool container. Fall back to batch
    // so ensureVpnSidecar runs and the agent attaches through the
    // tunnel's network namespace.
    const provider = this.deps.vpnTunnelProvider?.();
    const hasTunnel = profile.user_id && provider
      ? !!(await provider.resolveActiveTunnel(profile.user_id, profile.id))
      : false;
    // Pre-warmed pool containers are profile-agnostic, so they can't carry a
    // per-profile egress token / sit on the internal network. Under enforcement,
    // fall back to batch (a dedicated container wired to the proxy).
    if (profile.container_image || profile.setup_commands?.length || hasTunnel || this.deps.config.egressEnforcement) {
      this.log.info({ taskId: task.id, image: profile.container_image, setupCmds: profile.setup_commands?.length, hasTunnel, egress: this.deps.config.egressEnforcement }, "Pooled incompatible, falling back to batch");
      return this.dispatchBatch(task, profile);
    }

    let workspacePath: string | undefined;
    const containerId = await this.deps.pool.claim();
    this.activeTasks.set(task.id, { containerId, profileId: task.profile_id, sessionId: task.session_id });

    try {
      const env = await this.buildEnvFromProfile(profile);

      if (task.workspace) {
        workspacePath = await this.deps.workspace.provision(task.workspace);
        await this.copyWorkspaceToContainer(containerId, workspacePath);
      }

      if (task.claude_md) {
        await this.writeClaudeMd(containerId, task.claude_md);
      }

      this.emit("task:container", task.id, containerId);

      const result = await this.runAgent(task, containerId, profile, env);
      await this.completeTask(task, result);
    } finally {
      await this.deps.pool.release(containerId);
      if (workspacePath) {
        await this.deps.workspace.cleanup(workspacePath);
      }
    }
  }

  private async dispatchSession(task: Task): Promise<void> {
    if (!task.session_id) {
      throw new Error("Session mode requires session_id");
    }

    const profile = await this.fetchProfile(task);
    const env = await this.buildEnvFromProfile(profile);

    let session = this.deps.sessionRegistry.get(task.session_id);
    let containerId: string;
    let needsInit = false;

    if (session && session.container_id) {
      const status = await this.deps.containerManager.getContainerStatus(session.container_id);

      if (status === "running") {
        // Container is alive — reuse it
        containerId = session.container_id;
      } else if (status === "paused") {
        // Container is paused — unpause and reuse
        await this.deps.containerManager.unpauseContainer(session.container_id);
        this.deps.sessionRegistry.updateActivity(task.session_id);
        containerId = session.container_id;
      } else if (session.persistent && session.volume_id) {
        // Dead container but volumes survive — recover with a new container
        this.log.info(
          { taskId: task.id, sessionId: task.session_id, oldContainerId: session.container_id, volumeId: session.volume_id },
          "Recovering persistent session with new container",
        );
        await this.safeRemoveContainer(session.container_id);
        containerId = await this.createSessionContainer(task.session_id, profile, env, session.volume_id);
        await this.deps.sessionRegistry.reassignContainer(task.session_id, containerId);
        session.container_id = containerId;
        // Re-run setup commands since it's a fresh container (workspace files are preserved via volume)
        if (profile.setup_commands?.length) {
          await this.runSetupCommands(containerId, profile.setup_commands, env);
        }
      } else {
        // Dead container, no volumes — create fresh. Remove the old one first:
        // getContainerStatus reporting non-running can be stale/transient (proxy
        // hiccup), so the old container may actually still be up. Without this,
        // reassigning leaves it running but unreferenced — a leaked duplicate.
        await this.safeRemoveContainer(session.container_id);
        containerId = await this.createSessionContainer(task.session_id, profile, env);
        await this.deps.sessionRegistry.reassignContainer(task.session_id, containerId);
        session.container_id = containerId;
        needsInit = true;
      }
    } else {
      // No existing container — create from scratch
      const volumeId = profile.persistent_sessions ? task.session_id : undefined;
      containerId = await this.createSessionContainer(task.session_id, profile, env, volumeId);

      if (!session) {
        // user_id MUST be the profile owner's user id, not the profile id.
        // The dashboard's /v1/workspaces list filters by request.user.id —
        // a row with user_id=<profile_id> doesn't match and ends up
        // invisible in the UI. resumeSession's ownership check
        // (workspace.user_id !== integration.user_id) would also reject it.
        // Pre-fix this was task.profile_id in both slots.
        // SaaS layer (if present) supplies the org_id the new
        // workspace should be tagged with. OSS deployments leave the
        // hook undefined so orgId stays null — and OSS workspaces
        // don't have the NOT NULL CHECK constraint that requires it.
        const orgId = (await this.deps.resolveOrgIdForTask?.(task.id)) ?? null;
        session = await this.deps.sessionRegistry.register(
          task.session_id,
          containerId,
          profile.user_id ?? task.profile_id,
          task.profile_id,
          profile.persistent_sessions,
          orgId,
        );
      } else {
        await this.deps.sessionRegistry.reassignContainer(task.session_id, containerId);
        session.container_id = containerId;
      }
      if (volumeId) {
        this.deps.sessionRegistry.setVolumeId(task.session_id, volumeId);
      }
      needsInit = true;
    }

    if (needsInit) {
      if (task.workspace) {
        const workspacePath = await this.deps.workspace.provision(task.workspace);
        await this.copyWorkspaceToContainer(containerId, workspacePath);
        await this.deps.workspace.cleanup(workspacePath);
      }
      if (task.claude_md) {
        await this.writeClaudeMd(containerId, task.claude_md);
      }
      if (profile.setup_commands?.length) {
        await this.runSetupCommands(containerId, profile.setup_commands, env);
      }
    }

    this.activeTasks.set(task.id, { containerId, profileId: task.profile_id, sessionId: task.session_id });
    this.emit("task:container", task.id, containerId);

    let result = await this.runAgent(task, containerId, profile, env, !needsInit);
    this.deps.sessionRegistry.updateActivity(task.session_id);

    // Goal loop: keep working the warm session until an INDEPENDENT judge
    // confirms the goal is met (or a stop condition trips). This replaces the
    // old "stopped under max_turns = done" heuristic — the judge decides
    // completion regardless of why the agent stopped, and continuations carry
    // the specific outstanding items. Enabled by the per-message composer
    // override (task.goal_mode) when set, otherwise the profile's auto_continue
    // default.
    const goalModeOn = task.goal_mode ?? profile.auto_continue;
    if (goalModeOn && task.session_id) {
      const maxIterations = profile.max_continuations ?? 5;
      const budgetCap = profile.continuation_budget_usd ?? Infinity;
      // Resolve the judge's model the SAME way the turn does — task →
      // workspace.model_override → profile.model. Using profile.model alone
      // sent the profile default (e.g. an ollama model) to the workspace's
      // overridden provider (e.g. an Anthropic key) → 404. The judge must run
      // on the model the workspace actually uses.
      const judgeWorkspace = task.session_id ? this.deps.sessionRegistry.get(task.session_id) : null;
      const judgeModel = resolveTaskModel(task, judgeWorkspace, profile) ?? profile.model ?? "claude-opus-4-8";
      const judgeEffort = task.effort ?? profile.effort ?? undefined;
      const goal = task.prompt;
      // Per-message acceptance criteria from the composer (optional).
      const criteria: string[] | undefined =
        task.acceptance_criteria && task.acceptance_criteria.length > 0
          ? task.acceptance_criteria
          : undefined;

      let iteration = 0;
      let totalCost = result.cost_usd;
      let prevProgress = true;
      let priorMissing: string[] | undefined;

      // `detail` carries the human-readable underlying cause for reasons that
      // are otherwise opaque (notably judge_error). It rides on the goal_stop
      // event, which relayToSubscribers persists to the event log — so the UI
      // can show WHY and it survives a container/server restart (the gap that
      // made the original "completion check unavailable" undiagnosable).
      const stopGoal = (reason: GoalStopReason, verdict?: GoalVerdict, detail?: string) => {
        this.emit("task:goal_stop", task.id, task.session_id, {
          reason,
          iteration,
          total_cost_usd: totalCost,
          verdict,
          ...(detail ? { detail } : {}),
        });
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const wasCutoff = result.max_turns_hit === true;
        let verdict: GoalVerdict;

        if (wasCutoff) {
          // The round was cut off by the per-round turn limit — not done by
          // definition, so skip the (blind) judge call and just continue. The
          // round/budget caps still apply so a perpetually-cut-off run can't
          // loop forever; a cutoff counts as progress (it won't trip no_progress).
          verdict = {
            done: false,
            missing: ["reached the per-round turn limit — resuming"],
            progress_made: true,
            rationale: "Turn limit reached; resuming the session.",
          };
          this.emit("task:goal_eval", task.id, task.session_id, { iteration, verdict });
          if (iteration >= maxIterations) { stopGoal("max_iterations", verdict); break; }
          if (totalCost >= budgetCap) { stopGoal("budget", verdict); break; }
          prevProgress = true;
          priorMissing = undefined;
        } else {
          // Voluntary stop — ask the independent judge whether the goal is met.
          // Announce the judge phase so the UI can show "Checking goal…"
          // instead of a stale Thinking/streaming state (the judge can take
          // a while and emits nothing until its verdict).
          this.emit("task:goal_judging", task.id, task.session_id, { iteration });
          let judged: GoalVerdict | null = null;
          // Tier 1: the primary judge inspects the workspace files, so it needs
          // the container alive. Unpause it if an idle sweep paused it between
          // the turn and now (best-effort; a removed container falls to tier 2).
          // Track the underlying cause so a judge_error stop can report WHY
          // (the cause is otherwise only in server warn logs, which vanish on
          // container restart). errMsg() keeps it short for the UI/event log.
          let inContainerErr: string | undefined;
          let fallbackErr: string | undefined;
          // If the container is dead (e.g. OOM-killed), skip the doomed exec —
          // it would just 409 and overwrite the real cause. ensureContainerRunning
          // throws a descriptive reason (OOM etc.) we keep for the detail.
          let containerAlive = true;
          try {
            await this.ensureContainerRunning(containerId);
          } catch (e) {
            containerAlive = false;
            inContainerErr = errMsg(e);
          }
          for (let attempt = 0; containerAlive && attempt < 2 && !judged; attempt++) {
            try {
              judged = await this.agentComms.judge(
                containerId,
                {
                  goal,
                  acceptance_criteria: criteria,
                  agent_result: result.text,
                  prior_missing: priorMissing,
                  model: judgeModel,
                  effort: judgeEffort,
                },
                env,
              );
            } catch (err) {
              inContainerErr = errMsg(err);
              this.log.warn({ taskId: task.id, attempt, err }, "goal judge call failed (in-container)");
            }
          }
          // Tier 2: container path unavailable (torn down / paused / flaky) —
          // fall back to a server-side judge that calls the model directly with
          // no container dependency. Weaker (no file inspection) but keeps the
          // autonomous loop deciding instead of dead-stopping.
          if (!judged) {
            try {
              // Ollama keys carry no base_url, but Ollama Cloud exposes an
              // OpenAI-compatible API at OLLAMA_BASE_URL/v1 — supply it so the
              // fallback works for ollama (the common "no verdict" case, since
              // kimi-class models often can't emit the strict in-container
              // json_schema verdict but parse fine via the lenient fallback).
              let judgeBaseUrl = profile.resolved_base_url;
              if (profile.resolved_provider === "ollama" && !judgeBaseUrl) {
                const { OLLAMA_BASE_URL } = await import("../services/ollama-service.js");
                judgeBaseUrl = `${OLLAMA_BASE_URL.replace(/\/+$/, "")}/v1`;
              }
              judged = await judgeServerSide(
                {
                  goal,
                  acceptance_criteria: criteria,
                  agent_result: result.text,
                  prior_missing: priorMissing,
                },
                {
                  apiKey: profile.resolved_api_key,
                  provider: profile.resolved_provider,
                  baseUrl: judgeBaseUrl,
                  model: judgeModel,
                },
                this.log,
              );
              if (judged) {
                this.log.info({ taskId: task.id }, "goal judge: used server-side fallback");
              }
            } catch (err) {
              fallbackErr = errMsg(err);
              this.log.warn({ taskId: task.id, err }, "server-side fallback judge failed");
            }
          }
          if (!judged) {
            // Both the in-container and server-side judges are unavailable —
            // keep the work done, stop looping. Surface the cause.
            const detail = [
              inContainerErr && `workspace judge: ${inContainerErr}`,
              fallbackErr && `fallback judge: ${fallbackErr}`,
            ].filter(Boolean).join("; ") || undefined;
            stopGoal("judge_error", undefined, detail);
            break;
          }
          verdict = judged;
          this.emit("task:goal_eval", task.id, task.session_id, { iteration, verdict });

          const decision = decideGoalNext(
            verdict,
            { iteration, totalCost, prevProgress },
            { maxIterations, budgetCap },
          );
          if (decision.action === "stop") { stopGoal(decision.reason, verdict); break; }

          prevProgress = verdict.progress_made;
          priorMissing = verdict.missing;
        }

        iteration++;
        this.log.info(
          { taskId: task.id, sessionId: task.session_id, iteration, maxIterations, totalCost, cutoff: wasCutoff },
          "Goal not yet met — continuing session",
        );
        // Note: goal_eval (above) is the round signal for the UI; we no longer
        // also emit task:continuing (it produced a duplicate timeline line).

        // On a turn-limit cutoff resume where it left off; otherwise hand the
        // agent the judge's specific outstanding items.
        const continuationTask: Task = {
          ...task,
          prompt: wasCutoff
            ? "You reached the turn limit before finishing. Continue exactly where you left off and keep working toward the goal."
            : this.buildContinuationPrompt(priorMissing ?? []),
          attempt: 1,
        };

        // Reset the task timeout for each round: it bounds a single turn (the
        // safety net for a stuck turn), NOT the whole goal loop. Without this,
        // the one per-task window (default 300s) elapses across rounds and the
        // timeout aborts a productive multi-round loop. The loop's own caps
        // (max_continuations, budget) bound the total.
        this.clearTaskTimeout(task.id);
        this.startTaskTimeout(task.id, (task.timeout_seconds ?? this.deps.config.taskTimeoutSeconds) * 1000);

        // A continuation turn can hard-error (runAgent throws). Bail gracefully:
        // keep the work from prior rounds, emit goal_stop, and let completeTask
        // finish with the last good result rather than failing the whole task.
        try {
          result = await this.runAgent(continuationTask, containerId, profile, env, true);
        } catch (err) {
          this.log.warn(
            { taskId: task.id, sessionId: task.session_id, iteration, err },
            "continuation turn failed — stopping goal loop",
          );
          stopGoal("agent_error");
          break;
        }
        this.deps.sessionRegistry.updateActivity(task.session_id);
        totalCost += result.cost_usd;
      }

      // Merge total cost into the final result.
      result = { ...result, cost_usd: totalCost };
    }

    await this.completeTask(task, result);
  }

  /** Continuation prompt for a goal-loop round — carries the judge's specific
   *  outstanding items so the agent works the gaps, not a vague "keep going". */
  private buildContinuationPrompt(missing: string[]): string {
    const items = missing.length > 0
      ? missing.map((m) => `- ${m}`).join("\n")
      : "- (re-check the goal's acceptance criteria and finish anything incomplete)";
    return [
      "You have NOT finished the goal yet. An independent review found these items still outstanding:",
      items,
      "",
      "Continue working until the goal is genuinely met. Do not stop or summarise as complete until it is done.",
    ].join("\n");
  }

  /** Create a session container, optionally mounting named volumes for persistent sessions. */
  private async createSessionContainer(
    sessionId: string,
    profile: Profile,
    env: Record<string, string>,
    volumeId?: string,
  ): Promise<string> {
    const binds: string[] = [];
    if (volumeId) {
      const wsVolume = `${VOLUME_PREFIX_WORKSPACE}${volumeId}`;
      const sdkVolume = `${VOLUME_PREFIX_SDK}${volumeId}`;
      // createNamedVolume is idempotent for the default driver
      await Promise.all([
        this.deps.containerManager.createNamedVolume(wsVolume),
        this.deps.containerManager.createNamedVolume(sdkVolume),
      ]);
      binds.push(`${wsVolume}:/workspace`, `${sdkVolume}:/home/agent/.claude`);
    }

    const vpn = await this.ensureVpnSidecar(profile, sessionId);
    // Session containers are reused across a session's tasks, so enforcement
    // uses the PROFILE default allowlist (baked into env at create time) — not
    // per-task egress, which can't retro-apply to a long-lived container.
    const egress = await this.applyEgress(profile.default_egress_domains, env, !!vpn);
    const containerId = await this.deps.containerManager.createContainer({
      image: profile.container_image,
      registryAuth: this.buildRegistryAuth(profile),
      env,
      binds: binds.length > 0 ? binds : undefined,
      cpus: this.deps.config.containerCpuSession,
      memory: this.deps.config.containerMemorySession,
      networkMode: egress?.networkMode ?? vpn?.networkMode,
      labels: {
        [CONTAINER_MODE_LABEL]: ContainerMode.Session,
        "vonzio-session-id": sessionId,
      },
    });
    if (vpn) {
      this.sidecarsByAgent.set(containerId, { sidecarId: vpn.sidecarId, tunnelId: vpn.tunnelId });
      try {
        await this.deps.vpnTunnelProvider?.()?.recordEvent?.(vpn.tunnelId, "agent_attached", { agentId: containerId, sidecarId: vpn.sidecarId });
      } catch (err) {
        this.log.warn({ err, tunnelId: vpn.tunnelId }, "recordEvent(agent_attached) failed");
      }
    }
    await this.deps.containerManager.startContainer(containerId);
    if (vpn?.dns?.length) {
      await this.applyTunnelDns(containerId, vpn.dns, vpn.searchDomains);
    }

    // Fix ownership on named volumes (Docker creates them as root)
    if (volumeId) {
      await this.execAsRoot(containerId, ["chown", "-R", "agent:agent", "/workspace", "/home/agent/.claude"]);
    }

    return containerId;
  }

  private async runAgent(task: Task, containerId: string, profile: ResolvedProfile, env?: Record<string, string>, isResume?: boolean): Promise<TaskResult> {
    // Start Ollama auth proxy if needed — only once per container (skip if already running)
    if (env?.OLLAMA_TARGET_URL) {
      await this.runSetupCommands(containerId, ["node /app/ollama-proxy.cjs &\nsleep 0.3"], env);
    }
    // Start the OpenAI translating gateway if this profile uses an OpenAI(-compatible) key.
    // The container is reused across turns and a cross-key switch changes
    // LLM_GATEWAY_TARGET_URL — so restart the gateway when the upstream changed
    // (or it died). Otherwise the stale gateway (bound to :11434; EADDRINUSE
    // makes a naive re-start exit) keeps routing to the previous provider's
    // endpoint. PID + target files avoid a procps dependency and skip needless
    // restarts when the upstream is unchanged.
    if (env?.LLM_GATEWAY_MODE) {
      await this.runSetupCommands(containerId, [
        'NEW="$LLM_GATEWAY_TARGET_URL"\n' +
        'OLD="$(cat /tmp/llm-gateway.pid 2>/dev/null)"\n' +
        'if [ "$(cat /tmp/llm-gateway.target 2>/dev/null)" = "$NEW" ] && kill -0 "$OLD" 2>/dev/null; then\n' +
        "  :\n" +  // already running with the right upstream — nothing to do
        "else\n" +
        // Only kill if the recorded PID is actually our gateway (guards against
        // a recycled PID now belonging to an unrelated process).
        '  if [ -n "$OLD" ] && grep -qa llm-gateway "/proc/$OLD/cmdline" 2>/dev/null; then\n' +
        '    kill "$OLD" 2>/dev/null\n' +
        // Wait for it to actually exit (≤1s) so the new one doesn't hit
        // EADDRINUSE on :11434 and exit — fixed sleeps race.
        '    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$OLD" 2>/dev/null || break; sleep 0.1; done\n' +
        "  fi\n" +
        "  node /app/llm-gateway.cjs &\n" +
        "  echo $! > /tmp/llm-gateway.pid\n" +
        '  printf %s "$NEW" > /tmp/llm-gateway.target\n' +
        "  sleep 0.3\n" +
        "fi",
      ], env);
    }

    // For session mode, look up the SDK's session ID from prior runs.
    // On first turn: don't pass session_id (SDK generates its own UUID).
    // On subsequent turns: pass the captured SDK session ID as resume.
    let sdkSessionId: string | undefined;
    if (isResume && task.session_id) {
      const session = this.deps.sessionRegistry.get(task.session_id);
      sdkSessionId = (session as Record<string, unknown> | null)?.sdk_session_id as string | undefined;
    }

    // Resolve profile's MCP servers and tool files
    const mcpServers = profile.mcp_servers ?? [];

    // Collect tool names from SDK-type MCP servers
    const sdkToolNames = mcpServers
      .filter((s) => s.type === "sdk" && s.tools?.length)
      .flatMap((s) => s.tools!);

    // Resolve tool files for SDK tools
    const toolFiles = sdkToolNames.length > 0
      ? await this.deps.toolFileService.resolveTools(sdkToolNames)
      : [];

    // Non-SDK MCP servers pass through to the agent runner
    const nonSdkServers = mcpServers.filter((s) => s.type !== "sdk");

    // Note: chrome-devtools MCP has compatibility issues in Docker/ARM64.
    // Chromium is installed in the base image and can be used directly via Bash.
    // Users can still add chrome-devtools MCP manually per profile if needed.

    // MCP tokens to clean up after task completes
    const mcpTokensToClean: Array<{ type: "memory" | "notify" | "gmail" | "platform" | "plugin"; token: string }> = [];

    // Memory integration: inject MCP server and build memory section for system prompt
    const userId = profile.user_id ?? "";
    // Look up org_id from the active workspace so MCP handlers can
    // scope reads/writes by tenant. The session may not be registered
    // yet (first-task batch mode); null falls through to OSS behaviour.
    const taskOrgId = task.session_id
      ? this.deps.sessionRegistry.get(task.session_id)?.org_id ?? null
      : null;
    let memorySection = "";
    if (profile.memory_enabled !== false && this.deps.memoryService && userId) {
      if (this.deps.config.internalServerUrl) {
        const memToken = `mem_${nanoid()}`;
        this.memoryTokens.set(memToken, { userId, profileId: profile.id, orgId: taskOrgId });
        mcpTokensToClean.push({ type: "memory", token: memToken });
        const memoryMcpUrl = `${this.deps.config.internalServerUrl}/mcp/memory`;
        nonSdkServers.push({
          name: "memory",
          type: "http",
          url: memoryMcpUrl,
          headers: { Authorization: `Bearer ${memToken}` },
        });
      }
      memorySection = await this.buildMemorySection(userId, profile.id);
    }

    // Notify integration: inject MCP server for agent-initiated notifications
    if (this.deps.config.internalServerUrl && userId) {
      const notifyToken = `notify_${nanoid()}`;
      // sessionId carried so notify-mcp can claim the right thread on
      // Telegram for feature #18 (thread-claim). Playbook-only sessions
      // pass task.session_id as their stable identifier.
      this.notifyTokens.set(notifyToken, { userId, sessionId: task.session_id ?? task.id });
      mcpTokensToClean.push({ type: "notify", token: notifyToken });
      const notifyMcpUrl = `${this.deps.config.internalServerUrl}/mcp/notify`;
      nonSdkServers.push({
        name: "notify",
        type: "http",
        url: notifyMcpUrl,
        headers: { Authorization: `Bearer ${notifyToken}` },
      });
    }

    // Gmail integration: inject MCP server for reading user's email.
    // Scope-aware: only injects when at least one gmail row is granted
    // to the running profile (scope='all' or profile id in profile_ids).
    if (this.deps.config.internalServerUrl && userId && this.deps.integrationService) {
      const gmailRows = await this.deps.integrationService.listForProfile(userId, "gmail", profile.id);
      const gmailIntegration = gmailRows[0];
      if (gmailIntegration?.enabled) {
        const gmailToken = `gmail_${nanoid()}`;
        this.gmailTokens.set(gmailToken, { userId });
        mcpTokensToClean.push({ type: "gmail", token: gmailToken });
        const gmailMcpUrl = `${this.deps.config.internalServerUrl}/mcp/gmail`;
        nonSdkServers.push({
          name: "gmail",
          type: "http",
          url: gmailMcpUrl,
          headers: { Authorization: `Bearer ${gmailToken}` },
        });
      }
    }

    // Platform MCP: inject server for agent-initiated platform operations (playbooks, tasks)
    if (this.deps.config.internalServerUrl && userId) {
      const platformToken = `platform_${nanoid()}`;
      this.platformTokens.set(platformToken, {
        userId,
        profileId: profile.id,
        orgId: taskOrgId,
        sessionId: task.session_id ?? task.id,
        capabilities: profile.platform_capabilities ?? [],
      });
      mcpTokensToClean.push({ type: "platform", token: platformToken });
      const platformMcpUrl = `${this.deps.config.internalServerUrl}/mcp/platform`;
      nonSdkServers.push({
        name: "vonzio",
        type: "http",
        url: platformMcpUrl,
        headers: { Authorization: `Bearer ${platformToken}` },
      });
    }

    // Plugin-contributed MCP servers (ctx.mcpRegistry). Unlike the built-in
    // MCPs above, these are injected unconditionally — the plugin's route does
    // its own per-user filtering and returns nothing when the user has no
    // relevant data. Each gets a per-task token the plugin resolves via
    // ctx.mcpSessions. A leading-"/" url is a path under the internal server.
    if (userId) {
      // All tokens minted here carry the SAME identity (this task's user /
      // profile / tenant). That invariant is what makes the single shared
      // pluginMcpTokens map safe despite ctx.mcpSessions.resolve not scoping by
      // plugin: even if one plugin obtained another's token, resolve yields the
      // identity it already has. Do NOT vary identity per server without adding
      // per-plugin token scoping.
      const pluginMcp = buildPluginMcpInjection(
        this.deps.mcpRegistry,
        this.deps.config.internalServerUrl,
        { userId, profileId: profile.id, orgId: taskOrgId },
        () => `pmcp_${nanoid()}`,
      );
      for (const { token, identity } of pluginMcp.tokens) {
        this.pluginMcpTokens.set(token, identity);
        mcpTokensToClean.push({ type: "plugin", token });
      }
      nonSdkServers.push(...pluginMcp.servers);
    }

    // Get friendly container name for preview URLs
    const containerName = await this.deps.containerManager.getContainerName(containerId) ?? containerId.slice(0, 12);

    // Build system prompt with environment context. Presence first —
    // tells the agent which chat surfaces (if any) AskUserQuestion can
    // reach, so it doesn't hang on background tasks with no audience.
    const resolvedMaxTurns = task.max_turns ?? profile.max_turns ?? this.deps.config.maxTurns;
    const presence = await this.resolvePresence(task.session_id);
    const presenceSection = buildPresenceSection(presence);
    let systemPrompt = this.buildSystemPrompt(
      task, containerId, containerName, sdkToolNames, nonSdkServers,
      memorySection, resolvedMaxTurns, presenceSection,
    );
    // When the platform-control MCP ("vonzio") is wired in, bake a short primer
    // into the system prompt (guaranteed-read) so the agent doesn't conflate
    // Vonzio nouns with its own runtime — e.g. answering "how many workspaces
    // do I have" by inspecting its container instead of calling workspace_list.
    // The MCP server also sends this via initialize.instructions; this is the
    // belt-and-suspenders copy.
    if (nonSdkServers.some((s) => s.name === "vonzio")) {
      systemPrompt += PLATFORM_MCP_PRIMER;
    }
    this.emit("task:system_prompt", task.id, task.session_id, systemPrompt);

    // Resolve subagents from profile's agent_ids
    const agentIds = profile.agent_ids ?? [];
    const subagents = agentIds.length > 0
      ? await this.deps.subagentService.resolveAgents(agentIds)
      : undefined;

    // Resolve and mount skills into the agent's personal scope
    // (~/.claude/skills/<name>/), so real-world skills that reference
    // ~/.claude/skills/<name>/scripts/... resolve unmodified. Bundle skills
    // (SKILL.md + scripts/assets) ship as a zip and are unpacked in-container;
    // single-file skills just write SKILL.md. agent-runner loads the "user"
    // setting scope so the SDK discovers them.
    const skillIds = profile.skill_ids ?? [];
    let hasSkills = false;
    if (skillIds.length > 0) {
      const resolvedSkills = await this.deps.skillService.resolveSkills(skillIds);
      for (const skill of resolvedSkills) {
        // Sanitized at upload time, but guard the shell interpolation anyway.
        const safe = skill.name.replace(/[^a-zA-Z0-9._-]/g, "-");
        const dir = `"$HOME/.claude/skills/${safe}"`;
        if (skill.archive) {
          // Stream the zip in (base64) and unpack it into the skill dir.
          await this.drainExec(
            containerId,
            ["sh", "-c", `mkdir -p ${dir} && base64 -d > /tmp/${safe}.zip && unzip -o -q /tmp/${safe}.zip -d ${dir} && rm -f /tmp/${safe}.zip`],
            skill.archive.toString("base64"),
          );
        } else {
          await this.drainExec(
            containerId,
            ["sh", "-c", `mkdir -p ${dir} && cat > ${dir}/SKILL.md`],
            skill.content,
          );
        }
      }
      hasSkills = resolvedSkills.length > 0;
    }

    // Resolve and mount per-agent knowledge documents at /knowledge (read-only).
    // Deliberately OUTSIDE /workspace so a persistent-session volume never caches
    // a stale copy — we wipe + re-sync on every container start, which also drops
    // docs the user has since deleted. The agent reads them on demand with
    // Read/Grep/Glob (PDFs via Read pages) — no embeddings/index (see #docs plan).
    // Provider-aware doc-reading guidance. Anthropic's native Read ingests
    // PDFs/images directly; Ollama/OpenAI-compat models can't, so steer them to
    // extract text with pdftotext (baked into the agent image) instead.
    const isAnthropicProvider = profile.resolved_provider === "api_key";
    const pdfGuidance = isAnthropicProvider
      ? "For PDFs, use Read with the `pages` parameter (a few pages at a time)."
      : "Your model cannot read PDFs or images directly — Read on a binary file will fail. " +
        "Extract text first, e.g. `pdftotext <file> -` (poppler-utils is installed), then work with the text. " +
        "Images require a vision-capable model.";

    let hasKnowledge = false;
    // Names of the docs actually available to this agent — surfaced in the
    // system prompt so the agent knows the KB exists every turn (no reminders).
    const knowledgeManifest: string[] = [];
    try {
      const documents = await this.deps.documentService.resolveForMount(task.profile_id, task.session_id);
      this.log.info(
        { taskId: task.id, sessionId: task.session_id, profileId: task.profile_id, docCount: documents.length },
        "knowledge: resolved documents for profile",
      );
      // Run as root: /knowledge lives at the container root, which the non-root
      // agent user can't create or write. Root-created files default to
      // world-readable (umask 022 → 644 / dirs 755), so the agent can still
      // Read them — but not modify them, which is exactly the read-only intent.
      const ROOT = "root";
      await this.drainExec(containerId, ["sh", "-c", "rm -rf /knowledge"], undefined, ROOT);
      if (documents.length > 0) {
        await this.drainExec(containerId, ["mkdir", "-p", "/knowledge"], undefined, ROOT);
        const indexLines: string[] = [];
        const usedNames = new Set<string>();
        for (const doc of documents) {
          // Keep this in lockstep with sanitizeDocName() in the dashboard's
          // MessageList — the UI maps /knowledge filenames back to docs (for
          // clickable citations) using the identical transform.
          let safeName = doc.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "document";
          if (usedNames.has(safeName)) safeName = `${doc.id}_${safeName}`;
          usedNames.add(safeName);
          // Skip images for non-vision providers: a non-Anthropic model can't
          // ingest an image, and if the agent Reads one the SDK 400s ("does not
          // support image input") and POISONS the session for every later turn.
          // Don't mount it at all — then a stray Read just fails cleanly
          // (file-not-found) instead of bricking the chat. Note it in the index.
          if (!isAnthropicProvider && doc.media_type.startsWith("image/")) {
            indexLines.push(`- ${safeName} — image, NOT available to this model (needs a vision-capable model)`);
            continue;
          }
          await this.drainExec(containerId, ["sh", "-c", `base64 -d > /knowledge/${safeName}`], doc.content_b64, ROOT);
          indexLines.push(`- ${safeName} (${doc.media_type})`);
          knowledgeManifest.push(`${safeName} (${doc.media_type})`);
        }
        const indexMd =
          "# Knowledge\n\n" +
          "Reference documents for this agent. Read them with Read/Grep/Glob. " +
          pdfGuidance + "\n\n" +
          indexLines.join("\n") + "\n";
        await this.drainExec(containerId, ["sh", "-c", "cat > /knowledge/INDEX.md"], indexMd, ROOT);
        // Ensure world-readable + traversable so the non-root agent can read them.
        await this.drainExec(containerId, ["sh", "-c", "chmod -R a+rX /knowledge || true"], undefined, ROOT);
        hasKnowledge = true;
        this.log.info({ taskId: task.id, count: documents.length }, "knowledge: mounted /knowledge");
      }
    } catch (err) {
      // A mount failure must not kill the task — the agent just runs without the
      // docs. Surfaced in logs so we can see size/timeout issues.
      this.log.error({ taskId: task.id, sessionId: task.session_id, err }, "knowledge: mount failed");
    }

    // Model: task → workspace.model_override → profile.model. Shared
    // with the dashboard ModelPicker and the Telegram/Slack /model
    // pickers so all four code paths use the same precedence.
    const workspace = task.session_id ? this.deps.sessionRegistry.get(task.session_id) : null;
    const model = resolveTaskModel(task, workspace, profile);
    const effort = task.effort ?? profile.effort;

    // Whether the effective model can accept image input. Claude (api_key /
    // claude_subscription) is vision-capable; OpenAI we can't introspect so we
    // assume yes (image_url usually works); Ollama varies per model — query its
    // capabilities. Drives the agent-runner's image-read guard so a non-vision
    // model degrades gracefully instead of hard-failing on an image. Fail-open.
    let supportsImages = true;
    if (profile.resolved_provider === "ollama" && profile.resolved_api_key && model) {
      try {
        const { fetchOllamaModelCapabilities } = await import("../services/ollama-service.js");
        supportsImages = (await fetchOllamaModelCapabilities(profile.resolved_api_key, model)).includes("vision");
      } catch { supportsImages = true; }
    }

    // Context replay: when the SDK can't carry context into this turn,
    // reconstruct the conversation from EventLog and prefix it to the
    // user's prompt. Two trigger conditions, same plumbing:
    //   (1) Cross-model switch: the upcoming turn's model differs from
    //       the one that produced the prior turn. The SDK's `resume`
    //       won't carry context across the model identity change (its
    //       session storage is keyed by model).
    //   (2) Session was just resurrected from `expired`: the new
    //       container is fresh, the SDK's on-disk session storage is
    //       gone (or never existed). Without replay the agent wakes
    //       up with no memory of the prior conversation — exactly the
    //       "What were we doing?" → "no prior session context" bug.
    // Force a fresh SDK session in either case so the new model issues
    // its own session_id we can resume against next turn. The flag in
    // (2) is transient/in-memory only and is cleared below.
    const lastRunModel = workspace?.last_run_model ?? null;
    const isCrossModelSwitch = !!(lastRunModel && model && model !== lastRunModel);
    const isResurrectedSession = workspace?.needs_context_replay === true;
    let crossModelReplay = "";
    if (task.session_id && (isCrossModelSwitch || isResurrectedSession) && this.deps.eventLog) {
      const transcript = this.deps.eventLog.buildTranscript(task.session_id);
      if (transcript) {
        const reasonLabel = isResurrectedSession
          ? "the workspace was paused for a while and the runtime was reaped"
          : "the previous turns ran on a different model";
        crossModelReplay = `[Conversation so far in this workspace — ${reasonLabel}. Continue this conversation as if it were yours.]\n\n${transcript}\n\n---\n\nThe user now says:\n\n`;
        this.log.info(
          { sessionId: task.session_id, fromModel: lastRunModel, toModel: model, transcriptChars: transcript.length, resurrected: isResurrectedSession },
          "Replaying conversation transcript for context",
        );
      }
      if (isResurrectedSession && workspace) {
        // Clear the transient flag so subsequent turns use the SDK's
        // normal resume path; replay only fires once on first wake.
        workspace.needs_context_replay = false;
      }
    }
    const forceFreshSession = crossModelReplay.length > 0;

    // Write attachments into container under /workspace/uploads/<timestamp>/
    // Apply the cross-model replay prefix here (rather than mutating task.prompt
    // upstream) so attachment-handling sees the original user message intact.
    let taskPrompt = crossModelReplay + task.prompt;
    if (task.attachments?.length) {
      const ts = Date.now();
      const uploadDir = `/workspace/uploads/${ts}`;
      await this.drainExec(containerId, ["mkdir", "-p", uploadDir]);
      const savedFiles: string[] = [];
      const usedNames = new Set<string>();

      for (let i = 0; i < task.attachments.length; i++) {
        const att = task.attachments[i];
        const ext = att.media_type.split("/")[1]?.replace("jpeg", "jpg").replace("plain", "txt") ?? "bin";
        let baseName = att.name
          ? att.name.replace(/[^a-zA-Z0-9._-]/g, "_")
          : `file_${i + 1}.${ext}`;

        // Deduplicate filenames
        if (usedNames.has(baseName)) {
          const dot = baseName.lastIndexOf(".");
          const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
          const extPart = dot > 0 ? baseName.slice(dot) : "";
          baseName = `${stem}_${i}${extPart}`;
        }
        usedNames.add(baseName);

        const filePath = `${uploadDir}/${baseName}`;
        await this.drainExec(containerId, ["sh", "-c", `base64 -d > ${filePath}`], att.data);
        savedFiles.push(filePath);
      }

      const fileList = savedFiles.join("\n  - ");
      const hasPdf = savedFiles.some(f => f.toLowerCase().endsWith('.pdf'));
      const readGuidance = hasPdf
        ? 'Use the Read tool to examine these files. For PDF files, always use the pages parameter (e.g. pages: "1-5") to read a few pages at a time — never read an entire PDF at once.'
        : 'Use the Read tool to examine these files.';
      // Append attachments note to the (possibly replay-prefixed) prompt so
      // both branches preserve the cross-model replay block when present.
      taskPrompt = `${taskPrompt}\n\n[The user attached ${savedFiles.length} file(s) to the workspace:\n  - ${fileList}\n${readGuidance}]`;
    }

    // On a cross-model switch, force a fresh SDK session — the prior session
    // belongs to the old model and won't carry over. The new model issues its
    // own session_id which we capture on the `init` event below.
    const effectiveSdkSessionId = forceFreshSession ? undefined : sdkSessionId;
    const payload: TaskPayload = {
      prompt: taskPrompt,
      allowed_tools: task.allowed_tools,
      max_turns: task.max_turns ?? profile.max_turns ?? this.deps.config.maxTurns,
      max_budget_usd: task.max_budget_usd,
      model: model || undefined,
      effort: effort || undefined,
      session_id: effectiveSdkSessionId, // SDK's session UUID for resume (undefined on first turn or model switch)
      resume: !!effectiveSdkSessionId,
      output_schema: task.output_schema,
      mcp_servers: nonSdkServers.length > 0 ? nonSdkServers : undefined,
      tool_files: toolFiles.length > 0 ? toolFiles : undefined,
      system_prompt: hasKnowledge
        ? systemPrompt +
          "\n\n## Knowledge base\n" +
          "This agent has a curated knowledge base mounted read-only at `/knowledge`. " +
          "ALWAYS treat it as the primary, authoritative source for the user's domain. " +
          "Before answering a question or asking the user for information, FIRST check whether " +
          "these documents are relevant and consult them (Read/Grep/Glob) — do not ask the user " +
          "for things that are likely covered here.\n\n" +
          (knowledgeManifest.length > 0
            ? "Available documents:\n" + knowledgeManifest.map((m) => `- ${m}`).join("\n") + "\n\n"
            : "See /knowledge/INDEX.md for the file list.\n\n") +
          pdfGuidance +
          "\n\n### Citing your sources\n" +
          "When your final answer draws on these documents, END the message with a fenced code " +
          "block tagged `vonzio:citations` containing a JSON array — one object per passage you " +
          "actually used:\n" +
          "```vonzio:citations\n" +
          '[{"file":"<filename, e.g. drivermanual.pdf>","page":<PDF page number or null>,"section":"<heading/section or null>","quote":"<short exact excerpt, <200 chars>"}]\n' +
          "```\n" +
          "Rules: cite ONLY documents you actually opened/extracted this turn; use the real " +
          "filename as shown above; `page` is the PDF page you read (null if unknown); keep quotes " +
          "short and verbatim; never fabricate a citation. Emit nothing if you didn't use the docs. " +
          "Put the block at the very end — it is parsed and hidden from the user, shown as citation chips."
        : systemPrompt,
      agents: subagents,
      has_skills: hasSkills,
      supports_images: supportsImages,
    };

    let result: TaskResult | null = null;
    try {
    // For relay: only use the task's own session_id (not the SDK's internal UUID)
    // so WS events route to the correct subscriber
    const relaySessionId = task.session_id;
    let resolvedSessionId = task.session_id;
    const toolCalls: TaskResult["tool_calls"] = [];

    // Track current tool_use to pair with tool_result
    let currentToolName: string | undefined;

    for await (const msg of this.agentComms.dispatch(containerId, payload, env)) {
      this.relayMessage(task.id, relaySessionId, msg);

      if (msg.type === "init" && msg.session_id) {
        // Persist the SDK's session ID on the workspace for resume across server restarts
        if (task.session_id) {
          const ws = this.deps.sessionRegistry.get(task.session_id);
          if (ws) {
            (ws as unknown as Record<string, unknown>).sdk_session_id = msg.session_id;
          }
          // Track the model that produced this turn so the next turn can
          // detect a cross-model switch and trigger transcript replay.
          if (model) {
            this.deps.sessionRegistry.setLastRunModel(task.session_id, model).catch((err: unknown) => {
              this.log.warn({ err, sessionId: task.session_id, model }, "Failed to persist last_run_model");
            });
          }
        }
        resolvedSessionId ??= task.session_id ?? msg.session_id;
      }

      if (msg.type === "tool_use") {
        currentToolName = msg.tool;
      }

      if (msg.type === "tool_result") {
        toolCalls.push({
          tool: msg.tool ?? currentToolName ?? "unknown",
          input: {},
          output: msg.output ?? "",
          timestamp: new Date().toISOString(),
        });
      }

      if (msg.type === "result" && msg.result) {
        result = {
          text: msg.result.text,
          structured_output: msg.result.structured_output,
          tool_calls: toolCalls,
          session_id: resolvedSessionId ?? msg.session_id ?? "",
          input_tokens: msg.result.input_tokens,
          output_tokens: msg.result.output_tokens,
          cost_usd: msg.result.cost_usd,
          turns: msg.result.turns,
        };
      }

      if (msg.type === "error") {
        // error_max_turns is not a real failure — the agent hit the turn limit.
        // The agent-runner already emitted a result with cost/usage data before this error,
        // so `result` is populated. Break instead of throwing so the caller gets the result.
        if (msg.error?.includes("error_max_turns") && result) {
          // Flag the cutoff so the goal loop continues without a blind judge call.
          result.max_turns_hit = true;
          break;
        }
        throw new Error(msg.error ?? "Agent error");
      }
    }

    if (!result) {
      // In session mode, the agent may have done useful work (edits, commands)
      // without emitting a final result message. Synthesize a result instead of failing.
      if (task.session_id) {
        result = {
          text: "",
          structured_output: undefined,
          tool_calls: toolCalls,
          session_id: resolvedSessionId ?? "",
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          turns: 0,
        };
      } else {
        throw new Error("Agent completed without producing a result");
      }
    }

    return result;
    } finally {
      // Clean up MCP tokens even if the agent errors
      for (const { type, token } of mcpTokensToClean) {
        if (type === "memory") this.memoryTokens.delete(token);
        else if (type === "notify") this.notifyTokens.delete(token);
        else if (type === "gmail") this.gmailTokens.delete(token);
        else if (type === "platform") this.platformTokens.delete(token);
        else if (type === "plugin") this.pluginMcpTokens.delete(token);
      }
    }
  }

  private relayMessage(taskId: string, sessionId: string | undefined, msg: AgentMessage): void {
    switch (msg.type) {
      case "token":
        this.emit("task:token", taskId, sessionId, msg.text);
        break;
      case "tool_use":
        this.emit("task:tool_use", taskId, sessionId, msg.tool, msg.input);
        // Also emit ask_user so Slack relay can render interactive buttons
        // Only emit when input has the questions array (skip the streaming-start empty emit)
        if (msg.tool === "AskUserQuestion" && msg.input && (msg.input as Record<string, unknown>).questions) {
          this.emit("task:ask_user", taskId, sessionId, msg.input);
        }
        break;
      case "tool_result":
        this.emit("task:tool_result", taskId, sessionId, msg.tool, msg.output);
        break;
      case "ask_user":
        this.emit("task:ask_user", taskId, sessionId, msg.input);
        break;
    }
  }

  /** Write user's answers to AskUserQuestion back to the container */
  /**
   * Wake a workspace container without running a task.
   * Creates a new container if none exists, reuses existing if alive.
   */
  async wakeWorkspaceContainer(sessionId: string, profile: ResolvedProfile): Promise<string | null> {
    const session = this.deps.sessionRegistry.get(sessionId);
    if (!session) return null;

    // Already has a running container
    const staleContainerId = session.container_id;
    if (session.container_id) {
      try {
        const status = await this.deps.containerManager.getContainerStatus(session.container_id);
        if (status === "running") return session.container_id;
        if (status === "paused") {
          await this.deps.containerManager.unpauseContainer(session.container_id);
          return session.container_id;
        }
      } catch { /* container gone */ }
    }

    // Falling through to create a fresh container. Remove the stale one first:
    // getContainerStatus reporting non-running (or throwing) can be transient,
    // so it may still be running — reassigning without removing it leaks a
    // duplicate.
    if (staleContainerId) {
      await this.safeRemoveContainer(staleContainerId);
    }

    // Build env from profile credentials
    const env = await this.buildEnvFromProfile(profile);

    // Create container (with volumes if persistent)
    const volumeId = profile.persistent_sessions ? sessionId : undefined;
    const containerId = await this.createSessionContainer(sessionId, profile, env, volumeId);
    await this.deps.sessionRegistry.reassignContainer(sessionId, containerId);
    if (volumeId) {
      this.deps.sessionRegistry.setVolumeId(sessionId, volumeId);
    }

    // Run setup commands
    if (profile.setup_commands?.length) {
      await this.runSetupCommands(containerId, profile.setup_commands, env);
    }

    // Write CLAUDE.md if profile has it
    if (profile.claude_md) {
      await this.writeClaudeMd(containerId, profile.claude_md);
    }

    return containerId;
  }

  async answerUserQuestion(containerId: string, answers: Record<string, string>): Promise<void> {
    const json = JSON.stringify({ answers });
    const cmd = ["sh", "-c", `echo '${json.replace(/'/g, "'\\''")}' > /tmp/vonzio_ask_user_answer.json`];
    for await (const _ of this.deps.containerManager.execInContainer(containerId, cmd)) {
      // drain
    }
  }

  private async completeTask(task: Task, result: TaskResult): Promise<void> {
    await this.updateTask(task.id, {
      status: "done",
      finished_at: new Date().toISOString(),
      result,
    });
    this.emit("task:done", task.id, task.session_id, result);
  }

  private async handleFailure(task: Task, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorType = errorMessage.includes("timeout") ? "timeout" as const : "error" as const;
    this.log.error({ taskId: task.id, sessionId: task.session_id, error: errorMessage, errorType }, "Task failed");

    // Self-heal a poisoned SDK conversation. A failed turn can leave content in
    // the SDK session history that the model rejects on every resume — e.g. an
    // image a non-vision model can't read ("400 does not support image input"),
    // after which every subsequent turn replays it and 400s forever, bricking
    // the chat. Drop the resume id so the NEXT turn starts a fresh SDK session
    // instead of replaying the broken history. Prior context is lost, but the
    // chat keeps working rather than being permanently stuck.
    if (task.session_id) {
      const session = this.deps.sessionRegistry.get(task.session_id) as Record<string, unknown> | null;
      if (session && session.sdk_session_id) {
        session.sdk_session_id = undefined;
        this.log.info({ taskId: task.id, sessionId: task.session_id }, "Cleared SDK resume after failure (fresh session next turn)");
      }
    }

    if (this.retry.shouldRetry(task, errorType)) {
      const delay = this.retry.nextDelay(task);
      const retryTask = this.retry.prepareRetry(task);

      await this.updateTask(task.id, {
        status: "queued",
        attempt: retryTask.attempt,
        error: errorMessage,
      });

      setTimeout(() => {
        this.deps.queue.enqueue(retryTask);
      }, delay);

      this.emit("task:retry", task.id, task.session_id, retryTask.attempt, delay);
    } else {
      await this.updateTask(task.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error: errorMessage,
      });
      // Include session_id so per-session subscribers (the chat WS that
      // backs the workspace UI) get the failure event, not just per-task
      // subscribers (admin task views, Telegram/Slack mirrors). Mirrors
      // the shape of task:done. Without this the chat stays stuck on
      // "working" forever — the spinner waits for a terminal event that
      // never arrives on its channel.
      this.emit("task:failed", task.id, task.session_id, errorMessage);
    }
  }

  private async fetchProfile(task: Task) {
    // Cross-key model selection: when the conversation carries an api_key_id
    // override, resolve the profile's credential from that key instead (its
    // provider + base_url too). The matching model comes separately from
    // workspace.model_override (resolveTaskModel) — the (model, key) pair is
    // set together by the picker, NOT guaranteed at this layer; a mismatched
    // pair would just error at the provider. The cross-model-switch replay
    // handles the SDK session reset when the model id changes.
    const workspace = task.session_id ? this.deps.sessionRegistry.get(task.session_id) : null;
    const apiKeyIdOverride = workspace?.api_key_id_override ?? null;
    const profile = await this.deps.profileService.getResolved(task.profile_id, { apiKeyIdOverride });
    if (!profile) {
      throw new Error(`Profile ${task.profile_id} not found`);
    }
    return profile;
  }

  private buildRegistryAuth(profile: Profile): { serveraddress: string; username: string; password: string } | undefined {
    const reg = profile.container_registry;
    if (!reg?.url || !reg.username || !reg.password) return undefined;
    return { serveraddress: reg.url, username: reg.username, password: reg.password };
  }

  private async buildEnvFromProfile(profile: { resolved_api_key?: string; resolved_provider?: string; resolved_base_url?: string; git_provider_id?: string; git_provider_ids?: string[]; id: string; user_id?: string | null }): Promise<Record<string, string>> {
    // Inject the secrets granted to this profile — system vars (API key,
    // git tokens) override below. Per-agent scoping (feature #17): a secret
    // with scope='all' goes to every profile; scope='agents' only to those
    // listed in its profile_ids.
    const env: Record<string, string> = {};
    if (profile.user_id && this.deps.secretVaultService) {
      const secrets = await this.deps.secretVaultService.getDecryptedForProfile(profile.user_id, profile.id);
      Object.assign(env, secrets);
    }
    if (profile.resolved_provider === "ollama" && profile.resolved_api_key) {
      env.ANTHROPIC_API_KEY = profile.resolved_api_key;
      env.ANTHROPIC_BASE_URL = "http://127.0.0.1:11434";
      const { OLLAMA_BASE_URL } = await import("../services/ollama-service.js");
      env.OLLAMA_TARGET_URL = OLLAMA_BASE_URL;
    } else if (profile.resolved_provider === "openai" && profile.resolved_api_key) {
      // The Claude Agent SDK still speaks the Anthropic Messages API; the
      // in-container llm-gateway translates it to OpenAI Chat Completions and
      // forwards to LLM_GATEWAY_TARGET_URL.
      env.ANTHROPIC_API_KEY = profile.resolved_api_key;
      env.ANTHROPIC_BASE_URL = "http://127.0.0.1:11434";
      env.LLM_GATEWAY_MODE = "openai";
      // Per-key endpoint override (OpenRouter/Azure/vLLM/LM Studio); falls
      // back to the server-wide OPENAI_BASE_URL when the key has none.
      const { OPENAI_BASE_URL, normalizeOpenAIBaseUrl } = await import("../services/openai-service.js");
      env.LLM_GATEWAY_TARGET_URL = profile.resolved_base_url
        ? normalizeOpenAIBaseUrl(profile.resolved_base_url)
        : OPENAI_BASE_URL;
    } else if (profile.resolved_provider === "claude_subscription" && profile.resolved_api_key) {
      // Claude Pro/Max subscription: the value is an sk-ant-oat01- OAuth token,
      // not an API key. The Agent SDK / Claude Code uses CLAUDE_CODE_OAUTH_TOKEN
      // as a bearer credential against the NATIVE Anthropic API (no gateway,
      // and it injects the oauth beta header itself). Clear any ANTHROPIC_API_KEY
      // a user secret may have injected above — if both are set the SDK could
      // prefer the API key and silently bypass the subscription.
      delete env.ANTHROPIC_API_KEY;
      env.CLAUDE_CODE_OAUTH_TOKEN = profile.resolved_api_key;
    } else if (profile.resolved_api_key) {
      env.ANTHROPIC_API_KEY = profile.resolved_api_key;
    } else {
      throw new Error("No API key linked to this agent. Go to Agents → Edit to attach one.");
    }

    // Inject git credentials from linked providers (or all user providers if none linked)
    let providerIds = profile.git_provider_ids?.length
      ? profile.git_provider_ids
      : profile.git_provider_id ? [profile.git_provider_id] : [];

    // Auto-resolve: if no providers explicitly linked, use all providers for this user
    if (providerIds.length === 0 && profile.user_id) {
      const userProviders = await this.deps.gitProviderService.list(profile.user_id);
      providerIds = userProviders.map((p) => p.id);
    }

    const gitProviders = await Promise.all(providerIds.map((id) => this.deps.gitProviderService.getWithSecret(id)));
    for (const gitProvider of gitProviders) {
      if (!gitProvider?.token) continue;

      if (gitProvider.type === "github") {
        env.GITHUB_TOKEN = gitProvider.token;
        env.GH_TOKEN = gitProvider.token;
      } else if (gitProvider.type === "gitlab") {
        env.GITLAB_TOKEN = gitProvider.token;
      } else if (gitProvider.type === "bitbucket") {
        env.BITBUCKET_TOKEN = gitProvider.token;
      }

      // Use the first provider with identity info for git committer
      if (!env.GIT_AUTHOR_NAME && gitProvider.user_name) {
        env.GIT_AUTHOR_NAME = gitProvider.user_name;
        env.GIT_COMMITTER_NAME = gitProvider.user_name;
      }
      if (!env.GIT_AUTHOR_EMAIL && gitProvider.user_email) {
        env.GIT_AUTHOR_EMAIL = gitProvider.user_email;
        env.GIT_COMMITTER_EMAIL = gitProvider.user_email;
      }
    }

    return env;
  }

  private systemPromptTemplate: string | null = null;

  private loadSystemPromptTemplate(): string {
    if (this.systemPromptTemplate) return this.systemPromptTemplate;

    const thisDir = typeof __dirname !== "undefined" ? __dirname : resolve(fileURLToPath(import.meta.url), "..");
    // `vonzio.md` is the current operator base-prompt filename; `system-prompt.md`
    // is kept as a fallback so existing self-hoster config/ volume mounts that
    // still carry the old name keep working.
    const bases = [
      join(process.cwd(), "config"),
      resolve(thisDir, "../../../../config"),
      "/app/config", // Docker path
    ];
    const candidates = bases.flatMap((b) => [join(b, "vonzio.md"), join(b, "system-prompt.md")]);

    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          const raw = readFileSync(candidate, "utf-8");
          // Strip YAML frontmatter
          const stripped = raw.replace(/^---[\s\S]*?---\n*/, "");
          this.systemPromptTemplate = stripped;
          return stripped;
        }
      } catch (err) {
        this.log.error({ path: candidate, err }, "Failed to load system prompt");
      }
    }

    this.log.warn({ candidates }, "System prompt file not found, using fallback");
    this.systemPromptTemplate = "You are Vonzio, a senior software engineer running in a Docker container.\n\n{{tool_section}}\n{{mcp_section}}";
    return this.systemPromptTemplate;
  }

  /**
   * Compute which chat surfaces are reachable for a given session — i.e.
   * where an `AskUserQuestion` call would actually surface to a human.
   * Three signals:
   *   - dashboard live: there's an open WS subscription on this session_id
   *   - telegram: a row exists in telegram_sessions for this session_id
   *   - slack: a row exists in slack_thread_mappings for this session_id
   *
   * Dashboard liveness is "right now"; telegram/slack are "this session
   * is bound to a chat, the bot will deliver." For background tasks
   * (one-shot mode, playbooks, no chat surface at all) all three come
   * back false — the prompt then tells the agent to NOT call
   * AskUserQuestion and to make a reasonable judgment instead.
   */
  private async resolvePresence(sessionId: string | undefined): Promise<Presence> {
    if (!sessionId) {
      return { dashboard: false, surfaces: [], any: false };
    }
    const dashboard = this.deps.sessionRegistry.getConnectedSessionIds().has(sessionId);
    // Each registered chat-surface provider does its own table read
    // (telegram via the plugin, slack via the still-in-core builtin).
    // resolvePresence used to read these tables directly -- the
    // SessionPresenceRegistry inverts that so the schemas can move
    // out of core without orchestrator changes.
    const surfaces = await this.deps.sessionPresence.surfacesFor(sessionId);
    return { dashboard, surfaces, any: dashboard || surfaces.length > 0 };
  }

  private buildSystemPrompt(
    task: Task,
    containerId: string,
    containerName: string,
    sdkToolNames: string[],
    mcpServers: McpServerConfig[],
    memorySection: string = "",
    resolvedMaxTurns?: number,
    presenceSection: string = "",
  ): string {
    const template = this.loadSystemPromptTemplate();
    const previewBase = this.deps.config.previewUrlTemplate.replace("{container_id}", containerName);

    const toolSection = sdkToolNames.length > 0
      ? `## Custom Tools\nYou have access to these custom MCP tools: ${sdkToolNames.join(", ")}\nUse them when relevant to the task.`
      : "";

    const mcpSection = mcpServers.length > 0
      ? `## External MCP Servers\nConnected: ${mcpServers.map((s) => `${s.name} (${s.type})`).join(", ")}`
      : "";

    return template
      .replace(/\{\{container_name\}\}/g, containerName)
      .replace(/\{\{container_id\}\}/g, containerId.slice(0, 12))
      .replace(/\{\{session_id\}\}/g, task.session_id ?? "none (one-shot task)")
      .replace(/\{\{egress_domains\}\}/g, task.egress_domains?.length ? task.egress_domains.join(", ") : "none (no outbound HTTP)")
      .replace(/\{\{preview_base\}\}/g, previewBase)
      // Trailing slash matters: the system-prompt docs show
      // `![alt]({{file_server}}filename.png)` — without it the resolved
      // URL becomes `http://...vonz.localhostfilename.png` and 404s.
      .replace(/\{\{file_server\}\}/g, previewBase.replace("{port}", "8000").replace(/\/?$/, "/"))
      .replace(/\{\{max_turns\}\}/g, String(resolvedMaxTurns ?? task.max_turns ?? this.deps.config.maxTurns))
      .replace(/\{\{budget_line\}\}/g, task.max_budget_usd ? `- Budget limit: $${task.max_budget_usd}` : "")
      .replace(/\{\{tool_section\}\}/g, toolSection)
      .replace(/\{\{mcp_section\}\}/g, mcpSection)
      .replace(/\{\{memory_section\}\}/g, memorySection)
      .replace(/\{\{presence_section\}\}/g, presenceSection)
      .replace(/\n{3,}/g, "\n\n") // Clean up extra blank lines
      .trim();
  }

  private async buildMemorySection(userId: string, profileId: string): Promise<string> {
    if (!this.deps.memoryService) return "";

    const memories = await this.deps.memoryService.getTopMemories(userId, profileId, 500);
    if (!memories.length) return "";

    const groups: Record<string, Memory[]> = {};
    for (const mem of memories) {
      (groups[mem.type] ??= []).push(mem);
    }

    const sectionLabels: Record<string, string> = {
      user: "User Preferences",
      feedback: "Feedback",
      project: "Project Context",
      reference: "References",
    };

    const sections: string[] = [];
    for (const [type, label] of Object.entries(sectionLabels)) {
      const items = groups[type];
      if (!items?.length) continue;
      const lines = items.map((m) => {
        const body = m.body.length > 200 ? m.body.slice(0, 200) + "..." : m.body;
        return `- ${m.name}: ${body}`;
      });
      sections.push(`### ${label}\n${lines.join("\n")}`);
    }

    return `## Agent Memory\nContext from prior sessions. Update or delete stale entries using memory tools.\n\n${sections.join("\n\n")}`;
  }

  private async runSetupCommands(containerId: string, commands: string[], env?: Record<string, string>): Promise<void> {
    for (const cmd of commands) {
      const output: string[] = [];
      // Append exit code sentinel so we can detect failures
      const wrappedCmd = `${cmd}; echo "::RC::$?"`;
      for await (const line of this.deps.containerManager.execInContainer(
        containerId,
        ["bash", "-lc", wrappedCmd],
        undefined,
        env,
      )) {
        output.push(line);
      }

      // Check exit code from sentinel
      const lastLine = output[output.length - 1] ?? "";
      const rcMatch = lastLine.match(/^::RC::(\d+)$/);
      const exitCode = rcMatch ? parseInt(rcMatch[1], 10) : -1;
      const logOutput = output.filter((l) => !l.startsWith("::RC::")).join("\n").slice(0, 500);

      if (exitCode !== 0) {
        this.log.error({ containerId, cmd, exitCode, output: logOutput }, "Setup command failed");
        throw new Error(`Setup command failed (exit ${exitCode}): ${cmd}`);
      }
      this.log.info({ containerId, cmd, output: logOutput }, "Setup command completed");
    }
  }

  private async writeClaudeMd(containerId: string, content: string): Promise<void> {
    // Pipe content via stdin to avoid shell escaping issues
    await this.drainExec(containerId, ["sh", "-c", "cat > /workspace/CLAUDE.md"], content);
  }

  private async copyWorkspaceToContainer(containerId: string, hostPath: string): Promise<void> {
    // Use tar to stream files into the container via docker exec
    // This works for both pooled and session containers where we can't bind-mount
    await this.drainExec(containerId, [
      "sh", "-c", "tar xf - -C /workspace",
    ], undefined);
    // Note: actual tar streaming requires docker cp; for now, this is a placeholder
    // that will use the ContainerManager's native copy support when implemented.
    // Batch mode uses bind mounts (the correct approach for host -> container).
  }

  private async drainExec(containerId: string, cmd: string[], stdin?: string, user?: string): Promise<void> {
    for await (const _ of this.deps.containerManager.execInContainer(containerId, cmd, stdin, undefined, user)) {
      // drain output
    }
  }

  private async execAsRoot(containerId: string, cmd: string[]): Promise<void> {
    for await (const _ of this.deps.containerManager.execInContainer(containerId, cmd, undefined, undefined, "root")) {
      // drain output
    }
  }

  /**
   * Best-effort: make sure a container is running before we exec into it
   * (used by the goal judge, which can race an idle-sweep pause). Unpauses a
   * paused container; throws for exited/removed so the caller can degrade.
   */
  private async ensureContainerRunning(containerId: string): Promise<void> {
    const status = await this.deps.containerManager.getContainerStatus(containerId);
    if (status === "running") return;
    if (status === "paused") {
      await this.deps.containerManager.unpauseContainer(containerId);
      return;
    }
    // exited / not_found — surface WHY. OOM is the common culprit when an
    // agent installs deps + runs tests under the memory cap.
    const exit = await this.deps.containerManager.getContainerExit(containerId).catch(() => null);
    if (exit?.oomKilled) {
      throw new Error("workspace container was OOM-killed (out of memory) — raise CONTAINER_MEMORY_LIMIT_SESSION");
    }
    throw new Error(`workspace container is ${status}${exit?.exitCode != null ? ` (exit ${exit.exitCode})` : ""}`);
  }

  private async safeRemoveContainer(containerId: string): Promise<void> {
    // If this agent was attached to a shared VPN sidecar, decrement
    // the tunnel's refcount. Only tear down the sidecar when the
    // last attached agent goes away; otherwise other agents lose
    // their network namespace mid-task.
    const pair = this.sidecarsByAgent.get(containerId);
    if (pair) {
      this.sidecarsByAgent.delete(containerId);
      // Emit agent_detached for live "N agents" count in UI.
      try {
        await this.deps.vpnTunnelProvider?.()?.recordEvent?.(
          pair.tunnelId,
          "agent_detached",
          { agentId: containerId, sidecarId: pair.sidecarId },
        );
      } catch (err) {
        this.log.warn({ err, tunnelId: pair.tunnelId }, "recordEvent(agent_detached) failed");
      }

      const entry = this.sidecarsByTunnel.get(pair.tunnelId);
      if (entry) {
        entry.refCount--;
        if (entry.refCount <= 0) {
          // Don't tear the tunnel down immediately — back-to-back tasks
          // for the same user would re-handshake against the customer's
          // VPN server, wasting time and risking duplicate-cert rejection.
          // Wait SIDECAR_GRACE_MS; if no agent re-attaches, then remove.
          // ensureVpnSidecar's reuse path cancels this timer when it
          // bumps the refcount.
          const tunnelId = pair.tunnelId;
          const sidecarId = entry.sidecarId;
          const existing = this.sidecarTeardownTimers.get(tunnelId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(async () => {
            this.sidecarTeardownTimers.delete(tunnelId);
            const current = this.sidecarsByTunnel.get(tunnelId);
            if (!current || current.refCount > 0) return; // re-attached during grace
            this.sidecarsByTunnel.delete(tunnelId);
            try {
              await this.deps.containerManager.removeContainer(sidecarId, true);
            } catch {
              // already gone
            }
            try {
              await this.deps.vpnTunnelProvider?.()?.recordEvent?.(tunnelId, "sidecar_down", { sidecarId });
            } catch (err) {
              this.log.warn({ err, tunnelId }, "recordEvent(sidecar_down) failed");
            }
            this.log.info({ tunnelId, sidecarId }, "VPN sidecar torn down after idle grace");
          }, SIDECAR_TEARDOWN_GRACE_MS);
          this.sidecarTeardownTimers.set(tunnelId, timer);
        }
      }
    }
    try {
      await this.deps.containerManager.removeContainer(containerId, true);
    } catch {
      // Container may already be gone
    }
  }

  /**
   * Verify the always-on egress proxy is available and return the info needed
   * to point an agent at it. Null when enforcement is off. The proxy is a
   * long-lived compose service (profile: egress) — not created here — so it
   * survives server restarts/crashes and never strands a running agent. Throws
   * (fail-closed) when enforcement is ON but the proxy service isn't running:
   * we must NOT silently place an agent on a network with no way out (or worse,
   * direct internet).
   */
  private async ensureEgressProxy(): Promise<{ networkName: string; alias: string; port: number } | null> {
    const cfg = this.deps.config;
    if (!cfg.egressEnforcement) return null;
    const network = cfg.egressProxyNetwork || "vonzio-egress";

    const running = (await this.deps.containerManager.listManagedContainers())
      .some((c) => c.labels[CONTAINER_MODE_LABEL] === ContainerMode.EgressProxy && c.status === "running");
    if (!running) {
      throw new Error(
        "EGRESS_ENFORCEMENT is on but the egress-proxy service is not running. " +
        "Start it with the 'egress' compose profile (e.g. COMPOSE_PROFILES=egress).",
      );
    }
    // Defense against a pre-existing non-internal network of the same name
    // (would be a fail-OPEN bypass). ensureNetwork throws on a posture mismatch;
    // the network already exists (the proxy is attached to it), so this verifies
    // rather than creates.
    await this.deps.containerManager.ensureNetwork(network, { internal: true });
    return { networkName: network, alias: this.EGRESS_PROXY_ALIAS, port: this.EGRESS_PROXY_PORT };
  }

  /**
   * Apply egress enforcement to an agent about to be created: mutate `env` to
   * route all egress through the proxy (and force the native-Anthropic model
   * path through the in-container gateway, since the Node SDK ignores proxy
   * env) and return the internal networkMode to attach it to. Returns null when
   * enforcement is off, the profile opted out (`["*"]`), or a VPN already
   * constrains egress (v1 leaves the VPN path unchanged). `egressDomains` is the
   * resolved allowlist (per-task for batch; profile default for session).
   */
  private async applyEgress(
    egressDomains: string[] | undefined,
    env: Record<string, string>,
    vpnActive: boolean,
    opts?: { tokenTtlSeconds?: number },
  ): Promise<{ networkMode: string } | null> {
    if (!this.deps.config.egressEnforcement) return null;
    if (vpnActive) return null; // VPN already routes/locks egress; compose in v2
    if ((egressDomains ?? []).includes("*")) return null; // explicit opt-out

    // Force the native-Anthropic model call through the proxy-aware gateway
    // BEFORE deriving model hosts, so api.anthropic.com ends up in the allowlist.
    routeModelThroughGateway(env);
    const plan = planEgress(egressDomains, modelHostsFromEnv(env));

    const proxy = await this.ensureEgressProxy();
    if (!proxy) throw new Error("egress enforcement enabled but proxy unavailable");
    Object.assign(env, buildProxyEnv({
      domains: plan.domains,
      secret: this.deps.config.egressProxySecret!,
      proxyAlias: proxy.alias,
      proxyPort: proxy.port,
      // Per-task (batch) tokens expire to bound replay if leaked; session tokens
      // are baked into a long-lived container's env with no refresh path, so
      // they don't expire (a mid-session 407 would otherwise kill the session).
      ttlSeconds: opts?.tokenTtlSeconds,
    }));
    return { networkMode: proxy.networkName };
  }

  /**
   * If the agent's profile has an active VPN tunnel, launch a paired
   * WireGuard sidecar and return its container id + the network_mode
   * string to attach the agent through. Returns null when no tunnel
   * is configured (OSS, or SaaS user without a tunnel for this
   * profile). Errors are logged and treated as "no tunnel" — a
   * misconfigured tunnel must not break agent launches.
   */
  private async ensureVpnSidecar(
    profile: Profile,
    workspaceId?: string,
  ): Promise<{ sidecarId: string; tunnelId: string; networkMode: string; dns?: string[]; searchDomains?: string[] } | null> {
    const provider = this.deps.vpnTunnelProvider?.();
    const encryptionKey = this.deps.config.encryptionKey;
    if (!provider || !encryptionKey || !profile.user_id) return null;
    try {
      // workspaceId, when passed, lets the provider consult a
      // per-workspace tunnel override before falling back to the
      // profile-based resolver.
      const tunnel = await provider.resolveActiveTunnel(profile.user_id, profile.id, workspaceId);
      if (!tunnel) return null;

      // Reuse path: another agent already brought up a sidecar for
      // this tunnel. Validate the cached sidecar's config is still
      // current (no tunnel row updates since); if stale, evict and
      // fall through to creation. Otherwise increment refcount,
      // cancel any pending teardown, and return its info.
      const cached = this.sidecarsByTunnel.get(tunnel.id);
      if (cached) {
        if (cached.version !== tunnel.version) {
          this.log.info({ tunnelId: tunnel.id, cachedVersion: cached.version, currentVersion: tunnel.version, refCount: cached.refCount }, "VPN sidecar config changed — evicting cached sidecar");
          const pendingTeardown = this.sidecarTeardownTimers.get(tunnel.id);
          if (pendingTeardown) {
            clearTimeout(pendingTeardown);
            this.sidecarTeardownTimers.delete(tunnel.id);
          }
          // Evict from map BEFORE destroying so concurrent dispatches
          // miss the cache and serialize via sidecarInFlight on the
          // new entry. Existing attached agents (refCount>0) keep
          // their network namespace until they terminate — we don't
          // force-disconnect to protect in-flight work. They finish
          // on the OLD config; new dispatches get the new one.
          this.sidecarsByTunnel.delete(tunnel.id);
          if (cached.refCount === 0) {
            try {
              await this.deps.containerManager.removeContainer(cached.sidecarId, true);
            } catch {
              // already gone
            }
          }
          // Fall through to creation path below.
        } else {
          cached.refCount++;
          const pendingTeardown = this.sidecarTeardownTimers.get(tunnel.id);
          if (pendingTeardown) {
            clearTimeout(pendingTeardown);
            this.sidecarTeardownTimers.delete(tunnel.id);
            this.log.info({ tunnelId: tunnel.id }, "Cancelled pending VPN sidecar teardown — new agent attached");
          }
          this.log.info({ tunnelId: tunnel.id, sidecarId: cached.sidecarId, refCount: cached.refCount }, "VPN sidecar reused");
          return {
            sidecarId: cached.sidecarId,
            tunnelId: tunnel.id,
            networkMode: cached.networkMode,
            dns: cached.dns,
            searchDomains: cached.searchDomains,
          };
        }
      }

      // Serialize concurrent creation for the same tunnel — two
      // simultaneous agent dispatches must NOT both create a sidecar,
      // or they'll fight for the duplicate-cert slot at the VPN
      // server and flap each other dead.
      const inFlight = this.sidecarInFlight.get(tunnel.id);
      if (inFlight) {
        const result = await inFlight;
        if (result) {
          // The in-flight call created and registered the sidecar.
          // Bump refcount for OUR attachment.
          const entry = this.sidecarsByTunnel.get(tunnel.id);
          if (entry) entry.refCount++;
        }
        return result;
      }

      // First caller for this tunnel — own the creation.
      const creation = this.createSidecar(tunnel, provider, encryptionKey);
      this.sidecarInFlight.set(tunnel.id, creation);
      try {
        return await creation;
      } finally {
        this.sidecarInFlight.delete(tunnel.id);
      }
    } catch (err) {
      this.log.error({ err, profileId: profile.id }, "Failed to bring up VPN sidecar; proceeding without tunnel");
      return null;
    }
  }

  /** Actually create + start the sidecar, wait for DNS push, record
   *  bookkeeping. Called only by ensureVpnSidecar via the in-flight
   *  serialization. */
  private async createSidecar(
    tunnel: { id: string; name: string; type: string; encryptedConfig?: string; authBlobEncrypted?: string; egressLockdown?: boolean; fullTunnel?: boolean; sidecarImage: string; version: string },
    provider: NonNullable<ReturnType<NonNullable<OrchestratorDeps["vpnTunnelProvider"]>>>,
    encryptionKey: string,
  ): Promise<{ sidecarId: string; tunnelId: string; networkMode: string; dns?: string[]; searchDomains?: string[] } | null> {
    const env: Record<string, string> = {};
    if (tunnel.type === "tailscale") {
      // Tailscale doesn't take a config file — the sidecar joins the
      // tailnet via auth key alone. The key lives in authBlobEncrypted
      // (reused for parity with OpenVPN's auth-user-pass blob).
      if (!tunnel.authBlobEncrypted) {
        this.log.error({ tunnelId: tunnel.id }, "Tailscale tunnel missing auth key");
        return null;
      }
      const authkey = decrypt(tunnel.authBlobEncrypted, encryptionKey);
      env.VPN_TS_AUTHKEY_B64 = Buffer.from(authkey, "utf8").toString("base64");
      // Hostname seen on the tailnet — useful for ACLs and admin UI.
      // Truncated tunnel id keeps it stable across sidecar restarts.
      env.VPN_TS_HOSTNAME = `vonzio-${tunnel.id.replace(/^vpn_/, "").slice(0, 12)}`;
    } else {
      if (!tunnel.encryptedConfig) {
        this.log.error({ tunnelId: tunnel.id, type: tunnel.type }, "Tunnel missing config");
        return null;
      }
      const config = decrypt(tunnel.encryptedConfig, encryptionKey);
      env.VPN_CONFIG_B64 = Buffer.from(config, "utf8").toString("base64");
      if (tunnel.authBlobEncrypted) {
        const authBlob = decrypt(tunnel.authBlobEncrypted, encryptionKey);
        env.VPN_AUTH_USER_PASS_B64 = Buffer.from(authBlob, "utf8").toString("base64");
      }
    }
    if (tunnel.fullTunnel) {
      // Default-route via tunnel — sidecar rewrites the config to add
      // 0.0.0.0/0 routes. egress_lockdown is implied (no other route
      // exists) and we skip the iptables overhead.
      env.VPN_FULL_TUNNEL = "1";
    } else if (tunnel.egressLockdown) {
      env.VPN_EGRESS_LOCKDOWN = "1";
    }
    // OpenVPN and Tailscale both need a userspace tun device (Tailscale
    // can run in userspace-only mode but kernel-mode is what we want
    // for network_mode:container to expose a working interface).
    const devices = (tunnel.type === "openvpn" || tunnel.type === "tailscale") ? ["/dev/net/tun"] : undefined;
    const sidecarId = await this.deps.containerManager.createContainer({
      image: tunnel.sidecarImage,
      env,
      capAdd: ["NET_ADMIN"],
      devices,
      labels: {
        [CONTAINER_MODE_LABEL]: ContainerMode.VpnSidecar,
        "vonzio-vpn-tunnel-id": tunnel.id,
        "vonzio-vpn-tunnel-type": tunnel.type,
      },
    });
    await this.deps.containerManager.startContainer(sidecarId);

    let dns: string[] | undefined;
    let searchDomains: string[] | undefined;
    if (tunnel.type === "openvpn") {
      const pushed = await this.readPushedDnsFromSidecar(sidecarId);
      if (pushed) {
        dns = pushed.dns;
        searchDomains = pushed.searchDomains;
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const networkMode = `container:${sidecarId}`;
    // Register with refCount 1 — this caller is the first attached agent.
    this.sidecarsByTunnel.set(tunnel.id, {
      sidecarId,
      networkMode,
      refCount: 1,
      version: tunnel.version,
      name: tunnel.name,
      dns,
      searchDomains,
    });

    this.log.info({ tunnelId: tunnel.id, sidecarId, dns, searchDomains }, "VPN sidecar up");
    try {
      await provider.recordEvent?.(tunnel.id, "sidecar_up", { sidecarId, hasDns: !!(dns && dns.length > 0) });
    } catch (err) {
      this.log.warn({ err, tunnelId: tunnel.id }, "recordEvent(sidecar_up) failed");
    }
    return { sidecarId, tunnelId: tunnel.id, networkMode, dns, searchDomains };
  }

  /**
   * Polls the OpenVPN sidecar for the DNS info its --up script writes
   * to /tmp/vpn-pushed-dns once the tunnel handshake completes. Returns
   * null only if the file never gains content within the deadline.
   *
   * Implementation note: containerManager.readFile is `cat`-based, so
   * a missing file returns an empty Buffer (not a throw) and an empty
   * file does the same. Both look the same here; both mean "not ready
   * yet" — keep polling until we see at least one DNS line or timeout.
   * Worst-case wait is ~10s; typical is <2s.
   */
  private async readPushedDnsFromSidecar(
    sidecarId: string,
  ): Promise<{ dns: string[]; searchDomains: string[] } | null> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const buf = await this.deps.containerManager.readFile(sidecarId, "/tmp/vpn-pushed-dns");
        const text = buf.toString("utf8");
        if (text.length > 0) {
          const dns: string[] = [];
          const searchDomains: string[] = [];
          for (const line of text.split("\n")) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] === "DNS" && parts[1]) dns.push(parts[1]);
            else if (parts[0] === "SEARCH" && parts[1]) searchDomains.push(parts[1]);
          }
          if (dns.length > 0) return { dns, searchDomains };
        }
      } catch {
        // Read failure (rare — usually a brief race with the sidecar
        // becoming ready). Treat same as empty: retry.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.log.warn({ sidecarId }, "Timed out waiting for VPN sidecar to push DNS — agent may not resolve tunneled hostnames");
    return null;
  }

  /**
   * Rewrites the agent container's /etc/resolv.conf so DNS queries go
   * to the tunnel's pushed DNS server instead of Docker's embedded
   * resolver. Best-effort: an exec failure is logged but doesn't break
   * the agent.
   */
  private async applyTunnelDns(
    agentId: string,
    dns: string[],
    searchDomains?: string[],
  ): Promise<void> {
    if (dns.length === 0) return;
    try {
      const lines: string[] = dns.map((ns) => `nameserver ${ns}`);
      if (searchDomains && searchDomains.length > 0) {
        lines.push(`search ${searchDomains.join(" ")}`);
      }
      const content = lines.join("\n") + "\n";
      const stream = this.deps.containerManager.execInContainer(
        agentId,
        ["sh", "-c", "cat > /etc/resolv.conf"],
        content,
        undefined,
        "root",
      );
      for await (const _ of stream) {
        // drain
      }
      this.log.info({ agentId, dns, searchDomains }, "Applied tunnel DNS to agent");
    } catch (err) {
      this.log.error({ err, agentId }, "Failed to apply tunnel DNS to agent — agent may not resolve tunneled hostnames");
    }
  }

  private async updateTask(taskId: string, updates: TaskUpdate): Promise<void> {
    await this.deps.db
      .update(schema.tasks)
      .set(updates)
      .where(eq(schema.tasks.id, taskId));
  }

  private startTaskTimeout(taskId: string, ms: number): void {
    if (ms <= 0) return; // 0/negative = watchdog disabled
    const timer = setTimeout(async () => {
      const active = this.activeTasks.get(taskId);
      if (!active) return;
      // Make this death greppable. A timeout-induced abort surfaces three
      // layers away (abort → stopContainer → judge 409 → "completion check
      // unavailable"); without this line, diagnosing it meant archaeology.
      this.log.warn(
        { taskId, ms, containerId: active.containerId, session: !!active.sessionId },
        "task watchdog fired — aborting hung turn (container kept for sessions)",
      );
      try {
        // Keep the container for session tasks — the timeout aborts the stuck
        // turn's exec but must NOT destroy a warm/persistent session container
        // (doing so killed it mid-goal-loop → continuation "container not
        // running"). Batch tasks have no session and get the full stop.
        await this.agentComms.abort(active.containerId, !!active.sessionId);
      } catch (err) {
        // Don't let an abort failure become an unhandled rejection in the
        // timer callback — log and move on; the task's own paths still clean up.
        this.log.warn({ err: errMsg(err), taskId }, "task watchdog: abort failed");
      }
    }, ms);
    this.activeTimers.set(taskId, timer);
  }

  private clearTaskTimeout(taskId: string): void {
    const timer = this.activeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(taskId);
    }
  }
}

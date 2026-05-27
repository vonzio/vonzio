import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskQueue } from "@vonzio/shared";
import type { Task, TaskResult } from "@vonzio/shared";
import type { ContainerManager } from "@vonzio/shared";
import type { ConcurrencyLimiter, VpnTunnelProvider } from "@vonzio/shared";
import { decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { buildPresenceSection, type Presence } from "./presence.js";
import { resolveTaskModel } from "../lib/model-resolution.js";
import { ContainerPool } from "../container/pool.js";
import { SessionRegistry, VOLUME_PREFIX_WORKSPACE, VOLUME_PREFIX_SDK } from "../container/session-registry.js";
import { WorkspaceProvisioner } from "../container/workspace.js";
import { AgentCommunicator, type AgentMessage, type TaskPayload } from "./agent-comms.js";
import type { EventLog } from "../events/event-log.js";
import { RetryHandler } from "./retry.js";
import type { ProfileService } from "../services/profile-service.js";
import type { ToolFileService } from "../services/tool-file-service.js";
import type { SkillService } from "../services/skill-service.js";
import type { SubagentService } from "../services/subagent-service.js";
import type { GitProviderService } from "../services/git-provider-service.js";
import type { MemoryService } from "../services/memory-service.js";
import type { SecretVaultService } from "../services/secret-vault-service.js";
import type { IntegrationService } from "../services/integration-service.js";
import type { Profile, ResolvedProfile, McpServerConfig } from "@vonzio/shared";
import type { Memory } from "@vonzio/shared";
import { nanoid } from "nanoid";

type TaskUpdate = Partial<typeof schema.tasks.$inferInsert>;

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
  gitProviderService: GitProviderService;
  memoryService?: MemoryService;
  secretVaultService?: SecretVaultService;
  integrationService?: IntegrationService;
  eventLog?: EventLog;
  /**
   * Read at request time, not construction time — cp-server mutates
   * coreDeps.vpnTunnelProvider after the orchestrator is built. A
   * getter (rather than a direct reference) lets the orchestrator see
   * the swap.
   */
  vpnTunnelProvider?: () => VpnTunnelProvider | undefined;
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
  // Tracks the VPN sidecar paired with each agent container so
  // safeRemoveContainer can clean it up. Empty for OSS (no tunnels).
  // tunnelId is carried so we can emit a sidecar_down event with
  // the right context on cleanup.
  private sidecarsByAgent = new Map<string, { sidecarId: string; tunnelId: string }>();
  private memoryTokens = new Map<string, { userId: string; profileId: string }>();
  private notifyTokens = new Map<string, { userId: string; sessionId: string }>();
  private gmailTokens = new Map<string, { userId: string }>();
  private tellerTokens = new Map<string, { userId: string; profileId: string }>();
  private platformTokens = new Map<string, { userId: string; profileId: string }>();
  private log: Logger;

  constructor(private deps: OrchestratorDeps) {
    super();
    this.agentComms = new AgentCommunicator(deps.containerManager);
    this.retry = new RetryHandler();
    this.log = deps.log?.child({ component: "orchestrator" }) ?? noopLogger;
  }

  resolveMemoryToken(token: string): { userId: string; profileId: string } | undefined {
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

  resolveTellerToken(token: string): { userId: string; profileId: string } | undefined {
    return this.tellerTokens.get(token);
  }

  clearTellerToken(token: string): void {
    this.tellerTokens.delete(token);
  }

  resolvePlatformToken(token: string): { userId: string; profileId: string } | undefined {
    return this.platformTokens.get(token);
  }

  clearPlatformToken(token: string): void {
    this.platformTokens.delete(token);
  }

  start(): void {
    this.running = true;
    this.deps.queue.onReady(() => this.scheduleProcessing());
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
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

  private async dispatchBatch(task: Task, prefetchedProfile?: Profile): Promise<void> {
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

      containerId = await this.deps.containerManager.createContainer({
        image: profile.container_image,
        registryAuth: this.buildRegistryAuth(profile),
        env,
        binds,
        cpus: this.deps.config.containerCpuBatch,
        memory: this.deps.config.containerMemoryBatch,
        networkMode: vpn?.networkMode,
        labels: {
          "vonzio-mode": "batch",
          "vonzio-task-id": task.id,
        },
      });
      if (vpn) this.sidecarsByAgent.set(containerId, { sidecarId: vpn.sidecarId, tunnelId: vpn.tunnelId });
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
    if (profile.container_image || profile.setup_commands?.length || hasTunnel) {
      this.log.info({ taskId: task.id, image: profile.container_image, setupCmds: profile.setup_commands?.length, hasTunnel }, "Pooled incompatible, falling back to batch");
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
        this.deps.sessionRegistry.reassignContainer(task.session_id, containerId);
        session.container_id = containerId;
        // Re-run setup commands since it's a fresh container (workspace files are preserved via volume)
        if (profile.setup_commands?.length) {
          await this.runSetupCommands(containerId, profile.setup_commands, env);
        }
      } else {
        // Dead container, no volumes — create fresh
        containerId = await this.createSessionContainer(task.session_id, profile, env);
        this.deps.sessionRegistry.reassignContainer(task.session_id, containerId);
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
        session = await this.deps.sessionRegistry.register(
          task.session_id,
          containerId,
          profile.user_id ?? task.profile_id,
          task.profile_id,
          profile.persistent_sessions,
        );
      } else {
        this.deps.sessionRegistry.reassignContainer(task.session_id, containerId);
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

    // Auto-continue: if the agent hit max_turns and the profile has auto_continue enabled,
    // keep dispatching continuation turns in the same session.
    if (profile.auto_continue && task.session_id) {
      const effectiveMaxTurns = task.max_turns ?? profile.max_turns ?? this.deps.config.maxTurns;
      const maxContinuations = profile.max_continuations ?? 5;
      const budgetCap = profile.continuation_budget_usd ?? Infinity;
      let continuationCount = 0;
      let totalCost = result.cost_usd;

      while (
        result.turns >= effectiveMaxTurns &&
        continuationCount < maxContinuations &&
        totalCost < budgetCap
      ) {
        continuationCount++;
        this.log.info(
          { taskId: task.id, sessionId: task.session_id, continuation: continuationCount, maxContinuations, totalCost },
          "Auto-continuing session",
        );

        this.emit("task:continuing", task.id, task.session_id, {
          continuation: continuationCount,
          max_continuations: maxContinuations,
          total_cost_usd: totalCost,
        });

        // Build a continuation task that resumes in the same session
        const continuationTask: Task = {
          ...task,
          prompt: "Continue working on the task. Review your previous progress and continue where you left off.",
          attempt: 1,
        };

        result = await this.runAgent(continuationTask, containerId, profile, env, true);
        this.deps.sessionRegistry.updateActivity(task.session_id);
        totalCost += result.cost_usd;

        // If agent finished before hitting max_turns, it's done on its own
        if (result.turns < effectiveMaxTurns) {
          this.log.info(
            { taskId: task.id, continuation: continuationCount, turns: result.turns },
            "Agent finished within turn limit during auto-continue",
          );
          break;
        }
      }

      // Merge total cost into final result
      if (continuationCount > 0) {
        result = { ...result, cost_usd: totalCost };
      }
    }

    await this.completeTask(task, result);
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

    const vpn = await this.ensureVpnSidecar(profile);
    const containerId = await this.deps.containerManager.createContainer({
      image: profile.container_image,
      registryAuth: this.buildRegistryAuth(profile),
      env,
      binds: binds.length > 0 ? binds : undefined,
      cpus: this.deps.config.containerCpuSession,
      memory: this.deps.config.containerMemorySession,
      networkMode: vpn?.networkMode,
      labels: {
        "vonzio-mode": "session",
        "vonzio-session-id": sessionId,
      },
    });
    if (vpn) this.sidecarsByAgent.set(containerId, { sidecarId: vpn.sidecarId, tunnelId: vpn.tunnelId });
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

  private async runAgent(task: Task, containerId: string, profile: Profile, env?: Record<string, string>, isResume?: boolean): Promise<TaskResult> {
    // Start Ollama auth proxy if needed — only once per container (skip if already running)
    if (env?.OLLAMA_TARGET_URL) {
      await this.runSetupCommands(containerId, ["node /app/ollama-proxy.cjs &\nsleep 0.3"], env);
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
    const mcpTokensToClean: Array<{ type: "memory" | "notify" | "gmail" | "teller" | "platform"; token: string }> = [];

    // Memory integration: inject MCP server and build memory section for system prompt
    const userId = profile.user_id ?? "";
    let memorySection = "";
    if (profile.memory_enabled !== false && this.deps.memoryService && userId) {
      if (this.deps.config.internalServerUrl) {
        const memToken = `mem_${nanoid()}`;
        this.memoryTokens.set(memToken, { userId, profileId: profile.id });
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

    // Teller integration: inject MCP server when the user has ≥1 connected
    // bank enrollment that is scope-granted to the running profile. The MCP
    // re-filters at call time too, so a multi-bank user where only one row
    // is scoped to this profile sees just that bank's enrollments.
    if (this.deps.config.internalServerUrl && userId && this.deps.integrationService) {
      const tellerRows = await this.deps.integrationService.listForProfile(userId, "teller", profile.id);
      const hasEnabledTeller = tellerRows.length > 0;
      if (hasEnabledTeller) {
        const tellerToken = `teller_${nanoid()}`;
        this.tellerTokens.set(tellerToken, { userId, profileId: profile.id });
        mcpTokensToClean.push({ type: "teller", token: tellerToken });
        const tellerMcpUrl = `${this.deps.config.internalServerUrl}/mcp/teller`;
        nonSdkServers.push({
          name: "teller",
          type: "http",
          url: tellerMcpUrl,
          headers: { Authorization: `Bearer ${tellerToken}` },
        });
      }
    }

    // Platform MCP: inject server for agent-initiated platform operations (playbooks, tasks)
    if (this.deps.config.internalServerUrl && userId) {
      const platformToken = `platform_${nanoid()}`;
      this.platformTokens.set(platformToken, { userId, profileId: profile.id });
      mcpTokensToClean.push({ type: "platform", token: platformToken });
      const platformMcpUrl = `${this.deps.config.internalServerUrl}/mcp/platform`;
      nonSdkServers.push({
        name: "vonzio",
        type: "http",
        url: platformMcpUrl,
        headers: { Authorization: `Bearer ${platformToken}` },
      });
    }

    // Get friendly container name for preview URLs
    const containerName = await this.deps.containerManager.getContainerName(containerId) ?? containerId.slice(0, 12);

    // Build system prompt with environment context. Presence first —
    // tells the agent which chat surfaces (if any) AskUserQuestion can
    // reach, so it doesn't hang on background tasks with no audience.
    const resolvedMaxTurns = task.max_turns ?? profile.max_turns ?? this.deps.config.maxTurns;
    const presence = await this.resolvePresence(task.session_id);
    const presenceSection = buildPresenceSection(presence);
    const systemPrompt = this.buildSystemPrompt(
      task, containerId, containerName, sdkToolNames, nonSdkServers,
      memorySection, resolvedMaxTurns, presenceSection,
    );
    this.emit("task:system_prompt", task.id, task.session_id, systemPrompt);

    // Resolve subagents from profile's agent_ids
    const agentIds = profile.agent_ids ?? [];
    const subagents = agentIds.length > 0
      ? await this.deps.subagentService.resolveAgents(agentIds)
      : undefined;

    // Resolve and write skills into container
    const skillIds = profile.skill_ids ?? [];
    let hasSkills = false;
    if (skillIds.length > 0) {
      const resolvedSkills = await this.deps.skillService.resolveSkills(skillIds);
      for (const skill of resolvedSkills) {
        const skillPath = `/workspace/.claude/skills/${skill.name}/SKILL.md`;
        await this.drainExec(containerId, ["sh", "-c", `mkdir -p /workspace/.claude/skills/${skill.name} && cat > ${skillPath}`], skill.content);
      }
      hasSkills = resolvedSkills.length > 0;
    }

    // Model: task → workspace.model_override → profile.model. Shared
    // with the dashboard ModelPicker and the Telegram/Slack /model
    // pickers so all four code paths use the same precedence.
    const workspace = task.session_id ? this.deps.sessionRegistry.get(task.session_id) : null;
    const model = resolveTaskModel(task, workspace, profile);
    const effort = task.effort ?? profile.effort;

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
      system_prompt: systemPrompt,
      agents: subagents,
      has_skills: hasSkills,
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
        else if (type === "teller") this.tellerTokens.delete(token);
        else if (type === "platform") this.platformTokens.delete(token);
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

    // Build env from profile credentials
    const env = await this.buildEnvFromProfile(profile);

    // Create container (with volumes if persistent)
    const volumeId = profile.persistent_sessions ? sessionId : undefined;
    const containerId = await this.createSessionContainer(sessionId, profile, env, volumeId);
    this.deps.sessionRegistry.reassignContainer(sessionId, containerId);
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

      this.emit("task:retry", task.id, retryTask.attempt, delay);
    } else {
      await this.updateTask(task.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error: errorMessage,
      });
      this.emit("task:failed", task.id, errorMessage);
    }
  }

  private async fetchProfile(task: Task) {
    const profile = await this.deps.profileService.getResolved(task.profile_id);
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

  private async buildEnvFromProfile(profile: { resolved_api_key?: string; resolved_auth_token?: string; resolved_provider?: string; git_provider_id?: string; git_provider_ids?: string[]; id: string; user_id?: string | null }): Promise<Record<string, string>> {
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
    } else if (profile.resolved_api_key) {
      env.ANTHROPIC_API_KEY = profile.resolved_api_key;
    } else if (profile.resolved_auth_token) {
      env.CLAUDE_CODE_OAUTH_TOKEN = profile.resolved_auth_token;
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
    const candidates = [
      join(process.cwd(), "config", "system-prompt.md"),
      resolve(thisDir, "../../../../config/system-prompt.md"),
      "/app/config/system-prompt.md", // Docker path
    ];

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
      return { dashboard: false, telegram: false, slack: false, any: false };
    }
    const dashboard = this.deps.sessionRegistry.getConnectedSessionIds().has(sessionId);

    // DB checks parallelized — the table-existence checks are cheap
    // indexed lookups, but doing them sequentially adds two RTTs per
    // task start.
    const [telegramRows, slackRows] = await Promise.all([
      this.deps.db.select({ id: schema.telegramSessions.session_id })
        .from(schema.telegramSessions)
        .where(eq(schema.telegramSessions.session_id, sessionId))
        .limit(1)
        .catch(() => [] as Array<{ id: string }>),
      this.deps.db.select({ id: schema.slackThreadMappings.session_id })
        .from(schema.slackThreadMappings)
        .where(eq(schema.slackThreadMappings.session_id, sessionId))
        .limit(1)
        .catch(() => [] as Array<{ id: string }>),
    ]);
    const telegram = telegramRows.length > 0;
    const slack = slackRows.length > 0;
    return { dashboard, telegram, slack, any: dashboard || telegram || slack };
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

  private async drainExec(containerId: string, cmd: string[], stdin?: string): Promise<void> {
    for await (const _ of this.deps.containerManager.execInContainer(containerId, cmd, stdin)) {
      // drain output
    }
  }

  private async execAsRoot(containerId: string, cmd: string[]): Promise<void> {
    for await (const _ of this.deps.containerManager.execInContainer(containerId, cmd, undefined, undefined, "root")) {
      // drain output
    }
  }

  private async safeRemoveContainer(containerId: string): Promise<void> {
    // Pair-remove the VPN sidecar before the agent container so the
    // agent's network namespace doesn't outlive the tunnel by even a
    // moment. Failure here is non-fatal — orphaned sidecars get
    // reaped on next host restart.
    const pair = this.sidecarsByAgent.get(containerId);
    if (pair) {
      this.sidecarsByAgent.delete(containerId);
      try {
        await this.deps.containerManager.removeContainer(pair.sidecarId, true);
      } catch {
        // Sidecar may already be gone
      }
      // Emit sidecar_down for observability. Provider may be unset on
      // OSS or noop on the default impl — call optionally.
      try {
        await this.deps.vpnTunnelProvider?.()?.recordEvent?.(
          pair.tunnelId,
          "sidecar_down",
          { sidecarId: pair.sidecarId, agentId: containerId },
        );
      } catch (err) {
        this.log.warn({ err, tunnelId: pair.tunnelId }, "recordEvent(sidecar_down) failed");
      }
    }
    try {
      await this.deps.containerManager.removeContainer(containerId, true);
    } catch {
      // Container may already be gone
    }
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
  ): Promise<{ sidecarId: string; tunnelId: string; networkMode: string; dns?: string[]; searchDomains?: string[] } | null> {
    const provider = this.deps.vpnTunnelProvider?.();
    const encryptionKey = this.deps.config.encryptionKey;
    if (!provider || !encryptionKey || !profile.user_id) return null;
    try {
      const tunnel = await provider.resolveActiveTunnel(profile.user_id, profile.id);
      if (!tunnel) return null;
      const config = decrypt(tunnel.encryptedConfig, encryptionKey);
      const env: Record<string, string> = {
        VPN_CONFIG_B64: Buffer.from(config, "utf8").toString("base64"),
      };
      // OpenVPN may also carry an auth-user-pass blob ("username\npassword")
      // as a second encrypted field. WireGuard tunnels leave this null.
      if (tunnel.authBlobEncrypted) {
        const authBlob = decrypt(tunnel.authBlobEncrypted, encryptionKey);
        env.VPN_AUTH_USER_PASS_B64 = Buffer.from(authBlob, "utf8").toString("base64");
      }
      // OpenVPN needs /dev/net/tun; WireGuard uses the kernel module and
      // doesn't.
      const devices = tunnel.type === "openvpn" ? ["/dev/net/tun"] : undefined;
      const sidecarId = await this.deps.containerManager.createContainer({
        image: tunnel.sidecarImage,
        env,
        capAdd: ["NET_ADMIN"],
        devices,
        labels: {
          "vonzio-mode": "vpn-sidecar",
          "vonzio-vpn-tunnel-id": tunnel.id,
          "vonzio-vpn-tunnel-type": tunnel.type,
        },
      });
      await this.deps.containerManager.startContainer(sidecarId);

      let dns: string[] | undefined;
      let searchDomains: string[] | undefined;
      if (tunnel.type === "openvpn") {
        // Wait for openvpn's --up script to write the pushed-DNS file.
        // The script runs after the tunnel completes its handshake.
        const pushed = await this.readPushedDnsFromSidecar(sidecarId);
        if (pushed) {
          dns = pushed.dns;
          searchDomains = pushed.searchDomains;
        }
      } else {
        // WireGuard: kernel sets things up instantly; brief settle.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      this.log.info({ tunnelId: tunnel.id, sidecarId, dns, searchDomains }, "VPN sidecar up");
      // Emit sidecar_up event. Best-effort: failure here doesn't
      // affect the agent launch.
      try {
        await provider.recordEvent?.(tunnel.id, "sidecar_up", {
          sidecarId,
          hasDns: !!(dns && dns.length > 0),
        });
      } catch (err) {
        this.log.warn({ err, tunnelId: tunnel.id }, "recordEvent(sidecar_up) failed");
      }
      return { sidecarId, tunnelId: tunnel.id, networkMode: `container:${sidecarId}`, dns, searchDomains };
    } catch (err) {
      this.log.error({ err, profileId: profile.id }, "Failed to bring up VPN sidecar; proceeding without tunnel");
      return null;
    }
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
    const timer = setTimeout(async () => {
      const active = this.activeTasks.get(taskId);
      if (active) {
        await this.agentComms.abort(active.containerId);
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

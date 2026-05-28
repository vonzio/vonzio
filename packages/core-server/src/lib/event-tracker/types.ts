export interface EventRecord {
  user_id?: string | null;
  /**
   * Optional org id. Stamped by SaaS callers from request.orgContext;
   * NULL on OSS deployments. Persisted alongside user_id so admin
   * dashboards can scope event queries per org.
   */
  org_id?: string | null;
  session_id?: string | null;
  event: string;
  source: "server" | "client";
  properties?: Record<string, unknown> | null;
  ip?: string | null;
  user_agent?: string | null;
}

export interface EnrichContext {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  userId?: string | null;
  sessionId?: string | null;
}

export type EnrichFn = (ctx: EnrichContext) => Partial<EventRecord>;

export type WriteFn = (event: EventRecord & { created_at: string }) => Promise<void>;

export interface TrackerLogger {
  error: (obj: unknown, msg?: string) => void;
}

export interface TrackerOptions {
  write: WriteFn;
  enrich?: EnrichFn;
  log?: TrackerLogger;
}

export interface TrackInput {
  event: string;
  source?: "server" | "client";
  userId?: string | null;
  /** SaaS callers pass request.orgContext?.org_id; OSS leaves it undefined. */
  orgId?: string | null;
  sessionId?: string | null;
  properties?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface Tracker {
  /** Fire-and-forget. Never throws into the caller's path. */
  track: (input: TrackInput) => void;
  /** Await the write (for tests or explicit flushing). Returns false on failure. */
  trackSync: (input: TrackInput) => Promise<boolean>;
}

import { eq, and, asc, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

/** Metadata view of a knowledge document (no content payload). */
export interface DocumentSummary {
  id: string;
  profile_id: string;
  session_id: string | null;
  name: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
}

/** A document with its base64 content, for mounting into a container. */
export interface DocumentWithContent extends DocumentSummary {
  content_b64: string;
}

export interface UploadDocumentInput {
  profile_id: string;
  /** Set → scope this doc to one workspace; omit/null → agent-level. */
  session_id?: string | null;
  name: string;
  media_type: string;
  /** Base64-encoded file content. */
  content_b64: string;
}

const META_COLS = {
  id: schema.documents.id,
  profile_id: schema.documents.profile_id,
  session_id: schema.documents.session_id,
  name: schema.documents.name,
  media_type: schema.documents.media_type,
  size_bytes: schema.documents.size_bytes,
  created_at: schema.documents.created_at,
} as const;

// Default caps (bytes) when none are supplied. Configurable via env
// (MAX_DOCUMENT_MB / MAX_PROFILE_DOCUMENTS_MB) — see config.ts. Postgres stores
// the base64 in a text column, so this isn't a blob store; keep it sane.
export const DEFAULT_MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_PROFILE_DOCUMENT_BYTES = 500 * 1024 * 1024;

export class DocumentError extends Error {}

export class DocumentService {
  readonly maxDocumentBytes: number;
  readonly maxProfileBytes: number;

  constructor(
    private db: DrizzleDB,
    maxDocumentBytes: number = DEFAULT_MAX_DOCUMENT_BYTES,
    maxProfileBytes: number = DEFAULT_MAX_PROFILE_DOCUMENT_BYTES,
  ) {
    this.maxDocumentBytes = maxDocumentBytes;
    this.maxProfileBytes = maxProfileBytes;
  }

  /** Agent-level docs for a profile (session_id IS NULL), oldest first. */
  async list(profileId: string): Promise<DocumentSummary[]> {
    return this.db
      .select(META_COLS)
      .from(schema.documents)
      .where(and(eq(schema.documents.profile_id, profileId), isNull(schema.documents.session_id)))
      .orderBy(asc(schema.documents.created_at));
  }

  /** Workspace-scoped docs for one session, oldest first. */
  async listForSession(sessionId: string): Promise<DocumentSummary[]> {
    return this.db
      .select(META_COLS)
      .from(schema.documents)
      .where(eq(schema.documents.session_id, sessionId))
      .orderBy(asc(schema.documents.created_at));
  }

  /**
   * Full documents (with content) to mount for a task: the agent-level docs for
   * the profile PLUS the workspace-scoped docs for this session. Agent docs
   * first, then workspace docs.
   */
  async resolveForMount(profileId: string, sessionId?: string): Promise<DocumentWithContent[]> {
    const agent = await this.db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.profile_id, profileId), isNull(schema.documents.session_id)))
      .orderBy(asc(schema.documents.created_at));
    const workspace = sessionId
      ? await this.db
          .select()
          .from(schema.documents)
          .where(eq(schema.documents.session_id, sessionId))
          .orderBy(asc(schema.documents.created_at))
      : [];
    return [...agent, ...workspace].map((r) => ({
      id: r.id, profile_id: r.profile_id, session_id: r.session_id,
      name: r.name, media_type: r.media_type, size_bytes: r.size_bytes,
      created_at: r.created_at, content_b64: r.content_b64,
    }));
  }

  /** Owning (profile_id, session_id) of a document — for delete ownership checks. */
  async getOwner(documentId: string): Promise<{ profile_id: string; session_id: string | null } | null> {
    const rows = await this.db
      .select({ profile_id: schema.documents.profile_id, session_id: schema.documents.session_id })
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId));
    return rows[0] ?? null;
  }

  async upload(input: UploadDocumentInput, userId?: string): Promise<DocumentSummary> {
    // Decode just to measure true byte size and reject malformed base64.
    let sizeBytes: number;
    try {
      sizeBytes = Buffer.from(input.content_b64, "base64").length;
    } catch {
      throw new DocumentError("Invalid file content.");
    }
    if (sizeBytes === 0) throw new DocumentError("File is empty.");
    if (sizeBytes > this.maxDocumentBytes) {
      throw new DocumentError(`File exceeds the ${Math.floor(this.maxDocumentBytes / 1024 / 1024)} MB limit.`);
    }

    // Cap is per-scope: agent docs count against the profile total; workspace
    // docs count against that workspace's total. Both use the same ceiling.
    const sessionId = input.session_id ?? null;
    const existing = sessionId ? await this.listForSession(sessionId) : await this.list(input.profile_id);
    const used = existing.reduce((sum, d) => sum + d.size_bytes, 0);
    if (used + sizeBytes > this.maxProfileBytes) {
      throw new DocumentError(
        `These documents would exceed the ${Math.floor(this.maxProfileBytes / 1024 / 1024)} MB total limit.`,
      );
    }

    const id = `doc_${nanoid()}`;
    const now = new Date().toISOString();
    await this.db.insert(schema.documents).values({
      id,
      profile_id: input.profile_id,
      session_id: sessionId,
      user_id: userId ?? null,
      name: input.name,
      media_type: input.media_type,
      size_bytes: sizeBytes,
      content_b64: input.content_b64,
      created_at: now,
    });
    return {
      id, profile_id: input.profile_id, session_id: sessionId, name: input.name,
      media_type: input.media_type, size_bytes: sizeBytes, created_at: now,
    };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(schema.documents).where(eq(schema.documents.id, id)).returning();
    return result.length > 0;
  }
}

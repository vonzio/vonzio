// ─── Error Codes (shared across REST + WS) ──────────────────────────

export const ErrorCodes = {
  // Auth
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",

  // Validation
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_JSON: "INVALID_JSON",

  // Resources
  NOT_FOUND: "NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",

  // Rate limiting / capacity
  RATE_LIMITED: "RATE_LIMITED",
  TOO_MANY_CONNECTIONS: "TOO_MANY_CONNECTIONS",

  // Task lifecycle
  TASK_FAILED: "TASK_FAILED",

  // Server
  INTERNAL_ERROR: "INTERNAL_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  BAD_GATEWAY: "BAD_GATEWAY",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// ─── Error Classes ───────────────────────────────────────────────────

export class ForbiddenError extends Error {
  code = ErrorCodes.FORBIDDEN;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  code = ErrorCodes.NOT_FOUND;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends Error {
  code = ErrorCodes.VALIDATION_FAILED;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ─── Response Helpers ────────────────────────────────────────────────

export function errorResponse(code: ErrorCode, message: string, details?: unknown) {
  return { error: message, code, ...(details !== undefined && { details }) };
}
